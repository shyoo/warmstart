import { useEffect, useState } from 'react'
import { errorMessage } from '@shared/errors.js'
import type { MigratableVcs, VcsMigrationResult } from '@shared/protocol'
import type { Project, Vcs } from '@shared/tasks'
import { rpc } from '../lib/daemon'

/** Target VCS offered for local migration, or null for non-repository projects. */
export function migrationTargetVcs(vcs: Vcs): MigratableVcs | null {
  if (vcs === 'git') return 'jj'
  if (vcs === 'jj') return 'git'
  return null
}

/** Human-readable one-line summary of a completed local VCS migration, including verbatim warnings. */
export function formatMigrationSummary(result: VcsMigrationResult): string {
  const jjSuffix =
    result.migration.toVcs === 'git' ? `; ${result.keptJjDir ? '.jj kept' : '.jj removed'}` : ''
  const base =
    `Switched ${result.project.name} to ${result.migration.toVcs}; ` +
    `rebuilt ${result.rebuiltWorkspaces} pool workspace(s)${jjSuffix}.`
  return result.warnings.length > 0 ? `${base} ${result.warnings.join(' ')}` : base
}

/**
 * In-app modal for switching a project locally between git and colocated jj (`project.migrateVcs`).
 *
 * ⛔ Local to this machine: `.warmstart/project.json` is never rewritten, `.git` stays intact on
 * forward migration, and uncommitted trunk files are refused unless explicitly allowed here.
 */
export function VcsMigrationModal({
  project,
  onClose,
  onMigrated
}: {
  project: Project
  onClose: () => void
  onMigrated: (result: VcsMigrationResult) => void | Promise<void>
}): React.JSX.Element | null {
  const target = migrationTargetVcs(project.vcs)
  const [allowDirtyTrunk, setAllowDirtyTrunk] = useState(false)
  const [removeJjDir, setRemoveJjDir] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  if (!target) return null

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await rpc('project.migrateVcs', {
        id: project.id,
        to: target,
        allowDirtyTrunk,
        ...(target === 'git' ? { removeJjDir } : {})
      })
      await onMigrated(result)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="confirm-shade"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="task-composer-modal vcs-migration-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vcs-migration-title"
      >
        <header className="wizard-head">
          <div>
            <h3 id="vcs-migration-title">
              {target === 'jj' ? 'Change version control to colocated jj' : 'Change version control back to git'}
            </h3>
            <p className="wizard-sub">
              {project.name} · <span className="mono">{project.vcs}</span> → <span className="mono">{target}</span>
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="vcs-migration-body">
          {target === 'jj' ? (
            <>
              <p className="dim">
                Initializes colocated <span className="mono">jj git init --colocate</span> alongside{' '}
                <span className="mono">.git</span> (keeping <span className="mono">.git</span> untouched so migration stays
                reversible), verifies every <span className="mono">warmstart/t*</span> branch imports as a bookmark at
                the identical commit SHA (aborting and rolling back <span className="mono">.jj</span> on mismatch), sets{' '}
                <span className="mono">revset-aliases.trunk()</span>, rebuilds pool workspaces as{' '}
                <span className="mono">jj</span> workspaces, and updates local{' '}
                <span className="mono">projects.vcs</span> without rewriting{' '}
                <span className="mono">.warmstart/project.json</span>.
              </p>
              <p className="dim">
                Preconditions: no task holding a pool workspace or trunk lease, <span className="mono">jj</span> &gt;=
                0.46.0 on PATH, and repository root path &lt;= 106 characters.
              </p>
            </>
          ) : (
            <>
              <p className="dim">
                Exports bookmarks back to git, verifies every SHA matches, replaces{' '}
                <span className="mono">jj</span> workspaces with git worktrees, flips local{' '}
                <span className="mono">projects.vcs</span> back to <span className="mono">git</span>, and keeps{' '}
                <span className="mono">.jj</span> by default so switching back remains easy.
              </p>
              <p className="dim">Preconditions: no task holding a pool workspace or trunk lease.</p>
            </>
          )}

          <div className="vcs-migration-checks">
            <label className="wizard-check">
              <input
                type="checkbox"
                checked={allowDirtyTrunk}
                disabled={busy}
                onChange={(e) => setAllowDirtyTrunk(e.target.checked)}
              />
              <span>
                <span className="wizard-check-label">Allow uncommitted changes in the trunk</span>
                <span className="wizard-check-hint">
                  Proceed even when the trunk checkout has modified or untracked files (nothing is stashed or reset).
                </span>
              </span>
            </label>

            {target === 'git' && (
              <label className="wizard-check">
                <input
                  type="checkbox"
                  checked={removeJjDir}
                  disabled={busy}
                  onChange={(e) => setRemoveJjDir(e.target.checked)}
                />
                <span>
                  <span className="wizard-check-label">Remove .jj directory after switching to git</span>
                  <span className="wizard-check-hint">
                    Leave unchecked to keep .jj on disk so switching back later is immediate.
                  </span>
                </span>
              </label>
            )}
          </div>

          {error && <div className="alert">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit()}>
              {busy ? `Switching to ${target}…` : `Switch to ${target}`}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
