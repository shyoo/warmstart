/**
 * Where a long thread message folds, so a whole reply can be posted without becoming a wall.
 *
 * ⭐ **The agent's closing reply is posted whole since t734** — t731's answer had sat cut to 400
 * characters in the activity peephole while the thread showed a one-line summary. Whole means some
 * replies run to pages, so past `after` lines the bubble shows the first `head` and folds the rest
 * behind a press. Short answers — which is most of them, and all of t731's — are never folded.
 *
 * ⛔ **Never inside a fenced block.** A fold that opened a ``` fence in the head and closed it in the
 * rest would render the head's tail as code and the rest's opening as prose — a command split in two
 * is the one thing this change exists to stop. The fold moves back to the line before the fence, or,
 * when the fence opens at the very top, past its closing line.
 *
 * ⚠️ Pure, and the one place the numbers live, so the tests pin exactly what folds.
 */
export const COLLAPSE_AFTER_LINES = 40
export const COLLAPSE_HEAD_LINES = 30

export interface Folded {
  head: string
  rest: string
  restLines: number
}

const FENCE = /^\s{0,3}(```|~~~)/

export function foldAt(
  text: string,
  after = COLLAPSE_AFTER_LINES,
  head = COLLAPSE_HEAD_LINES
): Folded | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length <= after) return null

  // Where each fence opens, so a cut can be tested against the block it would land in.
  let open = -1
  const blocks: Array<{ from: number; to: number }> = []
  lines.forEach((line, i) => {
    if (!FENCE.test(line)) return
    if (open === -1) open = i
    else {
      blocks.push({ from: open, to: i })
      open = -1
    }
  })
  // ⚠️ An unclosed fence runs to the end, exactly as the markdown reader treats it.
  if (open !== -1) blocks.push({ from: open, to: lines.length - 1 })

  // ⛔ Nor inside a table (t908): a head holding half a table and a rest with no header row would
  // draw the second half as pipes. A table is a run of two or more consecutive lines holding a pipe,
  // outside any fence.
  let run = -1
  for (let i = 0; i <= lines.length; i += 1) {
    const piped = i < lines.length && (lines[i] as string).includes('|') && !blocks.some((b) => i >= b.from && i <= b.to)
    if (piped && run === -1) run = i
    if (!piped && run !== -1) {
      if (i - run >= 2) blocks.push({ from: run, to: i - 1 })
      run = -1
    }
  }

  let cut = head
  for (let moves = 0; moves <= blocks.length; moves += 1) {
    const inside = blocks.find((b) => cut > b.from && cut <= b.to)
    if (!inside) break
    cut = inside.from > 0 ? inside.from : inside.to + 1
  }
  // Folding off fewer than a handful of lines hides nothing worth a press.
  if (cut <= 0 || lines.length - cut < 5) return null

  return {
    head: lines.slice(0, cut).join('\n'),
    rest: lines.slice(cut).join('\n'),
    restLines: lines.length - cut
  }
}
