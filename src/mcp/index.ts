import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import type { DaemonEndpoint, RpcMethod, RpcParams, RpcResponse, RpcResult } from '@shared/protocol.js'
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
 * setting an environment variable it does not control. The worker tier can report completion, ask a
 * person, file a follow-up inside its own mandate, and leave a handoff. The controller tier can read
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
        (err instanceof Error ? err.message : String(err))
    )
  }
}

async function rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
  const ep = endpoint()
  const res = await fetch(`http://127.0.0.1:${ep.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
    body: JSON.stringify({ id: Date.now(), method, params })
  })
  const body = (await res.json()) as RpcResponse
  if (!body.ok) throw new Error(body.error.message)
  return body.result as RpcResult<M>
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

    let decision: 'allow' | 'deny' = 'deny'
    let message = 'Multi Agent Controller could not reach orchestratord to ask.'
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
 */
server.registerTool(
  'request_human',
  {
    title: 'Ask the operator a question',
    description:
      'Put a question to the operator and wait. Use this instead of guessing when the answer changes ' +
      'what you build.',
    inputSchema: { question: z.string() }
  },
  async (args) => {
    const sessionId = process.env.MULTI_AGENT_CONTROLLER_SESSION_ID ?? ''
    try {
      const answer = await rpc('approval.request', {
        sessionId,
        origin: 'tool_gate',
        tool: 'request_human',
        target: '',
        summary: args.question,
        raw: ''
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: answer.decision === 'allow' ? 'The operator agreed.' : 'The operator declined.'
          }
        ]
      }
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
