import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * t903: a fork made home, and the one click that reaches the repository it was forked from.
 *
 * ⛔ **Real repositories, and nothing on a network.** Both remotes read as github.com — that is
 * where the slugs come from — and `url.<bare>.insteadOf` rewrites them to local bare repositories,
 * so every fetch and push here is real git against a disk. Only `gh` is faked, at `spawn.run`.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let setup: typeof import('./projectsetup.js')
let upstream: typeof import('./upstream.js')
let repotrust: typeof import('./repotrust.js')
let spawn: typeof import('./spawn.js')
let undoGh: () => void
let seq = 0

const UP_URL = 'https://github.com/Upstream-Org/thing.git'
const FORK_URL = 'https://github.com/me/thing.git'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** ⚠️ As configured: `git remote get-url` applies the `insteadOf` rewrite these fixtures rely on. */
function url(cwd: string, remote: string): string {
  return git(cwd, 'config', '--get', `remote.${remote}.url`)
}

function commitFile(cwd: string, name: string, content: string, message: string): string {
  writeFileSync(join(cwd, name), content)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

/**
 * An upstream with one commit, a fork of it carrying one fork-only commit, and a checkout whose
 * remotes are laid out as `layout` says.
 */
function seed(layout: 't897' | 'home'): { root: string; upBare: string; forkBare: string; base: string; forkOnly: string } {
  seq += 1
  const upBare = join(dir, `up${seq}.git`)
  const forkBare = join(dir, `fork${seq}.git`)
  const work = join(dir, `seedwork${seq}`)
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.email', 'test@example.invalid')
  git(work, 'config', 'user.name', 'Test')
  const base = commitFile(work, 'README.md', 'upstream\n', 'upstream: first')
  git(dir, 'init', '-q', '--bare', '-b', 'main', upBare)
  git(work, 'push', '-q', upBare, 'main')
  const forkOnly = commitFile(work, 'AGENTS.md', 'my own notes\n', 'fork: my own AGENTS.md')
  git(dir, 'init', '-q', '--bare', '-b', 'main', forkBare)
  git(work, 'push', '-q', forkBare, 'main')

  const root = join(dir, `root${seq}`)
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'Test')
  // `addProject` writes `.warmstart/` into the checkout; the add wizard keeps it out of git like this.
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.warmstart/\n')
  git(root, 'config', `url.${upBare}.insteadOf`, UP_URL)
  git(root, 'config', `url.${forkBare}.insteadOf`, FORK_URL)
  if (layout === 't897') {
    git(root, 'remote', 'add', 'origin', UP_URL)
    git(root, 'remote', 'add', 'fork', FORK_URL)
    git(root, 'fetch', '-q', 'origin')
    git(root, 'fetch', '-q', 'fork')
    git(root, 'checkout', '-q', '-B', 'main', '--track', 'origin/main')
  } else {
    git(root, 'remote', 'add', 'origin', FORK_URL)
    git(root, 'remote', 'add', 'upstream', UP_URL)
    git(root, 'fetch', '-q', 'origin')
    git(root, 'fetch', '-q', 'upstream')
    git(root, 'checkout', '-q', '-B', 'main', '--track', 'origin/main')
  }
  return { root, upBare, forkBare, base, forkOnly }
}

/** Fake `gh`: a permission for `repo view`, a URL for `pr create`, and every call recorded. */
function fakeGh(permission: string, prUrl = 'https://github.com/Upstream-Org/thing/pull/7'): string[][] {
  const calls: string[][] = []
  const realRun = spawn.run
  vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, args: unknown, ...rest: unknown[]) => {
    if (typeof cmd === 'string' && /gh(\.exe)?$/i.test(cmd)) {
      const a = args as string[]
      calls.push(a)
      if (a[0] === 'repo' && a[1] === 'view') return { stdout: `${permission}\n`, stderr: '' }
      return { stdout: `${prUrl}\n`, stderr: '' }
    }
    return (realRun as (...x: unknown[]) => unknown)(cmd, args, ...rest)
  }) as never)
  return calls
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-forkhome-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  setup = await import('./projectsetup.js')
  upstream = await import('./upstream.js')
  repotrust = await import('./repotrust.js')
  spawn = await import('./spawn.js')
  const { stubCliPath } = await import('./testkit.js')
  undoGh = stubCliPath('gh')
  db.openDb(join(dir, 'forkhome.db'))
})

afterEach(() => {
  vi.restoreAllMocks()
  repotrust.clearRepoTrustCache()
})

afterAll(() => {
  undoGh()
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('whose repository it is (t903)', () => {
  it('counts ADMIN and MAINTAIN as yours and nothing else', () => {
    expect(repotrust.trustFor('ADMIN')).toBe('own')
    expect(repotrust.trustFor('maintain')).toBe('own')
    // ⛔ The operator's answer: a collaborator with WRITE on somebody else's project is still external.
    expect(repotrust.trustFor('WRITE')).toBe('external')
    expect(repotrust.trustFor('READ')).toBe('external')
    expect(repotrust.trustFor('')).toBe('unknown')
    expect(repotrust.trustFor(null)).toBe('unknown')
  })

  it('reads it from gh, and calls a remote off github.com unknown without asking', async () => {
    const calls = fakeGh('READ')
    const reading = await repotrust.repoTrust('Upstream-Org/thing')
    expect(reading).toMatchObject({ slug: 'Upstream-Org/thing', trust: 'external', permission: 'READ' })
    expect(calls[0]).toEqual(['repo', 'view', 'Upstream-Org/thing', '--json', 'viewerPermission', '--jq', '.viewerPermission'])

    const local = join(dir, 'offgithub')
    mkdirSync(local)
    git(local, 'init', '-q')
    git(local, 'remote', 'add', 'origin', join(dir, 'nowhere.git'))
    const off = await repotrust.remoteTrust(local, 'origin')
    expect(off.trust).toBe('unknown')
    expect(off.reason).toMatch(/not on github\.com/)
    expect(calls).toHaveLength(1)
  })
})

describe('Make my fork home (t903)', () => {
  it('swaps the remotes, re-points the trunk at the fork, and turns a pull-request finish into a push', async () => {
    const { root } = seed('t897')
    const project = projects.addProject({ root })
    projects.setProjectPolicy(project.id, { pushRemote: 'fork', finish: 'pull-request', landingTarget: 'main' })

    const result = await setup.makeForkHome(project.id)

    expect(url(root, 'origin')).toBe(FORK_URL)
    expect(url(root, 'upstream')).toBe(UP_URL)
    expect(git(root, 'remote').split('\n').sort()).toEqual(['origin', 'upstream'])
    // ⛔ The trunk tracked the upstream; left that way a bare `git push` would go to their repository.
    expect(git(root, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
    expect(result).toMatchObject({ fork: 'me/thing', upstream: 'Upstream-Org/thing', warnings: [] })
    expect(result.project.config.landing?.upstreamRemote).toBe('upstream')
    expect(result.project.config.landing?.pushRemote).toBeUndefined()
    expect(result.project.config.landing?.finish).toBe('commit-and-push')
    expect(projects.policyFor(result.project).upstreamRemote).toBe('upstream')

    await expect(setup.makeForkHome(project.id)).rejects.toThrow(/already home/)
  })

  it('refuses before renaming anything when an upstream remote already exists', async () => {
    const { root } = seed('t897')
    git(root, 'remote', 'add', 'upstream', 'https://github.com/someone/else.git')
    await expect(setup.swapToForkHome(root, 'fork', 'main')).rejects.toThrow(/already has an `upstream` remote/)
    expect(url(root, 'origin')).toBe(UP_URL)
    expect(url(root, 'fork')).toBe(FORK_URL)
  })

  /**
   * ⛔ The wizard's whole path: clone, `gh repo fork`, then the fork made home — so a project born
   * from the checkbox never has the t897 layout that sent t902's pull request upstream.
   *
   * ⚠️ `gh repo fork` is faked by doing what it does to the clone (adding the remote); the clone,
   * the renames and the fetch are real, through `GIT_CONFIG_*` so the clone itself is rewritten.
   */
  it('clones, forks, and makes the fork home in one step', async () => {
    const { upBare, forkBare } = seed('home')
    const saved = { ...process.env }
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `url.${upBare}.insteadOf`,
      GIT_CONFIG_VALUE_0: UP_URL,
      GIT_CONFIG_KEY_1: `url.${forkBare}.insteadOf`,
      GIT_CONFIG_VALUE_1: FORK_URL
    })
    const realRun = spawn.run
    vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, args: unknown, opts: unknown, ...rest: unknown[]) => {
      if (typeof cmd === 'string' && /gh(\.exe)?$/i.test(cmd)) {
        const a = args as string[]
        if (a[0] === 'repo' && a[1] === 'fork') git((opts as { cwd: string }).cwd, 'remote', 'add', a[4]!, FORK_URL)
        return { stdout: '', stderr: '' }
      }
      return (realRun as (...x: unknown[]) => unknown)(cmd, args, opts, ...rest)
    }) as never)
    try {
      seq += 1
      const root = join(dir, `wizard${seq}`)
      const result = await setup.cloneProject({ source: 'Upstream-Org/thing', root, fork: true })

      expect(result).toMatchObject({ upstreamRemote: 'upstream', fork: 'me/thing', upstream: 'Upstream-Org/thing', defaultBranch: 'main' })
      expect(result.warnings).toEqual([])
      expect(url(root, 'origin')).toBe(FORK_URL)
      expect(url(root, 'upstream')).toBe(UP_URL)
      expect(git(root, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })

  it('keeps the finish policy the operator chose when it was not pull-request', async () => {
    const { root } = seed('t897')
    const project = projects.addProject({ root })
    projects.setProjectPolicy(project.id, { pushRemote: 'fork', finish: 'commit-and-verify' })
    const result = await setup.makeForkHome(project.id)
    expect(result.project.config.landing?.finish).toBe('commit-and-verify')
  })
})

describe('Propose upstream (t903)', () => {
  async function seededTask() {
    const s = seed('home')
    const project = projects.setProjectPolicy(projects.addProject({ root: s.root }).id, {
      upstreamRemote: 'upstream',
      landingTarget: 'main'
    })
    const task = tasks.createTask({ title: 'PRIVATE prompt words', projectId: project.id, createdBy: { kind: 'human' } })
    const branch = `warmstart/t${task.seq}`
    git(s.root, 'checkout', '-q', '-b', branch, 'main')
    const own = commitFile(s.root, 'work.txt', 'the change\n', 'fix: the change upstream wants')
    git(s.root, 'checkout', '-q', 'main')
    tasks.setTaskBranch(task.id, branch, 1)
    return { ...s, project, task, own }
  }

  it('previews only the task’s own commits, onto the upstream, and sends nothing', async () => {
    const { task, own, base } = await seededTask()
    const calls = fakeGh('READ')

    const preview = await upstream.previewUpstreamProposal(task.id)

    expect(preview).toMatchObject({
      upstream: 'Upstream-Org/thing',
      base: 'main',
      baseSha: base,
      branch: `warmstart/up-t${task.seq}`,
      head: `me:warmstart/up-t${task.seq}`,
      title: 'fix: the change upstream wants',
      trust: { trust: 'external', permission: 'READ' }
    })
    // ⛔ The fork-only AGENTS.md commit is on origin/main and is not this task's; it is not offered.
    expect(preview.commits).toEqual([{ sha: own, subject: 'fix: the change upstream wants', files: ['work.txt'], forkOnly: [] }])
    expect(JSON.stringify(preview)).not.toContain('PRIVATE')
    expect(calls.filter((c) => c[0] === 'pr')).toEqual([])
  })

  it('replays exactly those commits onto upstream/main, pushes to the fork and opens the PR there', async () => {
    const { task, forkBare, base } = await seededTask()
    const calls = fakeGh('READ')
    const preview = await upstream.previewUpstreamProposal(task.id)

    const { url } = await upstream.proposeUpstream({
      id: task.id,
      baseSha: preview.baseSha,
      commits: preview.commits.map((c) => c.sha),
      title: 'Fix the change',
      body: 'Why it matters.'
    })

    expect(url).toBe('https://github.com/Upstream-Org/thing/pull/7')
    const pushed = `warmstart/up-t${task.seq}`
    expect(git(forkBare, 'rev-parse', `${pushed}~1`)).toBe(base)
    expect(git(forkBare, 'ls-tree', '--name-only', pushed).split('\n').sort()).toEqual(['README.md', 'work.txt'])
    const create = calls.find((c) => c[0] === 'pr' && c[1] === 'create')!
    const at = (flag: string): string | undefined => create[create.indexOf(flag) + 1]
    expect(at('--repo')).toBe('Upstream-Org/thing')
    expect(at('--head')).toBe(`me:${pushed}`)
    expect(at('--base')).toBe('main')
    expect(at('--title')).toBe('Fix the change')
    const said = tasks.messagesFor(task.id).at(-1)!
    expect(said.text).toBe(`Proposed upstream, on your click: ${url}`)
    // ⛔ Never a landing line: nothing reached this project's own target.
    expect(said.text.startsWith('Landed as')).toBe(false)
    expect(said.text.startsWith('Pull request opened for')).toBe(false)
  })

  it('refuses, sending nothing, when what would be sent is not what the person saw', async () => {
    const { task, forkBare } = await seededTask()
    const calls = fakeGh('READ')
    const preview = await upstream.previewUpstreamProposal(task.id)

    await expect(
      upstream.proposeUpstream({ id: task.id, baseSha: '0'.repeat(40), commits: preview.commits.map((c) => c.sha), title: 't', body: '' })
    ).rejects.toThrow(/changed since you looked/)
    await expect(
      upstream.proposeUpstream({ id: task.id, baseSha: preview.baseSha, commits: [], title: 't', body: '' })
    ).rejects.toThrow(/changed since you looked/)
    expect(calls.filter((c) => c[0] === 'pr')).toEqual([])
    expect(git(forkBare, 'branch', '--list', `warmstart/up-t${task.seq}`)).toBe('')
  })

  it('tells an agent never to push or open a pull request upstream itself', async () => {
    const { upstreamClause } = await import('./prompt.js')
    const home = seed('home')
    const project = projects.setProjectPolicy(projects.addProject({ root: home.root }).id, { upstreamRemote: 'upstream' })
    expect(upstreamClause(project)).toMatch(/Never push to the `upstream` remote or open a pull request on it yourself/)
    const plain = seed('home')
    expect(upstreamClause(projects.addProject({ root: plain.root }))).toBe('')
  })

  it('is not offered on a project whose fork is not home', async () => {
    const { root } = seed('t897')
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'x', projectId: project.id, createdBy: { kind: 'human' } })
    await expect(upstream.previewUpstreamProposal(task.id)).rejects.toThrow(/Make my fork home/)
  })
})

/** One more commit on the upstream itself, as its maintainers would push it. */
function upstreamCommit(upBare: string, name: string, content: string, message: string): string {
  seq += 1
  const work = join(dir, `upwork${seq}`)
  git(dir, 'clone', '-q', upBare, work)
  git(work, 'config', 'user.email', 'maintainer@example.invalid')
  git(work, 'config', 'user.name', 'Maintainer')
  const sha = commitFile(work, name, content, message)
  git(work, 'push', '-q', 'origin', 'HEAD:main')
  return sha
}

describe('fork-only paths stay in the fork (t907)', () => {
  it('leaves them out of a proposal, file by file, and drops a commit that carries nothing else', async () => {
    const s = seed('home')
    const project = projects.setProjectPolicy(projects.addProject({ root: s.root }).id, {
      upstreamRemote: 'upstream',
      landingTarget: 'main',
      forkOnly: ['AGENTS.md', 'fork/**']
    })
    const task = tasks.createTask({ title: 'x', projectId: project.id, createdBy: { kind: 'human' } })
    const branch = `warmstart/t${task.seq}`
    git(s.root, 'checkout', '-q', '-b', branch, 'main')
    // ⭐ The commit that did not apply before: it edits an AGENTS.md the upstream never had
    // (`modify/delete`) beside the change the upstream wants.
    mkdirSync(join(s.root, 'fork'), { recursive: true })
    writeFileSync(join(s.root, 'AGENTS.md'), 'my own notes, updated\n')
    writeFileSync(join(s.root, 'fork', 'plan.md'), 'the plan\n')
    const mixed = commitFile(s.root, 'work.txt', 'the change\n', 'feat: the change, and my notes')
    const notesOnly = commitFile(s.root, join('fork', 'plan.md'), 'the plan, revised\n', 'fork: revise the plan')
    git(s.root, 'checkout', '-q', 'main')
    tasks.setTaskBranch(task.id, branch, 1)
    fakeGh('READ')

    const preview = await upstream.previewUpstreamProposal(task.id)
    expect(preview.commits.map((c) => c.sha)).toEqual([mixed, notesOnly])
    expect(preview.commits[0]!.forkOnly.sort()).toEqual(['AGENTS.md', 'fork/plan.md'])
    expect(preview.commits[1]!.forkOnly).toEqual(['fork/plan.md'])

    await upstream.proposeUpstream({ id: task.id, baseSha: preview.baseSha, commits: preview.commits.map((c) => c.sha), title: 't', body: '' })

    const pushed = `warmstart/up-t${task.seq}`
    expect(git(s.forkBare, 'ls-tree', '-r', '--name-only', pushed).split('\n').sort()).toEqual(['README.md', 'work.txt'])
    expect(git(s.forkBare, 'rev-list', '--count', `${s.base}..${pushed}`)).toBe('1')
    expect(git(s.forkBare, 'log', '-1', '--format=%s', pushed)).toBe('feat: the change, and my notes')
    expect(tasks.messagesFor(task.id).at(-1)!.detail).toContain("Left out as this fork's own: ")
  })

  it('refuses a proposal with nothing in it but the fork’s own files, and sends nothing', async () => {
    const s = seed('home')
    const project = projects.setProjectPolicy(projects.addProject({ root: s.root }).id, {
      upstreamRemote: 'upstream',
      landingTarget: 'main',
      forkOnly: ['HANDOFF.md']
    })
    const task = tasks.createTask({ title: 'x', projectId: project.id, createdBy: { kind: 'human' } })
    const branch = `warmstart/t${task.seq}`
    git(s.root, 'checkout', '-q', '-b', branch, 'main')
    commitFile(s.root, 'HANDOFF.md', 'state\n', 'docs: handoff')
    git(s.root, 'checkout', '-q', 'main')
    tasks.setTaskBranch(task.id, branch, 1)
    const calls = fakeGh('READ')

    await expect(upstream.previewUpstreamProposal(task.id)).rejects.toThrow(/nothing to propose upstream/)
    expect(calls.filter((c) => c[0] === 'pr')).toEqual([])
  })

  it('keeps only paths inside the repository, as git spells them, and tells the agent which they are', async () => {
    const { upstreamClause } = await import('./prompt.js')
    const s = seed('home')
    const id = projects.addProject({ root: s.root }).id
    const backslash = String.fromCharCode(92)
    expect(() => projects.setProjectPolicy(id, { forkOnly: ['AGENTS.md', '../outside'] })).toThrow(/not a path inside the repository: \.\.\/outside/)
    expect(() => projects.setProjectPolicy(id, { forkOnly: [':(top)x'] })).toThrow(/not a path inside/)
    const project = projects.setProjectPolicy(id, { upstreamRemote: 'upstream', forkOnly: [' AGENTS.md ', `fork${backslash}**`, 'AGENTS.md', ''] })
    expect(project.config.landing?.forkOnly).toEqual(['AGENTS.md', 'fork/**'])
    expect(upstreamClause(project)).toContain('left out of what goes: `AGENTS.md`, `fork/**`')
    expect(projects.setProjectPolicy(id, { forkOnly: null }).config.landing?.forkOnly).toBeUndefined()
  })
})

describe('Sync from upstream (t907)', () => {
  function home(finish: 'commit-and-merge' | 'commit-and-push') {
    const s = seed('home')
    const project = projects.setProjectPolicy(projects.addProject({ root: s.root }).id, {
      upstreamRemote: 'upstream',
      landingTarget: 'main',
      finish
    })
    return { ...s, project }
  }

  it('merges the upstream’s new commits under the fork’s own, never rewriting them, and does not push unless the policy does', async () => {
    const s = home('commit-and-merge')
    const theirs = upstreamCommit(s.upBare, 'NEWS.md', 'news\n', 'upstream: news')

    const result = await upstream.syncFromUpstream(s.project.id)

    expect(result).toMatchObject({ from: 'upstream/main', into: 'main', incoming: 1, fastForward: false, pushed: false })
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(result.head)
    // ⛔ A merge: both parents kept, the fork's own AGENTS.md commit still where it was published.
    expect(git(s.root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([s.forkOnly, theirs])
    expect(git(s.forkBare, 'rev-parse', 'main')).toBe(s.forkOnly)
    // And a second press has nothing to do.
    expect((await upstream.syncFromUpstream(s.project.id)).incoming).toBe(0)
  })

  it('pushes to the fork when the finish policy pushes', async () => {
    const s = home('commit-and-push')
    upstreamCommit(s.upBare, 'NEWS.md', 'news\n', 'upstream: news')
    fakeGh('ADMIN')

    const result = await upstream.syncFromUpstream(s.project.id)

    expect(result.pushed).toBe(true)
    expect(git(s.forkBare, 'rev-parse', 'main')).toBe(result.head)
  })

  it('aborts a conflict, names the files and leaves the checkout as it was', async () => {
    const s = home('commit-and-merge')
    commitFile(s.root, 'README.md', 'ours\n', 'fork: our readme')
    const before = git(s.root, 'rev-parse', 'HEAD')
    upstreamCommit(s.upBare, 'README.md', 'theirs\n', 'upstream: their readme')

    await expect(upstream.syncFromUpstream(s.project.id)).rejects.toThrow(/conflicts in README\.md\. The merge was aborted/)
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(s.root, 'status', '--porcelain')).toBe('')
  })

  it('refuses while the checkout is behind its own fork, or on another branch', async () => {
    const s = home('commit-and-merge')
    upstreamCommit(s.upBare, 'NEWS.md', 'news\n', 'upstream: news')
    seq += 1
    const elsewhere = join(dir, `forkwork${seq}`)
    git(dir, 'clone', '-q', s.forkBare, elsewhere)
    git(elsewhere, 'config', 'user.email', 'me@example.invalid')
    git(elsewhere, 'config', 'user.name', 'Me')
    commitFile(elsewhere, 'MINE.md', 'from my laptop\n', 'fork: from another machine')
    git(elsewhere, 'push', '-q', 'origin', 'HEAD:main')
    const before = git(s.root, 'rev-parse', 'HEAD')

    await expect(upstream.syncFromUpstream(s.project.id)).rejects.toThrow(/1 commit behind `origin\/main`/)
    git(s.root, 'checkout', '-q', '-b', 'side')
    await expect(upstream.syncFromUpstream(s.project.id)).rejects.toThrow(/checked out rather than `main`/)
    expect(git(s.root, 'rev-parse', 'main')).toBe(before)
  })
})
