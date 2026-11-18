import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseAgyModels } from './adapters/antigravity-cli.js'
import { costModel, costModels } from './costmodel.js'

/**
 * t1401: a model the vendor's CLI lists becomes pickable without a Warmstart release.
 *
 * ⭐ The case that asked for it, verbatim: on 2026-11-18 `agy models` (agy 1.5.10) listed
 * `gemini-4-neon` and `gemini-4-carbon`, and the cost model knew neither.
 */
const AGY_MODELS_1_5_10 = [
  'Fetching available models...',
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  'gemini-pro-orchestrator-argon\tOrchestrator (Argon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ''
].join('\r\n')

const CM = 'google.antigravity.2026-08'

describe('reading `agy models`', () => {
  const models = parseAgyModels(AGY_MODELS_1_5_10)
  const byId = new Map(models.map((m) => [m.id, m]))

  it('folds one line per effort into one model, efforts low to high', () => {
    expect(byId.get('gemini-4-neon')).toEqual({ id: 'gemini-4-neon', label: 'Gemini 4 Neon', effortLevels: ['low', 'medium', 'high', 'xhigh'] })
    expect(byId.get('gemini-4-carbon')?.effortLevels).toEqual(['low', 'medium', 'high'])
    expect(byId.get('gpt-oss-120b')).toEqual({ id: 'gpt-oss-120b', label: 'GPT-OSS 120B', effortLevels: ['medium'] })
    expect(models).toHaveLength(11)
  })

  it('keeps a model listed bare whole, with no effort', () => {
    expect(byId.get('gemini-pro-orchestrator')).toEqual({ id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)', effortLevels: [] })
    expect(byId.get('gemini-pro-orchestrator-neon')?.effortLevels).toEqual([])
  })

  it('splits an effort only where the id and the label both say so, and skips what is not a model line', () => {
    const odd = parseAgyModels('Fetching available models...\nError: offline\nmystery-high\tMystery Model\n \tblank id\n')
    expect(odd).toEqual([{ id: 'mystery-high', label: 'Mystery Model', effortLevels: [] }])
    expect(parseAgyModels('')).toEqual([])
  })
})

describe('a cost model accepting discovered models', () => {
  afterEach(() => {
    costModel(CM).setDiscovered([])
  })

  const seen = (id: string, effortLevels: string[] = ['low', 'high']) => ({ id, effortLevels, seenAt: Date.parse('2026-11-18T23:00:00Z') })

  it('names a model it does not list, with no price and no window, in the pool its prefix says', () => {
    const cm = costModel(CM)
    expect(cm.acceptsDiscovered()).toBe(true)
    expect(cm.modelSpec('gemini-4-neon')).toBeNull()

    const result = cm.setDiscovered([seen('gemini-4-neon', ['low', 'medium', 'high', 'xhigh']), seen('gpt-oss-240b', ['medium'])])
    expect(result.accepted).toEqual(['gemini-4-neon', 'gpt-oss-240b'])

    const neon = cm.modelSpec('gemini-4-neon')
    expect(neon).toMatchObject({ id: 'gemini-4-neon', pool: 'gemini', input_per_mtok: null, output_per_mtok: null, context_window: null })
    expect(neon?.effort_levels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(neon?.discovered).toContain('2026-11-18T23:00:00')
    expect(neon).not.toHaveProperty('$comment')
    expect(cm.modelSpec('gpt-oss-240b')?.pool).toBe('gpt')
    expect(cm.offeredModelIds()).toContain('gemini-4-neon')
    expect(cm.modelIds()).toContain('gemini-4-neon')
    // An id with the old effort suffix resolves against the discovered base, as it does for a listed one.
    expect(cm.modelSpec('gemini-4-neon-high')?.pool).toBe('gemini')
    expect(cm.pools().find((p) => p.id === 'gemini')?.models).toContain('gemini-4-neon')
  })

  it('⛔ lets the file win for a model it lists', () => {
    const cm = costModel(CM)
    const before = cm.modelSpec('gemini-4-argon')
    const result = cm.setDiscovered([seen('gemini-4-argon', ['max'])])
    expect(result.accepted).toEqual([])
    expect(cm.modelSpec('gemini-4-argon')).toBe(before)
    expect(cm.modelSpec('gemini-4-argon')?.discovered).toBeUndefined()
  })

  it('⛔ refuses a model no prefix places in a quota pool, rather than gate it against no window', () => {
    const cm = costModel(CM)
    const result = cm.setDiscovered([seen('mystery-1')])
    expect(result.refused.map((r) => r.id)).toEqual(['mystery-1'])
    expect(result.refused[0]?.reason).toContain('quota pool')
    expect(cm.modelSpec('mystery-1')).toBeNull()
  })

  it('replaces, so a model the CLI stopped listing leaves', () => {
    const cm = costModel(CM)
    cm.setDiscovered([seen('gemini-4-neon')])
    cm.setDiscovered([seen('gemini-4-carbon')])
    expect(cm.modelSpec('gemini-4-neon')).toBeNull()
    expect(cm.modelSpec('gemini-4-carbon')).not.toBeNull()
  })

  it('accepts nothing into a file that declares no template', () => {
    const other = costModels().find((m) => m.id !== CM && !m.acceptsDiscovered())
    expect(other).toBeDefined()
    expect(other!.setDiscovered([seen('claude-new-1')]).accepted).toEqual([])
    expect(other!.modelSpec('claude-new-1')).toBeNull()
  })
})

describe('what the daemon does with a discovered model', () => {
  let dir: string
  let db: typeof import('./db.js')
  let workers: typeof import('./workers.js')
  let api: typeof import('./api/workers.js')
  let support: typeof import('./api/support.js')
  const AGY = 'aaaaaaaa-0000-4000-8000-000000001401'

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'warmstart-discovery-'))
    process.env.WARMSTART_DATA_DIR = dir
    db = await import('./db.js')
    db.openDb(join(dir, 'discovery.db'))
    workers = await import('./workers.js')
    api = await import('./api/workers.js')
    support = await import('./api/support.js')
  })

  afterAll(() => {
    costModel(CM).setDiscovered([])
    db.closeDb()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A held file handle on Windows is not a test failure.
    }
  })

  function worker(identity: Record<string, unknown>): void {
    db.db()
      .prepare(
        `insert or replace into workers (id, label, adapter_id, isolation_root, enabled,
                                         human_occupied, max_concurrent, role, identity_json, created_at)
         values (?,?,?,?,1,0,1,'worker',?,?)`
      )
      .run(AGY, 'Antigravity', 'antigravity-cli', dir, JSON.stringify({ loggedIn: true, ...identity }), Date.now())
  }

  it('offers what the CLI listed, accepts it as a default, and marks it discovered', async () => {
    const discoveredModels = parseAgyModels(AGY_MODELS_1_5_10)
    worker({ discoveredModels, discoveredAt: Date.now(), availableModels: discoveredModels.map((m) => m.id) })
    expect(() => support.checkWorkerDefaults('antigravity-cli', { defaultModel: 'gemini-4-neon' })).toThrow(/can be priced for/)

    workers.syncDiscoveredModels()

    expect(workers.knownModelIds('antigravity-cli')).toContain('gemini-4-neon')
    expect(workers.knownModelIds('antigravity-cli', AGY)).toContain('gemini-4-carbon')
    // The orchestrator ids match the `gemini-` prefix, so they are offered too.
    expect(workers.knownModelIds('antigravity-cli', AGY)).toContain('gemini-pro-orchestrator')
    expect(() => support.checkWorkerDefaults('antigravity-cli', { defaultModel: 'gemini-4-neon' })).not.toThrow()

    const options = await api.apiWorkers({ version: '0', startedAt: Date.now(), port: 0 })['model.options']()
    const mine = options.find((o) => o.adapterId === 'antigravity-cli' && o.workerId === AGY)
    const neon = mine?.models.find((m) => m.id === 'gemini-4-neon')
    expect(neon?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(neon?.discovered).toBeTruthy()
    expect(mine?.models.find((m) => m.id === 'gemini-4-argon')?.discovered).toBeUndefined()
  })

  it('takes a model away once no live worker’s CLI lists it', () => {
    worker({ discoveredModels: null })
    workers.syncDiscoveredModels()
    expect(workers.knownModelIds('antigravity-cli')).not.toContain('gemini-4-neon')
  })
})
