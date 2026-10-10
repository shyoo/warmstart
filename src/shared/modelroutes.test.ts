import { describe, expect, it } from 'vitest'
import { resolveModelChoice } from './tasks.js'
import {
  autoCandidates,
  autoModelCount,
  autoRoutes,
  isRoutableModel,
  modelOffered,
  notOffered,
  pairWithTags,
  readRoutes,
  routableTags,
  routeEffortFor,
  routesFromLegacy,
  tagBoundEffort,
  tagsRoutable,
  tagsOnWorker,
  type ModelRoute
} from './modelroutes.js'
import { inferredTags } from './modeltags.js'

/** A row; `tags` defaults to the built-in class tag of its model, as an untouched row displays. */
const row = (model: string, effort: string | null, auto = true, tags: string[] = inferredTags(model)): ModelRoute => ({
  model,
  effort,
  tags,
  auto
})

describe('model routes (t638)', () => {
  const worker = {
    modelRoutes: [
      row('claude-opus-5-5', 'xhigh', true, ['High']),
      row('claude-opus-5-5', 'medium', true, ['Med']),
      row('claude-opus-5', 'high', false),
      row('claude-sonnet-5', 'high', true),
      row('claude-haiku-4-5', null, false)
    ]
  }

  it('⭐ Auto gets one pair per model, the first listed; a class narrows before that', () => {
    expect(autoCandidates(worker)).toEqual([
      { model: 'claude-opus-5-5', effort: 'xhigh' },
      { model: 'claude-sonnet-5', effort: 'high' }
    ])
    expect(autoCandidates(worker, ['Med'])).toEqual([
      { model: 'claude-opus-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5', effort: 'high' }
    ])
    expect(autoCandidates(worker, ['Low'])).toEqual([])
    expect(autoModelCount(worker)).toBe(2)
  })

  it('a class override on the exact pair beats any other line and the built-in heuristic', () => {
    expect(tagsOnWorker(worker, 'claude-opus-5-5', 'medium')).toEqual(['Med'])
    expect(tagsOnWorker(worker, 'claude-opus-5-5', 'xhigh')).toEqual(['High'])
    // No effort named: the first line for the model.
    expect(tagsOnWorker(worker, 'claude-opus-5-5')).toEqual(['High'])
    // No line at all: the heuristic.
    expect(tagsOnWorker(worker, 'gpt-5.6-mini')).toEqual(['Low'])
    expect(tagsOnWorker({ modelRoutes: null }, 'claude-sonnet-5')).toEqual(['Med'])
  })

  it('⛔ a class asks every line of the model, not its first (t697)', () => {
    // t691: xhigh (high) listed above medium (med); the first-line answer said "nothing in med".
    expect(pairWithTags(worker, 'claude-opus-5-5', null, ['Med'])).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
    // The session's own effort wins when its line is in the class…
    expect(pairWithTags(worker, 'claude-opus-5-5', 'xhigh', ['High'])).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
    // …and yields to a line that is, when it is not.
    expect(pairWithTags(worker, 'claude-opus-5-5', 'xhigh', ['Med'])).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
    expect(pairWithTags(worker, 'claude-opus-5-5', null, ['Low'])).toBeNull()
    // No line at all: the heuristic, carrying whatever effort the candidate had.
    expect(pairWithTags(worker, 'gpt-5.6-mini', 'low', ['Low'])).toEqual({ model: 'gpt-5.6-mini', effort: 'low' })
    expect(pairWithTags(worker, null, null, ['Med'])).toBeNull()
  })

  it("an effort inherited from the table prefers the model's auto line", () => {
    const w = { modelRoutes: [row('claude-opus-5', 'low', false), row('claude-opus-5', 'max', true)] }
    expect(routeEffortFor(w, 'claude-opus-5')).toBe('max')
    expect(routeEffortFor(worker, 'claude-opus-5')).toBe('high')
    expect(routeEffortFor(worker, 'claude-haiku-4-5')).toBeNull()
  })

  it('folds the three legacy maps into rows without dropping a setting', () => {
    expect(
      routesFromLegacy(['claude-sonnet-5'], { 'claude-opus-5': 'max', 'claude-sonnet-5': 'high' }, {
        'claude-haiku-4-5': 'low'
      })
    ).toEqual([
      row('claude-sonnet-5', 'high', true),
      row('claude-opus-5', 'max', false),
      row('claude-haiku-4-5', null, false, ['Low'])
    ])
    expect(routesFromLegacy(null, null, null)).toEqual([])
  })

  /**
   * ⛔ A recording is not a route (t675). The transcript may report a model the worker never
   * listed — measured 2026-09-24, when sessions spawned for `claude-opus-5-5` reported
   * `claude-opus-4-8` — and continuity must not follow it into the next dispatch.
   */
  it('calls a model routable where the worker names it, and nowhere else', () => {
    // Auto and manual rows alike, plus both kinds of default.
    expect(isRoutableModel(worker, 'claude-opus-5-5')).toBe(true)
    expect(isRoutableModel(worker, 'claude-opus-5')).toBe(true)
    expect(
      isRoutableModel(
        { modelRoutes: [], defaultModel: 'claude-sonnet-5', defaultModels: { claude: 'claude-opus-5' } },
        'claude-opus-5'
      )
    ).toBe(true)
    // Never listed: not a route, not a default, not routable — even with a built-in class.
    expect(isRoutableModel(worker, 'claude-opus-4-8')).toBe(false)
    expect(isRoutableModel(worker, null)).toBe(false)
    expect(isRoutableModel(worker, undefined)).toBe(false)
    expect(isRoutableModel(null, 'claude-opus-5-5')).toBe(false)
    expect(isRoutableModel({ modelRoutes: null }, 'claude-opus-5-5')).toBe(false)
  })
})

describe('classBoundEffort (t811)', () => {
  // ClaudeFirst's table when t809 and t810 ran: opus·high is `high` by the built-in heuristic.
  const claudeFirst = {
    modelRoutes: [
      row('claude-opus-5-5', 'high'),
      row('claude-opus-5-5', 'medium', true, ['Med']),
      row('claude-sonnet-5', 'medium', true, ['Low'])
    ]
  }

  it('⛔ replaces a task effort that would take the model out of the requested class', () => {
    expect(tagBoundEffort(claudeFirst, 'claude-opus-5-5', 'high', ['Med'])).toBe('medium')
    expect(tagBoundEffort(claudeFirst, 'claude-opus-5-5', 'medium', ['High'])).toBe('high')
    expect(tagBoundEffort(claudeFirst, 'claude-sonnet-5', 'max', ['Low'])).toBe('medium')
  })

  it("an effort absent from the table is not a class row, so the class row's effort answers", () => {
    expect(tagBoundEffort(claudeFirst, 'claude-opus-5-5', 'xhigh', ['Med'])).toBe('medium')
    expect(tagBoundEffort(claudeFirst, 'claude-opus-5-5', null, ['Med'])).toBe('medium')
  })

  it('keeps a task effort whose own row is in the class', () => {
    const w = { modelRoutes: [row('claude-opus-5-5', 'high', true, ['High']), row('claude-opus-5-5', 'max', false, ['High'])] }
    expect(tagBoundEffort(w, 'claude-opus-5-5', 'max', ['High'])).toBe('max')
    expect(tagBoundEffort(w, 'claude-opus-5-5', 'high', ['High'])).toBe('high')
  })

  it('passes the effort through where there is no class, no model or no row in the class', () => {
    expect(tagBoundEffort(claudeFirst, 'claude-opus-5-5', 'low', null)).toBe('low')
    expect(tagBoundEffort(claudeFirst, 'claude-opus-5-5', 'low', undefined)).toBe('low')
    expect(tagBoundEffort(claudeFirst, null, 'low', ['Med'])).toBe('low')
    // Scoring holds a task with nothing in its class; this does not invent a row for it.
    expect(tagBoundEffort(claudeFirst, 'claude-sonnet-5', 'high', ['High'])).toBe('high')
  })

  it("a model with no rows keeps the task's effort when the built-in class matches", () => {
    expect(tagBoundEffort({ modelRoutes: [] }, 'claude-opus-5-5', 'xhigh', ['High'])).toBe('xhigh')
    expect(tagBoundEffort(null, 'claude-opus-5-5', 'xhigh', ['High'])).toBe('xhigh')
  })
})

describe('a plan that offers fewer models than the catalogue (t953)', () => {
  // CodexFirst's free account, measured 2026-10-07: its models_cache.json lists three models, and the
  // operator's table still ticked Sol for Auto-route.
  const free = {
    identity: { subscriptionType: 'Free', availableModels: ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
    defaultModel: 'gpt-6-sol',
    modelRoutes: [
      row('gpt-6-sol', 'high', true, ['High']),
      row('gpt-6-sol', 'medium', true, ['Med']),
      row('gpt-5.6-terra', 'medium', true, ['Low'])
    ]
  }

  it('offers everything where the account never said what it offers', () => {
    expect(modelOffered(null, 'gpt-6-sol')).toBe(true)
    expect(modelOffered({ identity: null }, 'gpt-6-sol')).toBe(true)
    expect(modelOffered({ identity: { availableModels: null } }, 'gpt-6-sol')).toBe(true)
    // ⛔ An empty list is unknown, not "nothing": it must not strand a worker with no model at all.
    expect(modelOffered({ identity: { availableModels: [] } }, 'gpt-6-sol')).toBe(true)
  })

  it('offers only what the list names, and never a missing model', () => {
    expect(modelOffered(free, 'gpt-6-luna')).toBe(true)
    expect(modelOffered(free, 'gpt-6-sol')).toBe(false)
    expect(modelOffered(free, null)).toBe(true)
  })

  it('⛔ Auto skips a ticked row the plan does not offer, but the stored row stays', () => {
    expect(autoRoutes(free).map((r) => r.model)).toEqual(['gpt-5.6-terra'])
    expect(autoCandidates(free).map((c) => c.model)).toEqual(['gpt-5.6-terra'])
    expect(autoCandidates(free, ['High'])).toEqual([])
    expect(autoModelCount(free)).toBe(1)
    expect(free.modelRoutes).toHaveLength(3)
  })

  it('names the plan and what it does list when it refuses', () => {
    const why = notOffered({ label: 'CodexFirst', ...free }, 'gpt-6-sol')
    expect(why).toContain("CodexFirst (Free plan) does not offer 'gpt-6-sol'")
    expect(why).toContain('gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna')
  })

  it('⛔ falls back to the CLI choice when the account default is a model the plan does not offer', () => {
    const choice = resolveModelChoice(null, { ...free, defaultEffort: 'medium' }, true)
    expect(choice.model).toBeNull()
    expect(choice.modelSource).toBe('cli')
    // Unchanged where the plan does offer the default.
    const plus = { ...free, identity: { availableModels: ['gpt-6-sol'] } }
    expect(resolveModelChoice(null, { ...plus, defaultEffort: 'medium' }, true).model).toBe('gpt-6-sol')
  })
})

describe('tags on a pair (t1042)', () => {
  // opus · medium has Audio and opus · high does not: the weaker row is the only one that matches.
  const audioOnWeaker = {
    modelRoutes: [
      row('claude-opus-5-5', 'high', true, ['High']),
      row('claude-opus-5-5', 'medium', true, ['Med', 'Audio']),
      row('claude-sonnet-5', 'high', true, ['High', 'Audio'])
    ]
  }

  it('⭐ needs every tag on the same pair, and filters before it reduces to one pair per model', () => {
    // Reduce first and opus's first row (high, no Audio) would be tested and the model lost.
    expect(autoCandidates(audioOnWeaker, ['Audio'])).toEqual([
      { model: 'claude-opus-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5', effort: 'high' }
    ])
    // High + Audio lives on sonnet only: opus has High and Audio, but on two different pairs.
    expect(autoCandidates(audioOnWeaker, ['High', 'Audio'])).toEqual([{ model: 'claude-sonnet-5', effort: 'high' }])
    expect(autoCandidates(audioOnWeaker, ['ZDR'])).toEqual([])
    expect(autoCandidates(audioOnWeaker)).toHaveLength(2)
  })

  it('⛔ never calls a pair a match because another effort of the same model has the tag', () => {
    expect(pairWithTags(audioOnWeaker, 'claude-opus-5-5', 'high', ['Audio'])).toEqual({
      model: 'claude-opus-5-5',
      effort: 'medium'
    })
    expect(pairWithTags(audioOnWeaker, 'claude-opus-5-5', 'high', ['High', 'Audio'])).toBeNull()
    // The effort the candidate carries wins where its own row matches.
    expect(pairWithTags(audioOnWeaker, 'claude-opus-5-5', 'medium', ['Audio'])?.effort).toBe('medium')
  })

  it('binds the effort to the matching row, and passes it through when nothing requires a tag', () => {
    expect(tagBoundEffort(audioOnWeaker, 'claude-opus-5-5', 'high', ['Audio'])).toBe('medium')
    expect(tagBoundEffort(audioOnWeaker, 'claude-opus-5-5', 'high', [])).toBe('high')
    expect(tagBoundEffort(audioOnWeaker, 'claude-opus-5-5', 'high', undefined)).toBe('high')
    // No matching row: this does not invent one; scoring has already held the task.
    expect(tagBoundEffort(audioOnWeaker, 'claude-opus-5-5', 'high', ['ZDR'])).toBe('high')
  })

  it('a row with no tags is valid for plain Auto and satisfies no tagged request', () => {
    const bare = { modelRoutes: [row('claude-opus-5-5', 'high', true, [])] }
    expect(autoCandidates(bare)).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect(autoCandidates(bare, ['High'])).toEqual([])
    expect(pairWithTags(bare, 'claude-opus-5-5', 'high', ['High'])).toBeNull()
  })

  it('a model with no row carries only its built-in class tag — never a custom one', () => {
    expect(tagsOnWorker({ modelRoutes: [] }, 'claude-haiku-4-5')).toEqual(['Low'])
    expect(pairWithTags({ modelRoutes: [] }, 'claude-haiku-4-5', 'low', ['Low'])).toEqual({ model: 'claude-haiku-4-5', effort: 'low' })
    expect(pairWithTags({ modelRoutes: [] }, 'claude-haiku-4-5', 'low', ['ZDR'])).toBeNull()
  })

  it('reads a stored row written before tags as its effective class, and keeps existing tags exactly', () => {
    const read = readRoutes([
      { model: 'claude-opus-5-5', effort: 'high', modelClass: null, auto: true },
      { model: 'claude-sonnet-5', effort: 'medium', modelClass: 'low', auto: false },
      { model: 'claude-haiku-4-5', effort: null, tags: ['ZDR', 'zdr', ' '], auto: true },
      { model: 'claude-opus-5', effort: 'low', tags: [], modelClass: 'high', auto: true },
      { effort: 'high' },
      'junk'
    ])
    expect(read).toEqual([
      row('claude-opus-5-5', 'high', true, ['High']),
      row('claude-sonnet-5', 'medium', false, ['Low']),
      row('claude-haiku-4-5', null, true, ['ZDR']),
      // An explicit empty list is the operator's word and is not refilled from the class.
      row('claude-opus-5', 'low', true, [])
    ])
    expect(readRoutes(null)).toEqual([])
  })
})

describe('what a picker may offer (t1042)', () => {
  const w = {
    defaultEffort: 'medium',
    modelRoutes: [
      row('claude-opus-5-5', 'high', true, ['High', 'ZDR']),
      row('claude-sonnet-5', 'medium', true, ['Med', 'Audio']),
      row('claude-haiku-4-5', null, false, ['Low'])
    ]
  }

  it('lists the tags on auto rows only, and calls a requirement routable only if one pair holds all of it', () => {
    expect(routableTags(w, 'claude-opus-5-5')).toEqual(['High', 'ZDR', 'Med', 'Audio'])
    expect(tagsRoutable(w, ['High', 'ZDR'], null)).toBe(true)
    // Each tag is on the table, but on two different pairs.
    expect(tagsRoutable(w, ['High', 'Audio'], null)).toBe(false)
    expect(tagsRoutable(w, [], null)).toBe(true)
    expect(tagsRoutable(null, ['Low'], null)).toBe(false)
    // An unticked row is not routable.
    expect(tagsRoutable(w, ['Low'], null)).toBe(false)
  })

  it('falls back to the default pair for a worker with no auto rows', () => {
    const bare = { defaultEffort: 'low', modelRoutes: [] }
    expect(routableTags(bare, 'claude-haiku-4-5')).toEqual(['Low'])
    expect(tagsRoutable(bare, ['Low'], 'claude-haiku-4-5')).toBe(true)
    expect(tagsRoutable(bare, ['Low', 'ZDR'], 'claude-haiku-4-5')).toBe(false)
    expect(routableTags(bare, null)).toEqual([])
    expect(tagsRoutable(bare, ['Low'], null)).toBe(false)
  })
})
