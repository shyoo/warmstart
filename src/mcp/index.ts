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
 */

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

const server = new McpServer({ name: 'agentyard', version: '0.0.1' })

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
    title: 'Ask agentyard whether this action may run',
    description:
      'Called by the agent CLI in place of showing a permission prompt. agentyard answers from the ' +
      "project's rules where it can, and asks the operator where it cannot.",
    inputSchema: {
      tool_name: z.string().describe('The tool the agent wants to use'),
      input: z.unknown().optional().describe('The tool input the agent proposed'),
      tool_use_id: z.string().optional()
    }
  },
  async (args, extra) => {
    const sessionId = process.env.AGENTYARD_SESSION_ID ?? ''
    const toolName = String(args.tool_name ?? 'unknown')
    const target = describeTarget(args.input)

    let decision: 'allow' | 'deny' = 'deny'
    let message = 'agentyard could not reach orchestratord to ask.'
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
      message = `agentyard denied by default: ${err instanceof Error ? err.message : String(err)}`
    }

    const payload =
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: args.input ?? {} }
        : { behavior: 'deny', message: message || 'Denied by agentyard policy.' }

    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
  }
)

/**
 * The worker tier's way to ask a person something, rather than guessing and being wrong expensively.
 * ⛔ This tier cannot widen its own mandate, spawn processes, run SQL, or reach outside its project.
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
    const sessionId = process.env.AGENTYARD_SESSION_ID ?? ''
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
 * ⛔ The only signal that a task succeeded. agentyard will not infer completion from a process
 * exiting, from a clean exit code, or from anything on screen.
 */
server.registerTool(
  'task_complete',
  {
    title: 'Report that the task is finished',
    description:
      'Call this when the work is done. agentyard will run the project checks and land the branch ' +
      'according to project policy. Nothing else marks a task complete.',
    inputSchema: { summary: z.string().describe('One line: what was done') }
  },
  async (args) => {
    const sessionId = process.env.AGENTYARD_SESSION_ID ?? ''
    try {
      await rpc('agent.complete', { sessionId, summary: args.summary })
      return { content: [{ type: 'text' as const, text: 'Recorded. agentyard is landing the work.' }] }
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
    const sessionId = process.env.AGENTYARD_SESSION_ID ?? ''
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
    const sessionId = process.env.AGENTYARD_SESSION_ID ?? ''
    try {
      await rpc('agent.handoff', { sessionId, note: args.note })
      return { content: [{ type: 'text' as const, text: 'Handoff recorded.' }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
    }
  }
)

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
