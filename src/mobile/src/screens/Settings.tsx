import { useCallback, useEffect, useState } from 'react'
import type { RpcResult } from '@shared/protocol'
import type { Project } from '@shared/tasks'
import { RemoteError, rpc } from '../api.js'
import { duration } from '../lib/format.js'
import { Notifications } from './Notifications.js'

type Fleet = RpcResult<'fleet.list'>
type Health = RpcResult<'health'>

export function SettingsScreen({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [data, setData] = useState<{ health: Health; projects: Project[]; fleet: Fleet } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    void Promise.all([rpc('health', undefined), rpc('project.list', undefined), rpc('fleet.list', undefined)])
      .then(([health, projects, fleet]) => { setData({ health, projects, fleet }); setError(null) })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) setError(err instanceof Error ? err.message : 'Could not load.')
      })
  }, [])
  useEffect(refresh, [refresh, refreshKey])
  if (error) return <p className="m-error m-screen">{error}</p>
  if (!data) return <p className="m-empty m-screen">Reading server information…</p>
  const enabled = data.fleet.filter((entry) => entry.worker.enabled)
  const running = enabled.reduce((sum, entry) => sum + entry.sessions.length, 0)
  return <div className="m-screen">
    <div className="m-hero"><p className="m-eyebrow">Multi Agent Controller</p><h1 className="m-page-title">Connected</h1><p className="m-server">{location.origin}</p></div>
    <section className="m-info-grid">
      <div><strong>{data.projects.length}</strong><span>Enabled projects</span></div>
      <div><strong>{enabled.length}</strong><span>Enabled workers</span></div>
      <div><strong>{running}</strong><span>Running sessions</span></div>
      <div><strong>{duration(data.health.uptimeMs, null, data.health.uptimeMs)}</strong><span>Server uptime</span></div>
    </section>
    <section className="m-card"><h2 className="m-section-title">Projects on this phone</h2>{data.projects.map((project) => <div className="m-project" key={project.id}><span className="m-project-dot" /><span><strong>{project.name}</strong><small>{project.config.landing?.target ?? 'Default branch'}</small></span></div>)}{data.projects.length === 0 && <p className="m-empty">No projects enabled for remote access.</p>}</section>
    <section className="m-card"><h2 className="m-section-title">Server</h2><dl className="m-details"><div><dt>Version</dt><dd>{data.health.version}</dd></div><div><dt>Address</dt><dd>{location.host}</dd></div><div><dt>Live workers</dt><dd>{enabled.filter((entry) => !entry.unavailable).length} available</dd></div></dl></section>
    <Notifications />
  </div>
}
