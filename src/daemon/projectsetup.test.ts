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
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
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
    expect(found.workspace.path).toBe(projects.defaultWorkspaceRoot(root))
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
      '.multi_agent_controller/project.json': JSON.stringify({
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
      readFileSync(join(root, '.multi_agent_controller', 'project.json'), 'utf8')
    ) as Record<string, unknown>
    expect((config.landing as Record<string, unknown>).finish).toBe('commit-only')
    expect((config.landing as Record<string, unknown>).target).toBe('trunk')
    expect((config.session as Record<string, unknown>).share).toBe('on')
    expect((config.workspaces as Record<string, unknown>).poolSize).toBe(4)
    expect(config.check).toEqual(['npm run test'])

    // The starter files carry the name and the branch that were chosen, not a template's defaults.
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('# Widget')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('never directly on `trunk`')
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
