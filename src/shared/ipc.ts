/**
 * The contract between the renderer and the Electron main process.
 *
 * Deliberately thin. Main is a window host, not the orchestrator: from M1 the renderer talks to
 * `orchestratord` over its own localhost WS/HTTP channel, because the daemon outlives this window
 * (see transient_docs/implementation_plan_2026-08-24.md §6.1). Anything that must survive the UI
 * closing does NOT belong here.
 */

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
  /** Where orchestratord publishes its port + token. Null until M1 lands the daemon. */
  daemonEndpoint: string | null
}

export interface AgentyardApi {
  getAppInfo(): Promise<AppInfo>
}

declare global {
  interface Window {
    agentyard: AgentyardApi
  }
}
