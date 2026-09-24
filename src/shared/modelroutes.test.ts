import { describe, expect, it } from 'vitest'
import {
  autoCandidates,
  autoModelCount,
  classOnWorker,
  isRoutableModel,
  routeEffortFor,
  routesFromLegacy,
  type ModelRoute
} from './modelroutes.js'

const row = (model: string, effort: string | null, auto = true, modelClass: ModelRoute['modelClass'] = null): ModelRoute => ({
  model,
  effort,
  modelClass,
  auto
})

describe('model routes (t638)', () => {
  const worker = {
    modelRoutes: [
      row('claude-opus-5-5', 'xhigh', true, 'high'),
      row('claude-opus-5-5', 'medium', true, 'med'),
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
    expect(autoCandidates(worker, 'med')).toEqual([
      { model: 'claude-opus-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5', effort: 'high' }
    ])
    expect(autoCandidates(worker, 'low')).toEqual([])
    expect(autoModelCount(worker)).toBe(2)
  })

  it('a class override on the exact pair beats any other line and the built-in heuristic', () => {
    expect(classOnWorker(worker, 'claude-opus-5-5', 'medium')).toBe('med')
    expect(classOnWorker(worker, 'claude-opus-5-5', 'xhigh')).toBe('high')
    // No effort named: the first line for the model.
    expect(classOnWorker(worker, 'claude-opus-5-5')).toBe('high')
    // No line at all: the heuristic.
    expect(classOnWorker(worker, 'gpt-5.6-mini')).toBe('low')
    expect(classOnWorker({ modelRoutes: null }, 'claude-sonnet-5')).toBe('med')
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
      row('claude-haiku-4-5', null, false, 'low')
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
