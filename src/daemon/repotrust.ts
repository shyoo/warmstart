/**
 * Whose repository a remote is — the fact every outward-facing landing has to know first (t903).
 *
 * ⛔ **Asked of `gh`, never guessed from a name.** t902 opened a pull request on
 * `Optiscaler-Client/Optiscaler-Client` unattended, because nothing in the landing path knew that
 * repository was somebody else's. An owner login compared against the remote's owner would call an
 * organisation the operator runs "external" and a repository they were merely added to "own";
 * `viewerPermission` is the answer GitHub itself gives. Measured 2026-10-03 on this machine:
 * `READ` on `Optiscaler-Client/Optiscaler-Client`, `ADMIN` on `shyoo/Optiscaler-Client` (the fork)
 * and on `shyoo/warmstart`.
 *
 * ⚠️ Costs a network call and no tokens. Cached per slug for an hour, because a permission is not
 * something that changes between two landings; an `unknown` is not cached, so a `gh` that was
 * signed out a minute ago is asked again.
 */
import type { RepoTrust, RepoTrustReading } from '@shared/tasks.js'
import { gitHubSlug, parseGitHubRepo } from '@shared/github.js'
import { errorMessage } from '@shared/errors.js'
import { remoteUrl } from './git.js'
import { launchArgs, spawnEnv, which } from './which.js'
import * as spawn from './spawn.js'

const TTL_MS = 60 * 60 * 1000
const cache = new Map<string, RepoTrustReading>()

/** ⛔ ADMIN and MAINTAIN only — the operator's answer (t903). WRITE is a collaborator elsewhere. */
export function trustFor(permission: string | null | undefined): RepoTrust {
  const p = permission?.trim().toUpperCase()
  if (!p) return 'unknown'
  return p === 'ADMIN' || p === 'MAINTAIN' ? 'own' : 'external'
}

/** Whose is `owner/repo`? Never throws: a failure is `unknown`, with the reason. */
export async function repoTrust(slug: string): Promise<RepoTrustReading> {
  const key = slug.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.readAt < TTL_MS) return hit
  const gh = which('gh')
  if (!gh) {
    return { slug, trust: 'unknown', permission: null, readAt: Date.now(), reason: 'the GitHub CLI (gh) is not installed' }
  }
  try {
    const call = launchArgs(gh, ['repo', 'view', slug, '--json', 'viewerPermission', '--jq', '.viewerPermission'])
    const { stdout } = await spawn.run(call.command, call.args, { env: spawnEnv(), timeout: 30_000 })
    const permission = stdout.trim() || null
    const reading: RepoTrustReading = { slug, trust: trustFor(permission), permission, readAt: Date.now() }
    if (reading.trust !== 'unknown') cache.set(key, reading)
    else reading.reason = 'gh reported no permission'
    return reading
  } catch (err) {
    return { slug, trust: 'unknown', permission: null, readAt: Date.now(), reason: errorMessage(err) }
  }
}

/** Whose repository is this remote? A remote that is missing or not on github.com is `unknown`. */
export async function remoteTrust(cwd: string, remote: string): Promise<RepoTrustReading> {
  const url = await remoteUrl(cwd, remote)
  const parsed = url ? parseGitHubRepo(url) : null
  if (!parsed) {
    return {
      slug: null,
      trust: 'unknown',
      permission: null,
      readAt: Date.now(),
      reason: url ? `\`${remote}\` is not on github.com (${url})` : `there is no \`${remote}\` remote`
    }
  }
  return repoTrust(gitHubSlug(parsed))
}

/** The sentence a refusal gives: whose it is, and how that was known. */
export function describeTrust(reading: RepoTrustReading): string {
  const name = reading.slug ?? 'that repository'
  if (reading.trust === 'unknown') {
    return `Warmstart could not tell whose ${name} is (${reading.reason ?? 'no answer'}), so it is treated as somebody else's`
  }
  return reading.trust === 'own'
    ? `${name} is yours (${reading.permission})`
    : `${name} is maintained by somebody else — your permission there is ${reading.permission}`
}

/** For the tests, which run against one fake `gh` after another. */
export function clearRepoTrustCache(): void {
  cache.clear()
}
