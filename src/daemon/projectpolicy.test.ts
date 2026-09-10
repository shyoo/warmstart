import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, ProjectConfig } from '@shared/tasks.js'
import { projectCompletionChoice, projectFinishChoice } from '@shared/tasks.js'
import { resolveFinishPolicy } from '@shared/policy.js'

/**
 * The middle tier, written from the app.
 *
 * ⛔ Three settings resolve **task → project → fleet**, and until 2026-08-31 the project tier of all
 * three could only be reached by hand-editing a committed JSON file. The resolvers were never the
 * problem; there was no writer. These tests pin the two properties that make the writer safe to put
 * behind a button: it **patches** (nothing it was not asked about changes, including keys this tool
 * has never heard of), and it writes the **spelling the resolvers already read**, so a project
 * configured from the UI and one configured in an editor are the same file.
 *
 * ⚠️ Against a real file on disk, because that file is the product. A mocked writer would prove the
 * function returns, not that `projectFinishChoice` can read back what it wrote.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')

let seq = 0

function makeProject(config?: Partial<ProjectConfig>): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  if (config) {
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({ schema_version: 1, name: `repo${seq}`, ...config }, null, 2)
    )
  }
  return projects.addProject({ root })
}

const configOnDisk = (project: Project): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(project.root, '.warmstart', 'project.json'), 'utf8')
  ) as Record<string, unknown>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-projectpolicy-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  db.openDb(join(dir, 'projectpolicy.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('setting a project’s policy', () => {
  it('creates project.json for a project that had none, and the resolvers read it back', () => {
    const project = makeProject()
    expect(project.configPath).toBeNull()

    const updated = projects.setProjectPolicy(project.id, {
      finish: 'commit-only',
      completion: 'checkpointed',
      sessionShare: 'on',
      poolSize: 5,
      landingTarget: 'trunk'
    })

    expect(updated.configPath).not.toBeNull()
    expect(projectFinishChoice(updated)).toBe('commit-only')
    expect(projectCompletionChoice(updated)).toBe('checkpointed')
    // The whole point of the tier: the project answers, so the fleet default does not.
    expect(resolveFinishPolicy(null, updated, 'commit-and-push')).toEqual({
      policy: 'commit-only',
      source: 'project',
      instruction: null
    })
    expect(updated.config.workspaces?.poolSize).toBe(5)
    expect(updated.config.landing?.target).toBe('trunk')
    expect(projects.policyFor(updated).landingTarget).toBe('trunk')
  })

  it('leaves everything it was not asked about alone, including keys it does not know', () => {
    const project = makeProject({
      check: ['npm test'],
      prepare: ['npm ci'],
      landing: { finish: 'commit-and-merge', target: 'main' },
      // ⛔ A key from a newer version of this tool, or one somebody added by hand. A settings page
      // that quietly dropped it would make editing one dropdown a destructive act on a file the
      // whole team pulls.
      futureThing: { keep: 'me' }
    } as Partial<ProjectConfig>)

    const updated = projects.setProjectPolicy(project.id, { sessionShare: 'off' })

    const raw = configOnDisk(updated)
    expect(raw.futureThing).toEqual({ keep: 'me' })
    expect(raw.check).toEqual(['npm test'])
    expect(raw.prepare).toEqual(['npm ci'])
    expect((raw.landing as Record<string, unknown>).finish).toBe('commit-and-merge')
    expect((raw.session as Record<string, unknown>).share).toBe('off')
  })

  it('writes inherit as a value, not as a deleted key', () => {
    const project = makeProject({ landing: { finish: 'commit-and-push' } })
    const updated = projects.setProjectPolicy(project.id, { finish: 'inherit' })

    expect((configOnDisk(updated).landing as Record<string, unknown>).finish).toBe('inherit')
    expect(projectFinishChoice(updated)).toBe('inherit')
    expect(resolveFinishPolicy(null, updated, 'commit-only').source).toBe('fleet')
  })

  it('drops the legacy `strategy` when the new spelling is set, so the file has one answer', () => {
    const project = makeProject({ landing: { strategy: 'auto-land', target: 'main' } })
    // What the old key meant, before anything is changed: push the trunk.
    expect(projectFinishChoice(project)).toBe('commit-and-push')

    const updated = projects.setProjectPolicy(project.id, { finish: 'commit-and-verify' })
    const landing = configOnDisk(updated).landing as Record<string, unknown>
    expect(landing.finish).toBe('commit-and-verify')
    expect(landing.strategy).toBeUndefined()
    expect(landing.target).toBe('main')
  })

  it('treats an empty custom instruction as “use the default”, not as an empty instruction', () => {
    const project = makeProject({ landing: { finish: 'custom', finishInstruction: 'run /commit' } })
    expect(resolveFinishPolicy(null, project).instruction).toBe('run /commit')

    const updated = projects.setProjectPolicy(project.id, { finishInstruction: '  ' })
    expect((configOnDisk(updated).landing as Record<string, unknown>).finishInstruction).toBeUndefined()
    expect(resolveFinishPolicy(null, updated).instruction).not.toBe('')
  })

  it('refuses what a resolver could only read as silence', () => {
    const project = makeProject()
    expect(() => projects.setProjectPolicy(project.id, { finish: 'lands-it' as never })).toThrow(
      /finish policy/
    )
    expect(() => projects.setProjectPolicy(project.id, { poolSize: 0 })).toThrow(/between 1 and 32/)
    expect(() => projects.setProjectPolicy(project.id, { landingTarget: '   ' })).toThrow(/empty/)
    expect(() => projects.setProjectPolicy(project.id, { completion: 'careful' as never })).toThrow(
      /completion mode/
    )
  })

  it('refuses to overwrite a project.json it cannot parse', () => {
    const project = makeProject({ check: [] })
    writeFileSync(
      join(project.root, '.warmstart', 'project.json'),
      '{ "schema_version": 1, // a comment JSON does not have\n}'
    )
    expect(() => projects.setProjectPolicy(project.id, { finish: 'commit-only' })).toThrow(
      /not valid JSON/
    )
  })
})

/**
 * ⛔ The cached row is not the config. `projects.config_json` is a copy of a file in the *user's own
 * repo*, and everything the landing gate turns on is read out of it — so the question is not whether
 * the copy is correct but when it was taken.
 *
 * ⭐ t338, 2026-09-10, is the whole reason these exist. The rename moved
 * `.multi_agent_controller/project.json` to `.warmstart/project.json` while a pre-rename daemon was
 * still running; its next reload found neither path and cached `{schema_version: 1}`. The new build
 * could read the new path perfectly well and never did, because `dispatch` only reloads on a *cold*
 * dispatch and every run of that task resumed one warm conversation. Three runs of the branch were
 * verified against real checks; the next two stopped at "this project defines no check commands".
 */
describe('reading a project’s config at the moment it is used', () => {
  it('picks up checks a stale row does not have', () => {
    const project = makeProject({ check: ['npm test'] })
    expect(projects.policyFor(project).check).toEqual(['npm test'])

    writeFileSync(
      join(project.root, '.warmstart', 'project.json'),
      JSON.stringify({ schema_version: 1, check: ['npm test', 'npm run build'] }, null, 2)
    )
    // The row still answers with what it was told last, which is exactly the failure mode.
    expect(projects.policyFor(projects.requireProject(project.id)).check).toEqual(['npm test'])

    const fresh = projects.reloadProjectIfPresent(project.id)
    expect(fresh).not.toBeNull()
    expect(projects.policyFor(fresh as Project).check).toEqual(['npm test', 'npm run build'])
  })

  it('recovers a project whose config was blanked by a build that could not see the new path', () => {
    // The row a pre-rename daemon left behind: no checks, no path, and the file sitting right there.
    const project = makeProject({ check: ['npm test'] })
    const legacy = join(project.root, '.multi_agent_controller')
    mkdirSync(legacy, { recursive: true })
    rmSync(join(project.root, '.warmstart'), { recursive: true, force: true })
    const blanked = projects.reloadProject(project.id)
    expect(blanked.configPath).toBeNull()
    expect(projects.policyFor(blanked).check).toEqual([])

    mkdirSync(join(project.root, '.warmstart'), { recursive: true })
    writeFileSync(
      join(project.root, '.warmstart', 'project.json'),
      JSON.stringify({ schema_version: 1, check: ['npm test'] }, null, 2)
    )
    const recovered = projects.reloadProjectIfPresent(project.id)
    expect(projects.policyFor(recovered as Project).check).toEqual(['npm test'])
  })

  it('answers null rather than throwing for a project that is gone', () => {
    expect(projects.reloadProjectIfPresent('no-such-project')).toBeNull()
  })
})
