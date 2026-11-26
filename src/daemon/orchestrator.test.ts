import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adapter } from './adapters/index.js'
import { costModel } from './costmodel.js'
import { modelOffered } from '@shared/modelroutes.js'
import {
  isOrchestratorModelId,
  isOrchestratorPresetId,
  makeOrchestratorPresetId,
  orchestratorPresetLabel,
  type OrchestratorPreset
} from '@shared/orchestrator.js'

const CM = 'google.antigravity.2026-08'
const AGY = 'w-agy-orch'
const CLAUDE = 'w-claude-orch'

describe('custom orchestrator presets (t1451)', () => {
  let dir = ''
  let prevPath: string | undefined
  let db: typeof import('./db.js')
  let workers: typeof import('./workers.js')
  let api: typeof import('./api/workers.js')
  let support: typeof import('./api/support.js')

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'warmstart-orchestrator-'))
    // Put a fake `agy` binary on PATH so `plan()` tests work on CI with no real CLI installed.
    const binDir = join(dir, 'bin')
    const fakeBin = join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(fakeBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
    if (process.platform !== 'win32') chmodSync(fakeBin, 0o755)
    prevPath = process.env.PATH
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`

    process.env.WARMSTART_DATA_DIR = dir
    db = await import('./db.js')
    db.openDb(join(dir, 'orchestrator.db'))
    workers = await import('./workers.js')
    api = await import('./api/workers.js')
    support = await import('./api/support.js')

    db.db()
      .prepare(
        `insert or replace into workers (id, label, adapter_id, isolation_root, enabled,
                                         human_occupied, max_concurrent, role, identity_json, created_at)
         values (?,?,?,?,1,0,1,'worker',?,?)`
      )
      .run(
        AGY,
        'Antigravity',
        'antigravity-cli',
        dir,
        JSON.stringify({
          loggedIn: true,
          availableModels: ['gemini-4-hydrogen', 'gemini-4-argon', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b']
        }),
        Date.now()
      )
    db.db()
      .prepare(
        `insert or replace into workers (id, label, adapter_id, isolation_root, enabled,
                                         human_occupied, max_concurrent, role, identity_json, created_at)
         values (?,?,?,?,1,0,1,'worker',?,?)`
      )
      .run(CLAUDE, 'Claude', 'claude-code', dir, JSON.stringify({ loggedIn: true }), Date.now())
  })

  afterAll(() => {
    costModel(CM).setPresets([])
    db?.closeDb()
    process.env.PATH = prevPath
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A held file handle on Windows is not a test failure.
    }
  })

  it('helper predicates and id minting work cleanly', () => {
    expect(isOrchestratorPresetId('orchestrator:neon-sonnet')).toBe(true)
    expect(isOrchestratorPresetId('orchestrator:')).toBe(false)
    expect(isOrchestratorPresetId('gemini-pro-orchestrator')).toBe(false)

    expect(isOrchestratorModelId('orchestrator:neon-sonnet')).toBe(true)
    expect(isOrchestratorModelId('gemini-pro-orchestrator')).toBe(true)
    expect(isOrchestratorModelId('gemini-pro-orchestrator-neon')).toBe(true)
    expect(isOrchestratorModelId('gemini-4-hydrogen')).toBe(false)

    const id1 = makeOrchestratorPresetId('Hydrogen + Sonnet')
    expect(id1).toBe('orchestrator:hydrogen-sonnet')
    expect(makeOrchestratorPresetId('Hydrogen + Sonnet', [id1])).toBe('orchestrator:hydrogen-sonnet-2')
    expect(orchestratorPresetLabel('orchestrator:hydrogen-sonnet')).toBe('Orchestrator: Hydrogen Sonnet')
  })

  it('antigravity-cli plan() emits --model gemini-pro-orchestrator and --settings without --effort', () => {
    const ad = adapter('antigravity-cli')
    expect(ad.info.capabilities.customOrchestrator).toBe(true)

    const preset: OrchestratorPreset = {
      id: 'orchestrator:hydrogen-sonnet',
      label: 'Hydrogen + Sonnet',
      plannerModel: 'gemini-4-hydrogen',
      plannerEffort: 'xhigh',
      executorModel: 'claude-sonnet-5-5',
      executorEffort: 'medium'
    }
    const plan = ad.plan({
      sessionId: 'sess-1',
      isolationRoot: dir,
      cwd: dir,
      transport: 'stream',
      model: preset.id,
      effort: 'high',
      orchestratorPreset: preset
    })

    const modelIdx = plan.args.indexOf('--model')
    expect(modelIdx).toBeGreaterThan(-1)
    expect(plan.args[modelIdx + 1]).toBe('gemini-pro-orchestrator')

    const settingsIdx = plan.args.indexOf('--settings')
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(JSON.parse(plan.args[settingsIdx + 1]!)).toEqual({
      orchestrator: {
        planner: 'gemini-4-hydrogen-xhigh',
        executor: 'claude-sonnet-5-5-medium'
      }
    })
    // Effort is carried on each role's slug, never as a top-level --effort flag.
    expect(plan.args).not.toContain('--effort')
  })

  it('antigravity-cli plan() omits effort suffix when a role has null effort', () => {
    const plan = adapter('antigravity-cli').plan({
      sessionId: 'sess-2',
      isolationRoot: dir,
      cwd: dir,
      transport: 'stream',
      model: 'orchestrator:bare',
      orchestratorPreset: {
        id: 'orchestrator:bare',
        label: 'Bare',
        plannerModel: 'gemini-4-argon',
        plannerEffort: null,
        executorModel: 'gpt-oss-120b',
        executorEffort: null
      }
    })
    const settingsIdx = plan.args.indexOf('--settings')
    expect(JSON.parse(plan.args[settingsIdx + 1]!)).toEqual({
      orchestrator: {
        planner: 'gemini-4-argon',
        executor: 'gpt-oss-120b'
      }
    })
  })

  it('validates, persists, exposes in model.options, and cleans up removed presets', async () => {
    const rpcApi = api.apiWorkers({ version: '0', startedAt: Date.now(), port: 0 })
    const preset: OrchestratorPreset = {
      id: 'orchestrator:hydrogen-sonnet',
      label: 'Hydrogen + Sonnet',
      plannerModel: 'gemini-4-hydrogen',
      plannerEffort: 'xhigh',
      executorModel: 'claude-sonnet-5-5',
      executorEffort: 'medium'
    }

    // Adapters without `customOrchestrator` refuse presets.
    expect(() =>
      support.checkWorkerDefaults('claude-code', { orchestratorPresets: [preset] })
    ).toThrow(/does not support custom orchestrator presets/)

    // Nested orchestrators and invalid efforts are refused.
    expect(() =>
      support.checkWorkerDefaults('antigravity-cli', {
        orchestratorPresets: [{ ...preset, plannerModel: 'gemini-pro-orchestrator' }]
      })
    ).toThrow(/non-orchestrator planner/)
    expect(() =>
      support.checkWorkerDefaults('antigravity-cli', {
        orchestratorPresets: [{ ...preset, executorEffort: 'xhigh' }]
      })
    ).toThrow(/has no effort level 'xhigh'/)

    // Save preset and set it as default in one update.
    const updated = await rpcApi['worker.update']({
      id: AGY,
      orchestratorPresets: [preset],
      defaultModel: preset.id,
      defaultEffort: null,
      defaultModels: { gemini: preset.id }
    })
    expect(updated.orchestratorPresets).toEqual([preset])
    expect(updated.defaultModel).toBe(preset.id)
    expect(updated.defaultModels?.gemini).toBe(preset.id)

    // Exposed in `model.options` with label, detail, empty effortLevels, and pool membership.
    const opts = await rpcApi['model.options']()
    const mine = opts.find((o) => o.adapterId === 'antigravity-cli' && o.workerId === AGY)
    expect(mine?.customOrchestrator).toBe(true)
    const entry = mine?.models.find((m) => m.id === preset.id)
    expect(entry?.label).toBe('Hydrogen + Sonnet')
    expect(entry?.detail).toContain('gemini-4-hydrogen (xhigh)')
    expect(entry?.detail).toContain('claude-sonnet-5-5 (medium)')
    expect(entry?.effortLevels).toEqual([])
    expect(entry?.pool).toBe('gemini')
    expect(mine?.pools?.find((p) => p.id === 'gemini')?.models).toContain(preset.id)

    // `modelOffered` allows the preset on the worker that defines it and refuses it elsewhere.
    expect(modelOffered(updated, preset.id)).toBe(true)
    expect(modelOffered(workers.requireWorker(CLAUDE), preset.id)).toBe(false)

    // Removing the preset clears dangling references cleanly.
    const cleared = await rpcApi['worker.update']({ id: AGY, orchestratorPresets: null })
    expect(cleared.orchestratorPresets).toBeNull()
    expect(cleared.defaultModel).toBeNull()
    expect(cleared.defaultModels).toBeNull()
    expect(workers.knownModelIds('antigravity-cli', AGY)).not.toContain(preset.id)
  })

  it('migration 99 is replay-safe when user_version is rewound', () => {
    const before = db.versionBefore('orchestrator_presets_json')
    const dbPath = join(dir, 'replay.db')
    const conn = db.openDb(dbPath)
    conn.exec(`pragma user_version = ${before}`)
    db.closeDb()
    expect(() => db.openDb(dbPath)).not.toThrow()
    // Re-open the main test DB for afterAll cleanup.
    db.openDb(join(dir, 'orchestrator.db'))
  })
})
