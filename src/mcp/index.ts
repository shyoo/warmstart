import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { DaemonEndpoint, RpcMethod, RpcParams, RpcResponse, RpcResult } from '@shared/protocol.js'
import { paths } from '../daemon/paths.js'
import { errorMessage } from '@shared/errors.js'
import { describeTarget, failed, keepAlive, questionsFrom, text, type NativeQuestion } from './payload.js'
import { workerTools, type ToolExtra } from './workertools.js'
import { appEnv } from '@shared/env.js'
import { APP_VERSION } from '@shared/version.js'

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
 * ⛔ **Two tiers, and the tier is set by the daemon, not asked for by the caller.** `WARMSTART_TIER`
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

const TIER = appEnv('TIER') === 'controller' ? 'controller' : 'worker'

function endpoint(): DaemonEndpoint {
  try {
    return JSON.parse(readFileSync(paths.endpoint, 'utf8')) as DaemonEndpoint
  } catch (err) {
    throw new Error(
      `orchestratord is not running (no endpoint at ${paths.endpoint}): ` +
        (errorMessage(err)),
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
              new Error(`Failed to parse RPC response: ${errorMessage(err)}`)
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

/**
 * How often a call held open on a person says it is still alive.
 *
 * ⛔ **A silent tool call is killed by the client, not by us.** Measured 2026-09-26 in claude-code
 * 2.1.283's own bundle: a stdio MCP call that sends *"no response or progress notification"* for
 * 1,800,000 ms is aborted, and only a `notifications/progress` resets that clock. `question.ask`
 * holds for up to an hour (`MAX_WAIT_MS`), so on t708 the CLI gave up at thirty minutes, the agent
 * ended its turn, and the operator's answer 51 seconds later went nowhere. Spiked the same day with
 * the idle timeout forced to 40s: a silent 100s call was aborted at 60s; the same call beating every
 * 20s returned normally. The CLI sent a `progressToken`, and did **not** cancel the call on our side
 * when it gave up — so the daemon cannot learn of an abort from here, only prevent one.
 *
 * ⚠️ Not a per-server `timeout` in the MCP config: that is also the *hard* wall-clock limit for every
 * tool on this server (default 1e8 ms there, and "progress notifications do not extend it"), so it
 * would cap `land_work`'s checks to fix `ask_human`'s wait. A beat resets only the idle clock, and it
 * costs no tokens — the CLI shows it in its own UI, not to the model.
 */
const HEARTBEAT_MS = 60 * 1000

/** `rpc` for a call that may wait on a person or on the project's checks. See HEARTBEAT_MS. */
async function held<M extends RpcMethod>(
  extra: ToolExtra | undefined,
  method: M,
  params?: RpcParams<M>
): Promise<RpcResult<M>> {
  const stop = keepAlive(extra, HEARTBEAT_MS)
  try {
    return await rpc(method, params)
  } finally {
    stop()
  }
}

// ⛔ Must match MCP_SERVER_NAME in mcpconfig.ts - the daemon registers this server under that
// key and tells the CLI to call `mcp__<that key>__approve`. Not imported: this bundle is spawned as
// a standalone process and deliberately shares no daemon module.
const server = new McpServer({ name: 'warmstart', version: APP_VERSION })

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
    title: 'Ask Warmstart whether this action may run',
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
    const sessionId = appEnv('SESSION_ID') ?? ''
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
      return await answerNativeQuestions(sessionId, askedList, extra)
    }

    let decision: 'allow' | 'deny' = 'deny'
    let message: string
    try {
      const answer = await held(extra, 'approval.request', {
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
      message = `Denied by default: ${errorMessage(err)}`
    }

    const payload =
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: args.input ?? {} }
        : { behavior: 'deny', message: message || 'Denied by Warmstart policy.' }

    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
  }
)

// ============================================================================ worker tier
//
// ⛔ Defined in `workertools.ts`, because the `warmstart-agent` helper serves the same tools to an
// agent whose CLI cannot speak MCP. See that file.
if (TIER === 'worker') {
  const io = { sessionId: appEnv('SESSION_ID') ?? '', rpc, held }
  for (const tool of workerTools(io)) server.registerTool(tool.name, tool.config, tool.handler)
}

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
  askedList: NativeQuestion[],
  extra?: ToolExtra
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const replies: string[] = []
  for (const asked of askedList) {
    const kind = asked.options.length === 0 ? 'text' : asked.multiSelect ? 'multi' : 'choice'
    try {
      const resolution = await held(extra, 'question.ask', {
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

await server.connect(new StdioServerTransport())
