import { modelLabel } from './modelname.js'

/**
 * Naming an agent where the *model* is the thing being compared.
 *
 * ⛔ **An adapter id is a transport, not an identity.** `openai-compatible` is Codex CLI on one
 * account and a 4B model served from a local endpoint on another, and `local-llm` is whatever
 * happens to be loaded. A quality table that names only the adapter puts two grades that measure
 * completely different things under one label and then invites an operator to compare them — which
 * is the one thing the Quality pages exist to make possible.
 *
 * So the model leads and the adapter follows it, quietly: *GPT 5.6 Mini · Codex CLI*. Where no model
 * was recorded there is nothing to lead with, and the adapter is all that can honestly be said.
 *
 * ⚠️ **The exact ids stay within reach**, the rule `modelname.ts` states and every caller keeps: the
 * `title` is the raw `adapter/model`, because the operator who needs the slug is the one debugging a
 * routing mistake and a prettified name they cannot trace back is worse than the slug it replaced.
 *
 * ⛔ Nothing here branches on which adapter it is. The labels come from the daemon, which asks the
 * adapters themselves; a table of vendor names in the renderer would go stale the day one shipped.
 */
export interface AgentName {
  /** What the cell shows: the model, or the adapter when no model was recorded. */
  primary: string
  /** The adapter, shown dim beside the model. Null when it is already `primary`. */
  secondary: string | null
  /** The exact ids, for the `title`. ⚠️ Never prettified — this is the debugging handle. */
  title: string
}

/**
 * `('openai-compatible', 'gpt-5.6-mini', {…})` → *GPT 5.6 Mini* · *Codex CLI*.
 *
 * `labels` maps adapter id to display name (`ReviewQueuePage.adapterLabels`). An id with no entry —
 * an adapter this build no longer loads — renders as itself rather than disappearing.
 */
export function agentName(
  adapterId: string | null | undefined,
  model: string | null | undefined,
  labels: Record<string, string> = {}
): AgentName {
  const id = adapterId?.trim() || null
  const adapterText = id ? (labels[id] ?? id) : null
  const modelText = modelLabel(model)
  const title = [id ?? 'adapter not recorded', model?.trim() || 'model not recorded'].join(' / ')

  if (!modelText) return { primary: adapterText ?? 'not recorded', secondary: null, title }
  // ⚠️ The adapter is dropped from view only when its label is what the model name already says —
  // `local-llm` beside *Qwen3 Coder 30B A3B* is noise, `Codex CLI` beside *GPT 5.6 Mini* is not.
  const redundant = adapterText !== null && adapterText.toLowerCase() === modelText.toLowerCase()
  return { primary: modelText, secondary: redundant ? null : adapterText, title }
}

/**
 * A whole list of judges in one cell — *GPT 5.6 Mini (Codex CLI), Gemini 3.8 Flash High*.
 *
 * ⚠️ Flattened to a string rather than to elements, because the cell it fills is a sentence about
 * who is used up. Returns null for nobody, which the caller words: "—" reads differently in the
 * *Graded by* column and in a batch row.
 */
export function agentNames(
  credits: ReadonlyArray<{ adapterId: string; model: string | null }>,
  labels: Record<string, string> = {}
): { text: string; title: string } | null {
  if (credits.length === 0) return null
  const named = credits.map((c) => agentName(c.adapterId, c.model, labels))
  return {
    text: named.map((n) => (n.secondary ? `${n.primary} (${n.secondary})` : n.primary)).join(', '),
    title: named.map((n) => n.title).join(', ')
  }
}
