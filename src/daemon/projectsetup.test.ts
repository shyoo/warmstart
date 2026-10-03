import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proposeChecks, proposeDocs, isEmptyProjectDir, suggestProjectName, detectStack } from './projectstack.js'

/**
 * Adding a project as a setup step.
 *
 * ⛔ **Against real directories, because directories are what it reads.** Every question this flow
 * answers — is it empty, is it a repo, is that workspace directory somebody else's, does this
 * project already exist — is a filesystem question, and a mocked one would prove the functions
 * return rather than that they are right about a disk.
 *
 * ⚠️ The half that matters most is what it *refuses*: the wizard writes a committed file and up to
 * three files into somebody's repository, so "never overwrites" and "never absolute" are the two
 * properties under test, not the happy path.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let setup: typeof import('./projectsetup.js')

let seq = 0

/** A directory with a git repo in it. ⚠️ Real, because `detectVcs` shells out to `git rev-parse`. */
function repoDir(files: Record<string, string> = {}): string {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' })
  // `createProject` commits what it wrote, and a CI runner has no global identity (run
  // 35403359041: `fatal: empty ident name`). Passing locally was this machine's config, not the test's.
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' })
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

function plainDir(files: Record<string, string> = {}): string {
  seq += 1
  const root = join(dir, `plain${seq}`)
  mkdirSync(root, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-projectsetup-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  setup = await import('./projectsetup.js')
  db.openDb(join(dir, 'projectsetup.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('what a directory suggests running', () => {
  it('still reads npm scripts, in cheap-first order and no other', () => {
    const root = plainDir({
      'package.json': JSON.stringify({
        scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', start: 'x' }
      })
    })
    expect(proposeChecks(root)).toEqual([
      'npm run typecheck',
      'npm run lint',
      'npm run test',
      'npm run build'
    ])
  })

  it('proposes pytest for a python project whose tests are a directory rather than a dependency', () => {
    // ⚠️ The awardtracker shape: `requirements.txt` pinned for production with no pytest in it, and
    // a `tests/` directory full of `test_*.py`. npm-only detection proposed nothing for it.
    const root = plainDir({
      'requirements.txt': 'Flask==3.0.3\nseleniumbase==4.26.1\n',
      'app.py': '',
      'tests/test_db.py': ''
    })
    expect(detectStack(root)).toEqual(['python'])
    expect(proposeChecks(root)).toEqual(['pytest -q'])
  })

  it('proposes the linters a python project actually declares, and not the ones it does not', () => {
    const withRuff = plainDir({ 'pyproject.toml': '[tool.ruff]\n', 'test_it.py': '' })
    expect(proposeChecks(withRuff)).toEqual(['ruff check .', 'pytest -q'])

    const withoutRuff = plainDir({ 'pyproject.toml': '[project]\nname="x"\n' })
    expect(proposeChecks(withoutRuff)).toEqual([])
  })

  it('proposes only Makefile targets that exist', () => {
    const root = plainDir({ Makefile: 'build:\n\tgo build\n\ntest:\n\tgo test\n' })
    // ⛔ No `make lint` and no `make check` — proposing one would fail every landing on
    // "No rule to make target".
    expect(proposeChecks(root)).toEqual(['make test'])
  })

  it('gives a polyglot repo both stacks, deduplicated', () => {
    const root = plainDir({
      'package.json': JSON.stringify({ scripts: { test: 'x' } }),
      'requirements.txt': 'pytest\n'
    })
    expect(detectStack(root)).toEqual(['node', 'python'])
    expect(proposeChecks(root)).toEqual(['npm run test', 'pytest -q'])
  })

  it('proposes dotnet build only where a bare one would run', () => {
    // ⛔ MSB1011: a bare `dotnet build` refuses a directory holding two project or solution files.
    expect(proposeChecks(plainDir({ 'App.csproj': '<Project />' }))).toEqual(['dotnet build'])
    expect(proposeChecks(plainDir({ 'App.csproj': '<Project />', 'App.sln': '' }))).toEqual(['dotnet build "App.sln"'])
    const many = plainDir({ 'A.sln': '', 'B.sln': '' })
    expect(detectStack(many)).toEqual(['dotnet'])
    expect(proposeChecks(many)).toEqual([])
  })

  it('says nothing about a directory it cannot read a manifest in', () => {
    const root = plainDir({})
    expect(detectStack(root)).toEqual([])
    expect(proposeChecks(root)).toEqual([])
  })
})

describe('what counts as an empty project', () => {
  it('treats a freshly initialised repository as empty', () => {
    // ⛔ The case the scaffolding exists for. `.git` on its own is not somebody's work.
    expect(isEmptyProjectDir(repoDir())).toBe(true)
  })

  it('does not treat a repository with a file in it as empty', () => {
    expect(isEmptyProjectDir(repoDir({ 'README.md': '# x' }))).toBe(false)
  })

  it('names a project after its package, then after its directory', () => {
    expect(suggestProjectName(plainDir({ 'package.json': '{"name":"@scope/widget"}' }))).toBe('widget')
    const bare = plainDir({})
    expect(suggestProjectName(bare)).toBe(bare.split(/[\\/]/).pop())
  })
})

describe('inspecting a directory before adding it', () => {
  it('reports an empty repo, its missing docs, and a workspace root that does not exist yet', () => {
    const root = repoDir()
    const found = setup.inspectProjectDirectory({ root })

    expect(found.exists).toBe(true)
    expect(found.isDirectory).toBe(true)
    expect(found.empty).toBe(true)
    expect(found.vcs).toBe('git')
    expect(found.alreadyAdded).toBeNull()
    expect(found.hasConfig).toBe(false)
    expect(found.config).toBeNull()
    expect(found.docs).toEqual({ 'README.md': false, 'AGENTS.md': false, 'HANDOFF.md': false })
    expect(found.workspace.state).toBe('free')
    expect(found.workspace.usable).toBe(true)
    // ⛔ The recommended name, derived once and read by both the resolver and the form.
    expect(found.workspace.path).toBe(projects.managedWorkspaceRoot(root))
    expect(found.workspace.relative).toBeNull()
  })

  it('answers for a directory that does not exist, rather than throwing', () => {
    const missing = join(dir, 'not-created-yet')
    const found = setup.inspectProjectDirectory({ root: missing })
    expect(found.exists).toBe(false)
    expect(found.vcs).toBe('none')
    // ⚠️ Still names it, because the form has to show a name for a directory it is about to create.
    expect(found.suggestedName).toBe('not-created-yet')
  })

  it('names the project already at a root, so the wizard can refuse instead of reconfiguring it', () => {
    const root = repoDir({ 'README.md': '# taken' })
    const existing = projects.addProject({ root, name: 'Already Here' })
    const found = setup.inspectProjectDirectory({ root })
    expect(found.alreadyAdded).toEqual({ id: existing.id, name: 'Already Here' })
  })

  it('loads a committed config so the form opens on what the repository already says', () => {
    const root = repoDir({
      '.warmstart/project.json': JSON.stringify({
        schema_version: 1,
        landing: { finish: 'commit-only', target: 'trunk' },
        check: ['make test']
      })
    })
    const found = setup.inspectProjectDirectory({ root })
    expect(found.hasConfig).toBe(true)
    expect(found.config?.landing?.target).toBe('trunk')
    expect(found.config?.check).toEqual(['make test'])
  })
})

describe('the workspace directory', () => {
  it('keeps managed pools distinct and the existing sibling default stable', () => {
    const first = repoDir()
    const second = repoDir()
    expect(projects.managedWorkspaceRoot(first)).not.toBe(projects.managedWorkspaceRoot(second))
    expect(projects.managedWorkspaceRoot(first)).toContain(join(dir, 'workspaces'))
    const legacy = projects.addProject({ root: first })
    expect(projects.policyFor(legacy).workspaceRoot).toBe(projects.defaultWorkspaceRoot(first))
  })

  it('records a managed choice without a machine path and resolves it after reload', () => {
    const root = repoDir()
    const project = projects.addProject({ root })
    const updated = projects.setProjectPolicy(project.id, { workspaceLocation: 'managed' })
    expect(updated.config.workspaces?.location).toBe('managed')
    expect(updated.config.workspaces?.root).toBeUndefined()
    expect(projects.policyFor(projects.reloadProject(project.id)).workspaceRoot)
      .toBe(projects.managedWorkspaceRoot(root))
    const sibling = projects.setProjectPolicy(project.id, {
      workspaceLocation: 'custom', workspaceRoot: projects.defaultWorkspaceRoot(root)
    })
    expect(sibling.config.workspaces?.location).toBeUndefined()
    expect(projects.policyFor(sibling).workspaceRoot).toBe(projects.defaultWorkspaceRoot(root))
  })

  it('ignores a stale custom path after choosing the managed location', async () => {
    const root = repoDir()
    const result = await setup.createProject({
      root,
      workspaceLocation: 'managed',
      workspaceRoot: join(root, 'stale-custom-path')
    })
    expect(result.warnings).toEqual([])
    expect(projects.policyFor(result.project).workspaceRoot).toBe(projects.managedWorkspaceRoot(root))
  })

  it('refuses a directory inside the project, naming why', () => {
    const root = repoDir()
    const report = setup.workspaceRootReport(root, join(root, 'workspaces'))
    expect(report.state).toBe('inside-project')
    expect(report.usable).toBe(false)
    expect(report.note).toMatch(/inside the project/i)
  })

  it('refuses the project directory itself', () => {
    const root = repoDir()
    expect(setup.workspaceRootReport(root, root).usable).toBe(false)
  })

  it('refuses a directory another project already keeps its workspaces in', () => {
    const first = repoDir()
    const owner = projects.addProject({ root: first, name: 'Owner' })
    const second = repoDir()

    const report = setup.workspaceRootReport(second, projects.policyFor(owner).workspaceRoot)
    expect(report.state).toBe('taken')
    expect(report.takenBy).toBe('Owner')
    expect(report.usable).toBe(false)
  })

  it('warns about a directory that already holds something without refusing it', () => {
    // ⚠️ An existing pool from a previous install looks exactly like this. Refusing would make
    // re-adding a project you already had impossible.
    const root = repoDir()
    const occupied = join(dir, `occupied${(seq += 1)}`)
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'ws1'), '')

    const report = setup.workspaceRootReport(root, occupied)
    expect(report.state).toBe('occupied')
    expect(report.usable).toBe(true)
    expect(report.note).toMatch(/already holds/)
  })

  it('writes a chosen root into project.json relatively, never as an absolute path', () => {
    // ⛔ The committed file is pulled by every clone and every machine. An absolute path in it is a
    // fact about one disk, which is the one thing that file may never carry.
    const root = repoDir()
    const chosen = join(dir, `elsewhere${(seq += 1)}`)
    const project = projects.addProject({ root })

    const updated = projects.setProjectPolicy(project.id, { workspaceRoot: chosen })
    const written = updated.config.workspaces?.root
    expect(written).toBeTruthy()
    expect(written).not.toMatch(/^([A-Za-z]:|\/)/)
    expect(written).toContain('../')
    // And it round-trips: the resolver reads back the directory that was chosen.
    expect(projects.policyFor(updated).workspaceRoot.toLowerCase()).toBe(chosen.toLowerCase())
  })

  it('writes the derived default as no key at all, so a clone derives its own', () => {
    const root = repoDir()
    const project = projects.addProject({ root })
    const updated = projects.setProjectPolicy(project.id, {
      workspaceRoot: projects.defaultWorkspaceRoot(root)
    })
    expect(updated.config.workspaces?.root).toBeUndefined()
    expect(projects.policyFor(updated).workspaceRoot).toBe(projects.defaultWorkspaceRoot(root))
  })
})

describe('creating a project', () => {
  it('registers it, writes the policy, the checks and the missing docs in one call', async () => {
    const root = repoDir({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }) })
    // ⚠️ The same landing target the policy below sets — which is what the wizard does, because the
    // templates are fetched after the policy step with the draft's own answers.
    const docs = setup.proposeProjectDocs({ root, name: 'Widget', landingTarget: 'trunk' })
    expect(docs.map((d) => d.name)).toEqual(['README.md', 'AGENTS.md', 'HANDOFF.md'])

    const result = await setup.createProject({
      root,
      name: 'Widget',
      policy: { finish: 'commit-only', landingTarget: 'trunk', sessionShare: 'on', poolSize: 4 },
      checks: ['npm run test'],
      docs
    })

    expect(result.warnings).toEqual([])
    expect(result.project.name).toBe('Widget')
    expect(result.docsWritten).toEqual(['README.md', 'AGENTS.md', 'HANDOFF.md'])

    const config = JSON.parse(
      readFileSync(join(root, '.warmstart', 'project.json'), 'utf8')
    ) as Record<string, unknown>
    expect((config.landing as Record<string, unknown>).finish).toBe('commit-only')
    expect((config.landing as Record<string, unknown>).target).toBe('trunk')
    expect((config.session as Record<string, unknown>).share).toBe('on')
    expect((config.workspaces as Record<string, unknown>).poolSize).toBe(4)
    expect((config.workspaces as Record<string, unknown>).location).toBe('managed')
    expect((config.workspaces as Record<string, unknown>).root).toBeUndefined()
    expect(config.check).toEqual(['npm run test'])

    // The starter files carry the name and the branch that were chosen, not a template's defaults.
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('# Widget')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('never directly on `trunk`')
  })

  it('commits the scaffolding it just wrote so the trunk starts clean', async () => {
    // ⛔ t505/t506, 2026-09-17: `.warmstart/project.json` is documented as a committed file, but
    // nothing ever committed it — it sat untracked until a landing found a dirty trunk and refused
    // to merge, with nothing to say the block was scaffolding Warmstart itself had left behind.
    const root = repoDir()
    const docs = setup.proposeProjectDocs({ root, name: 'Clean' })
    const result = await setup.createProject({ root, name: 'Clean', docs })

    expect(result.warnings).toEqual([])
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.warmstart', ...result.docsWritten], {
        cwd: root,
        encoding: 'utf8'
      })
    ).toBe('')

    const committed = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    })
    expect(committed).toContain('.warmstart/project.json')
    for (const name of result.docsWritten) expect(committed).toContain(name)
  })

  it('leaves project.json untracked behind a committed .gitignore entry when asked to ignore', async () => {
    // ⛔ t554: the operator's explicit choice. The config is written but never staged; the
    // `.gitignore` rule commits beside the starter docs so the trunk handed back is clean.
    const root = repoDir()
    const docs = setup.proposeProjectDocs({ root, name: 'Ignored' })
    const result = await setup.createProject({ root, name: 'Ignored', docs, scaffoldingGit: 'ignore' })

    expect(result.warnings).toEqual([])
    expect(existsSync(join(root, '.warmstart', 'project.json'))).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.warmstart/project.json')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')

    const committed = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    })
    expect(committed).toContain('.gitignore')
    expect(committed).not.toContain('.warmstart/project.json')
    for (const name of result.docsWritten) expect(committed).toContain(name)
  })

  it('does not duplicate a .gitignore entry that already covers the config', async () => {
    const root = repoDir({ '.gitignore': 'node_modules/\n.warmstart/\n' })
    const result = await setup.createProject({ root, name: 'Covered', scaffoldingGit: 'ignore' })

    expect(result.warnings).toEqual([])
    expect(
      readFileSync(join(root, '.gitignore'), 'utf8').split('\n').filter((l) => l.includes('warmstart'))
    ).toEqual(['.warmstart/'])
  })

  it('appends the entry cleanly with or without a trailing newline, and only once', async () => {
    const root = plainDir({})
    writeFileSync(join(root, '.gitignore'), 'node_modules/')
    expect(setup.ensureIgnoreEntry(root)).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.warmstart/project.json\n'
    )
    expect(setup.ensureIgnoreEntry(root)).toBe(false)
    // ⚠️ A negation means somebody is hand-editing the rule — the plain entry is appended after
    // it so the file stays ignored without touching their lines.
    writeFileSync(join(root, '.gitignore'), '.warmstart/\n!.warmstart/project.json\n')
    expect(setup.ensureIgnoreEntry(root)).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      '.warmstart/\n!.warmstart/project.json\n.warmstart/project.json\n'
    )
  })

  it('warns rather than silently no-op when the config is already tracked', async () => {
    // ⛔ `.gitignore` does not untrack. Without the sentence the operator reads a clean trunk and
    // a policy that still lands on every clone — the entry did nothing and said nothing.
    const root = repoDir()
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(join(root, '.warmstart', 'project.json'), '{"schema_version":1}')
    execFileSync('git', ['add', '--', '.warmstart/project.json'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-qm', 'track the config'], { cwd: root, stdio: 'ignore' })

    const result = await setup.createProject({ root, name: 'Tracked', scaffoldingGit: 'ignore' })

    expect(result.warnings).toEqual([
      expect.stringContaining('already tracked')
    ])
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
  })

  it('leaves an existing config alone rather than committing over it', async () => {
    const root = repoDir()
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(join(root, '.warmstart', 'project.json'), '{"schema_version":1}')
    // ⚠️ Untracked on purpose: a config the operator wrote themselves and has not yet committed is
    // theirs to commit, not this wizard's to sweep up alongside the files it wrote.
    const result = await setup.createProject({ root, name: 'Untouched' })

    expect(result.warnings).toEqual([])
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.warmstart'], { cwd: root, encoding: 'utf8' })
    ).toContain('.warmstart')
  })

  it('never overwrites a doc that is already there', async () => {
    const root = repoDir({ 'README.md': 'mine, and not to be replaced' })
    const result = await setup.createProject({
      root,
      name: 'Keeps',
      // ⚠️ Forced: the form only ever offers the missing ones, so arriving here means the file
      // appeared between inspecting and creating — and that file is somebody's work.
      docs: [{ name: 'README.md', content: 'the tool’s version' }]
    })
    expect(result.docsWritten).toEqual([])
    expect(result.warnings).toEqual(['README.md already exists and was left alone'])
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('mine, and not to be replaced')
  })

  it('refuses a directory that does not exist unless it was asked to create it', async () => {
    const missing = join(dir, `absent${(seq += 1)}`)
    await expect(setup.createProject({ root: missing })).rejects.toThrow(/does not exist/)
    expect(existsSync(missing)).toBe(false)

    const created = await setup.createProject({ root: missing, createDirectory: true })
    expect(existsSync(missing)).toBe(true)
    expect(created.project.root.toLowerCase()).toBe(missing.toLowerCase())
  })

  it('refuses a root that is already a project rather than reconfiguring it', async () => {
    const root = repoDir()
    projects.addProject({ root, name: 'First' })
    await expect(
      setup.createProject({ root, name: 'Second', policy: { finish: 'commit-only' } })
    ).rejects.toThrow(/already the project "First"/)
  })

  it('initialises a repository on the branch the policy is about to call its landing target', async () => {
    // ⛔ A repo initialised on `master` under a policy that lands on `main` fails its first landing
    // on a ref that does not exist.
    const root = plainDir({})
    const result = await setup.createProject({
      root,
      name: 'Fresh',
      gitInit: true,
      policy: { landingTarget: 'main', poolSize: 2 }
    })
    expect(result.project.vcs).toBe('git')
    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    expect(branch).toBe('main')
  })

  it('refuses an unusable workspace directory before anything is registered', async () => {
    const root = repoDir()
    await expect(
      setup.createProject({ root, name: 'Nope', workspaceRoot: join(root, 'inside') })
    ).rejects.toThrow(/inside the project/i)
    expect(setup.inspectProjectDirectory({ root }).alreadyAdded).toBeNull()
  })
})

describe('the starter templates', () => {
  it('propose only the files that are missing', () => {
    const root = repoDir({ 'README.md': '# there', 'HANDOFF.md': 'state' })
    expect(setup.proposeProjectDocs({ root }).map((d) => d.name)).toEqual(['AGENTS.md'])
  })

  it('state what was read and mark what would have to be learned', () => {
    const [readme, agents, handoff] = proposeDocs({
      root: plainDir({ 'requirements.txt': 'pytest\n' }),
      name: 'Thing',
      checks: ['pytest -q'],
      landingTarget: 'main',
      missing: ['README.md', 'AGENTS.md', 'HANDOFF.md']
    })
    // ⛔ Nothing here claims to know what the project does. Every such line is a marked TODO, and
    // everything stated as fact was read off the disk or chosen in the form.
    expect(readme?.content).toContain('TODO')
    expect(readme?.content).toContain('`pytest -q`')
    expect(agents?.content).toContain('Update [`HANDOFF.md`](HANDOFF.md) in the same commit')
    expect(handoff?.content).toContain('Nothing has been worked on through it yet')
    expect(handoff?.content).toContain('python')
  })
})

describe('a project kept to this checkout (t897)', () => {
  function commitAll(root: string, message: string): void {
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: root, stdio: 'ignore' })
  }
  function head(root: string): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  }

  it('writes the config, excludes it through info/exclude, and commits and edits nothing tracked', async () => {
    // ⛔ Somebody else's repository: a commit here would ride along in every pull request, and a
    // `.gitignore` edit is a tracked change. The exclude file is the one place git keeps per-checkout.
    const root = repoDir({ 'README.md': '# theirs\n' })
    commitAll(root, 'upstream')
    const before = head(root)
    const docs = setup.proposeProjectDocs({ root, name: 'Theirs' })
    expect(docs.length).toBeGreaterThan(0)

    const result = await setup.createProject({ root, name: 'Theirs', docs, scaffoldingGit: 'local' })

    expect(existsSync(join(root, '.warmstart', 'project.json'))).toBe(true)
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.warmstart/')
    expect(existsSync(join(root, '.gitignore'))).toBe(false)
    expect(head(root)).toBe(before)
    expect(result.docsWritten).toEqual([])
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
    expect(result.warnings.join('\n')).toMatch(/starter docs are not written/)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
  })

  it('stays quiet and writes the entry once when the exclude already covers it', async () => {
    const root = repoDir()
    writeFileSync(join(root, '.git', 'info', 'exclude'), '# mine\n/.warmstart\n')
    const result = await setup.createProject({ root, name: 'Covered', scaffoldingGit: 'local' })
    expect(result.warnings).toEqual([])
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe('# mine\n/.warmstart\n')
  })

  it('says so when the repository already tracks a .warmstart directory', async () => {
    const root = repoDir({ '.warmstart/project.json': '{"schema_version":1}\n' })
    commitAll(root, 'ships a config')
    const result = await setup.createProject({ root, name: 'Ships', scaffoldingGit: 'local' })
    expect(result.warnings.join('\n')).toMatch(/already tracks files under \.warmstart/)
  })

  it('names the contributing guide wherever GitHub would find it', () => {
    const root = repoDir({ '.github/CONTRIBUTING.md': 'be nice\n' })
    expect(setup.inspectProjectDirectory({ root }).contributing).toBe('.github/CONTRIBUTING.md')
    expect(setup.inspectProjectDirectory({ root: repoDir() }).contributing).toBeNull()
  })
})

describe('cloning a project (t897)', () => {
  function upstream(): string {
    const root = repoDir({ 'Thing.csproj': '<Project />\n' })
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: root, stdio: 'ignore' })
    return root
  }

  it('clones into a new directory with origin as the source, and reads its default branch', async () => {
    const source = upstream()
    seq += 1
    const root = join(dir, 'clones', `clone${seq}`)
    const result = await setup.cloneProject({ source, root, fork: false })

    expect(existsSync(join(root, 'Thing.csproj'))).toBe(true)
    expect(result.defaultBranch).toBe('main')
    expect(result.upstreamRemote).toBeNull()
    expect(result.fork).toBeNull()
    expect(result.warnings).toEqual([])
    expect(execFileSync('git', ['remote'], { cwd: root, encoding: 'utf8' }).trim()).toBe('origin')
    // ⚠️ The stack is read off the clone, which is why the clone comes before the wizard's setup step.
    expect(setup.inspectProjectDirectory({ root }).proposedChecks).toEqual(['dotnet build'])
  })

  it('clones into an empty directory that already exists', async () => {
    const source = upstream()
    const root = plainDir()
    const result = await setup.cloneProject({ source, root, fork: false })
    expect(result.defaultBranch).toBe('main')
  })

  it('refuses a destination with something in it, before fetching anything', async () => {
    const root = plainDir({ 'keep.txt': 'mine\n' })
    await expect(setup.cloneProject({ source: upstream(), root, fork: false })).rejects.toThrow(/not empty/)
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('refuses to fork a source that is not on GitHub, before cloning it', async () => {
    seq += 1
    const root = join(dir, 'clones', `nofork${seq}`)
    await expect(setup.cloneProject({ source: upstream(), root, fork: true })).rejects.toThrow(/github\.com/)
    expect(existsSync(root)).toBe(false)
  })

  it('refuses a destination that is already a project', async () => {
    const root = plainDir()
    projects.addProject({ root })
    await expect(setup.cloneProject({ source: upstream(), root, fork: false })).rejects.toThrow(/already the project/)
  })
})

describe('a project that pushes to a fork (t897)', () => {
  it('stores the push remote, and writes origin or blank as no key', () => {
    const root = repoDir()
    const project = projects.addProject({ root })
    const forked = projects.setProjectPolicy(project.id, { pushRemote: ' fork ' })
    expect(forked.config.landing?.pushRemote).toBe('fork')
    expect(projects.policyFor(forked).pushRemote).toBe('fork')

    const origin = projects.setProjectPolicy(project.id, { pushRemote: 'origin' })
    expect(origin.config.landing && 'pushRemote' in origin.config.landing).toBe(false)
    expect(projects.policyFor(origin).pushRemote).toBeNull()
    expect(() => projects.setProjectPolicy(project.id, { pushRemote: 'a b' })).toThrow(/not a remote name/)
  })

  it('names its branches warmstart/t<seq> with nothing from the prompt, and they still parse', async () => {
    // ⛔ A fork is public; the slug is the first forty characters of a private prompt.
    const worktrees = await import('./worktrees.js')
    const finish = await import('./finish.js')
    const root = repoDir()
    const plain = projects.addProject({ root })
    const title = 'PRIVATE: fix the thing my manager mentioned'
    expect(worktrees.branchNameFor(7, worktrees.branchTitleFor(plain, title))).toBe('warmstart/t7-private-fix-the-thing-my-manager-mention')

    const forked = projects.setProjectPolicy(plain.id, { pushRemote: 'fork' })
    const branch = worktrees.branchNameFor(7, worktrees.branchTitleFor(forked, title))
    expect(branch).toBe('warmstart/t7')
    expect(worktrees.branchNameFor(7, worktrees.branchTitleFor(forked, title), 2)).toBe('warmstart/t7.2')
    expect(finish.taskSeqFromBranch(branch)).toBe(7)
    expect(finish.taskSeqFromBranch('warmstart/t7.2')).toBe(7)
    expect(finish.taskSeqFromBranch('warmstart/t7x')).toBeNull()
  })
})
