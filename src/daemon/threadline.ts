/**
 * The shape of a system line on a task thread.
 *
 * ⛔ **A system message is one short line, and everything it used to say is its `detail`.** The
 * thread renders `text` as the bubble and `detail` behind an expander, so a line here is what a
 * person reads at a glance and the detail is the basis they open when the glance is not enough.
 * Nothing is dropped in the move: what a reader could once find in the text is still on the row,
 * and what code reads back — `salvageLandedCommits` on the *"Landed as …"* headline, the resolve
 * buttons on the last failure line — matches on `messageBody`, which is text and detail together.
 */

import type { TaskMessage } from '@shared/tasks.js'

/** Longest a thread line is meant to be; anything past it goes behind the expander. */
export const LINE_MAX = 100

/**
 * The first sentence of a reason, on one line, cut with an ellipsis if it still runs long.
 *
 * ⚠️ Sentence-ended, not word-counted: the reasons this is applied to were written as prose and
 * their first sentence is usually the claim, with the explanation after the full stop. A cut mid-
 * sentence is the fallback, and the caller puts the whole reason in `detail` whenever this returns
 * anything other than the input.
 */
export function oneLine(text: string, max = LINE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = flat.match(/^(.*?[.!?])(?:\s|$)/)?.[1]
  let line = sentence && sentence.length >= 12 ? sentence : flat
  if (/[.!?]$/.test(line) && !/\.\.\.$/.test(line)) line = line.slice(0, -1)
  if (line.length <= max) return line
  return `${line.slice(0, max - 1).trimEnd()}…`
}

/** `14:05` — a wall-clock time in the operator's zone, for a line that names when something resumes. */
export function clockTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `2m` / `45s` / `1h 10m` — a duration for a line that names how long until something happens. */
export function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 90) return `${total}s`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/**
 * Everything a message says, for code that matches on it. ⛔ Readers that used to match on
 * `.text` alone would silently stop matching once the sentence they look for moved into `detail`.
 */
export function messageBody(m: Pick<TaskMessage, 'text' | 'detail'>): string {
  return m.detail ? `${m.text}\n${m.detail}` : m.text
}
