/**
 * The change a task made, on the screen where somebody decides what to do about it — and the two
 * patch renderers the Diff pane draws it with.
 *
 * ⛔ **Agent output is untrusted text, and a patch is the most untrusted text in this app** — it is
 * literally a file the agent wrote, quoted back. Every line below is a React text node inside
 * `<pre>` or a `<td>`, and the only thing derived from its content is a CSS class chosen from the
 * first character. ⛔ No `dangerouslySetInnerHTML`, no markdown, no syntax highlighter (every one of
 * them takes a string and returns HTML, which is the one thing that may not happen here), and no
 * linkified paths. A path is text too. See `docs/ui.md`.
 *
 * ⛔ **What lands and what does not are drawn apart.** The file list is the committed change — the
 * bytes `Land` moves. Uncommitted files in the workspace are a separate banner, because they are
 * going nowhere and showing them in the same list would say a file was about to land when it was
 * about to be left behind.
 *
 * ⛔ **Not only at the gate.** This was drawn on `awaiting_human` alone, so the change vanished the
 * moment a task finished — which is when somebody reading a thread most often wants to know what it
 * did (reported 2026-09-13). It is drawn wherever there is a resolvable change, open at the gate
 * where the question is *should this land* and closed elsewhere, and it stays silent rather than
 * showing a refusal on a task that never had one.
 *
 * ⭐ **The list is here; the patches are in the Diff pane** (t425, 2026-09-13). A patch drawn inline
 * got the thread column's width at best and the 300px ledger's at worst, which is what the pane
 * exists to fix — so a file row here *opens* the pane at that file rather than unfolding under
 * itself, and nothing in this column draws a line of code. `PatchBody` and `SplitBody` live in this
 * file because the rule at the top applies to them, and the pane imports them.
 *
 * ⚠️ One `git` call for the list, asked when the panel opens and when the task moves, never on a
 * timer — the same contract as `task.pendingWork`.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { TaskDiffFile, TaskDiffFileEntry, TaskDiffSummary } from '@shared/tasks'
import { rpc } from '../../lib/daemon'
import { patchLineClass } from '../../lib/diffline'
import { useDiffPane } from '../../lib/diffpane'
import { gapsBefore } from '../../lib/hunks'
import type { DiffView } from '../../lib/prefs'
import { splitPatch } from '../../lib/sidebyside'

/** `+12 −3`, or nothing at all for a file with no counted lines. */
export function counts(added: number, removed: number): React.JSX.Element {
  return (
    <span className="diff-counts">
      {added > 0 && <span className="diff-counts-add">+{added.toLocaleString()}</span>}
      {removed > 0 && <span className="diff-counts-del">−{removed.toLocaleString()}</span>}
      {added === 0 && removed === 0 && <span className="diff-counts-none">no counted lines</span>}
    </span>
  )
}

/**
 * `⋯ 586 unmodified lines`, between two hunks or above the first.
 *
 * ⚠️ Arithmetic on the `@@` headers (`lib/hunks.ts`), never a read of the file: the pane knows how
 * far apart two hunks are, not what lies between them. Nothing after the last hunk, because a
 * patch does not say how long the file is.
 */
function gapText(lines: number): string {
  return `⋯ ${lines.toLocaleString()} unmodified line${lines === 1 ? '' : 's'}`
}

function Gap({ lines }: { lines: number }): React.JSX.Element | null {
  if (lines <= 0) return null
  return <div className="diff-gap">{gapText(lines)}</div>
}

/**
 * One file's patch as two columns: old on the left, new on the right.
 *
 * ⛔ **Cells, never markup.** Every number and every line is a React text node, exactly like the
 * unified view — `splitPatch` derives structure from first characters and the table is elements this
 * codebase writes. A changed row pairs the two halves of one edit; a row standing alone on one side
 * is a line only that side has.
 */
export function SplitBody({ patch }: { patch: string }): React.JSX.Element {
  const blocks = useMemo(() => splitPatch(patch), [patch])
  const gaps = useMemo(() => gapsBefore(blocks.map((b) => b.header)), [blocks])
  return (
    <div className="diff-split-wrap">
      {blocks.map((block, bi) => {
        const gap = gaps[bi] ?? 0
        return (
          // ⚠️ The index is the key for the same reason the unified view uses it: a patch has
          // repeated identical rows by nature and nothing here reorders.
          <div key={bi} className="diff-split-block">
            {block.meta.length > 0 && (
              <pre className="diff-split-meta">
                {block.meta.map((line, i) => (
                  <span key={i} className={patchLineClass(line)}>
                    {line}
                    {'\n'}
                  </span>
                ))}
              </pre>
            )}
            <Gap lines={gap} />
            {block.header !== null && <div className="diff-split-hunk">{block.header}</div>}
            {block.rows.length > 0 && (
              <table className="diff-split">
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri} className={`diff-split-row diff-split-row--${row.kind}`}>
                      <SplitCell side={row.left} tint={row.kind === 'change' ? 'del' : row.kind} />
                      <SplitCell side={row.right} tint={row.kind === 'change' ? 'add' : row.kind} />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SplitCell({
  side,
  tint
}: {
  side: { no: number | null; text: string } | null
  tint: 'context' | 'change' | 'del' | 'add'
}): React.JSX.Element {
  return (
    <td className={`diff-split-cell diff-split-cell--${side ? tint : 'empty'}`}>
      {side !== null && (
        <>
          <span className="diff-split-no">{side.no}</span>
          {/* ⚠️ A space for an empty line, so the row keeps its height without a `&nbsp;` entity. */}
          <span className="diff-split-text">{side.text === '' ? ' ' : side.text}</span>
        </>
      )}
    </td>
  )
}

/**
 * Single column or side by side, for every patch on the screen.
 *
 * ⛔ **One control per pane, not one per file.** A toggle on each file is a control somebody has to
 * press again for every file in a forty-file change, and two files left in different layouts read as
 * a rendering bug rather than as a choice. ⚠️ Remembered in `localStorage` (`prefs.ts`) because
 * which layout somebody reads a diff in is a property of the person, not of the task.
 */
export function ViewToggle({
  view,
  onView
}: {
  view: DiffView
  onView: (view: DiffView) => void
}): React.JSX.Element {
  return (
    <div className="diff-view-toggle" role="group" aria-label="Diff layout">
      <button
        type="button"
        className={view === 'unified' ? 'diff-view-toggle--on' : undefined}
        aria-pressed={view === 'unified'}
        title="One column, the way git prints a patch: removals and additions in reading order."
        onClick={() => onView('unified')}
      >
        Single column
      </button>
      <button
        type="button"
        className={view === 'split' ? 'diff-view-toggle--on' : undefined}
        aria-pressed={view === 'split'}
        title="Two columns: the file as it was on the left, as it is on the right. ⚠️ The pairing is positional, so a line that moved across a large edit can sit opposite an unrelated one."
        onClick={() => onView('split')}
      >
        Side by side
      </button>
    </div>
  )
}

/** The unified patch, one `<span>` of text per line, with a gap row above each hunk. */
function UnifiedBody({ patch }: { patch: string }): React.JSX.Element {
  const lines = useMemo(() => patch.split('\n'), [patch])
  const gaps = useMemo(() => gapsBefore(lines), [lines])
  return (
    <pre className="diff-patch">
      {lines.map((line, i) => {
        // ⚠️ The index is the key because a patch has repeated identical lines by nature and
        // nothing here reorders: this list is rebuilt wholesale or not at all.
        const gap = gaps[i] ?? 0
        return (
          // ⚠️ A `<span>` for the gap too, not a `<div>`: the `<pre>` holds spans of text and
          // nothing else, and `test/ui.test.mjs` reads its markup to prove that.
          <Fragment key={i}>
            {gap > 0 && (
              <span className="diff-line diff-line--gap">
                {gapText(gap)}
                {'\n'}
              </span>
            )}
            <span className={patchLineClass(line)}>
              {line === '' ? ' ' : line}
              {'\n'}
            </span>
          </Fragment>
        )
      })}
    </pre>
  )
}

export function PatchBody({ file, view }: { file: TaskDiffFile; view: DiffView }): React.JSX.Element {
  if (!file.ok) return <p className="diff-refusal">{file.reason}</p>
  return (
    <>
      {view === 'split' ? <SplitBody patch={file.patch} /> : <UnifiedBody patch={file.patch} />}
      {file.truncated && (
        <p className="diff-note">
          Showing {file.patch.length.toLocaleString()} of {file.bytes.toLocaleString()} characters —
          open the file in your editor to read the rest.
        </p>
      )}
    </>
  )
}

/**
 * One row of the inline file list: a path, its counts, and a press that opens the Diff pane there.
 *
 * ⚠️ A binary or generated file is listed and not pressable — there is nothing to open on it — and
 * says which of the two it is.
 */
function FileRow({
  file,
  onOpen
}: {
  file: TaskDiffFileEntry
  onOpen: (path: string) => void
}): React.JSX.Element {
  const shown = !file.binary && !file.generated
  return (
    <div className="diff-file">
      <button
        type="button"
        className="diff-file-head"
        onClick={shown ? () => onOpen(file.path) : undefined}
        disabled={!shown}
        title={shown ? 'Open this file in the Diff pane' : undefined}
      >
        <span className="diff-file-caret" aria-hidden>
          {shown ? '›' : '·'}
        </span>
        {/* ⛔ Text. A path is agent-influenced too — it is whatever the agent named a file. */}
        <span className="diff-file-path">{file.path}</span>
        {file.binary && <span className="diff-badge">binary</span>}
        {file.generated && <span className="diff-badge">generated</span>}
        {counts(file.added, file.removed)}
      </button>
    </div>
  )
}

export function DiffPanel({
  taskId,
  updatedAt,
  atGate
}: {
  taskId: string
  /** Re-read when the task moves: landing, committing and replying all change what is on the branch. */
  updatedAt: number
  /**
   * Is this the screen that asks whether the change should land?
   *
   * ⛔ Decides whether an unresolvable change says so: only at the gate, because that is the one
   * screen where *I could not look* answers the question being asked. On a finished task a refusal
   * would be a red line under every task whose branch is long gone. ⚠️ It does **not** decide
   * whether the panel is open — nothing does; see the `<details>` below.
   */
  atGate: boolean
}): React.JSX.Element | null {
  const [summary, setSummary] = useState<TaskDiffSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pane = useDiffPane()

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const answer = await rpc('task.diffSummary', { id: taskId })
        if (live) {
          setSummary(answer)
          setError(null)
        }
      } catch (e) {
        // ⚠️ A read that failed is not a change with nothing in it. The last good answer stays.
        if (live) setError(e instanceof Error ? e.message : 'could not read this change')
      }
    })()
    return () => {
      live = false
    }
  }, [taskId, updatedAt])

  // `null` means not yet known, which is not the same as "nothing there" and draws nothing.
  if (!summary && !error) return null
  // ⛔ Away from the gate, an unresolved change is not news: a draft has no branch and a task that
  // landed months ago has no workspace. The gate is the one screen where *I could not look* is the
  // answer to the question being asked, so it is the one screen that says it.
  if (!atGate && (error !== null || summary?.ok !== true)) return null

  const openPane = (focusPath?: string): void =>
    pane.open({ taskId, source: { kind: 'branch' }, ...(focusPath ? { focusPath } : {}) })
  const shownInPane = pane.request?.taskId === taskId && pane.request.source.kind === 'branch'

  // ⚠️ Collapsed by default everywhere, including at the gate (reported 2026-09-14: it used to
  // spring open on its own whenever a task landed at `awaiting_human`, which read as a surprise
  // rather than a nudge). The person still presses it themselves before deciding.
  return (
    <details className="diff-panel">
      <summary className="diff-panel-summary">
        {/* ⛔ Not *Review the change*: the panel is drawn on finished tasks too, where there is
            nothing left to review and the words read as an instruction that no longer applies. */}
        <span className="diff-panel-title">Changes in this task</span>
        {summary?.ok && (
          <span className="diff-panel-meta">
            {summary.files.length.toLocaleString()}
            {summary.filesTruncated ? '+' : ''} file{summary.files.length === 1 ? '' : 's'}
            {counts(summary.insertions, summary.deletions)}
          </span>
        )}
      </summary>
      <div className="diff-panel-body">
        {error && <p className="diff-refusal">{error}</p>}
        {summary && !summary.ok && <p className="diff-refusal">{summary.reason}</p>}

        {summary?.ok && summary.separateCommits > 1 && (
          <p className="diff-warn">
            This task landed {summary.separateCommits} separate commits, with other tasks&rsquo; work
            between them. Each is counted and shown on its own.
          </p>
        )}
        {summary?.ok && summary.filesTruncated && (
          <p className="diff-warn">
            More files changed than are listed here. The largest changes are shown first.
          </p>
        )}
        {/* ⛔ The banner that keeps the two answers apart. */}
        {summary && summary.workspaceReadable && summary.uncommittedFiles > 0 && (
          <p className="diff-warn">
            {summary.uncommittedFiles} uncommitted file{summary.uncommittedFiles === 1 ? '' : 's'} in the
            workspace <strong>will not land</strong>. Commit these changes first to include them.
          </p>
        )}
        {/* ⚠️ Only where it matters: on a task still holding a workspace. A finished task has no
            workspace to read, and saying so there would report a release as a failure. */}
        {atGate && summary && !summary.workspaceReadable && (
          <p className="diff-note">
            Workspace could not be read; uncommitted status is unknown.
          </p>
        )}

        {summary?.ok && summary.files.length > 0 && (
          <div className="diff-panel-actions">
            <button
              type="button"
              className="btn btn--ghost diff-open-pane"
              aria-pressed={shownInPane}
              title="Read every file's patch in the Diff pane, at the right of the window."
              onClick={() => openPane()}
            >
              {shownInPane ? 'Shown in Diff pane' : 'Open in Diff pane'}
            </button>
          </div>
        )}
        {summary?.ok && summary.files.map((f) => <FileRow key={f.path} file={f} onOpen={openPane} />)}
        {summary?.ok && summary.files.length === 0 && (
          <p className="diff-note">This branch changes no files.</p>
        )}
      </div>
    </details>
  )
}
