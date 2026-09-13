/**
 * What a `@@` header says about where a hunk sits in the file, and how far apart two hunks are.
 *
 * ⛔ **Numbers out of the header, never out of the code.** The Diff pane draws a `⋯ N unmodified
 * lines` row between two hunks so a reader knows how far apart they are, and N is arithmetic on
 * the two `@@ -a,b +c,d @@` headers git already printed — no second `git` call, and no reading of
 * the file. Like `diffline.ts`, pure and in `lib/` so a test pins it without a DOM.
 *
 * ⚠️ The **old** side is what the gap is counted on. Between two hunks the file is unchanged, so
 * both sides agree on the count; before the first hunk they agree too unless the file is new, where
 * the old side starts at `-0,0` and the new side is the honest one. `gapBefore` takes the larger of
 * the two, which is the right answer in both cases.
 */

export interface HunkRange {
  oldStart: number
  oldLen: number
  newStart: number
  newLen: number
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The ranges a `@@` header names, or null for any other line. A missing `,len` means 1, as in git. */
export function parseHunkHeader(line: string): HunkRange | null {
  const m = HEADER.exec(line)
  if (!m) return null
  return {
    oldStart: Number.parseInt(m[1] ?? '0', 10),
    oldLen: m[2] === undefined ? 1 : Number.parseInt(m[2], 10),
    newStart: Number.parseInt(m[3] ?? '0', 10),
    newLen: m[4] === undefined ? 1 : Number.parseInt(m[4], 10)
  }
}

/**
 * How many unchanged lines lie between the previous hunk and this one — or above the first.
 *
 * ⚠️ Never negative: overlapping headers cannot come out of git, but a patch is agent-influenced
 * text and a row reading `−3 unmodified lines` would be a bug drawn on the screen.
 */
export function gapBefore(prev: HunkRange | null, cur: HunkRange): number {
  if (prev === null) {
    return Math.max(0, cur.oldStart - 1, cur.newStart - 1)
  }
  const old = cur.oldStart - (prev.oldStart + prev.oldLen)
  const fresh = cur.newStart - (prev.newStart + prev.newLen)
  return Math.max(0, old, fresh)
}

/**
 * The gap above each entry of a patch, in one pass.
 *
 * ⚠️ One number per input line, `0` for every line that is not a hunk header, so a component can
 * index it beside the line it is drawing without keeping a running variable across a render — which
 * the React compiler rejects, and rightly: a render must be a pure function of its inputs.
 */
export function gapsBefore(lines: ReadonlyArray<string | null>): number[] {
  let prev: HunkRange | null = null
  return lines.map((line) => {
    const range = line === null ? null : parseHunkHeader(line)
    if (range === null) return 0
    const gap = gapBefore(prev, range)
    prev = range
    return gap
  })
}
