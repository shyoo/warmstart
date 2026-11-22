export interface StaleDependency {
  name: string
  expected: string | null
  installed: string | null
}

export interface EnsureDepsResult {
  ok: boolean
  installed: boolean
  stale: StaleDependency[]
  reason?: string
}

export type EnsureDepsRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean }
) => { status: number; error?: Error }

export function findStaleDependencies(repoDir?: string): StaleDependency[]
export function formatStaleDependencies(stale: StaleDependency[]): string
export function ensureDeps(opts?: {
  repoDir?: string
  checkOnly?: boolean
  env?: NodeJS.ProcessEnv
  run?: EnsureDepsRunner
  log?: (...args: unknown[]) => void
  errorLog?: (...args: unknown[]) => void
}): EnsureDepsResult
