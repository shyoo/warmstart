import { useEffect, useState } from 'react'
import type { ModelOptions } from '@shared/protocol'
import type { Project } from '@shared/tasks'
import { RemoteError, rpc } from '../api.js'

/** File a task: project, prompt, optional model, priority. Then open what was filed. */
export function NewScreen({ openTask }: { openTask: (id: string) => void }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [models, setModels] = useState<ModelOptions[]>([])
  const [projectId, setProjectId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void Promise.all([rpc('project.list', undefined), rpc('model.options', undefined)])
      .then(([p, m]) => {
        setProjects(p)
        setModels(m)
        if (p[0]) setProjectId(p[0].id)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Could not load.')
        }
      })
  }, [])

  const submit = async (): Promise<void> => {
    if (prompt.trim().length === 0 || projectId.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await rpc('task.create', {
        title: prompt.trim(),
        projectId,
        priority,
        ...(model ? { constraints: { model } } : {})
      })
      openTask(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Filing failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="m-error m-screen">{error}</p>

  return (
    <div className="m-screen">
      <label className="m-field">
        <span>Project</span>
        <select className="m-input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="m-field">
        <span>What needs doing</span>
        <textarea
          className="m-input m-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="One task, plain words…"
          rows={4}
        />
      </label>
      <label className="m-field">
        <span>Model (optional)</span>
        <select className="m-input" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Automatic</option>
          {models.flatMap((o) =>
            o.models.map((m) => (
              <option key={`${o.adapterId}:${m.id}`} value={m.id}>
                {o.adapterId} · {m.id}
              </option>
            ))
          )}
        </select>
      </label>
      <label className="m-field">
        <span>Priority</span>
        <select className="m-input" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
          {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <button
        className="m-btn m-btn--primary"
        disabled={busy || prompt.trim().length === 0 || projectId.length === 0}
        onClick={() => void submit()}
      >
        {busy ? 'Filing…' : 'File task'}
      </button>
    </div>
  )
}
