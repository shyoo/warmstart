import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { DaemonEndpoint, RpcMethod, RpcParams, RpcResponse, RpcResult } from '@shared/protocol.js'
import { cleanQuestionText, extractEmbeddedParameters, isMultiSelectQuestion } from '@shared/tasks.js'
import { paths } from '../daemon/paths.js'

/**
 * The agentyard MCP server.
 *
 * Spawned by the agent CLI, not by us - which is exactly why it exists as its own entry point. Its
 * headline job is being the target of `--permission-prompt-tool`: when the CLI would have shown a
 * permission card, it calls `approve` here instead, and blocks on the answer.
 *
 * That is what makes an approval a **structured event** rather than something to read off a screen.
 * ⛔ agentyard never parses a terminal to decide whether an agent may act; a mis-read approval card
 * is an unattended *yes*.
 *
 * It holds no state. Everything routes to orchestratord, which owns the policy, the queue and the
 * escalation clock.
 *
 * ⛔ **Two tiers, and the tier is set by the daemon, not asked for by the caller.** `MULTI_AGENT_CONTROLLER_TIER`
 * comes from the MCP config file the daemon wrote for that session; an agent cannot promote itself by
 * setting an environment variable it does not control. The worker tier can report completion, hand
 * the task back to a person, ask a person, file a follow-up inside its own mandate, and leave a
 * handoff. The controller tier can read
 * the fleet and move work about, and is handed out only to the chat session, where a person is
 * watching. Unattended judgment gets **no tools at all** - it answers as JSON the daemon validates.
 *
 * ⛔ There is no `task_delete` in either tier. An agent that can delete the record of its own failed
 * work is an agent that can hide it.
 */

const TIER = process.env.MULTI_AGENT_CONTROLLER_TIER === 'controller' ? 'controller' : 'worker'

/** Render whatever a tool produced as MCP text content. */
function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
    ]
  }
}

function failed(err: unknown): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true
  }
}

function endpoint(): DaemonEndpoint {
  try {
    return JSON.parse(readFileSync(paths.endpoint, 'utf8')) as DaemonEndpoint
  } catch (err) {
    throw new Error(
      `orchestratord is not running (no endpoint at ${paths.endpoint}): ` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err }
    )
  }
}

function rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
  const ep = endpoint()
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ id: Date.now(), method, params })
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: ep.port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          authorization: `Bearer ${ep.token}`
        },
        timeout: 0
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as RpcResponse
            if (!parsed.ok) {
              reject(new Error(parsed.error.message))
            } else {
              resolve(parsed.result as RpcResult<M>)
            }
          } catch (err) {
            reject(
              new Error(`Failed to parse RPC response: ${err instanceof Error ? err.message : String(err)}`)
            )
          }
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ⛔ Must match MCP_SERVER_NAME in mcpconfig.ts - the daemon registers this server under that
// key and tells the CLI to call `mcp__<that key>__approve`. Not imported: this bundle is spawned as
// a standalone process and deliberately shares no daemon module.
const server = new McpServer({ name: 'multi-agent-controller', version: '0.0.1' })

/**
 * The permission prompt tool.
 *
 * ⚠️ The request and response shapes are **not documented**. This implementation mirrors the Agent
 * SDK's `canUseTool` contract - a `{behavior: 'allow', updatedInput}` / `{behavior: 'deny', message}`
 * object returned as JSON text - and logs whatever it actually receives to
 * `<dataDir>/logs/mcp-approve.log` so the real shape can be read off a live run rather than guessed
 * at twice. See HANDOFF.md.
 */
server.registerTool(
  'approve',
  {
    title: 'Ask Multi Agent Controller whether this action may run',
    description:
      'Called by the agent CLI in place of showing a permission prompt. The controller answers from the ' +
      "project's rules where it can, and asks the operator where it cannot.",
    inputSchema: {
      tool_name: z.string().describe('The tool the agent wants to use'),
      input: z.unknown().optional().describe('The tool input the agent proposed'),
      tool_use_id: z.string().optional()
    }
  },
  async (args, extra) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    const toolName = String(args.tool_name ?? 'unknown')
    const target = describeTarget(args.input)

    // ⛔ A question is not a permission request, and answering it allow/deny destroys it.
    // Measured 2026-08-30 on claude-code 2.1.251 (R14.a): the CLI's own `AskUserQuestion` arrives
    // here carrying the whole question - labels, per-option prose, `multiSelect` - and was being
    // flattened into three buttons. It is routed to the Question object instead.
    const askedList = questionsFrom(args.input)
    if (
      (toolName === 'AskUserQuestion' ||
        toolName === 'ask_question' ||
        toolName === 'AskQuestion' ||
        toolName === 'ask_human') &&
      askedList.length > 0
    ) {
      return await answerNativeQuestions(sessionId, askedList)
    }

    let decision: 'allow' | 'deny' = 'deny'
    let message: string
    try {
      const answer = await rpc('approval.request', {
        sessionId,
        origin: 'permission_prompt',
        tool: toolName,
        target,
        summary: `${toolName}${target ? `: ${target}` : ''}`,
        // Whatever the CLI sent, verbatim, so the operator sees the real request and not our gloss.
        raw: JSON.stringify({ args, extra: { requestId: extra?.requestId } }).slice(0, 4000)
      })
      decision = answer.decision === 'deny' ? 'deny' : 'allow'
      message = answer.reason ?? ''
    } catch (err) {
      message = `Denied by default: ${err instanceof Error ? err.message : String(err)}`
    }

    const payload =
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: args.input ?? {} }
        : { behavior: 'deny', message: message || 'Denied by Multi Agent Controller policy.' }

    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
  }
)

// ============================================================================ worker tier
//
// Scoped to its own run, its own project, its own mandate and its own budget. ⛔ Deliberately absent:
// raw process spawn, raw SQL, the filesystem outside its project, any way to widen its own mandate,
// and any way to assign work directly to another worker.
if (TIER === 'worker') {
/**
 * The worker tier's way to ask a person something, rather than guessing and being wrong expensively.
 *
 * ⛔ **This replaced `request_human`, which could not carry an answer.** That tool routed through
 * the approval path, whose answer set is closed at allow/deny — so an agent that asked *"OAuth,
 * session cookies, or magic link?"* got back `The operator agreed.` The question travelled all the
 * way to a person and the reply had nowhere to sit. See daemon/questions.ts.
 *
 * ⚠️ This call blocks, and it can block for minutes: the daemon holds it until somebody answers or
 * until the session's prompt cache expires. That is deliberate — an answer that arrives while the
 * session is still warm costs a cache read, and the same answer after a restart costs a full rebuild.
 */
server.registerTool(
  'ask_human',
  {
    title: 'Ask the operator a question and wait for the answer',
    description:
      'Put a question to the operator and wait for a real answer. Use this instead of guessing ' +
      'whenever the answer changes what you build. Offer options when there is a fixed set of ' +
      'sensible ones — the operator answers those in one click. Set `multi_select` to true ' +
      '(or `multiSelect`) if the operator can choose more than one option (checkboxes). ' +
      'Leave options empty for an open question. If nobody answers in time you are told so plainly; stop rather than guessing.',
    inputSchema: {
      question: z.string().describe('The question, in full. The operator sees exactly this text.'),
      header: z.string().optional().describe('A few words naming the decision, e.g. "Auth approach"'),
      options: z
        .array(
          z.union([
            z.string(),
            z.object({
              label: z.string().describe('The choice, as the operator will see it on a button'),
              detail: z.string().optional().describe('What choosing this means, and what it costs')
            })
          ])
        )
        .optional()
        .describe('Leave empty for an open question'),
      multi_select: z
        .boolean()
        .optional()
        .describe('May the operator choose more than one option (checkboxes)? Set true for multiple selection.'),
      multiSelect: z.boolean().optional().describe('Alias for multi_select'),
      is_multi_select: z.boolean().optional().describe('Alias for multi_select'),
      multiple: z.boolean().optional().describe('Alias for multi_select')
    }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    const rawQuestion = args.question
    const embedded = extractEmbeddedParameters(rawQuestion)
    const questionText = cleanQuestionText(embedded.question)
    const header = args.header || embedded.header

    const rawOptions = args.options ?? []
    const options = rawOptions.map((o) => (typeof o === 'string' ? { label: o } : o))

    const explicitMulti =
      args.multi_select === true ||
      args.multiSelect === true ||
      args.is_multi_select === true ||
      args.multiple === true ||
      embedded.multiSelect === true
    const isMulti = explicitMulti || isMultiSelectQuestion(questionText, options, header)

    // ⛔ The kind is derived from what was actually supplied or inferred, not asked for separately.
    const kind = options.length === 0 ? 'text' : isMulti ? 'multi' : 'choice'
    try {
      const resolution = await rpc('question.ask', {
        sessionId,
        origin: 'ask_human',
        kind,
        question: questionText,
        ...(header ? { header } : {}),
        ...(options.length > 0
          ? {
              options: options.map((option, index) => ({
                id: `opt${index + 1}`,
                label: option.label,
                ...(option.detail ? { detail: option.detail } : {})
              }))
            }
          : {})
      })
      return { content: [{ type: 'text' as const, text: resolution.reply }] }
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Could not reach the operator: ${String(err)}` }
        ],
        isError: true
      }
    }
  }
)

/**
 * A phase boundary on a `checkpointed` task.
 *
 * ⛔ A Question with a fixed answer set, which is the one place a question's options are *not*
 * written by the asker - because the three things a person can say at a phase boundary are the same
 * three every time: carry on, do something else, or stop. That makes it answerable in one click on
 * the Attention bar, which matters more here than anywhere else: a checkpoint is answered often, and
 * an interaction that costs a page load each time would train the operator to turn checkpointing off.
 *
 * ⚠️ Named in the prompt only for tasks whose completion mode resolves to `checkpointed`. An
 * autonomous agent is told to work to the end, and calling this would be a stop nobody asked for.
 */
server.registerTool(
  'checkpoint',
  {
    title: 'Report a finished phase and wait for the go-ahead',
    description:
      'Call this at a phase boundary when the task is being run in phases. Say what you have done ' +
      'and what you propose to do next, then wait. The operator can let you carry on, redirect you, ' +
      'or stop you. Do not use this to ask a question — `ask_human` is for that.',
    inputSchema: {
      phase: z.string().describe('A few words naming the phase just finished'),
      done: z.string().describe('What you actually did in it'),
      next: z.string().describe('What you propose to do next, in one or two sentences')
    }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      const resolution = await rpc('question.ask', {
        sessionId,
        origin: 'checkpoint',
        kind: 'choice',
        header: args.phase,
        question: `Finished: ${args.done}

Proposed next: ${args.next}`,
        options: [
          { id: 'continue', label: 'Carry on', detail: 'Do exactly what you proposed.' },
          { id: 'redirect', label: 'Do something else', detail: 'Follow the note instead.' },
          { id: 'stop', label: 'Stop here', detail: 'Leave a handoff and end the run.' }
        ]
      })
      return { content: [{ type: 'text' as const, text: resolution.reply }] }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Could not reach the operator: ${String(err)}` }],
        isError: true
      }
    }
  }
)

/**
 * ⛔ The only signal that a task succeeded. The controller will not infer completion from a process
 * exiting, from a clean exit code, or from anything on screen.
 */
server.registerTool(
  'task_complete',
  {
    title: 'Report that the task is finished',
    description:
      'Call this when the work is done. The controller will run the project checks and land the branch ' +
      'according to project policy. Nothing else marks a task complete.',
    inputSchema: { summary: z.string().describe('One line: what was done') }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      await rpc('agent.complete', { sessionId, summary: args.summary })
      return { content: [{ type: 'text' as const, text: 'Recorded. The controller is landing the work.' }] }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Could not report completion: ${String(err)}` }],
        isError: true
      }
    }
  }
)

/**
 * The other way a run can end: the agent has gone as far as it can, and the rest is a person's.
 *
 * ⛔ **Not a quieter `task_complete`, and the description must never let it read as one.** It claims
 * nothing about the work, lands nothing and runs no checks; the task comes to rest at
 * `awaiting_human` carrying the agent's own reason.
 *
 * ⭐ The gap it closes, measured on t226 (2026-09-05): an ordinary run stays open until
 * `task_complete` arrives, so an agent that is told *"leave it, I will close this out myself"* and
 * obeys has nothing to call. `task_complete` would assert a success the finish path had just refused,
 * `handoff` records a note and ends nothing, and `ask_human` asks a question it no longer has. The
 * turn ended, the session sat live and idle, and the board showed the task running all evening.
 */
server.registerTool(
  'await_human',
  {
    title: 'Hand the task back to a person and stop',
    description:
      'Call this when you have gone as far as you can and the rest genuinely needs a person: a step ' +
      'only they can take, a decision that is theirs to make, or work they have said they will close ' +
      'out themselves. It is NOT a way to finish early — if the work is done, call `task_complete`; ' +
      'if you only need an answer to carry on, call `ask_human`, which waits and lets you continue. ' +
      'This one ends the run. Nothing is landed, committed or discarded, and the task rests where a ' +
      'person can see your reason and reply. Stopping without calling this leaves the task reading ' +
      'as still running.',
    inputSchema: {
      reason: z
        .string()
        .describe('One line: what a person now has to decide or do. They see exactly this on the task.'),
      state: z
        .string()
        .optional()
        .describe(
          'Where things stand — what is done, what is not, and where the work is. Recorded as the ' +
            "handoff, so a successor does not pay to rediscover the state of the branch."
        )
    }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      const result = await rpc('agent.awaitHuman', {
        sessionId,
        reason: args.reason,
        ...(args.state ? { state: args.state } : {})
      })
      return {
        content: [{ type: 'text' as const, text: result.reply }],
        ...(result.ok ? {} : { isError: true })
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Could not hand this over: ${String(err)}` }],
        isError: true
      }
    }
  }
)

/**
 * Agent-authored work. Bounded by the calling task's inherited mandate and budget - a task that has
 * lost `spawn_tasks` simply cannot do this, and the refusal comes from the daemon, not from here.
 */
server.registerTool(
  'task_create',
  {
    title: 'File a follow-up task',
    description:
      'File work that should not be part of this task. It inherits a narrowed version of this ' +
      "task's authority and a share of its budget.",
    inputSchema: {
      title: z.string(),
      prompt: z.string().optional(),
      assignee_hint: z.enum(['human', 'any']).optional()
    }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      const result = await rpc('agent.createTask', {
        sessionId,
        title: args.title,
        ...(args.prompt ? { prompt: args.prompt } : {}),
        ...(args.assignee_hint ? { assigneeHint: args.assignee_hint } : {})
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: result.ok ? `Filed as t${result.seq}.` : `Not filed: ${result.reason}`
          }
        ]
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
    }
  }
)

/**
 * File a whole plan at once, and block on the operator approving it.
 *
 * ⛔ **The approval is structural, not an instruction.** An agent told in its prompt to ask before
 * splitting can forget, or can decide this particular split is obvious; an agent whose `task_split`
 * call does not return until a person has answered cannot. That is the whole reason this blocks
 * rather than filing and notifying.
 *
 * ⛔ **One approval for the whole split, not one per child.** Every coding subtask trips `riskOf`'s
 * `controller` gate — any agent-filed task whose mandate allows `commit` or `push` does — so a split
 * of five would otherwise raise five separate consults and leave five drafts, and on an install with
 * no controller turn available none of them would ever run. The operator approved this exact set, by
 * title, one second ago; asking again five times is not a second safety check, it is a way to make
 * the feature unusable.
 *
 * ⚠️ Atomic. Nothing is written until the operator says yes, and if any piece cannot be filed the
 * ones already created are unwound — a planner blocked on half a plan has no way out.
 */
server.registerTool(
  'task_split',
  {
    title: 'Break this plan into subtasks and delegate them',
    description:
      'File the whole plan in one call: two or more concrete pieces, each with its own full ' +
      'instruction. The operator approves the entire split before anything is filed, so make each ' +
      'piece legible on a card. Each piece must be completable by an agent that has NOT read this ' +
      'conversation, so its instruction has to carry its own context: what to change, where, and ' +
      'what done looks like. Pieces without dependency edges may run in parallel. If the plan calls ' +
      'for sequential execution or landing, encode that order with depends_on; otherwise add an ' +
      'edge only where it is genuinely needed, because it costs a subtask’s wait. After this ' +
      'returns, STOP: the work is ' +
      'delegated and you will be woken again when every piece has settled.',
    inputSchema: {
      pieces: z
        .array(
          z.object({
            instruction: z
              .string()
              .describe('The full prompt for this piece, self-contained. This is what the agent is sent.'),
            summary: z
              .string()
              .optional()
              .describe('A short label for the board, e.g. "Add the migration"'),
            depends_on: z
              .array(z.number().int())
              .optional()
              .describe(
                'Indices of EARLIER pieces this piece must wait for, starting at 0. Use these to ' +
                  'encode every promised execution or landing order; omitted pieces may run in parallel.'
              )
          })
        )
        .describe('Two or more pieces. A split of one is refused.')
    }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      const result = await rpc('agent.split', {
        sessionId,
        pieces: (args.pieces ?? []).map((p) => ({
          title: p.instruction,
          ...(p.summary ? { summary: p.summary } : {}),
          dependsOn: p.depends_on ?? []
        }))
      })
      return {
        content: [{ type: 'text' as const, text: result.reply }],
        ...(result.ok ? {} : { isError: true })
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
    }
  }
)

/**
 * Add one edge between two pieces of this planner's own split.
 *
 * ⛔ Scoped to this task's own children, and the daemon enforces it rather than trusting the
 * argument. An agent that can add an arbitrary edge anywhere in the fleet can hold up work it has
 * never seen; the blast radius of a mistake here is the plan the agent is holding, and nothing else.
 *
 * ⚠️ Usually unnecessary — `task_split` takes the edges inline, which is one call instead of N. This
 * exists for the ordering a planner only realises it needs after seeing the pieces filed.
 */
server.registerTool(
  'task_depend',
  {
    title: 'Make one piece of this plan wait for another',
    description:
      'Add a dependency between two pieces of THIS task’s split, by their t-numbers. The blocked ' +
      'piece will not be dispatched until the one it needs has completed. Prefer passing depends_on ' +
      'to task_split; use this only for an ordering you discovered afterwards.',
    inputSchema: {
      task: z.number().int().describe('The t-number of the piece that must WAIT'),
      depends_on: z.number().int().describe('The t-number of the piece it waits FOR')
    }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      const result = await rpc('agent.depend', {
        sessionId,
        taskSeq: args.task,
        dependsOnSeq: args.depends_on
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: result.ok
              ? `t${args.task} now waits for t${args.depends_on}.`
              : `Not added: ${result.reason}`
          }
        ],
        ...(result.ok ? {} : { isError: true })
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
    }
  }
)

server.registerTool(
  'handoff',
  {
    title: 'Leave a note for whoever continues this task',
    description:
      'Record what you were doing, what is done and what the next step is. Prepended to the next ' +
      "session's prompt, so a successor does not pay to rediscover the state of the branch.",
    inputSchema: { note: z.string() }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      await rpc('agent.handoff', { sessionId, note: args.note })
      return { content: [{ type: 'text' as const, text: 'Handoff recorded.' }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
    }
  }
)

} // end worker tier

// ============================================================================ controller tier
//
// ⚠️ Handed only to the chat session, where a person is watching. Read the fleet, move work about,
// answer approvals — and nothing that writes to a repository, spawns a process, or deletes a record.
if (TIER === 'controller') {
  server.registerTool(
    'fleet_status',
    {
      title: 'What the fleet is doing',
      description:
        'Every worker, its quota reading with the age of that reading, and its live sessions. ' +
        'A quota percentage is never current — check sampledAt before you reason about it.',
      inputSchema: {}
    },
    async () => {
      try {
        return text(await rpc('fleet.list'))
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description: 'Every task on the board, with status, origin, lineage and spend.',
      inputSchema: { project_id: z.string().optional() }
    },
    async (args) => {
      try {
        return text(await rpc('task.list', args.project_id ? { projectId: args.project_id } : {}))
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'task_get',
    {
      title: 'Read one task',
      description: 'The task, its whole thread, and every run against it.',
      inputSchema: { id: z.string() }
    },
    async (args) => {
      try {
        return text(await rpc('task.get', { id: args.id }))
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'task_create',
    {
      title: 'File a task',
      description:
        'File work. Prefer status "draft" for anything you are proposing rather than committing to: ' +
        'a draft is visible on the board, costs nothing, and dispatches nothing until it is promoted. ' +
        'Write its prompt at promotion, not now.',
      inputSchema: {
        title: z.string(),
        prompt: z.string().optional(),
        project_id: z.string().optional(),
        status: z.enum(['draft', 'ready']).optional(),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
        depends_on: z.array(z.string()).optional()
      }
    },
    async (args) => {
      try {
        const task = await rpc('task.create', {
          title: args.title,
          ...(args.prompt ? { prompt: args.prompt } : {}),
          ...(args.project_id ? { projectId: args.project_id } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.priority ? { priority: args.priority } : {}),
          ...(args.depends_on ? { dependsOn: args.depends_on } : {})
        })
        return text(`Filed as t${task.seq} (${task.status}).`)
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'task_update',
    {
      title: 'Change a task',
      description: 'Retitle, reprioritise, or set an estimate. Does not change status.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
        est_tokens: z.number().optional()
      }
    },
    async (args) => {
      try {
        return text(
          await rpc('task.update', {
            id: args.id,
            ...(args.title ? { title: args.title } : {}),
            ...(args.priority ? { priority: args.priority } : {}),
            ...(args.est_tokens !== undefined ? { estTokens: args.est_tokens } : {})
          })
        )
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'task_promote',
    {
      title: 'Move a draft into the queue',
      description:
        'Promote a draft to ready. This is the moment to write its prompt — from what the work before ' +
        'it actually learned, not from what was guessed when it was filed.',
      inputSchema: { id: z.string(), prompt: z.string().optional() }
    },
    async (args) => {
      try {
        if (args.prompt) await rpc('task.message', { id: args.id, text: args.prompt })
        const task = await rpc('task.promote', { id: args.id })
        return text(`t${task.seq} is ${task.status}.`)
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'task_cancel',
    {
      title: 'Stop work on a task',
      description:
        'Cancel is not delete. The work winds down and the task comes to rest in a state you choose; ' +
        'nothing is destroyed and no run is lost. There is deliberately no delete in this tier.',
      inputSchema: {
        id: z.string(),
        resting_state: z.enum(['paused_user', 'draft', 'cancelled']).optional(),
        reason: z.string().optional()
      }
    },
    async (args) => {
      try {
        const task = await rpc('task.cancel', {
          id: args.id,
          ...(args.resting_state ? { restingState: args.resting_state } : {}),
          ...(args.reason ? { reason: args.reason } : {})
        })
        return text(`t${task.seq} is ${task.status}.`)
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'estimate',
    {
      title: 'What work like this has cost',
      description:
        'The median of completed runs, with its confidence and basis. Read the basis: with no history ' +
        'it is a deliberately pessimistic guess, not a measurement.',
      inputSchema: { id: z.string() }
    },
    async (args) => {
      try {
        return text(await rpc('task.estimate', { id: args.id }))
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'approval_list',
    {
      title: 'Approvals waiting on an answer',
      description:
        'Each carries the blocked session cache expiry. Waiting is priced, which is why these are not ' +
        'notifications.',
      inputSchema: {}
    },
    async () => {
      try {
        return text(await rpc('approval.list'))
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'approval_answer',
    {
      title: 'Answer one approval',
      description:
        'Unblock a session. allow_always remembers the answer as a project rule, so the same question ' +
        'is answered in 30ms next time and never reaches anyone.',
      inputSchema: { id: z.string(), decision: z.enum(['allow', 'allow_always', 'deny']) }
    },
    async (args) => {
      try {
        return text(await rpc('approval.answer', { id: args.id, decision: args.decision }))
      } catch (err) {
        return failed(err)
      }
    }
  )

  server.registerTool(
    'resource_status',
    {
      title: 'What is contended for',
      description: 'Workspaces, exclusive locks and rate-limited services, with who holds what.',
      inputSchema: {}
    },
    async () => {
      try {
        return text(await rpc('resource.list'))
      } catch (err) {
        return failed(err)
      }
    }
  )
} // end controller tier

/**
 * The vendor's own question(s), if this is one.
 *
 * ⚠️ Shape measured, not documented: `{questions: [{question, header?, options: [{label,
 * description?}], multiSelect?}]}`. Returns an empty array on anything that does not match, so a future change
 * to the payload degrades to the ordinary approval path rather than throwing inside a permission
 * hook - where the failure mode is an agent that cannot act at all.
 */
interface NativeQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: Array<{ id: string; label: string; detail?: string }>
}

function questionsFrom(input: unknown): NativeQuestion[] {
  if (!input || typeof input !== 'object') return []
  const list = (input as { questions?: unknown }).questions
  if (!Array.isArray(list) || list.length === 0) return []
  const result: NativeQuestion[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const rawQuestion = typeof record.question === 'string' ? record.question : null
    if (!rawQuestion) continue
    const embedded = extractEmbeddedParameters(rawQuestion)
    const question = cleanQuestionText(embedded.question)
    const header =
      typeof record.header === 'string' && record.header ? record.header : embedded.header
    const rawOptions = Array.isArray(record.options) ? record.options : []
    const explicitMulti =
      record.multiSelect === true ||
      record.multi_select === true ||
      record.is_multi_select === true ||
      record.multiple === true ||
      embedded.multiSelect === true
    const isMulti =
      explicitMulti ||
      isMultiSelectQuestion(
        question,
        rawOptions as Array<{ label?: string; detail?: string } | string>,
        header
      )

    result.push({
      question,
      ...(header ? { header } : {}),
      multiSelect: isMulti,
      options: rawOptions
        .map((o, index) => {
          if (typeof o === 'string') {
            return { id: `opt${index + 1}`, label: o }
          }
          const option = o as Record<string, unknown>
          const label =
            typeof option.label === 'string'
              ? option.label
              : typeof option.text === 'string'
                ? option.text
                : null
          if (!label) return null
          return {
            id: typeof option.id === 'string' && option.id.trim() ? option.id.trim() : `opt${index + 1}`,
            label,
            ...(typeof option.description === 'string' && option.description
              ? { detail: option.description }
              : typeof option.detail === 'string' && option.detail
                ? { detail: option.detail }
                : {})
          }
        })
        .filter((o): o is { id: string; label: string; detail?: string } => o !== null)
    })
  }
  return result
}

/**
 * Put the vendor's question(s) to a person, and hand the answer(s) back through the only channel that
 * carries one.
 *
 * ⛔ `{behavior:'deny', message}` is the answer channel, and this is measured rather than
 * assumed. R14.b: returning `allow` yields the tool result *"The user did not answer the questions."*
 * - the hook gates *asking*, not *answering*. R14.b-prime: a `deny` message reaches the model as the
 * tool result and is acted on (*"Got it - server-side session cookies it is."*).
 *
 * ⚠️ So the message must read as an answer and never as an apology: the model is told this
 * was a refusal, and the only thing correcting that impression is the sentence itself. It also lands
 * in the run's `permission_denials`; nothing reads that field today, and anything that starts to
 * must not count these as denials.
 */
async function answerNativeQuestions(
  sessionId: string,
  askedList: NativeQuestion[]
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const replies: string[] = []
  for (const asked of askedList) {
    const kind = asked.options.length === 0 ? 'text' : asked.multiSelect ? 'multi' : 'choice'
    try {
      const resolution = await rpc('question.ask', {
        sessionId,
        origin: 'native_tool',
        kind,
        question: asked.question,
        ...(asked.header ? { header: asked.header } : {}),
        ...(asked.options.length > 0 ? { options: asked.options } : {})
      })
      replies.push(resolution.reply)
    } catch (err) {
      // ⚠️ Says what happened rather than pretending to an answer. An agent told the operator
      // declined would build on a refusal nobody made.
      replies.push(
        `The question could not be put to the operator (${String(err)}). Do not guess: stop and say what you were about to do.`
      )
      break
    }
  }
  const message = replies.join('\n')
  return { content: [{ type: 'text' as const, text: JSON.stringify({ behavior: 'deny', message }) }] }
}

/** A best-effort one-line rendering of what is about to happen. Never used for a policy decision. */
function describeTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = record[key]
    if (typeof value === 'string') return value.slice(0, 300)
  }
  return ''
}

await server.connect(new StdioServerTransport())
