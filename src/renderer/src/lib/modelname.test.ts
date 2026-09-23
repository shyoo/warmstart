import { describe, expect, it } from 'vitest'
import { compactModelLabel, effortLabel, modelLabel } from './modelname.js'

/**
 * ⛔ **Every id here is one this fleet can actually dispatch**, read off the four files in
 * `costmodels/`. A formatter tested on invented ids proves it can title-case; these prove it names
 * the models an operator will see in the Worker column.
 */
describe('modelLabel', () => {
  it('writes the ids in costmodels/ the way a person says them', () => {
    // openai.codex.2026-08
    expect(modelLabel('gpt-6-astra')).toBe('GPT 6 Astra')
    expect(modelLabel('gpt-6-sol')).toBe('GPT 6 Sol')
    expect(modelLabel('gpt-5.6-terra')).toBe('GPT 5.6 Terra')
    expect(modelLabel('gpt-5.6-luna')).toBe('GPT 5.6 Luna')
    expect(modelLabel('gpt-5.5')).toBe('GPT 5.5')
    expect(modelLabel('gpt-5.4-mini')).toBe('GPT 5.4 Mini')
    // anthropic.subscription.2026-08 — the vendor prefix is what the family name already says.
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    // A version split across segments is one number, not two words.
    expect(modelLabel('claude-haiku-4-5')).toBe('Haiku 4.5')
    // google.antigravity.2026-08
    expect(modelLabel('gemini-3.8-flash-high')).toBe('Gemini 3.8 Flash High')
    expect(modelLabel('gemini-3.1-pro-high')).toBe('Gemini 3.1 Pro High')
    expect(modelLabel('gemini-3.7-flash-medium')).toBe('Gemini 3.7 Flash Med')
    expect(modelLabel('gemini-3.5-flash-low')).toBe('Gemini 3.5 Flash Low')
    expect(modelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(modelLabel('claude-opus-4-6-thinking')).toBe('Opus 4.6 Thinking')
    expect(modelLabel('gpt-oss-120b-medium')).toBe('GPT OSS 120B Med')
    // local.llm.2026-09
    expect(modelLabel('qwen3-coder-30b-a3b')).toBe('Qwen3 Coder 30B A3B')
  })

  it('drops a build date, which is not part of what the model is called', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    // ⚠️ Only a trailing eight-digit group. A version is not a date and must survive.
    expect(modelLabel('gpt-5.6-terra')).toBe('GPT 5.6 Terra')
  })

  it('appends the effort the CLI was told, where the id does not already carry one', () => {
    expect(modelLabel('claude-sonnet-5', 'medium')).toBe('Sonnet 5 Med')
    expect(modelLabel('claude-opus-5', 'xhigh')).toBe('Opus 5 XHigh')
    expect(modelLabel('claude-haiku-4-5', 'low')).toBe('Haiku 4.5 Low')
  })

  it('never writes the level twice when it is part of the id', () => {
    // Antigravity meters each level as its own model, so the id is where the level lives there.
    expect(modelLabel('gemini-3.7-flash-medium', 'medium')).toBe('Gemini 3.7 Flash Med')
    expect(modelLabel('gemini-3.7-flash-medium', 'high')).toBe('Gemini 3.7 Flash Med')
  })

  it('has no model list to fall out of date: an id it has never seen is still named', () => {
    expect(modelLabel('some-future-model-9')).toBe('Some Future Model 9')
    expect(modelLabel('deepseek-v4')).toBe('Deepseek V4')
  })

  it('drops the org an openai-compatible endpoint is reached through, and keeps the version', () => {
    expect(modelLabel('meta-llama/llama-4-70b')).toBe('Llama 4 70B')
    // ⛔ The dot is inside the version. Splitting on it would name this model "6 Terra".
    expect(modelLabel('openrouter/gpt-5.6-terra')).toBe('GPT 5.6 Terra')
  })

  it('says nothing rather than something, where there is no model', () => {
    // ⚠️ Null is a real answer — the CLI chooses — and each caller words it for its own space.
    expect(modelLabel(null)).toBeNull()
    expect(modelLabel(undefined)).toBeNull()
    expect(modelLabel('   ')).toBeNull()
    expect(modelLabel(null, 'high')).toBeNull()
    expect(modelLabel('<synthetic>')).toBeNull()
    expect(modelLabel('<synthetic>', 'medium')).toBeNull()
  })
})

describe('effortLabel', () => {
  it('covers the vocabulary the cost models declare', () => {
    expect(effortLabel('low')).toBe('Low')
    expect(effortLabel('medium')).toBe('Med')
    expect(effortLabel('high')).toBe('High')
    expect(effortLabel('xhigh')).toBe('XHigh')
    expect(effortLabel('max')).toBe('Max')
  })

  it('shows a level nobody here has heard of rather than hiding it', () => {
    expect(effortLabel('ultra')).toBe('Ultra')
    expect(effortLabel(null)).toBeNull()
  })
})

describe('compactModelLabel', () => {
  it('drops what the agent icon beside a chart mark already says', () => {
    expect(compactModelLabel('gemini-3.1-pro-high')).toBe('3.1 Pro High')
    expect(compactModelLabel('gemini-3.7-flash-medium')).toBe('3.7 Flash Med')
    expect(compactModelLabel('gpt-6-astra')).toBe('6 Astra')
    expect(compactModelLabel('gpt-6-sol')).toBe('6 Sol')
    expect(compactModelLabel('gpt-5.6-sol')).toBe('5.6 Sol')
    expect(compactModelLabel('muse-spark-1.3-contributor')).toBe('Spark 1.3 C')
  })

  it('keeps the word in front of a version that ends the name, or nothing would be left', () => {
    expect(compactModelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(compactModelLabel('claude-opus-5')).toBe('Opus 5')
    expect(compactModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  it('leaves a name with no version, and a local model, as modelLabel writes them', () => {
    expect(compactModelLabel('gpt-oss')).toBe(modelLabel('gpt-oss'))
    expect(compactModelLabel('local-llm:Qwen3-Coder-30B.gguf')).toBe(modelLabel('local-llm:Qwen3-Coder-30B.gguf'))
    expect(compactModelLabel(null)).toBeNull()
  })
})
