// Is this checkout a safe base to cut a release from?
//
// ⛔ The trap this exists for, measured 2026-09-15: `v0.1.0-rc.1` was tagged on `origin/main` while
// the trunk's `main` sat 25 commits ahead of it, unpushed, two of them schema migrations. The
// operator's daily-driver app had been built from that trunk and had migrated the live database
// to v73; the release understood v71, so its daemon refused the operator's own data on the very
// first install. A release is cut from `origin/main`; anything the trunk knows that origin does not
// is a release that will refuse the machine it was built on.
//
// The facts are read out of git, from a worktree or the trunk alike, because branch refs are
// shared through the common directory. Any problem is printed and exits 1; `/release` runs this
// before it changes anything.
//
//   node scripts/check-release-base.mjs [--repo <path>] [--target <branch>] [--no-fetch]

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'

const run = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * What git says about the trunk and this checkout, relative to `origin/<target>`.
 *
 * `trunkAhead` is the number that was 25. `headBehind` is the other way to tag the wrong base:
 * bumping the version on a branch origin has already moved past. `trunkDirty` names tracked files
 * changed but uncommitted in the trunk — what the trunk runs but nothing can ship.
 */
export function measure(repo, { target = 'main', fetch = true } = {}) {
  if (fetch) run(repo, 'fetch', '--quiet', 'origin', target)
  const trunk = dirname(run(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  // The trunk's checked-out branch by name; `main` is the convention, the ref is what counts.
  let trunkBranch = target
  try {
    trunkBranch = run(trunk, 'rev-parse', '--abbrev-ref', 'HEAD')
  } catch {
    // A bare or detached trunk: judge the target branch ref instead.
  }
  const counts = (range) => run(repo, 'rev-list', '--left-right', '--count', range).split(/\s+/).map(Number)
  const [trunkBehind, trunkAhead] = counts(`origin/${target}...${trunkBranch}`)
  const [headBehind] = counts(`origin/${target}...HEAD`)
  let trunkDirty = []
  try {
    // ⛔ Not through `run`: porcelain's leading space is data (` M file`), and a trim eats it.
    trunkDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: trunk,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3))
  } catch {
    // No working tree there: nothing can be dirty.
  }
  return { trunk, trunkBranch, trunkAhead, trunkBehind, headBehind, trunkDirty }
}

/** The problems that refuse a release, as sentences; an empty list is a safe base. */
export function judge({ trunkAhead, headBehind, trunkDirty, trunkBranch }, target = 'main') {
  const problems = []
  if (trunkAhead > 0) {
    problems.push(
      `the trunk's ${trunkBranch} is ${trunkAhead} commit(s) ahead of origin/${target}: a release cut now would not ` +
        `contain them, and the app built from the trunk may already have migrated the operator's database past what ` +
        `the release understands. Push the trunk first (/push there), then cut.`
    )
  }
  if (headBehind > 0) {
    problems.push(
      `this branch is ${headBehind} commit(s) behind origin/${target}: rebase onto it before bumping the version, ` +
        `or the release is tagged on a base origin has already moved past.`
    )
  }
  if (trunkDirty.length > 0) {
    const named = trunkDirty.slice(0, 3).join(', ') + (trunkDirty.length > 3 ? ', …' : '')
    problems.push(
      `the trunk has ${trunkDirty.length} uncommitted change(s) (${named}): commit or discard them so what ships ` +
        `is what the trunk runs.`
    )
  }
  return problems
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const target = option('--target', 'main')
  const facts = measure(option('--repo', process.cwd()), { target, fetch: !args.includes('--no-fetch') })
  const problems = judge(facts, target)
  if (problems.length === 0) {
    if (facts.trunkBehind > 0) {
      console.log(`note: the trunk's ${facts.trunkBranch} is ${facts.trunkBehind} commit(s) behind origin/${target}; pull it before building locally.`)
    }
    console.log(`release base ok: the trunk (${facts.trunk}) has nothing origin/${target} lacks, and HEAD contains origin/${target}.`)
  } else {
    for (const problem of problems) console.error(`⛔ ${problem}`)
    console.error('Refusing to prepare a release from this base.')
    process.exit(1)
  }
}
