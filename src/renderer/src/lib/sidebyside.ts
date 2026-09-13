/**
 * A unified patch as rows two columns can draw.
 *
 * ⛔ **Structure, never markup.** Like `diffline.ts` this derives shapes from the first character
 * of each line and hands the component text to set as text nodes — the side-by-side table is
 * `<td>` elements this codebase writes, never HTML parsed out of the patch. Pure and in `lib/`
 * so it is pinned by a test without a DOM.
 *
 * ⚠️ Pairing is positional, not semantic. A removed run followed by an added run is zipped
 * top-to-top so the two halves of an edit sit on one row; where the runs differ in length the
 * surplus lines stand alone on their own side. That can misalign a line that moved across a
 * larger edit, and the unified view next to the toggle is where such a row is checked.
 */
import { patchLineKind } from './diffline'

export interface SplitSide {
  /** The line number on that side of the file, or null where the row has no line there. */
  no: number | null
  /** The line's text with its leading `+`/`-`/space marker removed. */
  text: string
}

export interface SplitRow {
  left: SplitSide | null
  right: SplitSide | null
  /** `change` has both sides; `del` and `add` stand alone on theirs. */
  kind: 'context' | 'change' | 'del' | 'add'
}

export interface SplitBlock {
  /** The `@@ … @@` header that opened this block, or null for the file headers above the first. */
  header: string | null
  /** `diff --git`, `---`/`+++` and friends: drawn once above the table, never as rows. */
  meta: string[]
  rows: SplitRow[]
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function flush(runs: { dels: string[]; adds: string[] }, rows: SplitRow[], at: { oldNo: number; newNo: number }): void {
  const n = Math.max(runs.dels.length, runs.adds.length)
  for (let i = 0; i < n; i += 1) {
    const del = runs.dels[i]
    const add = runs.adds[i]
    if (del !== undefined && add !== undefined) {
      rows.push({
        left: { no: at.oldNo, text: del },
        right: { no: at.newNo, text: add },
        kind: 'change'
      })
      at.oldNo += 1
      at.newNo += 1
    } else if (del !== undefined) {
      rows.push({ left: { no: at.oldNo, text: del }, right: null, kind: 'del' })
      at.oldNo += 1
    } else if (add !== undefined) {
      rows.push({ left: null, right: { no: at.newNo, text: add }, kind: 'add' })
      at.newNo += 1
    }
  }
  runs.dels.length = 0
  runs.adds.length = 0
}

/** Split a unified patch into blocks of two-column rows. */
export function splitPatch(patch: string): SplitBlock[] {
  const blocks: SplitBlock[] = []
  let current: SplitBlock = { header: null, meta: [], rows: [] }
  blocks.push(current)
  // Hunk-local state: the next line number on each side, and the runs being paired.
  const at = { oldNo: 0, newNo: 0 }
  const runs = { dels: [] as string[], adds: [] as string[] }
  let inHunk = false

  const endHunk = (): void => {
    if (inHunk) flush(runs, current.rows, at)
    inHunk = false
  }

  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      endHunk()
      // A hunk header opens a block that carries it; the file headers stay on the first.
      if (current.header !== null || current.rows.length > 0) {
        current = { header: null, meta: [], rows: [] }
        blocks.push(current)
      }
      current.header = line
      at.oldNo = Number.parseInt(hunk[1] ?? '0', 10) || 0
      at.newNo = Number.parseInt(hunk[2] ?? '0', 10) || 0
      inHunk = true
      continue
    }
    if (!inHunk) {
      // File headers and anything else above the first hunk: shown, never numbered.
      if (line.length > 0) current.meta.push(line)
      continue
    }
    const kind = patchLineKind(line)
    if (kind === 'add') {
      runs.adds.push(line.slice(1))
    } else if (kind === 'del') {
      // ⚠️ A `---` header inside a hunk would classify as meta, not del — `patchLineKind`
      // checks the triple-character headers first, which is exactly why both call it.
      runs.dels.push(line.slice(1))
    } else if (kind === 'context') {
      flush(runs, current.rows, at)
      const text = line.startsWith(' ') ? line.slice(1) : line
      current.rows.push({
        left: { no: at.oldNo, text },
        right: { no: at.newNo, text },
        kind: 'context'
      })
      at.oldNo += 1
      at.newNo += 1
    } else {
      // `\ No newline at end of file` and friends: git's own notes, consuming no line on
      // either side. Skipped rather than numbered, which would shift every row below one.
      flush(runs, current.rows, at)
    }
  }
  endHunk()
  // A patch of headers and no hunks (a mode change, a pure rename) still draws its meta.
  return blocks.filter((b) => b.header !== null || b.meta.length > 0 || b.rows.length > 0)
}
