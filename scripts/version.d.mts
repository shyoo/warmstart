/** Typings for `version.mjs`, so the build configs and the L1 checks can import it typed. */
export const PLACEHOLDER_VERSION: string
export function isSemver(value: unknown): boolean
export function versionFromDescribe(description: string): string | null
export function resolveVersion(options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string
