import { describe, expect, it } from 'vitest'
import { agentName, agentNames } from './agentname.js'

/**
 * ⛔ The case this file exists for: **`openai-compatible` is not a judge.** It is Codex on one
 * account and a small local model on another, and a quality table that prints the adapter id alone
 * says those two produced the same kind of number.
 */
const LABELS = {
  'claude-code': 'Claude Code',
  'openai-compatible': 'Codex CLI',
  'antigravity-cli': 'Antigravity CLI',
  'local-llm': 'Local LLM'
}

describe('agentName', () => {
  it('leads with the model and keeps the adapter beside it', () => {
    const name = agentName('openai-compatible', 'gpt-5.6-terra', LABELS)
    expect(name.primary).toBe('GPT 5.6 Terra')
    expect(name.secondary).toBe('Codex CLI')
  })

  it('tells two openai-compatible accounts apart, which the adapter id cannot', () => {
    const codex = agentName('openai-compatible', 'gpt-5.4-mini', LABELS)
    const local = agentName('openai-compatible', 'qwen3-coder-30b-a3b', LABELS)
    expect(codex.primary).toBe('GPT 5.4 Mini')
    expect(local.primary).toBe('Qwen3 Coder 30B A3B')
    expect(codex.primary).not.toBe(local.primary)
  })

  it('keeps the exact ids in the title, so the slug is always one hover away', () => {
    expect(agentName('openai-compatible', 'gpt-5.6-terra', LABELS).title).toBe(
      'openai-compatible / gpt-5.6-terra'
    )
  })

  it('⛔ says a model was not recorded rather than substituting a default', () => {
    const name = agentName('openai-compatible', null, LABELS)
    expect(name.primary).toBe('Codex CLI')
    expect(name.secondary).toBeNull()
    expect(name.title).toBe('openai-compatible / model not recorded')
  })

  it('names an adapter this build no longer loads as itself', () => {
    expect(agentName('some-retired-cli', null, LABELS).primary).toBe('some-retired-cli')
  })

  it('has an answer when nothing at all was recorded', () => {
    expect(agentName(null, null, LABELS)).toEqual({
      primary: 'not recorded',
      secondary: null,
      title: 'adapter not recorded / model not recorded'
    })
  })

  it('does not repeat the adapter when its label is what the model already says', () => {
    expect(agentName('local-llm', 'local-llm', { 'local-llm': 'Local LLM' }).secondary).toBeNull()
  })
})

describe('agentNames', () => {
  it('names every judge that is used up on a task, model first', () => {
    const listed = agentNames(
      [
        { adapterId: 'openai-compatible', model: 'gpt-5.4-mini' },
        { adapterId: 'antigravity-cli', model: 'gemini-3.8-flash-high' }
      ],
      LABELS
    )
    expect(listed?.text).toBe('GPT 5.4 Mini (Codex CLI), Gemini 3.8 Flash High (Antigravity CLI)')
    expect(listed?.title).toBe(
      'openai-compatible / gpt-5.4-mini, antigravity-cli / gemini-3.8-flash-high'
    )
  })

  it('returns null for nobody, and lets the caller word it', () => {
    expect(agentNames([], LABELS)).toBeNull()
  })
})
