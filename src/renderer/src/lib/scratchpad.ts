import type { Task, TaskStatus } from '@shared/tasks'

/**
 * A project's scratchpad as cards (t994): one markdown file, split on its own `---` lines.
 *
 * ⛔ **The text is the record.** Every card operation here is a text edit the operator could have
 * made in VS Code, and `serializeScratch(parseScratch(text)) === text` for any text: opening the
 * page and leaving it writes nothing back, and a file of 685 prompts survives a one-card edit with
 * the other 684 byte for byte.
 *
 * ⭐ **Whitespace belongs to the slot, not to the prompt.** Each card's blank lines before and after
 * it (`Frame`) stay where they are when bodies move, so reordering never leaves a `---` jammed against
 * text. Only `body` — the card's text from its first non-blank line to its last — travels.
 *
 * ⚠️ **A separator is a line of three or more dashes and nothing else, outside a code fence.** That
 * is how the operator already split their history; `***` and `___` are left as text because nobody
 * wrote them meaning "next prompt".
 */

/** One card. `key` is stable across moves and edits in this session; it is never written. */
export interface ScratchItem {
  key: number
  body: string
}

/** The blank lines around one slot. `lead` ends with a newline or is empty; `trail` starts with one. */
export interface Frame {
  lead: string
  trail: string
  /**
   * The slot held no lines at all — a `---` on the first or last line, or two in a row. ⚠️ Not the
   * same as one blank line, which also reads as `''`; without this a round trip adds a newline.
   */
  bare?: true
}

export interface ScratchDoc {
  items: ScratchItem[]
  /** One per item, positional. */
  frames: Frame[]
  /** `seps[i]` is the exact separator line between item `i` and `i + 1`. */
  seps: string[]
}

export const SEPARATOR = '---'

let nextKey = 1
function key(): number {
  return nextKey++
}

const SEPARATOR_LINE = /^-{3,}[ \t]*$/
const FENCE = /^[ \t]{0,3}(```|~~~)/

/** Which lines are separators, skipping fenced code. */
function separatorLines(lines: string[]): number[] {
  const out: number[] = []
  let fence: string | null = null
  lines.forEach((line, i) => {
    const open = FENCE.exec(line)?.[1]
    if (open) {
      if (fence === null) fence = open
      else if (open === fence) fence = null
      return
    }
    if (fence === null && SEPARATOR_LINE.test(line)) out.push(i)
  })
  return out
}

function frameOf(chunk: string): { frame: Frame; body: string } {
  const lead = /^(?:[ \t]*\n)*/.exec(chunk)?.[0] ?? ''
  const rest = chunk.slice(lead.length)
  const trail = /(?:\n[ \t]*)*$/.exec(rest)?.[0] ?? ''
  return { frame: { lead, trail }, body: rest.slice(0, rest.length - trail.length) }
}

/** ⚠️ Text that is only whitespace is no cards at all, not one empty card. */
export function parseScratch(text: string): ScratchDoc {
  if (text.trim() === '') return { items: [], frames: [], seps: [] }
  const lines = text.split('\n')
  const cuts = separatorLines(lines)
  const items: ScratchItem[] = []
  const frames: Frame[] = []
  const seps: string[] = []
  let start = 0
  for (const cut of [...cuts, lines.length]) {
    const slot = lines.slice(start, cut)
    const { frame, body } = frameOf(slot.join('\n'))
    items.push({ key: key(), body })
    frames.push(slot.length === 0 ? { ...frame, bare: true } : frame)
    if (cut < lines.length) seps.push(lines[cut]!)
    start = cut + 1
  }
  return { items, frames, seps }
}

export function serializeScratch(doc: ScratchDoc): string {
  const lines: string[] = []
  doc.items.forEach((item, i) => {
    const frame = doc.frames[i] ?? INNER
    const chunk = frame.lead + item.body + frame.trail
    if (!(frame.bare && chunk === '')) lines.push(chunk)
    const sep = doc.seps[i]
    if (sep !== undefined) lines.push(sep)
  })
  return lines.join('\n')
}

/** A card's body, cut wherever it now holds a separator line of its own. */
function splitBody(body: string): string[] {
  const lines = body.split('\n')
  const cuts = separatorLines(lines)
  if (cuts.length === 0) return [body]
  const parts: string[] = []
  let start = 0
  for (const cut of [...cuts, lines.length]) {
    parts.push(frameOf(lines.slice(start, cut).join('\n')).body)
    start = cut + 1
  }
  return parts
}

const INNER: Frame = { lead: '\n', trail: '\n' }

/**
 * Replace one card's text. ⭐ A `---` typed into it splits it there, exactly as the file would read.
 *
 * ⚠️ The splitting is the caller's to time: the editor applies it on blur, not per keystroke, so the
 * caret is not thrown into a new card halfway through typing a line of dashes.
 */
export function setBody(doc: ScratchDoc, index: number, body: string, split = false): ScratchDoc {
  const item = doc.items[index]
  const frame = doc.frames[index]
  if (!item || !frame) return doc
  const parts = split ? splitBody(body) : [body]
  if (parts.length === 1) {
    return { ...doc, items: doc.items.map((each, i) => (i === index ? { ...each, body } : each)) }
  }
  const items = parts.map((part, j) => ({ key: j === 0 ? item.key : key(), body: part }))
  const frames = parts.map((_, j) => ({
    lead: j === 0 ? frame.lead : INNER.lead,
    trail: j === parts.length - 1 ? frame.trail : INNER.trail
  }))
  return {
    items: [...doc.items.slice(0, index), ...items, ...doc.items.slice(index + 1)],
    frames: [...doc.frames.slice(0, index), ...frames, ...doc.frames.slice(index + 1)],
    seps: [...doc.seps.slice(0, index), ...parts.slice(1).map(() => SEPARATOR), ...doc.seps.slice(index)]
  }
}

/** Cut one card in two at a character offset into its body. Nothing happens at either end. */
export function splitAt(doc: ScratchDoc, index: number, offset: number): ScratchDoc {
  const body = doc.items[index]?.body ?? ''
  const before = body.slice(0, offset).replace(/\s+$/, '')
  const after = body.slice(offset).replace(/^\s+/, '')
  if (!before || !after) return doc
  return setBody(doc, index, `${before}\n\n${SEPARATOR}\n\n${after}`, true)
}

/** Join a card and the one after it into one prompt; the separator between them goes. */
export function mergeWithNext(doc: ScratchDoc, index: number): ScratchDoc {
  const first = doc.items[index]
  const second = doc.items[index + 1]
  const top = doc.frames[index]
  const bottom = doc.frames[index + 1]
  if (index < 0 || !first || !second || !top || !bottom) return doc
  const body = [first.body, second.body].filter((b) => b !== '').join('\n\n')
  return {
    items: [...doc.items.slice(0, index), { key: first.key, body }, ...doc.items.slice(index + 2)],
    frames: [
      ...doc.frames.slice(0, index),
      { lead: top.lead, trail: bottom.trail, ...(top.bare && bottom.bare ? { bare: true as const } : {}) },
      ...doc.frames.slice(index + 2)
    ],
    seps: [...doc.seps.slice(0, index), ...doc.seps.slice(index + 1)]
  }
}

/** Move a card to another position; the slots' whitespace stays put. */
export function moveItem(doc: ScratchDoc, from: number, to: number): ScratchDoc {
  if (from === to || from < 0 || to < 0 || from >= doc.items.length || to >= doc.items.length) return doc
  const items = [...doc.items]
  items.splice(to, 0, ...items.splice(from, 1))
  return { ...doc, items }
}

/** Place a dragged card on the indicated side of a target, regardless of drag direction. */
export function moveBeside(doc: ScratchDoc, from: number, target: number, side: 'before' | 'after'): ScratchDoc {
  if (from === target) return doc
  const to = side === 'before'
    ? target - (from < target ? 1 : 0)
    : target + (from > target ? 1 : 0)
  return moveItem(doc, from, to)
}

/**
 * A new card after `index` (or at the very end with `index` omitted), and its key.
 *
 * ⚠️ After the last card, the new one takes over the file's ending — its trailing newlines — so the
 * file still ends the way it did.
 */
export function insertAfter(doc: ScratchDoc, body: string, index = doc.items.length - 1): { doc: ScratchDoc; key: number } {
  const item = { key: key(), body }
  if (doc.items.length === 0) {
    return { doc: { items: [item], frames: [{ lead: '', trail: '\n' }], seps: [] }, key: item.key }
  }
  const at = Math.min(Math.max(index, 0), doc.items.length - 1)
  const frames = [...doc.frames]
  const before = frames[at] ?? INNER
  const last = at === doc.items.length - 1
  const inserted: Frame = last ? { lead: INNER.lead, trail: before.trail } : INNER
  if (last) frames[at] = { ...before, trail: INNER.trail }
  frames.splice(at + 1, 0, inserted)
  const items = [...doc.items]
  items.splice(at + 1, 0, item)
  const seps = [...doc.seps]
  seps.splice(at, 0, SEPARATOR)
  return { doc: { items, frames, seps }, key: item.key }
}

export function removeItem(doc: ScratchDoc, index: number): ScratchDoc {
  if (index < 0 || index >= doc.items.length) return doc
  if (doc.items.length === 1) return { items: [], frames: [], seps: [] }
  const frames = [...doc.frames]
  const gone = frames[index] ?? INNER
  // The file's opening and ending stay with whichever card now holds that end.
  if (index === 0) frames[1] = { ...(frames[1] ?? INNER), lead: gone.lead }
  if (index === doc.items.length - 1) frames[index - 1] = { ...(frames[index - 1] ?? INNER), trail: gone.trail }
  frames.splice(index, 1)
  const seps = [...doc.seps]
  seps.splice(index === 0 ? 0 : index - 1, 1)
  return { items: doc.items.filter((_, i) => i !== index), frames, seps }
}

// ------------------------------------------------------------------------------------- tags

/**
 * What a card says about itself on its first line.
 *
 * `* New` is a prompt not filed yet — the marker the operator already wrote by hand. `* Filed t994`
 * and `* Sent t990` are written by this page when a card becomes a task or goes to a conversation,
 * and name it. Anything else on the first line is the prompt's own text.
 */
export type ScratchTag = { kind: 'new' } | { kind: 'filed' | 'sent'; ref: string }

const NEW_MARKER = /^\*[ \t]+new[ \t]*$/i
const DONE_MARKER = /^\*[ \t]+(filed|sent)[ \t]+(t\d+(?:\.\d+)*)[ \t]*$/i

export function tagOf(body: string): ScratchTag | null {
  const first = body.split('\n', 1)[0] ?? ''
  if (NEW_MARKER.test(first)) return { kind: 'new' }
  const done = DONE_MARKER.exec(first)
  return done ? { kind: done[1]!.toLowerCase() as 'filed' | 'sent', ref: done[2]!.toLowerCase() } : null
}

export function markerFor(tag: ScratchTag): string {
  return tag.kind === 'new' ? '* New' : `* ${tag.kind === 'filed' ? 'Filed' : 'Sent'} ${tag.ref}`
}

/** How many cards are open: marked `* New`, the ones the page shows by default. */
export function openCount(doc: ScratchDoc): number {
  return doc.items.filter((item) => tagOf(item.body)?.kind === 'new').length
}

/** The body with its marker line (and the blank lines after it) taken off. */
function withoutMarker(body: string): string {
  if (!tagOf(body)) return body
  const newline = body.indexOf('\n')
  return newline < 0 ? '' : body.slice(newline + 1).replace(/^(?:[ \t]*\n)*/, '')
}

/** Write, replace or (with `null`) remove a card's marker. */
export function withTag(body: string, tag: ScratchTag | null): string {
  const rest = withoutMarker(body)
  if (!tag) return rest
  return rest === '' ? markerFor(tag) : `${markerFor(tag)}\n\n${rest}`
}

export function setTag(doc: ScratchDoc, index: number, tag: ScratchTag | null): ScratchDoc {
  const item = doc.items[index]
  return item ? setBody(doc, index, withTag(item.body, tag)) : doc
}

/** What filing or sending a card hands over: its text, without the marker. */
export function promptOf(body: string): string {
  return withoutMarker(body).trim()
}

/** One line to name a card by: its first line of text, without heading or list marks. */
export function titleOf(body: string, max = 90): string {
  const line = promptOf(body)
    .split('\n')
    .map((l) => l.replace(/^[ \t]*(?:#{1,6}[ \t]+|[*+-][ \t]+|\d+[.)][ \t]+|>[ \t]?)/, '').trim())
    .find((l) => l !== '')
  if (!line) return 'Empty prompt'
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// ---------------------------------------------------------------------------------- folding

/** A card drawn, or a run of cards folded away behind one row (`keys` opens it). */
export type ScratchRow =
  | { kind: 'item'; index: number; item: ScratchItem }
  | { kind: 'fold'; from: number; keys: number[] }

/**
 * What the page draws.
 *
 * ⛔ **Only `New` shows by default** (operator's decision, t994): a filed prompt, a sent one and every
 * untagged one from before this page existed fold into one row per consecutive run, in place, so
 * the order on screen is still the order in the file. `shown` holds cards opened anyway — a run the
 * operator unfolded, or a card filed a moment ago during its brief confirmation period.
 */
export function scratchRows(doc: ScratchDoc, showAll: boolean, shown: ReadonlySet<number>): ScratchRow[] {
  const rows: ScratchRow[] = []
  doc.items.forEach((item, index) => {
    if (showAll || shown.has(item.key) || tagOf(item.body)?.kind === 'new') {
      rows.push({ kind: 'item', index, item })
      return
    }
    const last = rows[rows.length - 1]
    if (last?.kind === 'fold') last.keys.push(item.key)
    else rows.push({ kind: 'fold', from: index, keys: [item.key] })
  })
  return rows
}

// ------------------------------------------------------------------------------- task links

type TaskRow = Pick<Task, 'id' | 'seq' | 'kind' | 'status' | 'deletedAt' | 'updatedAt'>

/**
 * The conversations a card can be sent to: this project's, still going, newest first.
 *
 * ⚠️ The sidebar's rule (`lib/sidebartasks.ts`): a conversation rests at `awaiting_human` between
 * turns and is still open there, and a failed one is still a thread to reply to. A message to one
 * that stopped starts a new run on the same thread, which is what sending means.
 */
export function conversationTargets<T extends TaskRow>(tasks: readonly T[]): T[] {
  return tasks
    .filter((t) => t.kind === 'conversation' && t.deletedAt === null && !CLOSED.has(t.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

const CLOSED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'cancelled', 'draft'])

/** The task a `Filed t994` marker names, if this project still has it. */
export function taskForRef<T extends Pick<Task, 'seq'>>(tasks: readonly T[], ref: string): T | undefined {
  const seq = /^t(\d+)$/i.exec(ref)?.[1]
  return seq === undefined ? undefined : tasks.find((t) => t.seq === Number(seq))
}
