/**
 * Model ids, written the way a person says them.
 *
 * ⛔ **Display only, and never parsed back.** The id is the identifier — it is what the cost model
 * is keyed by, what the CLI is passed, and what every `<option value>` in this app carries. This
 * turns one into a label for a human to read at a glance, so `gemini-3.7-flash-medium` reads as
 * *Gemini 3.7 Flash Med* in a table cell that has room for three words and not for a slug.
 *
 * ⚠️ The exact id is therefore always kept within reach — every caller puts it in a `title`. A
 * prettified name that cannot be traced back to the thing that was dispatched is worse than the
 * slug it replaced, because the operator who needs the id is the one debugging a routing mistake.
 *
 * ⛔ **Nothing branches on a family name.** This is string formatting: an id nobody has ever seen
 * gets title-cased and shown, not dropped. A models table that has to be edited before a new model
 * can be named would go stale the day one shipped, and the cost model files are already the one
 * place that lists them.
 */

/** Rendered upper-case whole. Vendor initialisms, not words. */
const ACRONYMS = new Set(['gpt', 'oss', 'llm', 'ai', 'api', 'vl', 'moe', 'r1', 'qwq'])

/**
 * Effort as it is written on screen.
 *
 * ⚠️ The keys are the vocabulary the cost models actually declare (`effort_levels`: low, medium,
 * high, xhigh, max), plus the spellings that arrive inside a model id on Antigravity, where the
 * level is part of the id rather than a flag. `medium` shortens because it is the common one and
 * the column is narrow; the rest are already short enough to leave alone.
 */
const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  med: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  minimal: 'Min'
}

/** A vendor prefix that only repeats what the family name already says. */
const REDUNDANT_PREFIXES = new Set(['claude', 'anthropic', 'openai', 'google'])

export function effortLabel(effort: string | null | undefined): string | null {
  if (!effort) return null
  const key = effort.trim().toLowerCase()
  if (!key) return null
  return EFFORT_LABELS[key] ?? titleCase(key)
}

/**
 * `claude-sonnet-5` + `medium` → `Sonnet 5 Med`. `gpt-5.6-terra` → `GPT 5.6 Terra`.
 *
 * ⚠️ `effort` is appended only when the id does not already carry one. Antigravity meters
 * `gemini-3.7-flash-medium` as its own model, so the level is in the id there and passing an effort
 * alongside it would render *Gemini 3.7 Flash Med Med*.
 *
 * Returns null for no model, which is a real answer — it means the CLI chooses — and the caller
 * words it, because "nothing chosen" reads differently in a table cell and in a detail pane.
 */
export function modelLabel(model: string | null | undefined, effort?: string | null): string | null {
  if (!model) return null
  // ⚠️ `org/model` is how an openai-compatible endpoint names one. The org is where the model is
  // being reached, not part of what it is called. ⛔ Split on `/` only — a dot is *inside* a version
  // (`gpt-5.6-terra`), so treating it as a separator would render that model as `6 Terra`.
  // ⚠️ A build date is not part of the name. `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are
  // the same model to everyone reading a table, and the eight digits crowd out the version that is
  // actually being compared between rows.
  const named = (model.trim().split('/').pop() ?? '').replace(/-\d{8}$/, '')
  const parts = named.split(/[-_\s]+/).filter(Boolean)
  if (parts.length === 0) return null

  const words: string[] = []
  let trailingEffort: string | null = null

  parts.forEach((part, i) => {
    const token = part.toLowerCase()
    if (i === 0 && parts.length > 1 && REDUNDANT_PREFIXES.has(token)) return
    // ⛔ Last position only. `max` is an effort at the end of an id and part of the name anywhere
    // else, and a model called `max-1` is not a level.
    if (i === parts.length - 1 && parts.length > 1 && EFFORT_LABELS[token]) {
      trailingEffort = EFFORT_LABELS[token]!
      return
    }
    const last = words[words.length - 1]
    // A version split across segments — `haiku-4-5` — is one number, not two words.
    if (/^\d+$/.test(token) && last && /\d$/.test(last)) {
      words[words.length - 1] = `${last}.${token}`
      return
    }
    words.push(word(token))
  })

  const suffix = trailingEffort ?? effortLabel(effort)
  return [words.join(' '), suffix].filter(Boolean).join(' ') || null
}

function word(token: string): string {
  if (ACRONYMS.has(token)) return token.toUpperCase()
  // A bare version number is already written the way it is read.
  if (/^\d+(\.\d+)*$/.test(token)) return token
  // Sizes and revisions — `120b`, `30b`, `a3b`. Short, and upper-case wherever anyone writes them.
  if (/\d/.test(token) && token.length <= 4) return token.toUpperCase()
  return titleCase(token)
}

function titleCase(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1)
}
