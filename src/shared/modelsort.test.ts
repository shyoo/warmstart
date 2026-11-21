import { describe, expect, it } from 'vitest'
import { modelFamily, sortModelIds } from './modelsort.js'

describe('modelFamily', () => {
  it('extracts normalized family prefixes across cloud and colon-namespaced local ids', () => {
    expect(modelFamily('gemini-4-argon')).toBe('gemini')
    expect(modelFamily('claude-opus-5-5')).toBe('claude')
    expect(modelFamily('gpt-6.1-sol')).toBe('gpt')
    expect(modelFamily('gpt-oss-120b')).toBe('gpt')
    expect(modelFamily('muse-spark-1.3')).toBe('muse')
    expect(modelFamily('local-llm:Qwen3-Coder.gguf')).toBe('local-llm')
  })
})

describe('sortModelIds', () => {
  it('groups Antigravity listed and discovered models cleanly by family and generation', () => {
    const unsorted = [
      'gemini-4-hydrogen',
      'gemini-4-argon',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'gemini-3.8-flash',
      'gpt-oss-120b',
      'gemini-4-neon',
      'gemini-4-carbon',
      'gemini-pro-orchestrator'
    ]

    expect(sortModelIds(unsorted)).toEqual([
      'gemini-4-argon',
      'gemini-4-carbon',
      'gemini-4-hydrogen',
      'gemini-4-neon',
      'gemini-3.8-flash',
      'gemini-pro-orchestrator',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-oss-120b'
    ])
  })

  it('orders preferredFamilyOrder when explicitly provided and preserves first-seen order otherwise', () => {
    const mixed = ['gpt-oss-120b', 'claude-opus-5-5', 'gemini-4-hydrogen', 'gemini-4-neon']

    expect(sortModelIds(mixed)).toEqual([
      'gpt-oss-120b',
      'claude-opus-5-5',
      'gemini-4-hydrogen',
      'gemini-4-neon'
    ])

    expect(sortModelIds(mixed, ['gemini', 'claude', 'gpt'])).toEqual([
      'gemini-4-hydrogen',
      'gemini-4-neon',
      'claude-opus-5-5',
      'gpt-oss-120b'
    ])
  })

  it('orders Claude generations descending and opus before sonnet before haiku within a generation', () => {
    const claudeIds = [
      'claude-haiku-4-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-haiku-5-5',
      'claude-opus-5',
      'claude-opus-5-5'
    ]

    expect(sortModelIds(claudeIds)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5'
    ])
  })

  it('orders Codex numbered generations descending ahead of versionless gpt-oss models', () => {
    const codexIds = [
      'gpt-oss-240b',
      'gpt-5.6-luna',
      'gpt-6-sol',
      'gpt-6.1-terra',
      'gpt-oss-120b',
      'gpt-6.1-sol',
      'gpt-5.5'
    ]

    expect(sortModelIds(codexIds)).toEqual([
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6-sol',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-oss-120b',
      'gpt-oss-240b'
    ])
  })

  it('orders Muse and local-llm ids deterministically without mutating the input array', () => {
    const input = [
      'local-llm:Qwen3.8-27B.gguf',
      'local-llm:Qwen3-Coder.gguf',
      'local-llm:Llama3-70B.gguf'
    ]
    const snapshot = [...input]

    expect(sortModelIds(input)).toEqual([
      'local-llm:Llama3-70B.gguf',
      'local-llm:Qwen3-Coder.gguf',
      'local-llm:Qwen3.8-27B.gguf'
    ])
    expect(input).toEqual(snapshot)

    expect(
      sortModelIds(['muse-spark-1.2', 'muse-spark-1.3-contributor', 'muse-spark-1.3'])
    ).toEqual(['muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-spark-1.2'])
  })
})
