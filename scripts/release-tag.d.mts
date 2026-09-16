/** Typings for `release-tag.mjs`, so `src/daemon/releaseplan.test.ts` can import it typed. */
export interface VersionTag {
  /** Normalised, `v`-prefixed: `v0.2.0-rc.1`. */
  name: string
  /** Without the `v`. */
  version: string
  triple: [number, number, number]
  prerelease: string | null
}
export interface ReleasePlan {
  version: string
  commit: string
  /** The last final tag, which the notes describe the change since; null before any final. */
  since: string | null
  why: string
}
export function parseTag(name: string): VersionTag | null
export function compareVersions(a: string, b: string): number
export function bumpTriple(triple: readonly [number, number, number], kind: 'major' | 'minor' | 'patch'): [number, number, number]
export function planRelease(input: {
  tags: ReadonlyArray<{ name: string; commit: string }>
  request: 'rc' | 'promote' | string
  bump?: 'major' | 'minor' | 'patch' | null
  head: string
}): ReleasePlan
export function readTags(cwd: string): Array<{ name: string; commit: string }>
