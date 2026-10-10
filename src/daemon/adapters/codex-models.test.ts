import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexAvailableModels } from './openai-compatible.js'

/**
 * Which models a Codex account's plan offers (t953). The file read is the whole mechanism, so these
 * are written against the shape measured on CodexFirst's free account on 2026-10-07.
 */
describe('readCodexAvailableModels', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  const cache = (models: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'ws-codex-models-'))
    writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({ client_version: '0.156.0', models }))
    return dir
  }

  it('lists the visible models and withholds hidden ones', () => {
    const root = cache([
      { slug: 'gpt-6-luna', visibility: 'list' },
      { slug: 'gpt-reserve', visibility: 'hide' },
      { slug: 'gpt-5.6-terra', visibility: 'list' },
      { slug: 'gpt-5.5', visibility: 'hide' },
      { slug: 'codex-auto-review', visibility: 'hide' }
    ])
    expect(readCodexAvailableModels(root)).toEqual(['gpt-6-luna', 'gpt-5.6-terra'])
  })

  it('⛔ is unknown, never empty, when there is nothing to go on', () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-codex-models-'))
    expect(readCodexAvailableModels(dir)).toBeNull()
    expect(readCodexAvailableModels(cache([]))).toBeNull()
    expect(readCodexAvailableModels(cache([{ slug: 'gpt-reserve', visibility: 'hide' }]))).toBeNull()
    writeFileSync(join(dir, 'models_cache.json'), '{not json')
    expect(readCodexAvailableModels(dir)).toBeNull()
  })

  it('restricts models for Free accounts, but treats a stale Free cache as unknown for paid accounts', () => {
    const freeRoot = cache([
      { slug: 'gpt-6-luna', visibility: 'list' },
      { slug: 'gpt-5.6-terra', visibility: 'list' }
    ])
    // Free plan: restricted to the models in cache
    expect(readCodexAvailableModels(freeRoot, 'Free')).toEqual(['gpt-6-luna', 'gpt-5.6-terra'])
    expect(readCodexAvailableModels(freeRoot, null)).toEqual(['gpt-6-luna', 'gpt-5.6-terra'])

    // Plus/Pro plan: if cache is stale from free tier (missing gpt-6-sol), return null so models are unconstrained
    expect(readCodexAvailableModels(freeRoot, 'Plus')).toBeNull()
    expect(readCodexAvailableModels(freeRoot, 'Pro')).toBeNull()

    // Plus/Pro plan with updated cache: returns all available models
    const plusRoot = cache([
      { slug: 'gpt-6-astra', visibility: 'list' },
      { slug: 'gpt-6-sol', visibility: 'list' },
      { slug: 'gpt-6-luna', visibility: 'list' }
    ])
    expect(readCodexAvailableModels(plusRoot, 'Plus')).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
    expect(readCodexAvailableModels(plusRoot, 'Pro')).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
  })
})
