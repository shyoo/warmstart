import { useEffect, useState } from 'react'
import type { Task, UpstreamProposal } from '@shared/tasks'
import { errorMessage } from '@shared/errors.js'
import { rpc } from '../../lib/daemon'

/**
 * **Propose upstream…** — the one way a pull request is opened on the repository a fork was made
 * from (t903).
 *
 * ⛔ **Nothing is sent until the person has seen what would be.** The dialog reads the preview
 * first — the repository, the base, every commit and every file it touches — and the request that
 * opens the pull request carries that preview's base and commit list, which the daemon re-reads and
 * refuses on any difference (`upstream.ts`). t902 opened one on somebody else's repository with
 * nobody asked; this is the answer to that, and it must stay a click.
 */
export function ProposeUpstream({
  task,
  upstreamRemote,
  onDone
}: {
  task: Task
  upstreamRemote: string
  onDone: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<UpstreamProposal | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setPreview(null)
    setError(null)
    setBusy(true)
    rpc('task.upstreamPreview', { id: task.id })
      .then((p) => {
        if (!live) return
        setPreview(p)
        setTitle(p.title)
        setBody(p.body)
      })
      .catch((err: unknown) => live && setError(errorMessage(err)))
      .finally(() => live && setBusy(false))
    return () => {
      live = false
    }
  }, [open, task.id])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy])

  const send = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const result = await rpc('task.proposeUpstream', {
        id: task.id,
        baseSha: preview.baseSha,
        commits: preview.commits.map((c) => c.sha),
        title,
        body
      })
      setSent(result.url)
      setOpen(false)
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const trustLine = (p: UpstreamProposal): string =>
    p.trust.trust === 'own'
      ? `You maintain ${p.upstream} (${p.trust.permission}).`
      : p.trust.trust === 'external'
        ? `${p.upstream} is maintained by somebody else — your permission there is ${p.trust.permission}. Its maintainers will see this.`
        : `Warmstart could not tell whose ${p.upstream} is (${p.trust.reason ?? 'no answer'}); treat it as somebody else’s.`

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost propose-upstream-open"
        title={`Open a pull request on ${upstreamRemote} with this task’s commits — after you see exactly what it sends.`}
        onClick={() => {
          setSent(null)
          setOpen(true)
        }}
      >
        Propose upstream…
      </button>
      {sent && <span className="note mono propose-upstream-sent">{sent}</span>}
      {open && (
        <div
          className="confirm-shade"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setOpen(false)
          }}
        >
          <section className="task-composer-modal propose-upstream" role="dialog" aria-modal="true" aria-labelledby="propose-upstream-title">
            <header className="wizard-head">
              <div>
                <h3 id="propose-upstream-title">Propose t{task.seq} upstream</h3>
                <p className="wizard-sub">
                  Only this task’s commits, replayed onto the original’s branch. Nothing is sent until you press the button
                  below.
                </p>
              </div>
              <button className="btn btn--ghost" aria-label="Close" disabled={busy} onClick={() => setOpen(false)}>
                ✕
              </button>
            </header>
            {!preview && busy && <p className="dim">Reading what would be sent…</p>}
            {error && <div className="alert">{error}</div>}
            {preview && (
              <div className="propose-upstream-body">
                <p>
                  A pull request on <span className="mono">{preview.upstream}</span> into{' '}
                  <span className="mono">{preview.base}</span> ({preview.baseSha.slice(0, 8)}), from{' '}
                  <span className="mono">{preview.head}</span>.
                </p>
                <p className={preview.trust.trust === 'own' ? 'dim' : 'alert'}>{trustLine(preview)}</p>
                <ol className="propose-upstream-commits">
                  {preview.commits.map((c) => {
                    // ⚠️ t907: what stays behind as the fork's own, said per commit — the person
                    // consents to what leaves, so what does not leave is part of the picture.
                    const sent = c.files.filter((f) => !c.forkOnly.includes(f))
                    return (
                      <li key={c.sha}>
                        <span className="mono">{c.sha.slice(0, 8)}</span> {c.subject}
                        <div className="dim mono propose-upstream-files">
                          {c.files.length === 0 ? 'no files' : sent.length > 0 ? sent.join(', ') : 'nothing — not sent'}
                        </div>
                        {c.forkOnly.length > 0 && (
                          <div className="dim propose-upstream-kept">
                            Kept in your fork: <span className="mono">{c.forkOnly.join(', ')}</span>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ol>
                <label className="dim">
                  Title
                  <input className="text-input" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="dim">
                  Description
                  <textarea className="text-input" rows={6} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
                </label>
                <div className="modal-actions">
                  <button className="btn" disabled={busy} onClick={() => setOpen(false)}>
                    Cancel
                  </button>
                  <button className="btn btn--primary" disabled={busy || !title.trim()} onClick={() => void send()}>
                    {busy ? 'Opening…' : `Open pull request on ${preview.upstream}`}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}
