/**
 * Model capability classes (tiers): high, med, low.
 *
 * ⛔ **Classification is data and heuristics, overridden per-worker.**
 * Tasks can specify a preferred capability class when using Auto Model routing,
 * giving operators control over assigning powerful models to hard tasks or
 * economy models to routine ones without having to pin an exact model ID.
 */

export type ModelClass = 'high' | 'med' | 'low'

export const MODEL_CLASSES: ModelClass[] = ['high', 'med', 'low']

export const MODEL_CLASS_LABELS: Record<ModelClass, string> = {
  high: 'High',
  med: 'Medium',
  low: 'Low'
}

/** Built-in defaults for well-known models across providers. */
export const DEFAULT_MODEL_CLASSES: Record<string, ModelClass> = {
  // Anthropic Claude
  'claude-opus-5': 'high',
  'claude-opus-4-8': 'high',
  'claude-opus-4-6': 'high',
  'claude-sonnet-5': 'med',
  'claude-sonnet-4-6': 'med',
  'claude-haiku-4-5': 'low',

  // OpenAI Codex
  'gpt-6-astra': 'high',
  'gpt-5.6-sol': 'high',
  'gpt-5.6-terra': 'med',
  'gpt-5.6-mini': 'low',
  'gpt-5.6-luna': 'low',
  'o1': 'high',
  'o3': 'high',

  // Google Antigravity
  'gemini-3.8-flash-high': 'high',
  'gemini-3.7-flash-high': 'high',
  'gemini-3.8-flash-medium': 'med',
  'gemini-3.7-flash-medium': 'med',
  'gemini-3.8-flash-low': 'low',
  'gemini-3.7-flash-low': 'low',

  // Meta Muse
  'meta-codellama-70b': 'med',

  // Local LLM / Bridge
  'qwen3-coder-30b-a3b': 'med'
}

/**
 * Determine the default capability class for a model ID using exact matches,
 * prefix matches, or keyword heuristics.
 */
export function defaultModelClass(modelId: string | null | undefined): ModelClass {
  if (!modelId) return 'med'
  const lower = modelId.toLowerCase()

  if (DEFAULT_MODEL_CLASSES[lower]) {
    return DEFAULT_MODEL_CLASSES[lower]
  }

  for (const [key, cls] of Object.entries(DEFAULT_MODEL_CLASSES)) {
    if (lower.startsWith(key)) return cls
  }

  // Keyword-based heuristics
  if (
    lower.includes('opus') ||
    lower.includes('astra') ||
    lower.includes('sol') ||
    lower.includes('ultra') ||
    lower.includes('pro') ||
    lower.includes('flash-high') ||
    lower.endsWith('-high') ||
    lower.endsWith('_high') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3')
  ) {
    return 'high'
  }

  if (
    lower.includes('haiku') ||
    lower.includes('mini') ||
    lower.includes('lite') ||
    lower.includes('nano') ||
    lower.includes('flash-low') ||
    lower.endsWith('-low') ||
    lower.endsWith('_low') ||
    lower.includes('small')
  ) {
    return 'low'
  }

  // Default middle tier
  return 'med'
}

/**
 * Resolve the effective model class for a model on a given worker.
 * Worker-level overrides take precedence over built-in defaults.
 */
export function resolveModelClass(
  modelId: string | null | undefined,
  worker?: { modelClasses?: Record<string, ModelClass> | null } | null
): ModelClass {
  if (!modelId) return 'med'
  if (worker?.modelClasses && worker.modelClasses[modelId]) {
    return worker.modelClasses[modelId]
  }
  return defaultModelClass(modelId)
}
