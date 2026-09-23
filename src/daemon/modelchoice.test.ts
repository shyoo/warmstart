import { describe, expect, it } from 'vitest'
import { resolveModelChoice } from '@shared/tasks.js'
import type { TaskConstraints } from '@shared/tasks.js'
import type { ModelRoute } from '@shared/modelroutes.js'

/**
 * Which model and effort a dispatch actually reaches for.
 *
 * ⭐ Two tiers - task, then worker, then the CLI's own choice - and deliberately not the three that
 * finish policy uses. A model id belongs to one CLI: `opus` means nothing to Antigravity and
 * `gemini-3.1-pro-high` means nothing to Claude Code, so a default held at the project or the fleet
 * would be invalid for every task that routed to a different adapter, which on a mixed fleet is most
 * of them.
 *
 * ⚠️ The resolver lives in `@shared` and is called by both the scheduler and the New Task form, so
 * the form cannot promise an inheritance the scheduler does not perform. These tests are the
 * definition both sides are held to.
 */

/** Only the two fields the resolver reads; a real TaskConstraints carries six more that do not. */
const constraints = (
  over: Partial<Pick<TaskConstraints, 'model' | 'effort'>> = {}
): Pick<TaskConstraints, 'model' | 'effort'> => ({ ...over })

const account = (defaultModel: string | null, defaultEffort: string | null = null) => ({
  defaultModel,
  defaultEffort
})

describe('resolving the model a task runs on', () => {
  it('takes the task pin over everything, because somebody chose it for this task', () => {
    const r = resolveModelChoice(constraints({ model: 'claude-opus-5' }), account('claude-sonnet-5'), true)
    expect(r.model).toBe('claude-opus-5')
    expect(r.modelSource).toBe('task')
  })

  it('falls to the account default when the task says nothing', () => {
    const r = resolveModelChoice(constraints(), account('claude-sonnet-5'), true)
    expect(r.model).toBe('claude-sonnet-5')
    expect(r.modelSource).toBe('worker')
  })

  it('leaves it to the CLI when neither says anything, which is an answer', () => {
    // ⛔ `null` is not "unset, keep looking" — there is no further tier. It is the state every
    //    install ran in before this control existed, and the one clearing the box returns to.
    const r = resolveModelChoice(constraints(), account(null), true)
    expect(r.model).toBeNull()
    expect(r.modelSource).toBe('cli')
  })

  it('says where the answer came from, not just what it is', () => {
    // ⚠️ A setting whose origin is invisible is one nobody trusts and everybody overrides — the same
    //    argument `resolveFinishPolicy` makes for carrying its `source`.
    expect(resolveModelChoice(constraints(), null, true).modelSource).toBe('cli')
    expect(resolveModelChoice(constraints(), account('x'), true).modelSource).toBe('worker')
    expect(resolveModelChoice(constraints({ model: 'y' }), account('x'), true).modelSource).toBe('task')
  })

  it('survives a worker that is not there at all', () => {
    const r = resolveModelChoice(constraints({ model: 'claude-opus-5' }), null, true)
    expect(r.model).toBe('claude-opus-5')
  })
})

describe('resolving effort, where the CLI can be told one', () => {
  it('inherits the account default the same way the model does', () => {
    const r = resolveModelChoice(constraints(), account('claude-opus-5', 'xhigh'), true)
    expect(r.effort).toBe('xhigh')
    expect(r.effortSource).toBe('worker')
  })

  it('lets the task override just the effort, keeping the account model', () => {
    // ⚠️ The two resolve independently, because the CLI takes them as two separate flags. A task
    //    that wants "the usual model, but think harder" must not have to restate the model.
    const r = resolveModelChoice(constraints({ effort: 'max' }), account('claude-opus-5', 'low'), true)
    expect(r.model).toBe('claude-opus-5')
    expect(r.modelSource).toBe('worker')
    expect(r.effort).toBe('max')
    expect(r.effortSource).toBe('task')
  })

  it('drops effort entirely where the adapter cannot be told one', () => {
    // ⛔ Dropped, not defaulted and not passed hopefully. Measured 2026-08-29: agy *refuses*
    //    `--effort` for every model this fleet dispatches, so sending it fails the dispatch outright
    //    rather than being politely ignored.
    const r = resolveModelChoice(
      constraints({ model: 'gemini-3.1-pro-high', effort: 'low' }),
      account(null, 'high'),
      false
    )
    expect(r.effort).toBeNull()
    expect(r.effortSource).toBe('cli')
  })

  it('still resolves the model normally on an adapter with no effort flag', () => {
    // ⛔ The guard. Antigravity has no effort control and must still inherit its account's model —
    //    collapsing the two would leave the whole provider unable to hold a default.
    const r = resolveModelChoice(constraints(), account('gemini-3.1-pro-high', 'ignored'), false)
    expect(r.model).toBe('gemini-3.1-pro-high')
    expect(r.modelSource).toBe('worker')
    expect(r.effort).toBeNull()
  })

  const rows = (...pairs: Array<[string, string | null, boolean?]>): ModelRoute[] =>
    pairs.map(([model, effort, auto]) => ({ model, effort, modelClass: null, auto: auto ?? true }))

  it("⛔ the default model runs at the default row's effort, not at another row's", () => {
    const acc = {
      defaultModel: 'claude-opus-5',
      defaultEffort: 'low',
      modelRoutes: rows(['claude-opus-5', 'high'], ['claude-sonnet-5', 'max'])
    }
    const r = resolveModelChoice(constraints(), acc, true)
    expect(r.model).toBe('claude-opus-5')
    expect(r.effort).toBe('low')
    expect(r.effortSource).toBe('worker')
  })

  it("a task pinning another model inherits that model's row effort, auto row first", () => {
    const acc = {
      defaultModel: 'claude-opus-5',
      defaultEffort: 'low',
      modelRoutes: rows(['claude-sonnet-5', 'high', false], ['claude-sonnet-5', 'max'])
    }
    const r = resolveModelChoice(constraints({ model: 'claude-sonnet-5' }), acc, true)
    expect(r.effort).toBe('max')
    expect(r.effortSource).toBe('worker')
  })

  it("task constraints effort overrides the worker's rows", () => {
    const acc = {
      defaultModel: 'claude-opus-5',
      defaultEffort: 'low',
      modelRoutes: rows(['claude-opus-5', 'high'])
    }
    const r = resolveModelChoice(constraints({ effort: 'xhigh' }), acc, true)
    expect(r.effort).toBe('xhigh')
    expect(r.effortSource).toBe('task')
  })

  it('falls back to worker.defaultEffort when the model has no row with an effort', () => {
    const acc = {
      defaultModel: 'claude-opus-5',
      defaultEffort: 'low',
      modelRoutes: rows(['claude-opus-5', 'high'])
    }
    const r = resolveModelChoice(constraints({ model: 'claude-sonnet-5' }), acc, true)
    expect(r.effort).toBe('low')
    expect(r.effortSource).toBe('worker')
  })
})
