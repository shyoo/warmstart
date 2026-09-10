import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Who pays for a readable board.
 *
 * ⛔ **This is the only judgment call that spends a turn without changing what the fleet does.** It
 * writes `titleSummary`, which nothing outside the UI reads — the task dispatches, runs and finishes
 * identically whether or not it is ever labelled. Everything below is about the cost discipline that
 * follows from that: off unless asked for, one question per tick, and never twice about the same
 * task.
 *
 * ⚠️ Driven through `tick()` rather than by calling the sweep directly. What is under test is that a
 * consult is *filed* by the free loop and that the setting really gates it, and a test that reached
 * past the loop to the function could pass with the call site deleted.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let settings: typeof import('./settings.js')
let controller: typeof import('./controller.js')
let scheduler: typeof import('./scheduler.js')
let judgment: typeof import('./judgment.js')

/** Long enough to be worth a label — see `TITLE_SUMMARY_THRESHOLD`. */
function longTitle(): string {
  return (
    'I wonder if we can use an AI-summarized title for each task, because each task description is ' +
    'lengthy and the board is unreadable.'
  )
}

function titleConsults(): ReturnType<typeof controller.pendingConsults> {
  return controller.pendingConsults().filter((c) => c.kind === 'title')
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-titlesummary-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  settings = await import('./settings.js')
  controller = await import('./controller.js')
  scheduler = await import('./scheduler.js')
  judgment = await import('./judgment.js')
  db.openDb(join(dir, 'titlesummary.db'))
})

beforeEach(() => {
  db.db().exec('delete from consults')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
  settings.setSetting('summariseTitles', false)
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

describe('asking the controller to name a long task', () => {
  it('is off until the operator asks for it', async () => {
    // ⛔ The default, and the one that matters most: an install that never touches this setting must
    // never spend a turn on a label. A board of paragraphs is the status quo, not a bug being fixed
    // at the operator's expense.
    expect(settings.DEFAULT_SETTINGS.summariseTitles).toBe(false)
    tasks.createTask({ title: longTitle() })
    await scheduler.tick()
    expect(titleConsults()).toHaveLength(0)
  })

  it('files one question once it is on', async () => {
    const task = tasks.createTask({ title: longTitle() })
    settings.setSetting('summariseTitles', true)
    await scheduler.tick()

    const filed = titleConsults()
    expect(filed).toHaveLength(1)
    expect(filed[0]?.subjectId).toBe(task.id)
    expect(filed[0]?.question).toContain(longTitle())
  })

  it('leaves a title that is already one line alone', async () => {
    // ⚠️ Asking for a one-line summary of one line invites a rewrite of a title the operator chose.
    tasks.createTask({ title: 'Fix the router tie-break' })
    settings.setSetting('summariseTitles', true)
    await scheduler.tick()
    expect(titleConsults()).toHaveLength(0)
  })

  it('asks about one task per tick, however many are waiting', async () => {
    // ⛔ An install that switches this on with a full board must not commission a question for every
    // row at once. The hourly cap would stop the drain, but the queue itself would already be a
    // hundred rows of work nobody asked for.
    for (let i = 0; i < 5; i++) tasks.createTask({ title: `${longTitle()} (${i})` })
    settings.setSetting('summariseTitles', true)
    await scheduler.tick()
    expect(titleConsults()).toHaveLength(1)
  })

  it('does not ask about a task that already has a label', async () => {
    const task = tasks.createTask({ title: longTitle() })
    tasks.updateTask(task.id, { titleSummary: 'Summarise task titles' })
    settings.setSetting('summariseTitles', true)
    await scheduler.tick()
    expect(titleConsults()).toHaveLength(0)
  })

  it('does not ask about work that is over', async () => {
    // ⚠️ A label is for a board still being read. Buying one for a task nobody will open again is the
    // purest waste on offer here.
    const task = tasks.createTask({ title: longTitle() })
    tasks.setStatus(task.id, 'completed')
    settings.setSetting('summariseTitles', true)
    await scheduler.tick()
    expect(titleConsults()).toHaveLength(0)
  })

  it('stores the answer as a label and leaves the prompt untouched', async () => {
    const task = tasks.createTask({ title: longTitle() })
    settings.setSetting('summariseTitles', true)
    await scheduler.tick()

    const filed = titleConsults()[0]
    expect(filed).toBeDefined()
    const applied = judgment.applyConsult(filed!, { summary: 'Summarise long task titles' })

    expect(applied.ok).toBe(true)
    const after = tasks.getTask(task.id)
    expect(after?.titleSummary).toBe('Summarise long task titles')
    // ⛔ `title` is what `promptFor()` sends to the agent. If this ever changes, the feature has
    // started editing instructions instead of labelling them.
    expect(after?.title).toBe(longTitle())
  })
})
