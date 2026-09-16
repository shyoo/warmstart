// Cut a release: decide the version, check the base, tag, push. No commit is ever made.
//
// The version is the tag (`scripts/version.mjs`), the notes are the tag's message, and
// `.github/workflows/release.yml` builds and publishes whatever a `v*` tag names. So a release
// candidate is one annotated tag on a commit `origin/main` already has and CI has already passed,
// and promoting it is a second tag - the final version - on the same commit. Nothing here writes to
// a tracked file, so there is nothing to push through CI first.
//
//   node scripts/release-tag.mjs plan rc [--bump minor|patch|major]   # what the next rc would be
//   node scripts/release-tag.mjs plan promote                         # the rc a final would name
//   node scripts/release-tag.mjs plan 0.3.0-rc.1                      # a version chosen by hand
//   node scripts/release-tag.mjs cut <version> --notes <file> [--commit <sha>] [--wait] [--dry-run]
//
// `plan` prints the version, the commit it would tag and the tag notes should be written since;
// `cut` runs every gate, tags and pushes. Both refuse loudly; neither ever tags on a refusal.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judge, measure } from './check-release-base.mjs'

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/
const REPOSITORY = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).releaseRepository

/** `v0.2.0-rc.1` → `{ name, version, triple, prerelease }`; anything that is not a version tag → null. */
export function parseTag(name) {
  const found = TAG.exec(name.trim())
  if (!found) return null
  const triple = [Number(found[1]), Number(found[2]), Number(found[3])]
  return { name: `v${found[1]}.${found[2]}.${found[3]}${found[4] ? `-${found[4]}` : ''}`, version: name.trim().slice(1), triple, prerelease: found[4] ?? null }
}

const compareTriples = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Semver order: `0.1.0-rc.1 < 0.1.0-rc.2 < 0.1.0 < 0.2.0-rc.1`. */
export function compareVersions(a, b) {
  const left = parseTag(`v${a}`)
  const right = parseTag(`v${b}`)
  if (!left || !right) throw new Error(`not a version: ${!left ? a : b}`)
  const byTriple = compareTriples(left.triple, right.triple)
  if (byTriple !== 0) return byTriple
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  const l = left.prerelease.split('.')
  const r = right.prerelease.split('.')
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined) return -1
    if (r[i] === undefined) return 1
    const numeric = /^\d+$/.test(l[i]) && /^\d+$/.test(r[i])
    const c = numeric ? Number(l[i]) - Number(r[i]) : l[i].localeCompare(r[i])
    if (c !== 0) return c
  }
  return 0
}

export function bumpTriple([major, minor, patch], kind) {
  if (kind === 'major') return [major + 1, 0, 0]
  if (kind === 'minor') return [major, minor + 1, 0]
  if (kind === 'patch') return [major, minor, patch + 1]
  throw new Error(`unknown bump: ${kind}`)
}

const rcNumber = (tag) => {
  const found = /^rc\.(\d+)$/.exec(tag.prerelease ?? '')
  return found ? Number(found[1]) : null
}

/**
 * Which version the next tag names, and on which commit.
 *
 * `tags` is every `v*` tag with the commit it points at. `rc` continues the open rc series when one
 * is above the last final (`v0.1.0` final, `v0.2.0-rc.1` open → `0.2.0-rc.2`), or starts one by
 * bumping the last final (minor unless told otherwise). `promote` names the highest open rc's bare
 * triple on the rc's own commit - the bytes a person verified are the bytes that ship. A literal
 * version must be above every tag that exists, so `/releases/latest` can never go backwards.
 */
export function planRelease({ tags, request, bump = null, head }) {
  const known = tags.map((tag) => ({ ...parseTag(tag.name), commit: tag.commit })).filter((tag) => tag.name)
  known.sort((a, b) => compareVersions(a.version, b.version))
  const finals = known.filter((tag) => tag.prerelease === null)
  const lastFinal = finals.at(-1) ?? null
  const baseTriple = lastFinal?.triple ?? [0, 0, 0]
  const openRcs = known.filter((tag) => rcNumber(tag) !== null && compareTriples(tag.triple, baseTriple) > 0)
  const since = lastFinal?.name ?? null

  if (request === 'rc') {
    let triple
    if (bump) triple = bumpTriple(baseTriple, bump)
    else if (openRcs.length > 0) triple = openRcs.at(-1).triple
    else triple = bumpTriple(baseTriple, 'minor')
    const inSeries = openRcs.filter((tag) => compareTriples(tag.triple, triple) === 0)
    const next = inSeries.length === 0 ? 1 : Math.max(...inSeries.map(rcNumber)) + 1
    const version = `${triple.join('.')}-rc.${next}`
    return { version, commit: head, since, why: inSeries.length === 0 ? `starts the ${triple.join('.')} series` : `continues ${inSeries.at(-1).name}` }
  }
  if (request === 'promote') {
    const rc = openRcs.at(-1)
    if (!rc) throw new Error(`nothing to promote: no rc tag above ${lastFinal?.name ?? 'any final'}. Cut one with \`plan rc\` first.`)
    const version = rc.triple.join('.')
    return { version, commit: rc.commit, since, why: `promotes ${rc.name}, on its own commit` }
  }
  const literal = parseTag(`v${request}`)
  if (!literal) throw new Error(`not a version: ${JSON.stringify(request)} (want rc, promote, or 1.2.3[-rc.N])`)
  const top = known.at(-1)
  if (top && compareVersions(literal.version, top.version) <= 0) {
    throw new Error(`${literal.name} is not above the highest existing tag ${top.name}; a release never goes backwards.`)
  }
  return { version: literal.version, commit: head, since, why: 'chosen by hand' }
}

// ---------------------------------------------------------------- git and gh, read here only

const git = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function readTags(cwd) {
  const out = git(cwd, 'for-each-ref', 'refs/tags/v*', '--format=%(refname:short) %(*objectname)%(objectname)')
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      // `%(*objectname)` is the commit an annotated tag points at and empty for a lightweight one,
      // so the concatenation is exactly one sha in either case - the first 40 characters.
      const [name, shas] = line.split(' ')
      return { name, commit: shas.slice(0, 40) }
    })
}

function ciStatus(sha) {
  const out = execFileSync(
    'gh',
    ['api', `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=10`, '--jq', '[.workflow_runs[] | {id, event, status, conclusion}]'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const runs = JSON.parse(out).filter((run) => run.event === 'push')
  return runs[0] ?? null
}

function waitForCi(run) {
  const result = spawnSync('gh', ['run', 'watch', String(run.id), '--exit-status'], { stdio: 'inherit' })
  return result.status === 0
}

function usage(message) {
  console.error(`⛔ ${message}`)
  console.error('usage: release-tag.mjs plan <rc|promote|version> [--bump kind] | cut <version> --notes <file> [--commit sha] [--wait] [--dry-run]')
  process.exit(1)
}

function main(argv) {
  const [command, subject, ...rest] = argv
  const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null)
  const flag = (name) => rest.includes(name)
  const cwd = process.cwd()

  if (command === 'plan') {
    if (!subject) usage('plan needs rc, promote or a version')
    git(cwd, 'fetch', '--quiet', '--tags', 'origin')
    let plan
    try {
      plan = planRelease({ tags: readTags(cwd), request: subject, bump: option('--bump'), head: git(cwd, 'rev-parse', 'origin/main') })
    } catch (err) {
      console.error(`⛔ ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
    console.log(`version ${plan.version}`)
    console.log(`commit ${plan.commit}`)
    console.log(`since ${plan.since ?? '(no final release yet)'}`)
    console.log(`why ${plan.why}`)
    console.log(plan.version.includes('-') ? 'publishes as a pre-release: invisible to installed apps' : 'publishes as latest: every installed app is offered it')
    return
  }

  if (command !== 'cut') usage(`unknown command ${JSON.stringify(command ?? '')}`)
  const tag = parseTag(`v${subject ?? ''}`)
  if (!tag) usage(`cut needs a version, got ${JSON.stringify(subject ?? '')}`)
  const notesPath = option('--notes')
  if (!notesPath) usage('cut needs --notes <file>')
  const body = readFileSync(notesPath, 'utf8').replace(/\r\n/g, '\n').trim()
  if (!body) usage(`${notesPath} is empty: a release carries notes`)
  if (/^#\s/m.test(body)) usage(`${notesPath} has a top-level # heading; the release title is "Warmstart ${tag.name}" already`)
  const dryRun = flag('--dry-run')

  // 1. The base. Same gate `/release` always had: nothing the trunk knows that origin does not.
  const facts = measure(cwd)
  const problems = judge(facts)
  git(cwd, 'fetch', '--quiet', '--tags', 'origin')
  const commit = git(cwd, 'rev-parse', option('--commit') ?? 'origin/main')
  // 2. The commit must be on origin/main - what is tagged is what was pushed and checked.
  if (spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd }).status !== 0) {
    problems.push(`${commit.slice(0, 7)} is not on origin/main; a release is cut from what origin has.`)
  }
  // 3. The tag must be new, here and there.
  if (readTags(cwd).some((known) => known.name === tag.name)) problems.push(`${tag.name} already exists locally.`)
  if (git(cwd, 'ls-remote', '--tags', 'origin', `refs/tags/${tag.name}`)) problems.push(`${tag.name} already exists on origin.`)
  // 4. A plan must agree: the version never goes backwards.
  try {
    planRelease({ tags: readTags(cwd), request: tag.version, head: commit })
  } catch (err) {
    problems.push(String(err instanceof Error ? err.message : err))
  }
  // 5. CI must have passed on that commit. Release builds run no tests (release.yml), so this is
  //    the only place the tagged bytes are known to be green.
  const run = ciStatus(commit)
  if (!run) problems.push(`no CI run found for ${commit.slice(0, 7)} on ${REPOSITORY}; was it pushed to main?`)
  else if (run.status !== 'completed') {
    if (flag('--wait')) {
      console.log(`CI run ${run.id} is ${run.status}; waiting…`)
      if (!waitForCi(run)) problems.push(`CI run ${run.id} did not succeed.`)
    } else problems.push(`CI run ${run.id} is still ${run.status}: pass --wait, or \`gh run watch ${run.id}\` and cut again.`)
  } else if (run.conclusion !== 'success') problems.push(`CI run ${run.id} concluded ${run.conclusion} on ${commit.slice(0, 7)}.`)

  if (problems.length > 0) {
    for (const problem of problems) console.error(`⛔ ${problem}`)
    console.error(`Refusing to tag ${tag.name}.`)
    process.exit(1)
  }

  const message = `Warmstart ${tag.name}\n\n${body}\n`
  if (dryRun) {
    console.log(`would tag ${tag.name} on ${commit} and push it, with this message:\n\n${message}`)
    return
  }
  const scratch = mkdtempSync(join(tmpdir(), 'warmstart-tag-'))
  try {
    const file = join(scratch, 'message.md')
    writeFileSync(file, message)
    // ⛔ `--cleanup=verbatim`: git would otherwise strip the `#` lines markdown headings are made of.
    git(cwd, 'tag', '--annotate', '--cleanup=verbatim', '--file', file, tag.name, commit)
    git(cwd, 'push', 'origin', `refs/tags/${tag.name}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`tagged ${tag.name} on ${commit.slice(0, 7)} and pushed it.`)
  console.log(`The Release workflow is building it: gh run list --workflow release.yml --limit 1`)
  console.log(`It publishes to https://github.com/${REPOSITORY}/releases/tag/${tag.name}${tag.prerelease ? ' as a pre-release' : ' as latest'}.`)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (invokedDirectly) main(process.argv.slice(2))
