/**
 * The Diff pane: one task's change, every file stacked in one scroll, at the right of the window.
 *
 * ⛔ **The same RPCs the inline views read, and the same renderers.** A branch is `task.diffSummary`
 * + `task.diffFile`; one recorded commit is `task.commitDiff` + `task.commitFile`, reading `<sha>^!`
 * so a task that landed twice never claims what landed in between. The patches are drawn by
 * `PatchBody` out of `thread/DiffPanel.tsx`, under the rule written at the top of that file: every
 * line a text node, nothing derived from the text but a class. This file adds a column and a
 * scroll, not a way of interpreting a patch.
 *
 * ⛔ **A budget on what opens by itself.** Each expanded file is one `git diff` call the moment the
 * pane opens, so `initialExpansion` (`lib/diffpane.ts`) opens files from the top until twelve or
 * 1,500 counted lines, and the rest wait for a click. The file somebody pressed in the inline list
 * is always open and scrolled to.
 *
 * ⚠️ A branch re-reads on `task.changed` for its task — landing, committing and replying all move
 * what is on it. A commit is immutable and is read once; if history was rewritten under the record
 * the read says so, which is the answer.
 *
 * Decisions: `transient_docs/diff_pane_2026-09-13.md`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskDiffFile, TaskDiffFileEntry, TaskDiffSummary } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { initialExpansion, type DiffPaneRequest } from '../lib/diffpane'
import { readDiffView, writeDiffView, type DiffView } from '../lib/prefs'
import { counts, PatchBody, ViewToggle } from './thread/DiffPanel'
import { PaneResizer, type PaneResizerSpec } from './SidebarResizer'

export const DIFFPANE_DEFAULT = 560
export const DIFFPANE_MIN = 360

/**
 * ⚠️ The ceiling follows the window: a pane may not eat the work it sits beside, and a constant
 * that was fine on a wide display leaves a narrow one with nothing but the diff.
 */
const DIFFPANE_SPEC: PaneResizerSpec = {
  variable: '--diffpane-w',
  storage: 'diffPaneWidth',
  defaultPx: DIFFPANE_DEFAULT,
  min: DIFFPANE_MIN,
  max: () => Math.max(DIFFPANE_MIN, Math.round(window.innerWidth * 0.6)),
  edge: 'right',
  label: 'Diff pane width',
  className: 'resizer--diffpane'
}

export function DiffPaneResizer(): React.JSX.Element {
  return <PaneResizer spec={DIFFPANE_SPEC} />
}

/**
 * One file in the stack: a sticky head with the path and counts, and the patch under it when open.
 *
 * ⚠️ Paid on open, never on render, and never twice: the patch is fetched the first time the row is
 * open — by the budget or by a press — and kept.
 */
function PaneFile({
  file,
  open,
  focused,
  view,
  onToggle,
  load,
  onSettled,
  mount
}: {
  file: TaskDiffFileEntry
  open: boolean
  focused: boolean
  view: DiffView
  onToggle: () => void
  load: (path: string) => Promise<TaskDiffFile>
  /** The patch arrived, or failed to: this row will not change height on its own again. */
  onSettled: (path: string) => void
  mount: (path: string, el: HTMLElement | null) => void
}): React.JSX.Element {
  const [patch, setPatch] = useState<TaskDiffFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = !file.binary && !file.generated

  useEffect(() => {
    if (!open || !shown || patch !== null || error !== null) return
    let live = true
    void (async () => {
      try {
        const answer = await load(file.path)
        if (live) setPatch(answer)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'could not read this file')
      } finally {
        if (live) onSettled(file.path)
      }
    })()
    return () => {
      live = false
    }
  }, [open, shown, patch, error, load, file.path, onSettled])

  return (
    <section
      ref={(el) => mount(file.path, el)}
      className={`diffpane-file${focused ? ' diffpane-file--focused' : ''}`}
    >
      <button
        type="button"
        className="diffpane-file-head"
        onClick={shown ? onToggle : undefined}
        disabled={!shown}
        aria-expanded={shown ? open : undefined}
      >
        <span className="diff-file-caret" aria-hidden>
          {shown ? (open ? '▾' : '▸') : '·'}
        </span>
        {/* ⛔ Text. A path is agent-influenced too — it is whatever the agent named a file. */}
        <span className="diff-file-path">{file.path}</span>
        {file.binary && <span className="diff-badge">binary</span>}
        {file.generated && <span className="diff-badge">generated</span>}
        {counts(file.added, file.removed)}
      </button>
      {open && shown && (
        <div className="diffpane-file-body">
          {error && <p className="diff-refusal">{error}</p>}
          {!error && !patch && <p className="diff-note">Reading…</p>}
          {!error && patch && <PatchBody file={patch} view={view} />}
        </div>
      )}
    </section>
  )
}

/**
 * The stack of files for one summary, with which of them are open.
 *
 * ⚠️ Keyed on the request by the parent, so a new commit or a re-read starts its expansion afresh
 * rather than inheriting a set of paths from a change that had different files.
 */
function PaneFiles({
  summary,
  focusPath,
  view,
  load
}: {
  summary: TaskDiffSummary
  focusPath: string | undefined
  view: DiffView
  load: (path: string) => Promise<TaskDiffFile>
}): React.JSX.Element {
  const [open, setOpen] = useState<Set<string>>(() => initialExpansion(summary.files, focusPath))
  const toggle = useCallback((path: string): void => {
    setOpen((was) => {
      const next = new Set(was)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /**
   * ⛔ **Scroll to the focused file once nothing above it will move it.** Each open file's patch
   * arrives on its own `git` call, and a file scrolled to the moment it mounts is pushed down the
   * pane by every patch that lands above it afterwards. So the scroll waits until the focused
   * file and every open file before it have settled, and then happens exactly once.
   */
  const [settled, setSettled] = useState<Set<string>>(() => new Set())
  const onSettled = useCallback((path: string): void => {
    setSettled((was) => (was.has(path) ? was : new Set(was).add(path)))
  }, [])
  const nodes = useRef(new Map<string, HTMLElement>())
  const mount = useCallback((path: string, el: HTMLElement | null): void => {
    if (el) nodes.current.set(path, el)
    else nodes.current.delete(path)
  }, [])
  const scrolled = useRef(false)
  useEffect(() => {
    if (scrolled.current || focusPath === undefined) return
    const at = summary.files.findIndex((f) => f.path === focusPath)
    if (at < 0) return
    const shown = (f: TaskDiffFileEntry): boolean => open.has(f.path) && !f.binary && !f.generated
    const ready = summary.files.slice(0, at + 1).every((f) => !shown(f) || settled.has(f.path))
    if (!ready) return
    scrolled.current = true
    nodes.current.get(focusPath)?.scrollIntoView({ block: 'start' })
  }, [focusPath, summary.files, open, settled])

  return (
    <>
      {summary.files.map((f) => (
        <PaneFile
          key={f.path}
          file={f}
          open={open.has(f.path)}
          focused={f.path === focusPath}
          view={view}
          onToggle={() => toggle(f.path)}
          load={load}
          onSettled={onSettled}
          mount={mount}
        />
      ))}
    </>
  )
}

export function DiffPane({
  request,
  onClose
}: {
  request: DiffPaneRequest
  onClose: () => void
}): React.JSX.Element {
  const [summary, setSummary] = useState<TaskDiffSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seq, setSeq] = useState<number | null>(null)
  // Bumped by `task.changed` for a branch, so the summary is re-read and the stack rebuilt.
  const [version, setVersion] = useState(0)
  const [view, setView] = useState<DiffView>(() => readDiffView())
  const choose = useCallback((next: DiffView): void => {
    setView(next)
    writeDiffView(next)
  }, [])

  const { taskId, source, focusPath } = request
  const sha = source.kind === 'commit' ? source.sha : null

  useDaemonEvents((event) => {
    if (event.type === 'task.changed' && event.task.id === taskId && sha === null) {
      setVersion((v) => v + 1)
    }
  })

  // The task's number for the head. One read per task, not per commit of it.
  useEffect(() => {
    let live = true
    setSeq(null)
    void (async () => {
      try {
        const got = await rpc('task.get', { id: taskId })
        if (live && got) setSeq(got.task.seq)
      } catch {
        // The head reads `t?` and the diff still draws; the number is a courtesy, not the content.
      }
    })()
    return () => {
      live = false
    }
  }, [taskId])

  useEffect(() => {
    let live = true
    setSummary(null)
    setError(null)
    void (async () => {
      try {
        const answer =
          sha === null
            ? await rpc('task.diffSummary', { id: taskId })
            : await rpc('task.commitDiff', { id: taskId, sha })
        if (live) setSummary(answer)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'could not read this change')
      }
    })()
    return () => {
      live = false
    }
  }, [taskId, sha, version])

  const load = useCallback(
    (path: string) =>
      sha === null
        ? rpc('task.diffFile', { id: taskId, path })
        : rpc('task.commitFile', { id: taskId, sha, path }),
    [taskId, sha]
  )

  // ⚠️ Escape closes the pane only while focus is inside it, so it cannot steal the key from a
  // dialog or a menu somewhere else on the screen.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const title = useMemo(() => {
    const t = seq === null ? 't?' : `t${seq}`
    return sha === null ? `${t} · Changes in this task` : `${t} · ${sha.slice(0, 8)}`
  }, [seq, sha])

  // ⚠️ The stack is keyed on what it shows, so a new commit or a re-read starts its expansion afresh.
  const stackKey = `${taskId}:${sha ?? 'branch'}:${version}`

  return (
    <aside className="diffpane" aria-label="Diff pane" onKeyDown={onKeyDown}>
      <header className="diffpane-head">
        <span className="diffpane-title">
          <span className={sha === null ? undefined : 'mono'}>{title}</span>
          {source.kind === 'commit' && source.subject && (
            <span className="diffpane-subject" title={source.subject}>
              {source.subject}
            </span>
          )}
        </span>
        {summary?.ok && (
          <span className="diff-panel-meta">
            {summary.files.length.toLocaleString()}
            {summary.filesTruncated ? '+' : ''} file{summary.files.length === 1 ? '' : 's'}
            {counts(summary.insertions, summary.deletions)}
          </span>
        )}
        <button
          type="button"
          className="icon-btn diffpane-close"
          title="Close the Diff pane (Esc)"
          aria-label="Close the Diff pane"
          onClick={onClose}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      {summary?.ok && summary.files.length > 0 && (
        <div className="diffpane-tools">
          <ViewToggle view={view} onView={choose} />
        </div>
      )}
      <div className="diffpane-body">
        {error && <p className="diff-refusal">{error}</p>}
        {!error && !summary && <p className="diff-note">Reading…</p>}
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
        {/* ⛔ The banner that keeps what lands apart from what does not, here as in the thread. */}
        {summary?.ok && sha === null && summary.workspaceReadable && summary.uncommittedFiles > 0 && (
          <p className="diff-warn">
            {summary.uncommittedFiles} file{summary.uncommittedFiles === 1 ? '' : 's'} in the
            workspace {summary.uncommittedFiles === 1 ? 'is' : 'are'} not committed and{' '}
            <strong>will not land</strong>.
          </p>
        )}
        {summary?.ok && (
          <PaneFiles key={stackKey} summary={summary} focusPath={focusPath} view={view} load={load} />
        )}
        {summary?.ok && summary.files.length === 0 && (
          <p className="diff-note">
            {sha === null ? 'This branch changes no files.' : 'This commit changes no files.'}
          </p>
        )}
      </div>
    </aside>
  )
}
