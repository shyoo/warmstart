import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * An account's own containment choice, and the refusal that enforces it.
 *
 * ⛔ **The gate is a refusal, never a downgrade.** A worker set to `sandboxed-only` does not run a
 * bypassing adapter "more carefully" — it declines the candidate, and the task holds with a sentence
 * on its row. Running it sandboxed instead is the t250 stall: a headless CLI that cannot ask turns
 * every command into a denial and spends the window discovering it.
 *
 * ⛔ **The gate asks `headlessAuthority`, never an adapter name.** The test pins that too, by
 * flipping the *declaration* rather than the adapter id and watching the refusal follow it.
 *
 * ⭐ **Moved from the project to the worker (t545).** The setting used to live on
 * `ProjectConfig.permission.unattended`, gating every adapter a project's tasks could reach alike; an
 * account's own reach into the machine is a fact about that account, so it travels with
 * `Worker.unattendedAuthority` instead — the same account is exactly as trusted whichever project
 * hands it work, and a task with no project is gated exactly the same as one with a project.
 */

let dir: string
let kit: typeof import('./testkit.js')
let scoring: typeof import('./scoring.js')
let workers: typeof import('./workers.js')

let restore: Array<() => void> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-unattended-'))
  process.env.WARMSTART_DATA_DIR = dir
  const store = await import('./db.js')
  store.openDb(join(dir, 'unattended.db'))
  kit = await import('./testkit.js')
  scoring = await import('./scoring.js')
  workers = await import('./workers.js')

  // ⛔ A routing test must not also assert that a CLI is on this machine: `eligibility.ts` rejects an
  // uninstalled adapter before any other gate, so without this every case here would pass for the
  // wrong reason.
  const { claudeCode } = await import('./adapters/claude-code.js')
  const { openaiCompatible } = await import('./adapters/openai-compatible.js')
  for (const ad of [claudeCode, openaiCompatible]) {
    const original = ad.isInstalled
    ad.isInstalled = () => true
    restore.push(() => {
      ad.isInstalled = original
    })
  }
})

afterAll(() => {
  for (const undo of restore) undo()
  restore = []
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the default a worker is commissioned with', () => {
  /**
   * ⛔ Codex is the only adapter this can name anything other than `full-user` for — every other
   * adapter's `headlessAuthority` is already `full-user`, so `sandboxed-only` on it would simply
   * refuse the account it was just commissioned on.
   */
  it('opens a codex worker on sandboxed-only, its own real mode', () => {
    const w = workers.createWorker({ adapterId: 'openai-compatible', label: `Codex ${Math.random()}` })
    expect(w.unattendedAuthority).toBe('sandboxed-only')
  })

  it('opens a bypass-only adapter on full-user, its own one mode', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: `Claude ${Math.random()}` })
    expect(w.unattendedAuthority).toBe('full-user')
  })

  it('honours an explicit choice at commissioning', () => {
    const w = workers.createWorker({
      adapterId: 'openai-compatible',
      label: `Codex ${Math.random()}`,
      unattendedAuthority: 'full-user'
    })
    expect(w.unattendedAuthority).toBe('full-user')
  })
})

describe('updating the setting', () => {
  it('round-trips through worker.update', () => {
    const w = workers.createWorker({ adapterId: 'openai-compatible', label: `Codex ${Math.random()}` })
    expect(w.unattendedAuthority).toBe('sandboxed-only')
    const after = workers.updateWorker(w.id, { unattendedAuthority: 'full-user' })
    expect(after.unattendedAuthority).toBe('full-user')
    expect(workers.requireWorker(w.id).unattendedAuthority).toBe('full-user')
  })
})

describe('the dispatch gate', () => {
  it('offers a bypassing worker that did not ask for a sandbox', () => {
    const worker = workers.createWorker({
      adapterId: 'claude-code',
      label: `Claude ${Math.random()}`,
      unattendedAuthority: 'full-user'
    })
    const task = kit.makeTask({ constraints: { workerId: worker.id } })

    const choice = scoring.chooseTarget(task)

    expect(choice.worker?.id).toBe(worker.id)
  })

  it('refuses a bypassing worker set to sandboxed-only, and says why', () => {
    const worker = workers.createWorker({
      adapterId: 'claude-code',
      label: `Claude ${Math.random()}`,
      unattendedAuthority: 'sandboxed-only'
    })
    const task = kit.makeTask({ constraints: { workerId: worker.id } })

    const choice = scoring.chooseTarget(task)

    expect(choice.worker).toBeNull()
    const refusal = choice.refusals?.find((r) => r.workerId === worker.id)
    expect(refusal?.why).toContain('full user authority')
    expect(refusal?.why).toContain('sandboxed adapters only')
    // ⚠️ Standing lives on the *choice*, not on each refusal — a field is standing only if every
    // gate that fired was. An adapter does not acquire a sandbox while a task waits, so a task with
    // nowhere to go should escalate to a person rather than sit at `ready` forever.
    expect(choice.standing).toBe(true)
  })

  it('still offers a sandboxed worker set to sandboxed-only', () => {
    const worker = workers.createWorker({ adapterId: 'openai-compatible', label: `Codex ${Math.random()}` })
    const task = kit.makeTask({ constraints: { workerId: worker.id } })

    const choice = scoring.chooseTarget(task)

    expect(choice.worker?.id).toBe(worker.id)
  })

  it('also offers a codex worker set to full-user: the gate reads headlessAuthority, not the choice', () => {
    const worker = workers.createWorker({
      adapterId: 'openai-compatible',
      label: `Codex ${Math.random()}`,
      unattendedAuthority: 'full-user'
    })
    const task = kit.makeTask({ constraints: { workerId: worker.id } })

    const choice = scoring.chooseTarget(task)

    expect(choice.worker?.id).toBe(worker.id)
  })

  it('follows the declaration, not the adapter name', async () => {
    // ⛔ The invariant behind the gate. Flip what the adapter *claims* and the refusal must move
    // with it — a version that special-cased `claude-code` would keep offering Codex here.
    const { openaiCompatible } = await import('./adapters/openai-compatible.js')
    const original = openaiCompatible.info.policy.headlessAuthority
    openaiCompatible.info.policy.headlessAuthority = 'full-user'
    try {
      const worker = workers.createWorker({
        adapterId: 'openai-compatible',
        label: `Codex ${Math.random()}`,
        unattendedAuthority: 'sandboxed-only'
      })
      const task = kit.makeTask({ constraints: { workerId: worker.id } })

      expect(scoring.chooseTarget(task).worker).toBeNull()
    } finally {
      openaiCompatible.info.policy.headlessAuthority = original
    }
  })

  it('gates a task with no project exactly the same as one with a project', () => {
    const worker = workers.createWorker({
      adapterId: 'claude-code',
      label: `Claude ${Math.random()}`,
      unattendedAuthority: 'sandboxed-only'
    })
    const task = kit.makeTask({ constraints: { workerId: worker.id } })

    const choice = scoring.chooseTarget(task)

    expect(choice.worker).toBeNull()
    expect(choice.refusals?.some((r) => r.why.includes('sandboxed adapters only'))).toBe(true)
  })
})
