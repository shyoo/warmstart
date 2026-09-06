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

  it('⛔ remembers the pieces row separately from the planner’s own', () => {
    const store: Record<string, string> = {}
    stub(store)
    const prefs = readComposerPrefs()
    writeComposerPrefs({
      ...prefs,
      workerId: 'w-opus',
      pieces: { ...prefs.pieces, workerId: 'w-haiku', maxChildren: 7, finishPolicy: 'commit-only' }
    })
    const back = readComposerPrefs()
    // "Plan with one model, build with another" is the case Plan & Split exists for; one row of
    // settings would have forced the planner and its pieces onto the same account.
    expect(back.workerId).toBe('w-opus')
    expect(back.pieces.workerId).toBe('w-haiku')
    expect(back.pieces.maxChildren).toBe(7)
    expect(back.pieces.finishPolicy).toBe('commit-only')
  })

  it('⚠️ clamps a stored fan-out from a build that allowed a different range', () => {
    const store: Record<string, string> = {}
    stub(store)
    const prefs = readComposerPrefs()
    writeComposerPrefs({ ...prefs, pieces: { ...prefs.pieces, maxChildren: 40 } })
    expect(readComposerPrefs().pieces.maxChildren).toBe(8)
    writeComposerPrefs({ ...prefs, pieces: { ...prefs.pieces, maxChildren: 1 } })
    // The floor is the daemon's own rule: a split of one is refused.
    expect(readComposerPrefs().pieces.maxChildren).toBe(2)
  })

  it('keeps the planner’s row when the pieces row is unreadable', () => {
    const store: Record<string, string> = { 'multi_agent_controller.composer': JSON.stringify({
      priority: 'P0',
      workerId: 'w-opus',
      pieces: 'not an object'
    }) }
    stub(store)
    const back = readComposerPrefs()
    expect(back.priority).toBe('P0')
    expect(back.workerId).toBe('w-opus')
    expect(back.pieces).toEqual(DEFAULT_COMPOSER_PREFS.pieces)
  })

  it('comes back with what was last chosen', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeComposerPrefs({
      priority: 'P0',
      kind: 'plan',
      finishPolicy: 'commit-only',
      sessionSharing: 'on',
      pieces: { ...DEFAULT_COMPOSER_PREFS.pieces },
      workerId: 'w-claude',
      byWorker: { 'w-claude': { model: 'claude-opus-5', effort: 'high', policy: 'auto' } }
    })
    const back = readComposerPrefs()
    expect(back.priority).toBe('P0')
    expect(back.kind).toBe('plan')
    expect(back.finishPolicy).toBe('commit-only')
    expect(back.sessionSharing).toBe('on')
    expect(back.workerId).toBe('w-claude')
    expect(modelChoiceFor(back, 'w-claude')).toEqual({
      model: 'claude-opus-5',
      effort: 'high',
      policy: 'auto'
    })
  })

  it('⛔ remembers *which* answer was given when no model was named', () => {
    // Auto and the account's own default are both "no model", and they are not the same
    // instruction: with a routable-model allowlist on the account, one hands the choice to the
    // router and the other does not. A composer that forgot which was picked would file the wrong
    // one every time it reopened.
    const store: Record<string, string> = {}
    stub(store)
    const prefs = rememberModelChoice(DEFAULT_COMPOSER_PREFS, 'w-codex', {
      model: '',
      effort: '',
      policy: 'inherit'
    })
    writeComposerPrefs(prefs)
    expect(modelChoiceFor(readComposerPrefs(), 'w-codex').policy).toBe('inherit')
  })

  it('reads a finish policy written under its old name', () => {
    stub({
      'multi_agent_controller.composer': JSON.stringify({ finishPolicy: 'agent-lands' })
    })
    // ⛔ Not `inherit`. `agent-lands` meant *push the trunk* when it was chosen, and a rename must
    // not quietly turn somebody's remembered choice into a different one.
    expect(readComposerPrefs().finishPolicy).toBe('commit-and-push')
  })

  it('remembers conversation, which is a kind the composer files', () => {
    stub({
      'multi_agent_controller.composer': JSON.stringify({ kind: 'conversation' })
    })
    expect(readComposerPrefs().kind).toBe('conversation')
  })

  it('drops only the field it cannot read, never the record around it', () => {
    stub({
      'multi_agent_controller.composer': JSON.stringify({
        priority: 'P9',
        // ⚠️ `multi-task` and not `conversation`: conversation is a real kind now, and a test whose
        // "unreadable" example quietly became readable would go on passing while asserting nothing.
        kind: 'multi-task',
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
    // ⚠️ `policy` back as `auto`: this record was written before the field existed, and `auto` is
    // what it did.
    expect(modelChoiceFor(back, 'w-codex')).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'medium',
      policy: 'auto'
    })
  })

  it('keeps a model against the account it was chosen for, and offers none for any other', () => {
    const prefs = rememberModelChoice(DEFAULT_COMPOSER_PREFS, 'w-claude', {
      model: 'claude-opus-5',
      effort: 'high',
      policy: 'auto'
    })
    expect(modelChoiceFor(prefs, 'w-claude')).toEqual({
      model: 'claude-opus-5',
      effort: 'high',
      policy: 'auto'
    })
    // ⛔ A model id belongs to one CLI. An account nobody has chosen a model for inherits, and never
    // borrows the last one somebody picked somewhere else.
    expect(modelChoiceFor(prefs, 'w-agy')).toEqual({ model: '', effort: '', policy: 'auto' })
    expect(modelChoiceFor(prefs, '')).toEqual({ model: '', effort: '', policy: 'auto' })
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
