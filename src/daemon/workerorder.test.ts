import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The order the operator puts the fleet in.
 *
 * ⭐ The fleet strip is a row of cards people learn the shape of, and until 2026-08-29 that shape was
 * whatever order the accounts happened to be commissioned in — with no way to change it short of
 * retiring a worker and signing it in again. Settings > Workers now owns the ordering and the strip
 * reads it, because `listWorkers()` is the only thing either of them asks.
 *
 * ⛔ Ordering is display only. Nothing here may become a routing input: the scheduler's order is its
 * scoring, and a stored position that quietly biased dispatch would be a priority list wearing the
 * costume of a cosmetic control.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let sessions: typeof import('./sessions.js')
let scheduler: typeof import('./scheduler.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-workerorder-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  sessions = await import('./sessions.js')
  scheduler = await import('./scheduler.js')
  db.openDb(join(dir, 'workerorder.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

let seq = 0
const add = (label?: string) => {
  seq += 1
  return workers.createWorker({ adapterId: 'claude-code', label: label ?? `w${seq}` })
}

const labels = () => workers.listWorkers().map((w) => w.label)

describe('making a worker less parallel', () => {
  it('keeps its already live work sessions and applies the lower limit only to new work', () => {
    const worker = workers.createWorker({ adapterId: 'claude-code', label: 'three jobs', maxConcurrent: 3 })
    const now = Date.now()
    for (const id of ['running-1', 'running-2', 'running-3']) {
      db.db()
        .prepare(
          `insert into sessions (id, worker_id, adapter_id, transport, state, purpose, started_at)
           values (?, ?, 'claude-code', 'stream', 'live', 'work', ?)`
        )
        .run(id, worker.id, now)
    }

    const reduced = workers.updateWorker(worker.id, { maxConcurrent: 1 })

    expect(reduced.maxConcurrent).toBe(1)
    expect(sessions.sessionsForWorker(worker.id).map((session) => session.id).sort()).toEqual([
      'running-1',
      'running-2',
      'running-3'
    ])
    // A new task is held at the newly lowered ceiling, while the existing three finish normally.
    expect(scheduler.atCapacity(sessions.sessionsForWorker(worker.id), reduced.maxConcurrent, null)).toBe(true)
  })
})

describe('putting the fleet in an order', () => {
  it('commissions each worker at the end, so an arranged strip does not rearrange itself', () => {
    add('alpha')
    add('bravo')
    add('charlie')
    expect(labels()).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('takes a whole ordering and returns the fleet as it now stands', () => {
    const ids = workers.listWorkers().map((w) => w.id)
    const after = workers.reorderWorkers([ids[2] as string, ids[0] as string, ids[1] as string])
    expect(after.map((w) => w.label)).toEqual(['charlie', 'alpha', 'bravo'])
    expect(labels()).toEqual(['charlie', 'alpha', 'bravo'])
  })

  it('is idempotent, because a full ordering sent twice is the same ordering', () => {
    const ids = workers.listWorkers().map((w) => w.id)
    workers.reorderWorkers(ids)
    workers.reorderWorkers(ids)
    expect(labels()).toEqual(['charlie', 'alpha', 'bravo'])
  })

  it('adds a new worker after the ones already placed, not at the top', () => {
    add('delta')
    expect(labels()).toEqual(['charlie', 'alpha', 'bravo', 'delta'])
  })

  it('refuses an id it does not know rather than reordering everything else around it', () => {
    const before = labels()
    expect(() => workers.reorderWorkers(['nope'])).toThrow(/no worker/)
    expect(labels()).toEqual(before)
  })

  it('refuses an ordering that lists the same worker twice', () => {
    const ids = workers.listWorkers().map((w) => w.id)
    expect(() => workers.reorderWorkers([ids[0] as string, ids[0] as string])).toThrow(/twice/)
  })

  /**
   * ⛔ The caller is a UI that lists live workers only. A retired worker is absent from that list
   * because it is retired, not because somebody wants it first — and it comes back into the list the
   * moment anything un-retires it.
   */
  it('leaves a worker the ordering never mentioned behind the ones it did', () => {
    const live = workers.listWorkers()
    const retired = workers.retireWorker(live[0]?.id as string)
    const rest = workers.listWorkers().map((w) => w.id)
    workers.reorderWorkers([...rest].reverse())

    const all = workers.listWorkers(true).map((w) => w.label)
    expect(all[all.length - 1]).toBe(retired.label)
  })
})
