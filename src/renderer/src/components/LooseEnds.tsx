import { useCallback, useEffect, useState } from 'react'
import type { LooseEnd } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { errorMessage } from '@shared/errors.js'
import { mergedSweepNote } from '../lib/looseends'

// The overview unmounts while another page is open. Keep the last confirmed scan at module scope so
// returning to it does not briefly erase the decisions the operator was just reading.
let previousEnds: LooseEnd[] | null = null

/**
 * Work that exists and is going nowhere.
 *
 * ⛔ **This panel is the exit prompt, asked later.** Every serious tool in this space preserves a
 * worktree that still holds work rather than reclaiming it — Claude Code's sweep leaves one alone
 * when it has "changed or untracked files, or unpushed commits", agent-orchestrator states *"never
 * force-delete dirty worktrees"* as a load-bearing rule — and every one of them asks a human at the
 * moment of preservation. This fleet is unattended by design, so there is nobody there to ask. The
 * question has to be asked afterwards, and this is where.
 *
 * ⚠️ Preserving work silently is only half a fix. `rescueDirt` stashes what a run left behind and
 * `leave-branch` keeps a branch intact when landing is refused; both are correct, and both were
 * invisible, which is indistinguishable from loss to the person who wanted the work. t5's commit
 * `ea05929` sat on its branch for a day before anybody found it.
 *
 * ⛔ Nothing here destroys anything **automatically**. Land it, file a task to deal with it, or say
 * you already know — and, for a branch with commits, say plainly that it is not needed: **Delete it**
 * is the one button on this panel that discards work, and it exists only because the operator
 * clicking it is a decision, not a scan the daemon made on its own.
 */
export function LooseEnds(): React.JSX.Element | null {
  const [ends, setEnds] = useState<LooseEnd[] | null>(previousEnds)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await rpc('looseend.list')
      previousEnds = next
      setEnds(next)
    } catch {
      // ⚠️ Silent. A repository this cannot read is not a reason to take the Overview down, and the
      // scan runs against every project's whole pool on a page that is otherwise always available.
      if (previousEnds === null) setEnds([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useDaemonEvents((event) => {
    if (event.type === 'task.changed' || event.type === 'run.changed') void refresh()
  })

  const act = async (fn: () => Promise<string | null>): Promise<void> => {
    setNote(null)
    try {
      setNote(await fn())
    } catch (err) {
      setNote(errorMessage(err))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Loose ends</h2>
          <p className="panel-sub">
            Uncommitted edits, unmerged branches, and temporary workspace stashes.
            No files are deleted unless you explicitly click Delete.
          </p>
        </div>
        <div className="tbl-actions">
          {loading && <span className="loose-ends-loading" role="status">Refreshing…</span>}
          {/* ⭐ The pull-request sweep runs every five minutes on its own; this runs it now, so a PR
              merged a moment ago is cleaned up — or its reason shown — without waiting. */}
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void act(async () => {
                setBusy('check-merged')
                return mergedSweepNote(await rpc('looseend.checkMerged'))
              })
            }
          >
            Check merged PRs
          </button>
        </div>
      </header>

      {note && <div className="notice">{note}</div>}

      {ends === null ? (
        <p className="dim">Scanning projects for loose ends…</p>
      ) : ends.length === 0 ? (
        <div className="empty-inline">
          <p>No loose ends.</p>
          <p className="dim">
            All worktrees are clean, finished branches have landed, and there are no uncommitted files or orphaned stashes.
          </p>
        </div>
      ) : (
        <table className="tbl tbl-loose-ends">
        <thead>
          <tr>
            <th>What</th>
            <th>Where</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ends.map((end) => (
            <tr key={end.id}>
              <td>
                <span className={`status ${TONE[end.kind]}`}>{LABEL[end.kind]}</span>
                <div className="tbl-sub">{end.summary}</div>
              </td>
              <td className="mono tbl-sub">
                {end.projectName}
                {end.taskSeq !== null && <> · t{end.taskSeq}</>}
              </td>
              <td>
                <div className="tbl-actions">
                  {/* ⛔ Only for a branch that already holds commits. There is nothing to land about
                      uncommitted files, and offering the button would imply the tool would commit
                      them — which is the one thing it will not do. */}
                  {end.kind === 'unlanded' && end.taskSeq !== null && (
                    <button
                      type="button"
                      className="btn btn--ok"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(async () => {
                          setBusy(end.id)
                          const task = (await rpc('task.list', {})).find((t) => t.seq === end.taskSeq)
                          if (!task) return 'Task no longer exists'
                          const r = await rpc('task.land', { id: task.id })
                          return r.landed ? `Landed t${end.taskSeq}` : `Not landed — ${r.reason}`
                        })
                      }
                    >
                      Land it
                    </button>
                  )}
                  {/* ⛔ The one destructive button on this panel. Only for a branch that carries real
                      commits — there is nothing to discard about an empty one, and that case is
                      already `stranded`'s "Retire it". Confirmed, because unlike everything else here
                      it does throw work away, on purpose, because the operator said it is not needed. */}
                  {end.kind === 'unlanded' && end.branch !== null && (
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(async () => {
                          if (
                            !confirm(
                              `Delete \`${end.branch}\`? This discards ${end.count} commit(s) that ` +
                                'the trunk does not have. This cannot be undone.'
                            )
                          )
                            return null
                          setBusy(end.id)
                          const r = await rpc('looseend.delete', {
                            projectId: end.projectId,
                            branch: end.branch as string
                          })
                          return r.deleted
                            ? `deleted ${end.branch}`
                            : `Could not delete ${end.branch}: ${r.reason ?? 'the branch was not removed'}`
                        })
                      }
                    >
                      Delete it
                    </button>
                  )}
                  {/* ⛔ Only for a branch with nothing on it. The daemon checks that again before
                      it deletes anything — this panel may be minutes old, and a branch that gained a
                      commit in between must not be removed because a stale row said it was empty. */}
                  {/* ⛔ Merged on GitHub, so there is nothing to land. The daemon re-reads the PR and
                      the branch before deleting the name, and never switches a checkout of yours. */}
                  {end.kind === 'merged' && end.branch !== null && (
                    <button
                      type="button"
                      className="btn btn--ok"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(async () => {
                          setBusy(end.id)
                          const r = await rpc('looseend.cleanup', {
                            projectId: end.projectId,
                            branch: end.branch as string
                          })
                          return r.deleted
                            ? `cleaned up ${end.branch}`
                            : `Could not clean up ${end.branch}: ${r.reason ?? 'the branch was not removed'}`
                        })
                      }
                    >
                      Clean up
                    </button>
                  )}
                  {end.kind === 'stranded' && end.branch !== null && (
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(async () => {
                          setBusy(end.id)
                          const r = await rpc('looseend.retire', {
                            projectId: end.projectId,
                            branch: end.branch as string
                          })
                          return r.deleted
                            ? `retired ${end.branch}`
                            : `Could not retire ${end.branch}: ${r.reason ?? 'the branch was not removed'}`
                        })
                      }
                    >
                      Retire it
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(async () => {
                        setBusy(end.id)
                        const task = await rpc('looseend.reclaim', end)
                        return `filed t${task.seq} to deal with it`
                      })
                    }
                  >
                    Make a task
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(async () => {
                        setBusy(end.id)
                        await rpc('looseend.dismiss', { id: end.id })
                        return null
                      })
                    }
                  >
                    Dismiss
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
    </div>
  )
}

const LABEL: Record<LooseEnd['kind'], string> = {
  uncommitted: 'uncommitted',
  unlanded: 'not landed',
  stash: 'stashed',
  stranded: 'branch left behind',
  merged: 'merged, branch left'
}

/** ⚠️ Uncommitted is the loudest: it is the only one where a pooled slot is still being held. */
const TONE: Record<LooseEnd['kind'], string> = {
  uncommitted: 'state-warn',
  unlanded: 'state-human',
  stash: 'state-idle',
  // ⚠️ The quietest of the four, deliberately. Nothing is at risk — every commit on it is already in
  // the trunk — so it is a tidy-up, and colouring it like lost work would train the operator to
  // ignore the list.
  stranded: 'state-idle',
  // ⚠️ Quiet for the same reason: the work reached the trunk through its pull request.
  merged: 'state-idle'
}
