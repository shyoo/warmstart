import { useState } from 'react'
import type { Project, ResourceAvailability } from '@shared/tasks'
import { rpc } from '../lib/daemon'

/**
 * Every project this install knows about, and the one control that belongs at fleet scope: adding
 * another.
 *
 * A project is a directory plus policy, and the policy is **committed in the repo** so a collaborator
 * or a fresh clone reproduces the same behaviour. Everything shown here that came from
 * `.multi_agent_controller/project.json` is a fact about the repository, not a setting stored in this app.
 *
 * ⛔ **No resources table.** This page used to list every one of the fleet's pools, landing locks
 * and metered APIs beneath the projects. It was read-only, it duplicated what each project's own
 * Settings tab already draws next to the policy those numbers exist to serve, and sitting under a
 * heading that says Settings it read as something an operator could change. Removed 2026-08-31.
 *
 * ⚠️ `resources` stays a prop, for the **Workspaces** column below. That is the one number from the
 * broker anybody scanning this list wants — how much of each project's pool is free — and it is
 * useful precisely because it sits on the project's own row rather than in a table of its own.
 */
export function Projects({
  projects,
  resources,
  refresh
}: {
  projects: Project[]
  resources: ResourceAvailability[]
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [root, setRoot] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async () => {
    if (!root.trim()) return
    setBusy(true)
    setError(null)
    try {
      await rpc('project.add', { root: root.trim() })
      setRoot('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Projects</h2>
          <p className="panel-sub">
            Every project this install knows about. Policy for one of them — how its tasks finish,
            what verifies them, how many run at once — lives on that project&rsquo;s own{' '}
            <strong>Settings</strong> tab.
          </p>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="form">
        <div className="form-row">
          <label>Add</label>
          <input
            className="form-wide mono"
            value={root}
            placeholder="path to a project directory"
            onChange={(e) => setRoot(e.target.value)}
          />
          <span className="form-hint">
            Multi Agent Controller reads <span className="mono">.multi_agent_controller/project.json</span> if it is there, and
            runs on defaults if it is not.
          </span>
        </div>
        <div className="form-actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => void add()}>
            Add project
          </button>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="empty-inline">
          <p>No projects yet.</p>
          <p className="dim">Tasks can run without one, but they get no workspace and no branch.</p>
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Project</th>
              <th>VCS</th>
              <th>Config</th>
              <th>Objective</th>
              <th>Landing</th>
              <th>Workspaces</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const pool = resources.find((r) => r.resource.id === `workspace:${project.id}`)
              return (
                <tr key={project.id}>
                  <td>
                    <span className="tbl-strong">{project.name}</span>
                    <div className="tbl-path mono" title={project.root}>
                      {project.root}
                    </div>
                  </td>
                  <td className="dim">{project.vcs}</td>
                  <td>
                    {project.configPath ? (
                      <span className="ok">committed</span>
                    ) : (
                      <span className="dim">defaults</span>
                    )}
                  </td>
                  <td className="dim">{project.config.objective ?? 'inherited'}</td>
                  <td className="dim">
                    {project.config.landing?.strategy ?? 'auto-land'} →{' '}
                    {project.config.landing?.target ?? 'main'}
                  </td>
                  <td className="num">
                    {pool ? `${pool.free}/${pool.resource.capacity} free` : 'not created yet'}
                  </td>
                  <td className="tbl-actions">
                    <button
                      className="btn btn--ghost"
                      onClick={() => void rpc('project.reload', { id: project.id }).then(refresh)}
                    >
                      Reload
                    </button>
                    {!project.configPath && (
                      <button
                        className="btn btn--ghost"
                        title="Write a starter .multi_agent_controller/project.json into the repository."
                        onClick={() =>
                          void rpc('project.writeConfig', { id: project.id }).then(refresh)
                        }
                      >
                        Write config
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

    </div>
  )
}
