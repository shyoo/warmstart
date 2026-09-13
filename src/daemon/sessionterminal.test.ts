import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Who may type into an agent, and what a pane may show when nobody can.
 *
 * ⛔ **The measured bug.** Measured 2026-09-13 on claude 2.1.270: a dispatched session runs
 * `--input-format stream-json`, whose stdin is newline-delimited JSON. Three raw keystrokes written
 * ahead of the next message produced
 * `Error parsing streaming input line (type=user, 112 chars): SyntaxError` and **exit 1** — the
 * identical run without them exited 0. The Session TUI tab offered *take the keyboard* on exactly
 * those sessions, so one stray character ended somebody's task.
 *
 * ⛔ And the same root cause a second time, in a place nobody was watching: `askForWrapUp` wrote its
 * prompt with `writeSession(id, text + '\r')`. On a pipe that is not a line at all — it buffers,
 * never parses, and then corrupts whatever message comes next. Every soft cancel of a dispatched
 * task waited out its ninety seconds and logged *did not wrap up in time* about a prompt the agent
 * had never been shown. `cancel.ts` uses `sendPrompt` now, which encodes what the transport expects.
 */

let dir: string
let db: typeof import('./db.js')
let sessions: typeof import('./sessions.js')

const WORKER = 'eeeeeeee-0000-4000-8000-000000000001'
const AGY_WORKER = 'eeeeeeee-0000-4000-8000-000000000002'

function seedSession(opts: {
  id: string
  transport: 'pty' | 'stream'
  state?: string
  workerId?: string
  adapterId?: string
}): void {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                             tokens_since_compact, started_at)
       values (?,?,?,?,?,?,'work',0,?)`
    )
    .run(
      opts.id,
      opts.workerId ?? WORKER,
      opts.adapterId ?? 'claude-code',
      opts.transport,
      join(dir, 'ws'),
      opts.state ?? 'live',
      Date.now()
    )
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-sessterm-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  sessions = await import('./sessions.js')
  db.openDb(join(dir, 'sessterm.db'))
  const worker = db.db().prepare(
    `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                          max_concurrent, role, created_at)
     values (?,?,?,?,1,0,1,'worker',?)`
  )
  worker.run(WORKER, 'claude', 'claude-code', join(dir, 'w1'), Date.now())
  worker.run(AGY_WORKER, 'agy', 'antigravity-cli', join(dir, 'w2'), Date.now())
})

beforeEach(() => db.db().exec('delete from sessions'))

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('typing into a session', () => {
  it('is refused on a pipe session, and says what to do instead', () => {
    seedSession({ id: 's-pipe', transport: 'stream' })
    expect(() => sessions.writeSession('s-pipe', 'hello')).toThrow(/pipe, not a terminal/)
  })

  /**
   * ⚠️ The transport is asked about before liveness on purpose. A caller told only `not live` would
   * reasonably try again once the process was up, and then find out the expensive way.
   */
  it('is refused on a pipe session that is not even running, for the same reason', () => {
    seedSession({ id: 's-pipe-dead', transport: 'stream', state: 'closed' })
    expect(() => sessions.writeSession('s-pipe-dead', 'hello')).toThrow(/pipe, not a terminal/)
  })

  it('is still offered to a real terminal, which is the one that has a keyboard', () => {
    seedSession({ id: 's-tty', transport: 'pty' })
    // ⚠️ Not live in this suite — no process was spawned — so the refusal it gets is about *that*,
    // which is the proof that the transport gate let it through.
    expect(() => sessions.writeSession('s-tty', 'hello')).toThrow(/not live/)
  })
})

/**
 * The other half of the answer: a dispatched agent has no terminal, so one is opened beside it.
 *
 * ⚠️ These are the refusals only. Actually opening one spawns the vendor's CLI, which L1 has no
 * business doing — the spawn itself is covered where every other spawn is, by driving the app.
 */
describe('opening a real terminal on a conversation', () => {
  it('refuses a conversation it has never heard of', () => {
    expect(() => sessions.attachTerminal('s-nobody')).toThrow(/not known/)
  })

  /**
   * ⛔ A second process on one live conversation is two agents in one context — two turns billed to
   * whichever run is open, and a `task_complete` that could settle the wrong task. Forking is what
   * makes this safe, and an adapter that cannot fork gets told so rather than being risked.
   */
  it('refuses on an adapter that cannot fork a conversation', () => {
    seedSession({
      id: 's-agy',
      transport: 'stream',
      workerId: AGY_WORKER,
      adapterId: 'antigravity-cli'
    })
    expect(() => sessions.attachTerminal('s-agy')).toThrow(/cannot fork/)
  })

  /**
   * ⛔ **Even a resting conversation is forked rather than resumed**, which is the counter-intuitive
   * half. `spawnSession`'s resume path reuses the *same row*, so the conversation would come back
   * marked `pty` while still reading `purpose: 'work'` — and `warmSessionFor` offers any live, idle
   * session on a task's own runs, so the next dispatch would write scheduled unattended work into the
   * terminal a person is sitting at. A fork leaves the row exactly as resumable as it was.
   */
  it('refuses a resting conversation too, rather than resuming the row out from under the scheduler', () => {
    seedSession({
      id: 's-agy-done',
      transport: 'stream',
      state: 'closed',
      workerId: AGY_WORKER,
      adapterId: 'antigravity-cli'
    })
    expect(() => sessions.attachTerminal('s-agy-done')).toThrow(/cannot fork/)
  })
})

/**
 * ⚠️ The log is empty until a session says something, and asking about one that never existed is not
 * an error: a pane opens against whatever id it was given and fills from the live feed either way.
 */
describe('the decoded log a live view reads back', () => {
  it('answers for an unknown session with nothing rather than a throw', () => {
    expect(sessions.streamLog('s-nobody')).toEqual([])
  })
})
