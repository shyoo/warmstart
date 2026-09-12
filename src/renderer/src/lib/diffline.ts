/**
 * How a patch line is classified for display — the whole of the interpretation applied to it.
 *
 * ⛔ **The first character, and nothing else.** This is agent output: a patch is literally a file an
 * agent wrote, quoted back. There is no tokenizer here, no language detection and no attempt to
 * understand the code, because every library that offers those takes a string and returns HTML, and
 * HTML is the one thing that may never be produced from this text. The class picked here is applied
 * to a React text node inside `<pre>`. See `docs/ui.md`.
 *
 * ⚠️ Pure, and in `lib/` rather than in the component, so it can be pinned by a test without a DOM.
 */
export type PatchLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

/**
 * ⚠️ The header lines are checked **first**, because `+++` and `---` begin with the add and delete
 * characters without being either. Checking the single characters first paints the two header lines
 * at the top of every file green and red, which reads as a change that is not there.
 */
export function patchLineKind(line: string): PatchLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('old mode ') || line.startsWith('new mode ')) return 'meta'
  if (line.startsWith('similarity index ')) return 'meta'
  if (line.startsWith('rename from ') || line.startsWith('rename to ')) return 'meta'
  if (line.startsWith('Binary files ')) return 'meta'
  // `\ No newline at end of file` — git's own note, not a line of anybody's code.
  if (line.startsWith('\\')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

export function patchLineClass(line: string): string {
  const kind = patchLineKind(line)
  return kind === 'context' ? 'diff-line' : `diff-line diff-line--${kind}`
}
