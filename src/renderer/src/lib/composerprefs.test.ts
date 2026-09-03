import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPOSER_PREFS,
  modelChoiceFor,
  readComposerPrefs,
  rememberModelChoice,
  writeComposerPrefs
} from './composerprefs.js'

/**
 * ⛔ The interesting cases are the damaged ones, not the round trip. This record is the only thing
 * standing between an operator and re-choosing five controls on every task they file, and the two
 * ways it can fail are opposite: forgetting everything because one field aged out, and handing an
 * account a model id belonging to a different CLI.
 */
const stub = (store: Record<string, string> | null, throws = false): void => {
  const storage = {
    getItem: (k: string) => {
      if (throws) throw new Error('site data disabled')
      return store?.[k] ?? null
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('site data disabled')
      if (store) store[k] = v
    }
  }
  ;(globalThis as { window?: unknown }).window = { localStorage: store === null ? null : storage }
}

describe('what the new-task composer was left set to', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('starts on inherit everywhere, because a fresh install has nothing to remember', () => {
    stub({})
    expect(readComposerPrefs()).toEqual(DEFAULT_COMPOSER_PREFS)
    expect(readComposerPrefs().finishPolicy).toBe('inherit')
    expect(readComposerPrefs().sessionSharing).toBe('inherit')
  })

  it('comes back with what was last chosen', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeComposerPrefs({
      priority: 'P0',
      kind: 'plan',
      finishPolicy: 'commit-only',
      sessionSharing: 'on',
      workerId: 'w-claude',
      byWorker: { 'w-claude': { model: 'claude-opus-5', effort: 'high' } }
    })
    const back = readComposerPrefs()
    expect(back.priority).toBe('P0')
    expect(back.kind).toBe('plan')
    expect(back.finishPolicy).toBe('commit-only')
    expect(back.sessionSharing).toBe('on')
    expect(back.workerId).toBe('w-claude')
    expect(modelChoiceFor(back, 'w-claude')).toEqual({ model: 'claude-opus-5', effort: 'high' })
  })

  it('reads a finish policy written under its old name', () => {
    stub({
      'multi_agent_controller.composer': JSON.stringify({ finishPolicy: 'agent-lands' })
    })
    // ⛔ Not `inherit`. `agent-lands` meant *push the trunk* when it was chosen, and a rename must
    // not quietly turn somebody's remembered choice into a different one.
    expect(readComposerPrefs().finishPolicy).toBe('commit-and-push')
  })

  it('drops only the field it cannot read, never the record around it', () => {
    stub({
      'multi_agent_controller.composer': JSON.stringify({
        priority: 'P9',
        kind: 'conversation',
        finishPolicy: 'nonsense',
        sessionSharing: 'maybe',
        workerId: 'w-codex',
        byWorker: { 'w-codex': { model: 'gpt-5.6-terra', effort: 'medium' } }
      })
    })
    const back = readComposerPrefs()
    expect(back.priority).toBe('P2')
    expect(back.kind).toBe('task')
    expect(back.finishPolicy).toBe('inherit')
    expect(back.sessionSharing).toBe('inherit')
    // ⭐ The half that survived is the point: an aged-out policy must not cost somebody their
    // pinned account and its model.
    expect(back.workerId).toBe('w-codex')
    expect(modelChoiceFor(back, 'w-codex')).toEqual({ model: 'gpt-5.6-terra', effort: 'medium' })
  })

  it('keeps a model against the account it was chosen for, and offers none for any other', () => {
    const prefs = rememberModelChoice(DEFAULT_COMPOSER_PREFS, 'w-claude', {
      model: 'claude-opus-5',
      effort: 'high'
    })
    expect(modelChoiceFor(prefs, 'w-claude')).toEqual({ model: 'claude-opus-5', effort: 'high' })
    // ⛔ A model id belongs to one CLI. An account nobody has chosen a model for inherits, and never
    // borrows the last one somebody picked somewhere else.
    expect(modelChoiceFor(prefs, 'w-agy')).toEqual({ model: '', effort: '' })
    expect(modelChoiceFor(prefs, '')).toEqual({ model: '', effort: '' })
    // Pure: the record it was given is untouched.
    expect(DEFAULT_COMPOSER_PREFS.byWorker).toEqual({})
  })

  it('survives a profile that refuses storage at all', () => {
    stub(null)
    expect(readComposerPrefs()).toEqual(DEFAULT_COMPOSER_PREFS)
    expect(() => writeComposerPrefs(DEFAULT_COMPOSER_PREFS)).not.toThrow()
    stub({}, true)
    expect(readComposerPrefs()).toEqual(DEFAULT_COMPOSER_PREFS)
    expect(() => writeComposerPrefs(DEFAULT_COMPOSER_PREFS)).not.toThrow()
  })

  it('ignores a stored shape that is not a record', () => {
    stub({ 'multi_agent_controller.composer': '["nope"]' })
    expect(readComposerPrefs()).toEqual(DEFAULT_COMPOSER_PREFS)
    stub({ 'multi_agent_controller.composer': 'not json at all' })
    expect(readComposerPrefs()).toEqual(DEFAULT_COMPOSER_PREFS)
    stub({ 'multi_agent_controller.composer': JSON.stringify({ byWorker: 'w-claude' }) })
    expect(readComposerPrefs().byWorker).toEqual({})
  })
})
