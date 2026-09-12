import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * A project's containment choice, and the refusal that enforces it.
 *
 * ⛔ **The gate is a refusal, never a downgrade.** A project set to `sandboxed-only` does not run a
 * bypassing adapter "more carefully" — it declines the candidate, and the task holds with a sentence
 * on its row. Running it sandboxed instead is the t250 stall: a headless CLI that cannot ask turns
 * every command into a denial and spends the window discovering it.
 *
 * ⛔ **The gate asks `headlessAuthority`, never an adapter name.** The test pins that too, by
 * flipping the *declaration* rather than the adapter id and watching the refusal follow it.
 */

let dir: string
let kit: typeof import('./testkit.js')
let projects: typeof import('./projects.js')
let scoring: typeof import('./scoring.js')
let workers: typeof import('./workers.js')

let restore: Array<() => void> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-unattended-'))
  process.env.WARMSTART_DATA_DIR = dir
  const store = await import('./db.js')
  store.openDb(join(dir, 'unattended.db'))
  kit = await import('./testkit.js')
  projects = await import('./projects.js')
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

let seq = 0
function project(unattended?: 'full-user' | 'sandboxed-only'): Project {
  seq += 1
  return kit.makeProject({
    dir,
    name: `repo${seq}`,
    ...(unattended ? { config: { permission: { unattended } } } : {})
  })
}

describe('the resolved policy', () => {
  /**
   * ⛔ The grandfathering rule, and the reason it is not the safer value: every project that
   * existed before this setting did would otherwise stop dispatching to two of three adapters the
   * moment its operator upgraded, which is changing what a running fleet may do underneath them.
   */
  it('resolves an absent key to full user authority', () => {
    expect(projects.policyFor(project()).unattendedAuthority).toBe('full-user')
  })

  it('reads a committed answer', () => {
    expect(projects.policyFor(project('sandboxed-only')).unattendedAuthority).toBe('sandboxed-only')
    expect(projects.policyFor(project('full-user')).unattendedAuthority).toBe('full-user')
  })

  it('writes the permissive value rather than deleting the key', async () => {
    // ⛔ An absent key and `full-user` resolve the same and mean different things: one is a project
    // nobody was ever asked about. The setting must be able to record "I was asked, and I said yes".
    const p = project('sandboxed-only')
    projects.setProjectPolicy(p.id, { unattendedAuthority: 'full-user' })
    const after = projects.requireProject(p.id)
    expect(after.config.permission?.unattended).toBe('full-user')
  })

  it('refuses a value that is not one of the two', () => {
    const p = project()
    expect(() =>
      projects.setProjectPolicy(p.id, { unattendedAuthority: 'whatever' as 'full-user' })
    ).toThrow(/unattended authority/)
  })
})

describe('the dispatch gate', () => {
  it('offers a bypassing adapter to a project that did not ask for a sandbox', () => {
    const p = project('full-user')
    workers.createWorker({ adapterId: 'claude-code', label: 'Claude A' })
    const task = kit.makeTask({ projectId: p.id })

    const choice = scoring.chooseTarget(task)

    expect(choice.worker).not.toBeNull()
  })

  it('refuses a bypassing adapter in a sandboxed-only project, and says why', () => {
    const p = project('sandboxed-only')
    const worker = workers.createWorker({ adapterId: 'claude-code', label: 'Claude B' })
    const task = kit.makeTask({ projectId: p.id })

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

  it('still offers a sandboxed adapter to a sandboxed-only project', () => {
    const p = project('sandboxed-only')
    workers.createWorker({ adapterId: 'openai-compatible', label: 'Codex A' })
    const task = kit.makeTask({ projectId: p.id })

    const choice = scoring.chooseTarget(task)

    expect(choice.worker).not.toBeNull()
  })

  it('follows the declaration, not the adapter name', async () => {
    // ⛔ The invariant behind the gate. Flip what the adapter *claims* and the refusal must move
    // with it — a version that special-cased `claude-code` would keep offering Codex here.
    const { openaiCompatible } = await import('./adapters/openai-compatible.js')
    const original = openaiCompatible.info.policy.headlessAuthority
    openaiCompatible.info.policy.headlessAuthority = 'full-user'
    try {
      const p = project('sandboxed-only')
      workers.createWorker({ adapterId: 'openai-compatible', label: 'Codex B' })
      const task = kit.makeTask({ projectId: p.id })

      expect(scoring.chooseTarget(task).worker).toBeNull()
    } finally {
      openaiCompatible.info.policy.headlessAuthority = original
    }
  })

  it('does not gate a task with no project, which has no owner to have chosen', () => {
    workers.createWorker({ adapterId: 'claude-code', label: 'Claude C' })
    const task = kit.makeTask()

    const choice = scoring.chooseTarget(task)

    // ⚠️ Asserts that *this* gate stayed silent, not that a worker was picked. By now the suite has
    // commissioned several accounts, so a field of tied candidates can legitimately defer to a
    // quota read — a real outcome that says nothing about containment either way.
    expect(choice.refusals?.some((r) => r.why.includes('sandboxed adapters only'))).toBeFalsy()
  })
})
