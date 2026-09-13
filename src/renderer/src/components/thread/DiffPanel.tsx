/**
 * The change a task made, on the screen where somebody decides what to do about it.
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
 * ⚠️ One `git` call for the list, one more per file somebody expands. Asked when the panel opens
 * and when the task moves, never on a timer — the same contract as `task.pendingWork`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskDiffFile, TaskDiffSummary } from '@shared/tasks'
import { rpc } from '../../lib/daemon'
import { patchLineClass } from '../../lib/diffline'
import { readDiffView, writeDiffView, type DiffView } from '../../lib/prefs'
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
 * One file's patch as two columns: old on the left, new on the right.
 *
 * ⛔ **Cells, never markup.** Every number and every line is a React text node, exactly like the
 * unified view — `splitPatch` derives structure from first characters and the table is elements this
 * codebase writes. A changed row pairs the two halves of one edit; a row standing alone on one side
 * is a line only that side has.
 */
function SplitBody({ patch }: { patch: string }): React.JSX.Element {
  const blocks = useMemo(() => splitPatch(patch), [patch])
  return (
    <div className="diff-split-wrap">
      {blocks.map((block, bi) => (
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
      ))}
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
 * ⛔ **One control per panel, not one per file.** A toggle on each file is a control somebody has to
 * press again for every file in a forty-file change, and two files left in different layouts read as
 * a rendering bug rather than as a choice. ⚠️ Remembered in `localStorage` (`prefs.ts`) because
 * which layout somebody reads a diff in is a property of the person, not of the task.
 */
function ViewToggle({
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

function PatchBody({ file, view }: { file: TaskDiffFile; view: DiffView }): React.JSX.Element {
  if (!file.ok) return <p className="diff-refusal">{file.reason}</p>
  const lines = file.patch.split('\n')
  return (
    <>
      {view === 'split' ? (
        <SplitBody patch={file.patch} />
      ) : (
        <pre className="diff-patch">
          {lines.map((line, i) => (
            // ⚠️ The index is the key because a patch has repeated identical lines by nature and
            // nothing here reorders: this list is rebuilt wholesale or not at all.
            <span key={i} className={patchLineClass(line)}>
              {line === '' ? ' ' : line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
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
 * One row of the file list, which fetches its own patch when it is opened.
 *
 * ⚠️ `load` rather than a task id and a path: the identical row draws a file out of the branch and a
 * file out of one recorded commit, and the only difference between those is which call answers.
 */
function FileRow({
  path,
  added,
  removed,
  binary,
  generated,
  view,
  load
}: {
  path: string
  added: number
  removed: number
  binary: boolean
  generated: boolean
  view: DiffView
  load: (path: string) => Promise<TaskDiffFile>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<TaskDiffFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ⚠️ Paid on expand, never on render. A hundred-file change is a hundred `git diff` calls if this
  // is done eagerly, to show text nobody has asked to read.
  const expand = useCallback(async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (!next || file) return
    try {
      setFile(await load(path))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not read this file')
    }
  }, [open, file, load, path])

  const shown = !binary && !generated
  return (
    <div className="diff-file">
      <button
        type="button"
        className="diff-file-head"
        onClick={shown ? () => void expand() : undefined}
        disabled={!shown}
        aria-expanded={shown ? open : undefined}
      >
        <span className="diff-file-caret">{shown ? (open ? '▾' : '▸') : '·'}</span>
        {/* ⛔ Text. A path is agent-influenced too — it is whatever the agent named a file. */}
        <span className="diff-file-path">{path}</span>
        {binary && <span className="diff-badge">binary</span>}
        {generated && <span className="diff-badge">generated</span>}
        {counts(added, removed)}
      </button>
      {open && shown && (
        <div className="diff-file-body">
          {error && <p className="diff-refusal">{error}</p>}
          {!error && !file && <p className="diff-note">Reading…</p>}
          {!error && file && <PatchBody file={file} view={view} />}
        </div>
      )}
    </div>
  )
}

/**
 * A resolved change: its files, and the layout toggle that draws them.
 *
 * ⚠️ Shared by the branch panel and by one commit's row, so neither can grow a way of drawing a
 * patch the other does not have.
 */
export function DiffFiles({
  summary,
  load
}: {
  summary: TaskDiffSummary
  load: (path: string) => Promise<TaskDiffFile>
}): React.JSX.Element {
  const [view, setView] = useState<DiffView>(() => readDiffView())
  const choose = useCallback((next: DiffView): void => {
    setView(next)
    writeDiffView(next)
  }, [])
  return (
    <>
      {summary.files.length > 0 && <ViewToggle view={view} onView={choose} />}
      {summary.files.map((f) => (
        <FileRow
          key={f.path}
          path={f.path}
          added={f.added}
          removed={f.removed}
          binary={f.binary}
          generated={f.generated}
          view={view}
          load={load}
        />
      ))}
    </>
  )
}

/**
 * One recorded commit's own change, read on demand.
 *
 * ⛔ **The commit, not the range.** A task that landed twice put its commits on the trunk with other
 * tasks' work between them, so `base..head` over the pair would claim the lot — `task.commitDiff`
 * reads exactly the sha of the row this hangs under. ⚠️ Only the totals are fetched until somebody
 * expands the row; the patch text costs a second call per file, as everywhere else here.
 */
export function CommitDiff({
  summary,
  taskId,
  sha
}: {
  summary: TaskDiffSummary
  taskId: string
  sha: string
}): React.JSX.Element {
  const load = useCallback(
    (path: string) => rpc('task.commitFile', { id: taskId, sha, path }),
    [taskId, sha]
  )
  if (!summary.ok) return <p className="diff-refusal">{summary.reason}</p>
  return (
    <div className="diff-commit-body">
      {summary.filesTruncated && (
        <p className="diff-warn">
          More files changed than are listed here. The largest changes are shown first.
        </p>
      )}
      <DiffFiles summary={summary} load={load} />
      {summary.files.length === 0 && <p className="diff-note">This commit changes no files.</p>}
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
   * ⛔ Decides two things, and both are about not crying wolf: the panel opens itself only at the
   * gate, and only at the gate does an unresolvable change say so. On a finished task a refusal
   * would be a red line under every task whose branch is long gone.
   */
  atGate: boolean
}): React.JSX.Element | null {
  const [summary, setSummary] = useState<TaskDiffSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const load = useCallback(
    (path: string) => rpc('task.diffFile', { id: taskId, path }),
    [taskId]
  )

  // `null` means not yet known, which is not the same as "nothing there" and draws nothing.
  if (!summary && !error) return null
  // ⛔ Away from the gate, an unresolved change is not news: a draft has no branch and a task that
  // landed months ago has no workspace. The gate is the one screen where *I could not look* is the
  // answer to the question being asked, so it is the one screen that says it.
  if (!atGate && (error !== null || summary?.ok !== true)) return null

  /**
   * ⛔ **Open when there is something to read and a decision to make.** At the gate a collapsed
   * panel is the same answer as no panel: the person presses Land without looking, which is what
   * this exists to stop. Elsewhere it is history, and history does not unfold itself.
   */
  return (
    <details className="diff-panel" open={atGate && summary?.ok === true && summary.files.length > 0}>
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
            {summary.uncommittedFiles} file{summary.uncommittedFiles === 1 ? '' : 's'} in the
            workspace {summary.uncommittedFiles === 1 ? 'is' : 'are'} not committed and{' '}
            <strong>will not land</strong>. Commit first if you want{' '}
            {summary.uncommittedFiles === 1 ? 'it' : 'them'} included.
          </p>
        )}
        {/* ⚠️ Only where it matters: on a task still holding a workspace. A finished task has no
            workspace to read, and saying so there would report a release as a failure. */}
        {atGate && summary && !summary.workspaceReadable && (
          <p className="diff-note">
            The workspace could not be read, so whether anything is uncommitted is unknown.
          </p>
        )}

        {summary?.ok && <DiffFiles summary={summary} load={load} />}
        {summary?.ok && summary.files.length === 0 && (
          <p className="diff-note">This branch changes no files.</p>
        )}
      </div>
    </details>
  )
}
