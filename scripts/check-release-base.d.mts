/** Typings for the release-base gate, so `src/daemon/releasebase.test.ts` can import it typed. */
export interface ReleaseBaseFacts {
  /** The trunk checkout the common `.git` directory belongs to. */
  trunk: string
  /** The branch checked out there; `main` by convention. */
  trunkBranch: string
  trunkAhead: number
  trunkBehind: number
  /** Commits on `origin/<target>` that HEAD does not contain. */
  headBehind: number
  /** Tracked files changed but uncommitted in the trunk. */
  trunkDirty: string[]
}
export function measure(repo: string, options?: { target?: string; fetch?: boolean }): ReleaseBaseFacts
export function judge(facts: ReleaseBaseFacts, target?: string): string[]
