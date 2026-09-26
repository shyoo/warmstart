import { emit } from './events.js'

/**
 * The peephole: what the agent working on a task is saying, while it says it.
 *
 * ⛔ **Not the task thread, and not the transcript.** The thread is the record a person reads
 * afterwards to find out what was decided, and writing every fragment of a running agent's prose
 * into it would bury that under a play-by-play. The transcript is the machine's exact copy and stays
 * the machine's. This is the third thing, and it is the one that was missing: a bounded tail, held in
 * memory, for the question "what is it doing *right now*".
 *
 * ⚠️ Held in memory on purpose, not out of laziness. Its correct lifetime is the run: a daemon
 * restart already returns every running task to `awaiting_human` (`reconcileTasks`), so a tail that survived
 * the restart would be describing work that no longer exists.
 *
 * ⛔ The text is **agent output** and therefore untrusted. It is carried as text, rendered as text,
 * and never interpreted - nothing here or downstream may read state out of it. AGENTS.md: the TUI is
 * for humans, the transcript is for the machine, and this is a window onto the first.
 */

/** Enough to see what is going on, few enough that a long run cannot grow without bound. */
const KEEP = 40

/** One line is trimmed to this. An agent can emit a whole file in a single block. */
const MAX_LINE = 400

interface Entry {
  text: string
  ts: number
  afterMessageId?: number
}

/**
 * One streaming line per tail, still being spoken.
 *
 * ⛔ **Only ever open on a `delta` adapter.** A `message` adapter's events are already whole, so
 * they settle on arrival and never open a line — reassembling those is exactly what glued Claude's
 * separate messages into one paragraph (t284). See `OutputFraming`.
 *
 * ⛔ **This is what stops streamed prose reading one word per line.** A provider that streams
 * (`muse exec --json` emits `run.output.delta` per few tokens) hands this module dozens of
 * fragments for one sentence. Each used to become its own tail entry, and the thread renders each
 * entry as its own block — so the operator read `landing / corners.test.ts / pass. The / tree /
 * is clean` as a column of words. A fragment that does not end in a newline is therefore a
 * *continuation*: it extends the open line, and watchers are told so (`append` on the event) rather
 * than being handed a new line. A fragment that does end in one (a tool announcement such as
 * `· bash`, a `[run: …]` status line) closes the line and each of its rows stands alone.
 */
interface Tail {
  lines: Entry[]
  open: Entry | null
}

const tails = new Map<string, Tail>()
const runTails = new Map<string, Tail>()
const messageAnchors = new Map<string, number>()
const RUN_KEEP = 200

function tailFor(map: Map<string, Tail>, key: string, keep: number): Tail {
  let tail = map.get(key)
  if (!tail) {
    tail = { lines: [], open: null }
    map.set(key, tail)
  }
  // ⚠️ The bound counts settled lines; the one line still being spoken sits outside it.
  while (tail.lines.length > keep) tail.lines.shift()
  return tail
}

function pushLine(tail: Tail, text: string, keep: number, taskId?: string): Entry {
  const entry: Entry = {
    text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text,
    ts: Date.now(),
    ...(taskId && messageAnchors.has(taskId) ? { afterMessageId: messageAnchors.get(taskId) } : {})
  }
  tail.lines.push(entry)
  while (tail.lines.length > keep) tail.lines.shift()
  return entry
}

function snapshot(tail: Tail | undefined): Entry[] {
  if (!tail) return []
  const lines = tail.lines.map((l) => ({ ...l }))
  // ⚠️ The open line is part of what a watcher sees: a pane opened mid-turn must show the sentence
  // in progress, not only the ones before it. Read trimmed — the stored form keeps a trailing
  // separator for the next fragment, which is scaffolding, not content.
  if (tail.open && tail.open.text.trim()) {
    lines.push(shown(tail.open))
  }
  return lines
}

/** What watchers are shown of an open line: content, without the scaffolding. */
function shown(open: Entry): Entry {
  return { ...open, text: open.text.trimEnd() }
}

/**
 * What one call to `noteActivity` is: a whole message, or a fragment of one.
 *
 * ⛔ **The adapter's answer, never this module's guess** — `AdapterCapabilities.outputFraming`, and
 * see that field for the two regressions that come of guessing. `message` is the default here for
 * the same reason it is the default there: it is the framing that cannot destroy text.
 */
export type OutputFraming = 'message' | 'delta'

/**
 * A whole message, framed by the vendor that wrote it.
 *
 * ⛔ **Its linebreaks are the agent's own and they are kept.** Claude Code emits one event per
 * assistant message, and reassembling those the way streamed deltas are reassembled produced
 * `…what t269 recorded.Now let me make the edits.` — two separate messages run together without so
 * much as a space, every paragraph break inside them gone (t284, reported 2026-09-07). So a message
 * settles immediately: it closes whatever line is open, and each of its own lines becomes a row.
 */
function noteMessage(
  text: string,
  taskId: string,
  taskTail: Tail,
  runTail: Tail | null
): void {
  // ⚠️ A message can arrive while a `delta` line is open — an adapter may emit a tool announcement
  // one way and prose the other. Settle the open line first rather than interleaving rows.
  closeOpen(taskId, taskTail, runTail)
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    // ⚠️ Interior blank lines are dropped rather than pushed as empty rows: the tail is bounded at
    // KEEP settled lines, and a paragraph break that costs one of them buys nothing a reader can
    // see — both renderers already put every row on its own block.
    const line = raw.replace(/[ \t\f\v]+/g, ' ').trim()
    if (!line) continue
    const entry = pushLine(taskTail, line, KEEP, taskId)
    emit({ type: 'task.activity', taskId, ...entry })
    if (runTail) pushLine(runTail, line, RUN_KEEP)
  }
}

/** Settle whatever line is open, so the next row does not extend it. */
function closeOpen(taskId: string, taskTail: Tail, runTail: Tail | null): void {
  if (taskTail.open) {
    const settled = shown(taskTail.open)
    taskTail.open = null
    if (settled.text) {
      taskTail.lines.push({ ...settled })
      while (taskTail.lines.length > KEEP) taskTail.lines.shift()
      emit({ type: 'task.activity', taskId, ...settled, append: true })
    }
  }
  if (runTail?.open) {
    const settled = shown(runTail.open)
    runTail.open = null
    if (settled.text) {
      runTail.lines.push(settled)
      while (runTail.lines.length > RUN_KEEP) runTail.lines.shift()
    }
  }
}

export function noteActivity(
  taskId: string,
  text: string,
  runId?: string,
  framing: OutputFraming = 'message'
): void {
  const taskTail = tailFor(tails, taskId, KEEP)
  const runTail = runId ? tailFor(runTails, runId, RUN_KEEP) : null

  if (framing === 'message') {
    noteMessage(text, taskId, taskTail, runTail)
    return
  }

  // ⚠️ `\r` is a carriage return, not content: a PTY-redrawn progress line would otherwise glue
  // itself onto the prose with its control characters intact.
  const norm = text.replace(/\r\n?/g, '\n')
  const closed = norm.endsWith('\n')
  const body = closed ? norm.slice(0, -1) : norm
  // ⛔ Interior newlines join; only the trailing one frames. A single fragment carrying `a\nb` is
  // one announcement that wrapped, not two turns — and the settled contract (`reading\n\n the file`
  // reads as one line) already says so. What spans fragments is streaming, and that is what the
  // open line reassembles.
  const flat = body.replace(/\n/g, ' ')
  const collapsed = flat.replace(/[ \t\f\v]+/g, ' ')

  if (closed) {
    const line = collapsed.trim()
    if (!line) {
      // A blank row ends the paragraph without saying anything: settle the open line, emit
      // nothing. Watchers already hold its text from the `append` events that built it.
      taskTail.open = null
      if (runTail) runTail.open = null
      return
    }
    // ⚠️ The open line keeps the boundary the fragments spell: `hel` + `lo\n` settles as
    // `hello`, not `hel lo`. Only the trailing end is dead whitespace — a line never needs it.
    settleLine(taskTail, collapsed.replace(/\s+$/, ''), KEEP, taskId, runTail)
    return
  }

  if (!collapsed.trim()) {
    // A whitespace-only fragment carries at most one separator. Give it only where one can be
    // missing — inside an open line that does not already end in one — and never start a line
    // with it. (A lone-space delta between two word deltas is the case that matters.)
    appendOpen(taskTail, ' ', taskId, runTail)
    return
  }
  appendOpen(taskTail, collapsed, taskId, runTail)
}

/**
 * A newline-terminated row: it finishes whatever line is open, then stands as its own entry.
 * Emitted as `append` where it extended the open line (watchers replace their last row with the
 * settled text) and as a fresh push otherwise.
 */
function settleLine(
  taskTail: Tail,
  piece: string,
  keep: number,
  taskId: string,
  runTail: Tail | null
): void {
  // ⚠️ `piece` carries its leading boundary (see above) but is never blank here; the fresh-push
  // half still trims, because a line starts with content.
  const line = piece.trim()
  if (taskTail.open) {
    const added = joinPiece(taskTail.open.text, piece)
    taskTail.open.text = cap(taskTail.open.text + added)
    taskTail.open.ts = Date.now()
    const settled = shown(taskTail.open)
    taskTail.lines.push({ ...settled })
    while (taskTail.lines.length > keep) taskTail.lines.shift()
    taskTail.open = null
    emit({ type: 'task.activity', taskId, ...settled, append: true })
  } else {
    const entry = pushLine(taskTail, line, keep, taskId)
    emit({ type: 'task.activity', taskId, ...entry })
  }
  if (runTail) {
    if (runTail.open) {
      const added = joinPiece(runTail.open.text, piece)
      runTail.open.text = cap(runTail.open.text + added)
      runTail.open.ts = Date.now()
      runTail.lines.push({ ...runTail.open })
      while (runTail.lines.length > RUN_KEEP) runTail.lines.shift()
      runTail.open = null
    } else {
      pushLine(runTail, line, RUN_KEEP)
    }
  }
}

/**
 * A fragment of the line still being spoken. Starts the open line where there is none (leading
 * whitespace is meaningless at a line start) and extends it otherwise, keeping the boundary the
 * fragments themselves spell: `landing` + ` corners` reads `landing corners`, `squ` + `ashing`
 * reads `squashing`. Emitted with the whole open line, so a watcher that missed a fragment still
 * lands on the right text.
 */
function appendOpen(taskTail: Tail, piece: string, taskId: string, runTail: Tail | null): void {
  if (!taskTail.open) {
    // ⚠️ Leading-trimmed only. A trailing separator belongs to the boundary with the *next*
    // fragment (`no ` + `squ` reads `no squ`), and trimming it here would glue the two (`nosqu`).
    // Reads go through `shown`, so the scaffolding never reaches a watcher.
    const start = piece.trimStart()
    if (!start.trim()) return
    taskTail.open = {
      text: cap(start), ts: Date.now(),
      ...(messageAnchors.has(taskId) ? { afterMessageId: messageAnchors.get(taskId) } : {})
    }
    const first = shown(taskTail.open)
    emit({ type: 'task.activity', taskId, ...first })
  } else {
    if (taskTail.open.text.endsWith('…')) return
    const added = joinPiece(taskTail.open.text, piece)
    if (!added) return
    taskTail.open.text = cap(taskTail.open.text + added)
    taskTail.open.ts = Date.now()
    const grown = shown(taskTail.open)
    emit({ type: 'task.activity', taskId, ...grown, append: true })
  }
  if (runTail) {
    if (!runTail.open) {
      const start = piece.trimStart()
      if (!start.trim()) return
      runTail.open = { text: cap(start), ts: Date.now() }
    } else {
      if (runTail.open.text.endsWith('…')) return
      const added = joinPiece(runTail.open.text, piece)
      if (!added) return
      runTail.open.text = cap(runTail.open.text + added)
      runTail.open.ts = Date.now()
    }
  }
}

/**
 * The piece as it attaches to the open line: concatenated, never re-spaced.
 *
 * ⛔ **No separator is ever inserted.** Streamed fragments spell their own boundary — `landing` +
 * ` corners` reads `landing corners` because the space arrived in the fragment, and `squ` +
 * `ashing` reads `squashing` because none did. Tokenisers split mid-word routinely, so inventing a
 * space where neither side has one corrupts words (`squ ashing`, measured in the report that
 * prompted this). The one cleanup is a doubled separator where both sides spell one.
 */
function joinPiece(open: string, piece: string): string {
  if (!piece) return ''
  if (!open) return piece
  if (open.endsWith(' ') && piece.startsWith(' ')) return piece.slice(1)
  return piece
}

function cap(text: string): string {
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text
}

export function activityFor(taskId: string): Entry[] {
  return snapshot(tails.get(taskId))
}

/** Keep the next activity line on the far side of a newly saved thread message. */
export function markThreadMessage(taskId: string, messageId: number): void {
  const tail = tails.get(taskId)
  if (tail) closeOpen(taskId, tail, null)
  messageAnchors.set(taskId, messageId)
}

/**
 * The prose in a tail: every line that is not an adapter's tool or status announcement.
 *
 * ⚠️ The prefixes are the ones the adapters write — `antigravity-cli` since M5, `claude-code` since
 * t423, both through `toolLine` in `stream.ts` so the vocabulary stays one list. This is also the
 * list the completion paths use when they fall back to the peephole because an agent reported
 * nothing, which is why a tool announcement that did not look like one would be quoted back onto a
 * thread as though the agent had said it.
 */
export function proseOf(entries: Array<{ text: string }>): string[] {
  return entries
    .map((e) => e.text)
    .filter(
      (t) =>
        t &&
        !t.startsWith('[Tool:') &&
        !t.startsWith('[run:') &&
        !t.startsWith('[search:') &&
        !t.startsWith('[find:') &&
        !t.startsWith('[list:') &&
        !t.startsWith('[fetch:') &&
        // ⚠️ A phase marker, not a sentence. It carries no words by construction — the vendor does
        // not publish them (see `StreamEvent.thinking`) — so it is the emptiest possible thing to
        // hand a debate seat's thread as that seat's closing position.
        !t.startsWith('[thinking')
    )
}

/**
 * The last `maxChars` of prose in a tail, in whole lines, oldest first.
 *
 * ⭐ What a `report-only` task said on the way to reporting complete — its deliverable is the
 * thread, and `task_complete`'s summary is described to the agent as *one line*, so the position a
 * debate seat spent a run building was arriving on its thread as a sentence (t382, 2026-09-12: two
 * of three seats, both rounds). ⚠️ **Best effort, and lossy by construction**: the peephole keeps
 * `RUN_KEEP` lines of `MAX_LINE` characters each, so a paragraph longer than that arrives cut with
 * an ellipsis. The prompt asking for the whole position in the summary is the fix; this is the net.
 */
export function closingProse(entries: Array<{ text: string }>, maxChars: number): string {
  const lines = proseOf(entries)
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (kept.length > 0 && size + line.length + 1 > maxChars) break
    kept.unshift(line)
    size += line.length + 1
  }
  return kept.join('\n').trim()
}

/**
 * How much of a report-only run's closing prose is kept on its thread.
 *
 * ⚠️ Sized for a position, not a transcript: under `exchange: 'full'` every seat's row travels
 * verbatim into every other seat's brief and into the organizer's prompt, so this is paid N² times
 * a round. Twelve thousand characters is about three pages, which is more than any round-one
 * position in t382 ran to and less than a run's whole narration.
 */
export const REPORT_PROSE_CHARS = 12_000

/**
 * The summary an agent reported, followed by the prose it said on the way — minus every line the
 * summary already contains, so a seat that put its whole position in the summary is not read twice.
 */
export function withClosingProse(summary: string, prose: string): string {
  const fresh = prose
    .split('\n')
    .filter((line) => line.trim() && !summary.includes(line.trim()))
    .join('\n')
    .trim()
  return fresh ? `${summary}\n\n${fresh}` : summary
}

export function runActivityFor(runId: string): Array<{ text: string; ts: number }> {
  return snapshot(runTails.get(runId))
}

/**
 * Take accumulated intermediate activity for a run and release the memory.
 * Called when a run is finished and about to be persisted into SQLite.
 */
export function consumeRunActivity(runId: string): Array<{ text: string; ts: number }> {
  const tail = runTails.get(runId)
  const got = snapshot(tail)
  runTails.delete(runId)
  return got
}

export function clearRunActivity(runId: string): void {
  runTails.delete(runId)
}

/**
 * Forget a task's tail.
 *
 * ⚠️ Called when a *new* attempt starts, never when one ends. What the last run said is exactly what
 * somebody wants to read in the seconds after it fails, and clearing on completion would blank the
 * pane at the moment it became interesting.
 */
export function clearActivity(taskId: string): void {
  tails.delete(taskId)
  // ⛔ Announced, not merely done. Whoever is watching this task holds their own copy of the tail —
  // they have to, because the list refreshes on every task event and a pane that rebuilt itself from
  // each fetch would flicker. So clearing it here and saying nothing left the **previous run's last
  // words** sitting under a task that had just been dispatched somewhere else, which reads as the new
  // run having failed the way the old one did.
  emit({ type: 'task.activity', taskId, text: '', ts: Date.now(), reset: true })
}
