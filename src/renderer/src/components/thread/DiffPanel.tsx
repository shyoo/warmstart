/**
 * The change a task would put on the trunk, on the screen where somebody decides whether it should.
 *
 * ⛔ **Agent output is untrusted text, and a patch is the most untrusted text in this app** — it is
 * literally a file the agent wrote, quoted back. Every line below is a React text node inside
 * `<pre>`, and the only thing derived from its content is a CSS class chosen from the first
 * character. ⛔ No `dangerouslySetInnerHTML`, no markdown, no syntax highlighter (every one of them
 * takes a string and returns HTML, which is the one thing that may not happen here), and no
 * linkified paths. A path is text too. See `docs/ui.md`.
 *
 * ⛔ **What lands and what does not are drawn apart.** The file list is the committed change — the
 * bytes `Land` moves. Uncommitted files in the workspace are a separate banner, because they are
 * going nowhere and showing them in the same list would say a file was about to land when it was
 * about to be left behind.
 *
 * ⚠️ One `git` call for the list, one more per file somebody expands. Asked when the panel opens
 * and when the task moves, never on a timer — the same contract as `task.pendingWork`.
 */
import { useCallback, useEffect, useState } from 'react'
import type { TaskDiffFile, TaskDiffSummary } from '@shared/tasks'
import { rpc } from '../../lib/daemon'
import { patchLineClass } from '../../lib/diffline'

/** `+12 −3`, or nothing at all for a file with no counted lines. */
function counts(added: number, removed: number): React.JSX.Element {
  return (
    <span className="diff-counts">
      {added > 0 && <span className="diff-counts-add">+{added.toLocaleString()}</span>}
      {removed > 0 && <span className="diff-counts-del">−{removed.toLocaleString()}</span>}
      {added === 0 && removed === 0 && <span className="diff-counts-none">no counted lines</span>}
    </span>
  )
}

function PatchBody({ file }: { file: TaskDiffFile }): React.JSX.Element {
  if (!file.ok) return <p className="diff-refusal">{file.reason}</p>
  const lines = file.patch.split('\n')
  return (
    <>
      <pre className="diff-patch">
        {lines.map((line, i) => (
          // ⚠️ The index is the key because a patch has repeated identical lines by nature and
          // nothing here reorders: this list is rebuilt wholesale or not at all.
          <span key={i} className={patchLineClass(line)}>
            {line === '' ? ' ' : line}
            {'\n'}
          </span>
        ))}
      </pre>
      {file.truncated && (
        <p className="diff-note">
          Showing {file.patch.length.toLocaleString()} of {file.bytes.toLocaleString()} characters —
          open the file in your editor to read the rest.
        </p>
      )}
    </>
  )
}

function FileRow({
  taskId,
  path,
  added,
  removed,
  binary,
  generated
}: {
  taskId: string
  path: string
  added: number
  removed: number
  binary: boolean
  generated: boolean
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
      setFile(await rpc('task.diffFile', { id: taskId, path }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not read this file')
    }
  }, [open, file, taskId, path])

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
          {!error && file && <PatchBody file={file} />}
        </div>
      )}
    </div>
  )
}

export function DiffPanel({
  taskId,
  updatedAt
}: {
  taskId: string
  /** Re-read when the task moves: landing, committing and replying all change what is on the branch. */
  updatedAt: number
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

  // `null` means not yet known, which is not the same as "nothing there" and draws nothing.
  if (!summary && !error) return null

  /**
   * ⛔ **Open when there is something to read.** This is drawn on a screen whose whole question is
   * *should this land*, and a collapsed panel there is the same answer as no panel: the person
   * presses Land without looking, which is what this exists to stop. Collapsed only when the change
   * is empty or could not be resolved, where the summary line is already the whole story.
   */
  return (
    <details className="diff-panel" open={summary?.ok === true && summary.files.length > 0}>
      <summary className="diff-panel-summary">
        <span className="diff-panel-title">Review the change</span>
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
        {summary && !summary.workspaceReadable && (
          <p className="diff-note">
            The workspace could not be read, so whether anything is uncommitted is unknown.
          </p>
        )}

        {summary?.ok &&
          summary.files.map((f) => (
            <FileRow
              key={f.path}
              taskId={taskId}
              path={f.path}
              added={f.added}
              removed={f.removed}
              binary={f.binary}
              generated={f.generated}
            />
          ))}
        {summary?.ok && summary.files.length === 0 && (
          <p className="diff-note">This branch changes no files.</p>
        )}
      </div>
    </details>
  )
}
