import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Zero-token complexity, over real task fixtures.
 *
 * ⛔ What this pins: a trivial rename-shaped prompt reads low, a long structured prompt with real
 * acceptance criteria reads high, a `plan` task is never called low however thin its prompt, a
 * stated `estTokens` overrides the word count rather than competing with it on equal footing, every
 * signal's contribution sums to exactly `score`, and the verb lexicon matches whole words only.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let complexity: typeof import('./complexity.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mac-complexity-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  complexity = await import('./complexity.js')
  db.openDb(join(dir, 'complexity.db'))
})

beforeEach(() => {
  db.db().exec('delete from task_deps')
  db.db().exec('delete from attachments')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const LONG_PROMPT = `We need to refactor the billing pipeline so it can price a run in two currencies.

Context: \`src/daemon/price.ts\` currently assumes every plan is priced in USD, and the new
antigravity.pro plan bills in EUR. This touches several files, including src/daemon/costmodel.ts
and src/shared/tasks.ts.

\`\`\`ts
export interface RunPrice {
  usd: number | null
}
\`\`\`

Acceptance criteria:
- [ ] priceOfWindowUsage accepts a currency and returns it on the result
- [ ] existing USD callers are unaffected
- [ ] the renderer shows the right currency symbol
- [ ] a run priced in EUR never silently reports as USD
- [ ] costmodel.test.ts covers the new currency field
- [ ] docs/cost-model.md documents the change`

describe('complexityOf', () => {
  it('scores a trivial rename-shaped prompt low', () => {
    const task = tasks.createTask({ title: 'fix the typo in the header' })
    const c = complexity.complexityOf(task)
    expect(c.band).toBe('low')
  })

  it('scores a long, structured prompt with real acceptance criteria high', () => {
    const task = tasks.createTask({ title: LONG_PROMPT })
    const c = complexity.complexityOf(task)
    expect(c.band).toBe('high')
  })

  it('never calls a plan task low, even with a threadbare prompt', () => {
    const task = tasks.createTask({ title: 'plan it', kind: 'plan' })
    const c = complexity.complexityOf(task)
    expect(c.band).not.toBe('low')
    expect(c.score).toBeGreaterThanOrEqual(0.34)
  })

  it('lets a stated estTokens dominate a short, otherwise-plain prompt', () => {
    const plain = tasks.createTask({ title: 'update the config value' })
    const sized = tasks.createTask({ title: 'update the config value', estTokens: 400_000 })
    const plainScore = complexity.complexityOf(plain).score
    const sizedScore = complexity.complexityOf(sized).score
    expect(sizedScore).toBeGreaterThan(plainScore + 0.4)
    const sizeSignal = complexity.complexityOf(sized).signals.find((s) => s.name === 'size')!
    expect(sizeSignal.weight).toBeGreaterThan(0.5)
  })

  it('sums every signal contribution to exactly the reported score', () => {
    for (const title of ['fix the typo', LONG_PROMPT, 'investigate the flaky test']) {
      const task = tasks.createTask({ title })
      const c = complexity.complexityOf(task)
      const total = c.signals.reduce((sum, s) => sum + s.contribution, 0)
      expect(total).toBeCloseTo(c.score, 6)
    }
  })

  it('matches the verb lexicon on whole words only', () => {
    // "typography" contains "typo" as a substring but is not the word "typo".
    const safe = tasks.createTask({ title: 'update the typography on the landing page' })
    const unsafe = tasks.createTask({ title: 'fix a typo on the landing page' })
    const safeVerb = complexity.complexityOf(safe).signals.find((s) => s.name === 'verb')!
    const unsafeVerb = complexity.complexityOf(unsafe).signals.find((s) => s.name === 'verb')!
    expect(safeVerb.value).toBe(0.5) // neither lexicon matched
    expect(unsafeVerb.value).toBe(0) // 'typo' matched as a down-verb
  })

  it('an up-verb like "refactor" raises the verb signal', () => {
    const task = tasks.createTask({ title: 'refactor the session pool' })
    const verb = complexity.complexityOf(task).signals.find((s) => s.name === 'verb')!
    expect(verb.value).toBe(1)
  })

  it('weights sum to 1 whether or not estTokens is stated', () => {
    const plain = tasks.createTask({ title: 'do a thing' })
    const sized = tasks.createTask({ title: 'do a thing', estTokens: 300_000 })
    for (const task of [plain, sized]) {
      const c = complexity.complexityOf(task)
      const totalWeight = c.signals.reduce((sum, s) => sum + s.weight, 0)
      expect(totalWeight).toBeCloseTo(1, 6)
    }
  })

  it('counts required capabilities toward the score', () => {
    const bare = tasks.createTask({ title: 'do a thing' })
    const needy = tasks.createTask({ title: 'do a thing', constraints: { needs: ['mcp', 'edit'] } })
    expect(complexity.complexityOf(needy).score).toBeGreaterThan(complexity.complexityOf(bare).score)
  })

  it('counts dependents toward the score', () => {
    const dependency = tasks.createTask({ title: 'the one everything waits on' })
    const before = complexity.complexityOf(dependency).score
    const waiting = tasks.createTask({ title: 'waits on it' })
    tasks.addDependency(waiting.id, dependency.id)
    const after = complexity.complexityOf(tasks.requireTask(dependency.id)).score
    expect(after).toBeGreaterThan(before)
  })
})
