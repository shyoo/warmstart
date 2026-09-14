import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A usage-probe PTY answers the TUI's terminal queries, because nobody else will.
 *
 * ⭐ Measured 2026-09-13 (t3): Muse Code 1.2.1 writes `ESC[6n` at startup and exits 0 at +6.4s when
 * it is not answered — before `/usage` is typed — so every probe read *"the probe session did not
 * start"* against a signed-in, folder-trusted worker. A person's terminal answers that query itself
 * (xterm.js does); the probe has no terminal on the other end. See termquery.ts.
 *
 * ⚠️ Driven through the real `spawnSession` on a declarative adapter pointing at `sh`, so what is
 * proven is the wiring in sessions.ts and not the answerer alone (termquery.test.ts has that). The
 * script puts the PTY in raw mode, asks where the cursor is, and echoes the six bytes it gets back
 * with the escape stripped — so the backscroll carries `cpr:[1;1R` only if the daemon answered.
 */

const ADAPTER_ID = 'test-cpr-probe'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let sessions: typeof import('./sessions.js')
let adapters: typeof import('./adapters/index.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-probepty-'))
  process.env.WARMSTART_DATA_DIR = dir
  mkdirSync(join(dir, 'adapters'), { recursive: true })
  writeFileSync(
    join(dir, 'adapters', `${ADAPTER_ID}.json`),
    JSON.stringify({
      schema_version: 1,
      id: ADAPTER_ID,
      label: 'test cpr probe (not an agent)',
      command: 'sh',
      version_args: ['-c', 'echo sh'],
      cost_model_id: 'anthropic.subscription.2026-08'
    })
  )
  db = await import('./db.js')
  workers = await import('./workers.js')
  sessions = await import('./sessions.js')
  adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'probepty.db'))
  adapters.loadAdapters()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle is not a test failure.
  }
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Asks where the cursor is and echoes the six bytes it is told, escape stripped. */
const ASK_CPR = [
  '-c',
  // Raw mode so the reply is delivered as it arrives rather than held for a newline.
  'stty raw -echo; printf "\\033[6n"; x=$(head -c 6 | tr -d "\\033"); echo "cpr:$x"'
]

// ⚠️ One worker for both cases: a declarative adapter is limited to a single account.
let workerId: string

/** Close and wait for the exit, so it is not reported into a database `afterAll` has closed. */
const closeAndWait = async (id: string): Promise<void> => {
  sessions.closeSession(id)
  const by = Date.now() + 5_000
  while (Date.now() < by && sessions.listSessions().some((s) => s.id === id)) await wait(50)
}

describe('a probe PTY with no terminal behind it', () => {
  beforeAll(() => {
    workerId = workers.createWorker({ adapterId: ADAPTER_ID, label: 'cpr' }).id
  })

  // ⚠️ `stty` and `sh` — the query is answered on every platform, but the fixture that proves it
  // through a real PTY is POSIX.
  it.skipIf(process.platform === 'win32')(
    'answers a cursor-position request so a TUI that waits for one starts',
    async () => {
      const session = sessions.spawnSession({
        workerId,
        purpose: 'probe',
        transport: 'pty',
        argv: ASK_CPR,
        cols: 80,
        rows: 24
      })
      const by = Date.now() + 10_000
      let said = ''
      while (Date.now() < by) {
        said = sessions.backscroll(session.id)
        if (said.includes('cpr:')) break
        await wait(100)
      }
      expect(said).toContain('cpr:[1;1R')
      await closeAndWait(session.id)
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')('leaves a session somebody is watching alone', async () => {
    // A `login` session is drawn by the renderer's xterm, which answers the query itself; a second
    // reply from the daemon would be a keystroke the person never typed.
    const session = sessions.spawnSession({
      workerId,
      purpose: 'login',
      transport: 'pty',
      argv: ASK_CPR,
      cols: 80,
      rows: 24
    })
    await wait(1500)
    expect(sessions.backscroll(session.id)).not.toContain('cpr:[1;1R')
    await closeAndWait(session.id)
  })
})
