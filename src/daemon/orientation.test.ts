import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORIENTATION_READING_ORDER, PROJECT_DOC_NAMES } from '@shared/tasks.js'
import type { Project, ProjectConfig } from '@shared/tasks.js'

/**
 * What a **cold** agent is told before it is told the task.
 *
 * ⛔ The whole feature is *cold only*, and half of these tests are about the word *only*. The
 * orientation sentence and the operator's seed both travel on exactly the prompts that restate the
 * task's own instruction — a session that already holds this task's context has read them, and
 * re-sending them is the same re-teaching t260 removed from follow-ups and t286 removed from
 * ordinary work turns. The prompt-level tests at the bottom pin that, because the unit tests above
 * them cannot: `coldStartBlock` will happily build a block for a warm task, and it is `promptFor`
 * that decides not to ask.
 *
 * ⚠️ Against real directories, because *is the file there* is the only question `orientationDocs`
 * asks. A mocked `existsSync` would prove the filter runs, not that a project that took the
 * add-project wizard's scaffolding gets the sentence its scaffolding earned.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let orientation: typeof import('./orientation.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let workers: typeof import('./workers.js')

let seq = 0

/** A project rooted at a fresh directory holding `docs`, configured with `config`. */
function makeProject(docs: string[], config?: Partial<ProjectConfig>): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  for (const name of docs) writeFileSync(join(root, name), `# ${name}\n`)
  if (config) {
    mkdirSync(join(root, '.multi_agent_controller'), { recursive: true })
    writeFileSync(
      join(root, '.multi_agent_controller', 'project.json'),
      JSON.stringify({ schema_version: 1, name: `repo${seq}`, ...config }, null, 2)
    )
  }
  return projects.addProject({ root })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-orientation-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  orientation = await import('./orientation.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  workers = await import('./workers.js')
  db.openDb(join(dir, 'orientation.db'))
  workers.createWorker({ adapterId: 'claude-code', label: 'claude-1', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('which orientation docs a project has', () => {
  it('names only the ones on disk', () => {
    const project = makeProject(['AGENTS.md', 'README.md'])
    expect(orientation.orientationDocs(project.root)).toEqual(['AGENTS.md', 'README.md'])
  })

  /**
   * ⛔ Rules, then state, then what the thing is — not the order any other list holds them in.
   * `AGENTS.md` is what an agent must not break and is worth reading before it can break anything.
   */
  it('reads them rules-first, not in the wizard’s order', () => {
    const project = makeProject(['README.md', 'AGENTS.md', 'HANDOFF.md'])
    expect(orientation.orientationDocs(project.root)).toEqual([
      'AGENTS.md',
      'HANDOFF.md',
      'README.md'
    ])
  })

  /**
   * ⛔ The two lists must hold the same **set**. `PROJECT_DOC_NAMES` is what the add-project wizard
   * offers to scaffold; `ORIENTATION_READING_ORDER` is what a cold prompt names. A name in one and
   * not the other is either a file the wizard writes and no prompt mentions, or a prompt telling an
   * agent to read a file nothing ever creates.
   */
  it('covers exactly the documents the wizard scaffolds', () => {
    expect([...ORIENTATION_READING_ORDER].sort()).toEqual([...PROJECT_DOC_NAMES].sort())
  })

  it('is empty for a root that does not exist', () => {
    expect(orientation.orientationDocs(join(dir, 'no-such-directory'))).toEqual([])
  })
})

describe('the orientation sentence', () => {
  it('names each doc with one clause on what it holds', () => {
    const project = makeProject(['AGENTS.md', 'HANDOFF.md', 'README.md'])
    const sentence = orientation.orientationSentence(project)
    expect(sentence).toContain('`AGENTS.md` (how to work in this codebase)')
    expect(sentence).toContain('`HANDOFF.md` (where the work currently stands)')
    expect(sentence).toContain('`README.md` (what this project is)')
    // ⚠️ One list, read as English, not three sentences or a bulleted block.
    expect(sentence).toContain('and `README.md`')
    expect(sentence).toContain('at the root of this project')
  })

  it('does not say “and” when there is only one', () => {
    const project = makeProject(['README.md'])
    const sentence = orientation.orientationSentence(project) ?? ''
    expect(sentence).toContain('Start by reading `README.md` (what this project is), at the root')
    expect(sentence).not.toContain(' and ')
  })

  /**
   * ⛔ The reason this is detected rather than declared. Telling an agent to read `HANDOFF.md` in a
   * repository that has never had one sends it looking, finding nothing, and spending a paragraph
   * deciding whether the tool is wrong or the checkout is.
   */
  it('is nothing at all for a project that keeps none of them', () => {
    const project = makeProject([])
    expect(orientation.orientationSentence(project)).toBeNull()
  })

  it('is nothing when the project has said off', () => {
    const project = makeProject(['AGENTS.md'], { prompt: { orientation: 'off' } })
    expect(orientation.orientationSentence(project)).toBeNull()
  })

  /** ⚠️ Absent is `auto`: a project that has never been asked still gets the line. */
  it('is present for a project that has never been asked', () => {
    const project = makeProject(['AGENTS.md'], { check: ['npm test'] })
    expect(orientation.orientationSentence(project)).toContain('`AGENTS.md`')
  })
})

describe('the cold-start block', () => {
  it('puts the operator’s seed after the doc line, not instead of it', () => {
    const project = makeProject(['AGENTS.md'], {
      prompt: { seed: 'Read CLAUDE.md before you start.' }
    })
    const block = orientation.coldStartBlock(project) ?? ''
    expect(block.indexOf('`AGENTS.md`')).toBeLessThan(block.indexOf('Read CLAUDE.md'))
  })

  /**
   * ⚠️ Verbatim. It is the operator's own prompt text; nothing here reformats it, truncates it or
   * wraps it in a sentence of its own.
   */
  it('carries the seed exactly as it was typed', () => {
    const seed = 'The API contract lives in docs/api.md.\n\nDo not touch generated/.'
    const project = makeProject([], { prompt: { seed } })
    expect(orientation.coldStartBlock(project)).toBe(seed)
  })

  it('is the seed alone when the project has said off', () => {
    const project = makeProject(['AGENTS.md'], {
      prompt: { orientation: 'off', seed: 'Read CLAUDE.md.' }
    })
    expect(orientation.coldStartBlock(project)).toBe('Read CLAUDE.md.')
  })

  it('is nothing for a project with neither, and for no project at all', () => {
    expect(orientation.coldStartBlock(makeProject([]))).toBeNull()
    expect(orientation.coldStartBlock(null)).toBeNull()
  })

  /** ⚠️ A seed of spaces is not a seed. It is what a cleared text box leaves behind. */
  it('ignores a blank seed', () => {
    const project = makeProject([], { prompt: { seed: '   ' } })
    expect(orientation.coldStartBlock(project)).toBeNull()
  })
})

describe('writing the cold-start settings from the app', () => {
  it('stores the orientation choice where the resolver reads it', () => {
    const project = makeProject(['AGENTS.md'])
    const off = projects.setProjectPolicy(project.id, { promptOrientation: 'off' })
    expect(orientation.orientationSentence(off)).toBeNull()

    const back = projects.setProjectPolicy(project.id, { promptOrientation: 'auto' })
    expect(orientation.orientationSentence(back)).toContain('`AGENTS.md`')
  })

  it('stores the seed, trims it, and clears it on empty', () => {
    const project = makeProject([])
    const seeded = projects.setProjectPolicy(project.id, { promptSeed: '  Read CLAUDE.md.  ' })
    expect(orientation.coldStartBlock(seeded)).toBe('Read CLAUDE.md.')

    const cleared = projects.setProjectPolicy(project.id, { promptSeed: '' })
    expect(orientation.coldStartBlock(cleared)).toBeNull()
  })

  /**
   * ⛔ The property that makes the writer safe to put behind a button: it **patches**. Setting the
   * seed must not silently answer the orientation question, and neither may touch a key this tool
   * has never heard of.
   */
  it('patches, leaving every key it was not asked about alone', () => {
    const project = makeProject(['AGENTS.md'], {
      prompt: { orientation: 'off' },
      check: ['npm test']
    })
    const updated = projects.setProjectPolicy(project.id, { promptSeed: 'Read CLAUDE.md.' })
    expect(updated.config?.prompt?.orientation).toBe('off')
    expect(updated.config?.check).toEqual(['npm test'])
  })

  it('refuses an orientation choice that is not one', () => {
    const project = makeProject([])
    expect(() =>
      projects.setProjectPolicy(project.id, { promptOrientation: 'sometimes' as never })
    ).toThrow(/not an orientation choice/)
  })
})

/**
 * The half the unit tests cannot reach.
 *
 * ⛔ `coldStartBlock` does not know whether a session is cold — `promptFor` does, and it is the one
 * that has to not ask. These four pin the gate itself.
 */
describe('where the cold-start block travels', () => {
  const seeded = (): Project =>
    makeProject(['AGENTS.md'], { prompt: { seed: 'Read CLAUDE.md before you start.' } })

  it('leads a cold prompt, ahead of the task', () => {
    const project = seeded()
    const task = tasks.createTask({ title: 'Cold work', status: 'ready', projectId: project.id })
    const prompt = scheduler.promptFor(task, 'claude-code', false, { markDelivered: false }).text
    expect(prompt).toContain('`AGENTS.md`')
    expect(prompt).toContain('Read CLAUDE.md before you start.')
    expect(prompt.indexOf('`AGENTS.md`')).toBeLessThan(prompt.indexOf('Cold work'))
  })

  /** ⛔ The point of t286. The session has read this already; sending it again is the confusion. */
  it('is withheld from a resumed run into the same session', () => {
    const project = seeded()
    const task = tasks.createTask({ title: 'Warm work', status: 'ready', projectId: project.id })
    scheduler.promptFor(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'human', 'also check the linter')
    const prompt = scheduler.promptFor(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false
    }).text
    expect(prompt).toContain('also check the linter')
    expect(prompt).not.toContain('`AGENTS.md`')
    expect(prompt).not.toContain('Read CLAUDE.md before you start.')
  })

  /** ⚠️ A compaction may have carried the orientation off with everything else, so it comes back. */
  it('returns after a compaction', () => {
    const project = seeded()
    const task = tasks.createTask({ title: 'Compacted work', status: 'ready', projectId: project.id })
    scheduler.promptFor(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'human', 'also check the linter')
    const prompt = scheduler.promptFor(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false,
      compacted: true
    }).text
    expect(prompt).toContain('`AGENTS.md`')
    expect(prompt).toContain('Read CLAUDE.md before you start.')
  })

  it('is absent for a task belonging to no project', () => {
    const task = tasks.createTask({ title: 'Projectless', status: 'ready' })
    const prompt = scheduler.promptFor(task, 'claude-code', false, { markDelivered: false }).text
    expect(prompt).toContain('Projectless')
    expect(prompt).not.toContain('at the root of this project')
  })
})
