import type {
  AdapterDetection,
  AdapterInfo,
  QuotaSnapshot,
  SessionTransport,
  WorkerIdentity
} from '@shared/protocol.js'

export interface SpawnRequest {
  sessionId: string
  isolationRoot: string
  cwd: string
  transport: SessionTransport
  model?: string | undefined
  /** Path to the MCP config giving this session agentyard's own tools. */
  mcpConfig?: string | null | undefined
  /** A one-shot flow (login, doctor) supplies its own argv and ignores session options. */
  argv?: string[] | undefined
}

export interface SpawnPlan {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface IdentityProbe extends WorkerIdentity {
  loggedIn: boolean | null
}

/**
 * One agent CLI.
 *
 * ⛔ The scheduler asks `info.capabilities` and `info.policy`. It never asks which adapter this is.
 * Antigravity lacking `/compact`, or lacking a classifier-backed auto mode, has to express itself
 * as a missing capability - not as a branch in scheduling code.
 */
export interface AgentAdapter {
  readonly info: AdapterInfo

  /** Is this CLI installed, and at what version? Cheap, run at commissioning and by Doctor. */
  detect(): Promise<AdapterDetection>

  /** Who is logged in to this isolation root? Must not spend a turn. */
  probeIdentity(isolationRoot: string): Promise<IdentityProbe>

  /**
   * How much of this account's window is left.
   *
   * ⚠️ Best-effort by contract. Every adapter must return a snapshot rather than throw, must set
   * `source`, and must never present a stale reading as current - see quota/poller.ts for why that
   * matters more than it sounds.
   */
  probeQuota(isolationRoot: string): Promise<Omit<QuotaSnapshot, 'workerId'>>

  /** Argv for the vendor's own login flow, run in a PTY the user types into. */
  loginArgv(): string[]

  plan(req: SpawnRequest): SpawnPlan

  /** Where this session's transcript will appear, so the tailer can watch before the file exists. */
  transcriptPath(isolationRoot: string, cwd: string, sessionId: string): string
}
