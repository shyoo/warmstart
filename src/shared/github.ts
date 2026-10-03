/**
 * Reading a GitHub repository out of what a person types or what `git remote get-url` says.
 *
 * ⚠️ Shared because both halves need the same answer: the add wizard names the directory a clone
 * would land in from the repository name, and the daemon turns a remote URL into the `owner/repo`
 * that `gh pr create --repo` and `--head <owner>:<branch>` are spelled with. Two parsers would be two
 * opinions about whether `git@github.com:a/b.git` is `a/b`.
 *
 * ⛔ github.com only. A GitHub Enterprise host is a different `gh` login and a different API, and a
 * parser that accepted any host would hand `gh` a repository it is not signed in to.
 */

export interface GitHubRepo {
  owner: string
  repo: string
}

const NAME = /^[A-Za-z0-9_.-]+$/

/**
 * `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git` or
 * `ssh://git@github.com/owner/repo.git` — or null for anything else, including a local path.
 */
export function parseGitHubRepo(input: string): GitHubRepo | null {
  const text = input.trim()
  if (!text) return null
  let path: string | null = null
  const scp = /^git@github\.com:(.+)$/i.exec(text)
  if (scp?.[1]) {
    path = scp[1]
  } else if (/^(https?|ssh|git):\/\//i.test(text)) {
    try {
      const url = new URL(text)
      if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') return null
      path = url.pathname
    } catch {
      return null
    }
  } else if (/^[^/\\:]+\/[^/\\:]+$/.test(text)) {
    // ⚠️ Bare `owner/repo` only — no colon, no backslash, exactly one slash — so `C:\Dev\x` and
    // `./a/b` are never mistaken for a repository on GitHub.
    path = text
  }
  if (!path) return null
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts as [string, string]
  if (!NAME.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') return null
  return { owner, repo }
}

export function gitHubSlug(repo: GitHubRepo): string {
  return `${repo.owner}/${repo.repo}`
}

/**
 * What to hand `git clone`: a GitHub repository by its https URL, anything else verbatim.
 *
 * ⚠️ Verbatim for the rest because a clone source is not only GitHub — a bare repository on a share
 * or another host clones the same way. Only forking needs GitHub, and that is refused separately.
 */
export function cloneSourceFor(input: string): string {
  const parsed = parseGitHubRepo(input)
  return parsed ? `https://github.com/${gitHubSlug(parsed)}.git` : input.trim()
}

/** The directory name a clone of this source gets, the way `git clone` would choose it. */
export function cloneDirectoryName(input: string): string | null {
  const parsed = parseGitHubRepo(input)
  if (parsed) return parsed.repo
  const last = input.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? ''
  const name = last.replace(/\.git$/i, '')
  return name && NAME.test(name) ? name : null
}
