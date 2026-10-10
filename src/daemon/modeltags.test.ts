import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'
import type { ModelRoute } from '@shared/modelroutes.js'

/**
 * Model tags end to end in the daemon (t1042, plan t1024): what the migration did to old data, what
 * the doors let in, and what a task asking for several tags is held for.
 *
 * ⚠️ The UI suite's worker has no credentials, so nothing about actual runs is asserted there; the
 * claims about routing are made here against `chooseTarget` and the stored rows.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scoring: typeof import('./scoring.js')
let api: typeof import('./api.js')
let dbPath: string
let origClaudeInstalled: () => boolean

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-modeltags-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scoring = await import('./scoring.js')
  api = await import('./api.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  origClaudeInstalled = claudeCode.isInstalled
  claudeCode.isInstalled = () => true
  dbPath = join(dir, 'modeltags.db')
  db.openDb(dbPath)
})

afterAll(async () => {
  const { claudeCode } = await import('./adapters/claude-code.js')
  claudeCode.isInstalled = origClaudeInstalled
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

beforeEach(() => {
  db.db().prepare('update workers set enabled = 0').run()
})

let seq = 0
function account(routes: ModelRoute[] | null, defaults: { model?: string; effort?: string } = {}): Worker {
  seq += 1
  const w = workers.createWorker({ adapterId: 'claude-code', label: `TagWorker-${seq}`, enabled: true })
  return workers.updateWorker(w.id, {
    defaultModel: defaults.model ?? 'claude-opus-5-5',
    defaultEffort: defaults.effort ?? 'medium',
    ...(routes ? { modelRoutes: routes } : {})
  })
}

const route = (model: string, effort: string | null, tags: string[], auto = true): ModelRoute => ({ model, effort, tags, auto })

function choose(worker: Worker, constraints: Record<string, unknown>) {
  const task = tasks.createTask({
    title: `tags ${seq}`,
    constraints: { workerId: worker.id, adapterId: 'claude-code', ...constraints }
  })
  return scoring.chooseTarget(task)
}

describe('routing on several tags', () => {
  const table = [
    route('claude-opus-5-5', 'high', ['High']),
    route('claude-opus-5-5', 'medium', ['Med', 'Audio']),
    route('claude-sonnet-5', 'medium', ['Low', 'ZDR', 'Audio'])
  ]

  it('⭐ routes to the pair that carries every tag, even when it is the model’s weaker row', () => {
    const w = account(table)
    const got = choose(w, { modelPolicy: 'auto', modelTags: ['Audio', 'Med'] })
    expect(got.worker?.id).toBe(w.id)
    expect(got.model).toBe('claude-opus-5-5')
    expect(got.effort).toBe('medium')
  })

  it('⛔ holds the task, naming the whole requirement, when no pair carries all of them', () => {
    const w = account(table)
    const got = choose(w, { modelPolicy: 'auto', modelTags: ['ZDR', 'High'] })
    expect(got.worker).toBeNull()
    expect(got.reason).toContain('no routable model/effort pair with ZDR + High')
  })

  it('never lets a requirement go missing: a tag nothing carries is a hold, not a downgrade', () => {
    const w = account(table)
    const got = choose(w, { modelPolicy: 'auto', modelTags: ['Audio', 'Nonexistent'] })
    expect(got.worker).toBeNull()
  })

  it('checks the worker’s default pair when it has no auto rows', () => {
    // No table at all: the default model at the default effort, carrying only its built-in class tag.
    const w = account(null, { model: 'claude-haiku-4-5', effort: 'low' })
    expect(choose(w, { modelPolicy: 'auto', modelTags: ['Low'] }).worker?.id).toBe(w.id)
    expect(choose(w, { modelPolicy: 'auto', modelTags: ['Low', 'ZDR'] }).worker).toBeNull()
  })

  it('plain Auto Model keeps its candidate set, including a row with no tags', () => {
    const w = account([route('claude-opus-5-5', 'high', [])])
    const got = choose(w, { modelPolicy: 'auto' })
    expect(got.worker?.id).toBe(w.id)
    expect(got.model).toBe('claude-opus-5-5')
  })

  it('applies the requirement to a pinned model, preferring its own effort where that row matches', () => {
    const w = account(table)
    // Pinned to opus: the High row has no Audio, the Med row does, so the pair is opus · medium.
    const got = choose(w, { model: 'claude-opus-5-5', effort: 'high', modelPolicy: 'auto', modelTags: ['Audio'] })
    expect(got.worker?.id).toBe(w.id)
    expect(got.effort).toBe('medium')
  })
})

describe('the doors', () => {
  it('turns the old one-class request into one tag and stores nothing of the old key', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({ title: 'old caller' })
    const set = await handlers['task.setModel']({ id: task.id, model: '__auto__', effort: null, modelClass: 'low' })
    expect(set.constraints.modelTags).toEqual(['Low'])
    expect('modelClass' in set.constraints).toBe(false)
    const legacyString = await handlers['task.setModel']({ id: task.id, model: '__auto__:high', effort: null })
    expect(legacyString.constraints.modelTags).toEqual(['High'])
  })

  it('stores a multi-tag requirement tidied, and refuses a malformed or over-long one', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({ title: 'tidy' })
    const set = await handlers['task.setModel']({
      id: task.id,
      model: '__auto__',
      effort: null,
      modelTags: [' ZDR ', 'zdr', 'Audio', '']
    })
    expect(set.constraints.modelTags).toEqual(['ZDR', 'Audio'])
    expect(() => handlers['task.setModel']({ id: task.id, model: '__auto__', effort: null, modelTags: ['x'.repeat(30)] })).toThrow(
      /longer than 24/
    )
    expect(() => handlers['task.setModel']({ id: task.id, model: '__auto__', effort: null, modelTags: 'ZDR' as never })).toThrow(
      /must be a list/
    )
  })

  it('⭐ reassigns the worker, the model policy and the tags in one call, so no tick sees half of it', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const w = account([route('claude-opus-5-5', 'medium', ['Med', 'Audio'])])
    const task = tasks.createTask({ title: 'atomic' })
    const moved = await handlers['task.setWorker']({
      id: task.id,
      workerId: w.id,
      model: null,
      modelPolicy: 'auto',
      modelTags: ['Med', 'Audio']
    })
    expect(moved.constraints).toMatchObject({ workerId: w.id, modelPolicy: 'auto', modelTags: ['Med', 'Audio'] })
  })

  it('refuses a tag requirement a pinned account has no pair for, naming the tags', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const w = account([route('claude-opus-5-5', 'medium', ['Med'])])
    const task = tasks.createTask({ title: 'pinned, unmatched' })
    await expect(
      Promise.resolve().then(() =>
        handlers['task.setWorker']({ id: task.id, workerId: w.id, model: null, modelPolicy: 'auto', modelTags: ['Med', 'ZDR'] })
      )
    ).rejects.toThrow(/no Auto Model \(Med \+ ZDR\) route/)
  })
})

describe('⛔ migration 90 turns the one class into one tag and never opts a table into Auto', () => {
  const rewind = () => {
    db.db().exec(`pragma user_version = ${db.versionBefore("quota_preempt_json like '%odelClass%'")}`)
    db.closeDb()
    db.openDb(dbPath)
  }

  it('rewrites stored rows and task JSON, leaves an untouched worker alone, and replays cleanly', () => {
    const untouched = workers.createWorker({ adapterId: 'claude-code', label: 'Untouched', enabled: false })
    const touched = workers.createWorker({ adapterId: 'claude-code', label: 'Touched', enabled: false })
    db.db()
      .prepare('update workers set model_routes_json = ? where id = ?')
      .run(
        JSON.stringify([
          { model: 'claude-opus-5-5', effort: 'high', modelClass: null, auto: true },
          { model: 'claude-opus-5-5', effort: 'medium', modelClass: 'med', auto: true },
          { model: 'claude-sonnet-5', effort: 'medium', modelClass: 'low', auto: false }
        ]),
        touched.id
      )
    const task = tasks.createTask({ title: 'old constraints' })
    db.db()
      .prepare('update tasks set constraints_json = ?, child_defaults_json = ?, quota_preempt_json = ? where id = ?')
      .run(
        JSON.stringify({ modelPolicy: 'auto', modelClass: 'high', pieceConstraints: { modelClass: 'low' } }),
        JSON.stringify({ modelClass: 'med' }),
        JSON.stringify({ trigger: 'window', reason: 'x', preemptAt: 1, resumeAt: 2, reassignModelClass: 'high' }),
        task.id
      )

    rewind()
    const check = () => {
      expect(workers.requireWorker(touched.id).modelRoutes).toEqual([
        route('claude-opus-5-5', 'high', ['High']),
        route('claude-opus-5-5', 'medium', ['Med']),
        route('claude-sonnet-5', 'medium', ['Low'], false)
      ])
      // ⛔ No rows invented: an untouched table is still null, so it is still out of Auto Model.
      expect(workers.requireWorker(untouched.id).modelRoutes).toBeNull()
      const stored = db
        .db()
        .prepare('select constraints_json, child_defaults_json, quota_preempt_json from tasks where id = ?')
        .get(task.id) as { constraints_json: string; child_defaults_json: string; quota_preempt_json: string }
      expect(JSON.parse(stored.constraints_json)).toEqual({
        modelPolicy: 'auto',
        modelTags: ['High'],
        pieceConstraints: { modelTags: ['Low'] }
      })
      expect(JSON.parse(stored.child_defaults_json)).toEqual({ modelTags: ['Med'] })
      expect((JSON.parse(stored.quota_preempt_json) as { reassignModelTags: string[] }).reassignModelTags).toEqual(['High'])
      expect(stored.quota_preempt_json).not.toContain('odelClass')
      expect(tasks.requireTask(task.id).constraints.modelTags).toEqual(['High'])
    }
    check()

    // Replaying it is a no-op, not an error and not a second rewrite.
    rewind()
    check()
  })

  it('keeps a worker’s own tags exactly, and a later edit survives the replay', () => {
    const w = account([route('claude-opus-5-5', 'high', ['ZDR', 'Audio'])])
    rewind()
    expect(workers.requireWorker(w.id).modelRoutes).toEqual([route('claude-opus-5-5', 'high', ['ZDR', 'Audio'])])
  })

  it('reads a task row written before tags as the same requirement even if it escaped the migration', () => {
    const task = tasks.createTask({ title: 'escaped' })
    db.db().prepare('update tasks set constraints_json = ? where id = ?').run(JSON.stringify({ modelClass: 'med' }), task.id)
    expect(tasks.requireTask(task.id).constraints).toEqual({ modelTags: ['Med'] })
  })
})

describe('Auto Model written as a client writes it', () => {
  it('keeps the tags of `model: null, modelPolicy: auto`, and drops them for any other choice', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({ title: 'client shape' })
    const auto = await handlers['task.setModel']({
      id: task.id,
      model: null,
      modelPolicy: 'auto',
      modelTags: ['ZDR', 'Audio'],
      effort: null
    })
    expect(auto.constraints).toMatchObject({ modelPolicy: 'auto', modelTags: ['ZDR', 'Audio'] })
    const inherit = await handlers['task.setModel']({ id: task.id, model: null, modelPolicy: 'inherit', modelTags: [], effort: null })
    expect(inherit.constraints.modelTags).toBeUndefined()
    expect(inherit.constraints.modelPolicy).toBe('inherit')
  })
})
