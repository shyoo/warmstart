import { normaliseAsk } from '@shared/policy.js'
import { errorMessage } from '@shared/errors.js'

/**
 * The pure half of the MCP server: what a tool result looks like, and how to read what the vendor
 * handed the permission hook.
 *
 * ⛔ **Separate from `index.ts` so it can be tested at all.** `index.ts` ends with a top-level
 * `await server.connect(new StdioServerTransport())`, so importing it *connects a stdio transport* —
 * which means no test could ever load it, and `questionsFrom` below, the most intricate parsing in
 * this app's agent-facing surface, had zero coverage for its whole life. Nothing here touches the
 * network, the daemon, `process.env` or stdio; the wiring stays next door.
 */

/** Render whatever a tool produced as MCP text content. */
export function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  }
}

/** The same, marked as a failure, carrying whatever the throw was willing to say about itself. */
export function failed(err: unknown): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [{ type: 'text' as const, text: errorMessage(err) }],
    isError: true
  }
}

/**
 * The vendor's own question(s), if this is one.
 *
 * ⚠️ Shape measured, not documented: `{questions: [{question, header?, options: [{label,
 * description?}], multiSelect?}]}`. Returns an empty array on anything that does not match, so a
 * future change to the payload degrades to the ordinary approval path rather than throwing inside a
 * permission hook - where the failure mode is an agent that cannot act at all.
 */
export interface NativeQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: Array<{ id: string; label: string; detail?: string }>
}

export function questionsFrom(input: unknown): NativeQuestion[] {
  if (!input || typeof input !== 'object') return []
  const list = (input as { questions?: unknown }).questions
  if (!Array.isArray(list) || list.length === 0) return []
  const result: NativeQuestion[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const rawQuestion = typeof record.question === 'string' ? record.question : null
    if (!rawQuestion) continue
    const rawOptions = Array.isArray(record.options) ? record.options : []
    const explicitMulti =
      record.multiSelect === true ||
      record.multi_select === true ||
      record.is_multi_select === true ||
      record.multiple === true

    // ⚠️ `description` is what the vendor's own `AskUserQuestion` calls the per-option prose, and
    // `detail` is what this app calls it. Mapped here, once, before anything else reads an option.
    const supplied = rawOptions
      .map((entry, index) => {
        if (typeof entry === 'string') return { id: `opt${index + 1}`, label: entry }
        const option = entry as Record<string, unknown>
        const label =
          typeof option.label === 'string'
            ? option.label
            : typeof option.text === 'string'
              ? option.text
              : null
        if (!label) return null
        return {
          id:
            typeof option.id === 'string' && option.id.trim() ? option.id.trim() : `opt${index + 1}`,
          label,
          ...(typeof option.description === 'string' && option.description
            ? { detail: option.description }
            : typeof option.detail === 'string' && option.detail
              ? { detail: option.detail }
              : {})
        }
      })
      .filter((option): option is { id: string; label: string; detail?: string } => option !== null)

    // ⛔ The same repair the agent's own `ask_human` gets. A question the CLI half-serialised is
    // half-serialised whichever tool it came from.
    const asked = normaliseAsk({
      question: rawQuestion,
      header: typeof record.header === 'string' ? record.header : null,
      kind: explicitMulti ? 'multi' : supplied.length > 0 ? 'choice' : 'text',
      options: supplied
    })

    result.push({
      question: asked.question,
      ...(asked.header ? { header: asked.header } : {}),
      multiSelect: asked.kind === 'multi',
      options: asked.options
    })
  }
  return result
}

/** A best-effort one-line rendering of what is about to happen. Never used for a policy decision. */
export function describeTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = record[key]
    if (typeof value === 'string') return value.slice(0, 300)
  }
  return ''
}
