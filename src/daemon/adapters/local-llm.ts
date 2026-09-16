import http from 'node:http'
import https from 'node:https'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot } from '@shared/protocol.js'
import type { AgentAdapter, IdentityProbe, SpawnPlan, SpawnRequest } from './types.js'
import { asRecord, num, type StreamEvent } from '../stream.js'
import { spawnEnv } from '../which.js'
import { errorMessage } from '@shared/errors.js'
import { localModelId } from '@shared/localmodel.js'

/**
 * Local LLM adapter — any OpenAI-compatible server, designed for llama.cpp + Qwen3-Coder.
 *
 * Unlike every other adapter, there is no agent CLI to wrap. Instead, a thin bridge script
 * (`local-llm-bridge.ts`, compiled to JS) is spawned as the "process". It reads prompts from
 * stdin, calls the local HTTP endpoint, and writes NDJSON stream records to stdout — fitting the
 * existing `SpawnPlan` contract perfectly.
 *
 * Key differences from cloud adapters:
 *  - No quota, no subscription, no credential directory
 *  - No compaction, no resume, no MCP
 *  - The "isolation root" is the endpoint URL, not a filesystem path
 *  - `isInstalled()` checks a cached reachability flag, not PATH
 *  - `detect()` pings `/v1/models` over HTTP
 *
 * ⛔ Conservative on every capability. This adapter has never been run, so every claim is
 * `documented` rather than `measured`, and every absent capability is declared as absent.
 */

const info: AdapterInfo = {
  id: 'local-llm',
  label: 'Local LLM',
  // ⛔ Not a command to look up on PATH. The bridge is started by Node.js and the endpoint is
  // checked via HTTP. This field is read by `which()` in the generic adapter but we override
  // `isInstalled()` and `detect()`, so it is only used for display purposes.
  command: 'local-llm-bridge',
  // No credential directory. Each worker is identified by its endpoint URL, stored as isolationRoot.
  isolationEnvVar: null,
  capabilities: {
    // ⛔ Stream only — there is no TUI to show in a PTY.
    transports: ['stream'],
    // Local inference has no bash or fs write tools. Declares read-only for quality review.
    permissionModes: ['default', 'read-only'],
    readOnlyPermissionMode: 'read-only',
    classifierBackedAuto: false,
    approvalChannel: 'none',
    manualCompact: false,
    // Each dispatch is a fresh conversation. No session state to resume.
    resumeSession: false,
    forkSession: false,
    nativeWorktree: false,
    // Text only through the API. Multimodal would require vision model + base64 encoding.
    imageInput: 'none',
    // ⛔ Tools are handled by the bridge script's OpenAI function-calling integration, not by MCP.
    // The bridge registers `task_complete` and `ask_human` as OpenAI-format tool definitions and
    // translates the calls to stream events. The daemon handles them from there.
    mcp: false,
    selectableEffort: false,
    // Local — no quota to probe. The worker is always eligible from a quota perspective.
    quotaProbe: 'none',
    // Nothing to bill: the model runs on the operator's own machine. ⛔ Which is a reason for
    // `none`, not for zero — a run here is `unpriced`, and that is a different statement.
    spendProbe: 'none',
    // ⭐ The bridge keeps stdin open and reads NDJSON prompts line by line, so follow-up messages
    // (wrap-up nudges, finish instructions) can be sent mid-conversation.
    streamPrompts: 'conversation',
    // The bridge flushes its SSE buffer on a newline, a sentence end or 60 characters, so an event
    // is a rung of one reply rather than the reply.
    outputFraming: 'delta',
    // The bridge already emits ~60-character rungs; there is no coarser mode to opt out of.
    streamsPartialOutput: false,
    mintsSessionId: false,
    // Usage comes from the OpenAI-format response's `usage` field in the final SSE chunk.
    // llama.cpp reports `prompt_tokens` and `completion_tokens` there.
    metering: 'stream',
    // Unlimited: each worker points at a different endpoint URL (or the same one — the operator's
    // choice). There is no credential to share and no account to conflict.
    maxAccounts: null
  },
  policy: {
    defaultPermissionMode: 'default',
    // ⚠️ Conservative because it is unverified: nothing here has been shown to enforce a
    // boundary, and the cheap direction for this question is to assume there is none.
    headlessAuthority: 'full-user',
    interruptSequence: '\x1b',
    costModelId: 'local.llm.2026-09',
    // No compaction, so preemption falls back to the handoff protocol.
    wrapUpProtocol: 'handoff',
    // The model has a context window and needs to know its budget.
    needsExplicitBudget: true
  },
  usageRefresh: null,
  firstRun: null,
  // No CLI login. Start the server and commission it.
  login: {
    kind: 'external',
    reason:
      'Local LLM has no login. Start your llama.cpp server (or any OpenAI-compatible server) ' +
      'and commission it here with the endpoint URL.'
  },
  verification: {
    level: 'measured',
    asOf: '2026-09-04',
    note:
      'Written for llama.cpp serving Qwen3-Coder-30B-A3B on Windows. Local inference has no write ' +
      'tools (no bash, no filesystem access) and runs in stream mode, declaring read-only permission mode for quality review.'
  }
}

// ---------------------------------------------------------------------------- HTTP probe

/** One GET, five seconds, the body as text. `status` is 0 when no response came at all. */
function getText(endpoint: string, path: string): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    let resolved = false
    const done = (result: { status: number; body: string; error?: string }) => {
      if (resolved) return
      resolved = true
      resolve(result)
    }
    try {
      const url = new URL(path, endpoint)
      const transport = url.protocol === 'https:' ? https : http
      const req = transport.get(url, { timeout: 5_000 }, (res) => {
        let body = ''
        res.on('data', (d: Buffer) => { body += d.toString() })
        res.on('end', () => done({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', (err) => done({ status: 0, body: '', error: err.message }))
      req.on('timeout', () => {
        req.destroy()
        done({ status: 0, body: '', error: 'timeout (5s)' })
      })
    } catch (err) {
      done({ status: 0, body: '', error: errorMessage(err) })
    }
  })
}

/**
 * What the server serves. `/v1/models` is the OpenAI-shaped list every compatible server answers;
 * the ids are **the server's own** — llama.cpp reports the gguf path it was started with unless
 * given `--alias` — and are kept verbatim behind the `local-llm:` prefix (`@shared/localmodel`).
 */
export async function probeEndpoint(
  endpoint: string
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const res = await getText(endpoint, '/v1/models')
  if (res.status !== 200) return { ok: false, models: [], error: res.error ?? `HTTP ${res.status}` }
  try {
    const parsed = JSON.parse(res.body) as { data?: Array<{ id?: string }> }
    const models = (parsed.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    return { ok: true, models }
  } catch {
    return { ok: true, models: [] }
  }
}

/**
 * The context window the server was started with, or null where it does not say.
 *
 * ⚠️ llama.cpp only: `/props` carries `default_generation_settings.n_ctx`, which is the slot's
 * window (`-c` divided by `--parallel`). Other OpenAI-compatible servers 404 here and get null,
 * which the cost model's `dynamic_models.context_window` then stands in for. A number here is a
 * measurement; the fallback is a guess, and the two are kept apart on purpose.
 */
export async function probeContextWindow(endpoint: string): Promise<number | null> {
  const res = await getText(endpoint, '/props')
  if (res.status !== 200) return null
  try {
    const parsed = JSON.parse(res.body) as { default_generation_settings?: { n_ctx?: unknown } }
    const n = parsed.default_generation_settings?.n_ctx
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------- bridge path
// The bridge script is compiled alongside the adapter and lives in the same output directory.

function bridgePath(): string {
  // In the compiled output, this file is at `.../adapters/local-llm.js` and the bridge is at
  // `.../adapters/local-llm-bridge.js`. In dev/test it is `.ts`.
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const js = join(thisDir, 'local-llm-bridge.js')
  if (existsSync(js)) return js
  const ts = join(thisDir, 'local-llm-bridge.ts')
  if (existsSync(ts)) return ts
  return js
}

// ---------------------------------------------------------------------------- stream decoder
/**
 * Local LLM bridge stream dialect.
 *
 * The bridge writes NDJSON records to stdout with a `type` key:
 *
 * ```
 * {"type":"init","model":"local-llm:Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf","session_id":null}
 * {"type":"assistant_text","text":"Hello"}
 * {"type":"tool_call","name":"task_complete","arguments":"{\"summary\":\"Done\"}"}
 * {"type":"tool_result","tool":"task_complete","summary":"Done"}
 * {"type":"usage","usage":{...},"final":true}
 * {"type":"result","text":"Done","status":"SUCCESS"}
 * ```
 */
function decodeStream(record: Record<string, unknown>): StreamEvent | null {
  if (!record || typeof record !== 'object') return null
  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'init') {
    return {
      kind: 'init',
      sessionId: typeof record.session_id === 'string' ? record.session_id : null,
      model: typeof record.model === 'string' ? record.model : null,
      permissionMode: null
    }
  }

  if (type === 'assistant_text') {
    const text = typeof record.text === 'string' ? record.text : ''
    if (!text) return null
    return { kind: 'assistant_text', text }
  }

  if (type === 'usage') {
    const usage = asRecord(record.usage)
    if (!usage) return null
    return {
      kind: 'usage',
      usage: {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        thinking: num(usage.thinking_tokens),
        cacheRead: num(usage.cache_read_tokens),
        cacheWrite: num(usage.cache_write_tokens)
      },
      final: record.final === true
    }
  }

  if (type === 'result') {
    const text = typeof record.text === 'string' ? record.text : null
    const status = typeof record.status === 'string' ? record.status : 'UNKNOWN'
    return {
      kind: 'result',
      text,
      costUsd: null,
      isError: status !== 'SUCCESS',
      terminalReason: status
    }
  }

  // tool_result with task_complete means the task is done — emit a result event
  if (type === 'tool_result' && record.tool === 'task_complete') {
    const summary = typeof record.summary === 'string' ? record.summary : ''
    return {
      kind: 'result',
      text: summary,
      costUsd: null,
      isError: false,
      terminalReason: 'task_complete'
    }
  }

  // tool_result with ask_human pauses the run and files a question for the operator
  if (type === 'tool_result' && record.tool === 'ask_human') {
    const question = typeof record.question === 'string' ? record.question : ''
    return {
      kind: 'turn_status',
      category: 'blocked',
      detail: question,
      needsAction: question
    }
  }

  return type ? { kind: 'other', type } : null
}

// ---------------------------------------------------------------------------- adapter

export const localLlm: AgentAdapter = {
  info,
  decodeStream,

  // The bridge reads the same NDJSON envelope Antigravity uses.
  encodeStreamPrompt: (text: string) =>
    JSON.stringify({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }),

  /**
   * ⛔ Checks a cached reachability flag. Updated by `detect()` which is called at commissioning
   * and by Doctor. On the first tick after startup, this returns `false` until `detect()` runs —
   * which is the conservative direction: a worker that nobody has checked is not dispatched to.
   */
  isInstalled(): boolean {
    return existsSync(bridgePath())
  },

  async detect(): Promise<AdapterDetection> {
    // Check that the bridge script exists
    const bridge = bridgePath()
    if (!existsSync(bridge)) {
      return {
        adapterId: info.id,
        found: false,
        path: null,
        version: null,
        error: `bridge script not found at ${bridge}`
      }
    }

    return {
      adapterId: info.id,
      found: true,
      path: bridge,
      version: '1.0.0'
    }
  },

  /**
   * ⛔ Identity is the endpoint URL itself. There is no account, no credential, no subscription.
   * A worker of this adapter is identified by where its server is.
   *
   * ⚠️ `isolationRoot` here is actually the endpoint URL, which is an overloading of the field.
   * This probe pings the endpoint to verify reachability and updates the cache.
   *
   * ⭐ It is also where the worker learns **which models it has**: `servedModels` is the picker a
   * local worker offers, because no cost model can list what an operator loaded. Re-read at every
   * identity refresh, so swapping the gguf behind an endpoint shows up on the next probe.
   */
  async probeIdentity(isolationRoot: string): Promise<IdentityProbe> {
    const endpoint = isolationRoot
    const probe = await probeEndpoint(endpoint)

    if (!probe.ok) {
      return {
        loggedIn: false,
        organization: probe.error ?? 'could not connect',
        raw: JSON.stringify({
          loggedIn: false,
          reason: `local LLM server not reachable at ${endpoint}: ${probe.error ?? 'unknown'}`,
          source: 'http-probe'
        })
      }
    }

    const contextWindow = await probeContextWindow(endpoint)
    return {
      loggedIn: true,
      cliVersion: '1.0.0',
      account: 'local',
      organization: probe.models.length > 0 ? `models: ${probe.models.join(', ')}` : 'connected',
      servedModels: probe.models.map(localModelId),
      contextWindow,
      raw: JSON.stringify({
        loggedIn: true,
        endpoint,
        models: probe.models,
        contextWindow,
        source: 'http-probe'
      })
    }
  },

  /**
   * Local — no quota. The worker is always eligible from a quota perspective.
   *
   * ⚠️ Returns `source: 'unknown'` with an explanatory error, not `source: 'cli'`, because there
   * is genuinely nothing to probe. The staleness ladder treats this correctly — it never asks for
   * a refresh and the UI shows "not reported".
   */
  async probeQuota(isolationRoot?: string): Promise<Omit<QuotaSnapshot, 'workerId'>> {
    let error: string | undefined = undefined
    if (isolationRoot) {
      const probe = await probeEndpoint(isolationRoot)
      if (!probe.ok) {
        error = probe.error ?? 'could not connect'
      }
    }
    return {
      windows: [],
      sampledAt: Date.now(),
      source: error ? 'unknown' : 'cli',
      error
    }
  },

  plan(req: SpawnRequest): SpawnPlan {
    const bridge = bridgePath()

    if (!existsSync(bridge)) {
      throw new Error(
        `local-llm bridge script not found at ${bridge}. This is a packaging error.`
      )
    }

    const env = spawnEnv()
    // ELECTRON_RUN_AS_NODE turns the Electron binary into a plain Node process that can read inside app.asar
    env.ELECTRON_RUN_AS_NODE = '1'
    // The endpoint URL is stored as the worker's isolationRoot.
    env.LOCAL_LLM_ENDPOINT = req.isolationRoot
    if (req.model) env.LOCAL_LLM_MODEL = req.model
    const mode = req.permissionMode ?? info.policy.defaultPermissionMode
    if (mode) env.LOCAL_LLM_PERMISSION_MODE = mode
    env.LOCAL_LLM_SESSION_ID = req.sessionId

    // If the caller provides custom argv (e.g. for a login/doctor session), use that.
    if (req.argv) {
      return { command: process.execPath, args: req.argv, env }
    }

    const isTs = bridge.endsWith('.ts')
    const args = isTs ? ['--experimental-strip-types', bridge] : [bridge]

    return {
      command: process.execPath,
      args,
      env
    }
  },

  transcriptPath(): string | null {
    // No transcript file. Metering comes from the stream.
    return null
  },

  discoverTranscript(): string | null {
    // No transcript file to discover. Metering is from stream.
    return null
  }
}
