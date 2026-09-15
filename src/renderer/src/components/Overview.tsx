import { useEffect, useState } from 'react'
import type { DoctorReport } from '@shared/protocol'
import { rpc } from '../lib/daemon'
import { ToolTable } from './Doctor'
import { LooseEnds } from './LooseEnds'

/**
 * Everything that is true of the whole fleet rather than of one project.
 *
 * ⚠️ Deliberately no live-session list (owner's call, 2026-08-26). What is running right now belongs
 * to the project it is running for, and until sessions carry a project id there is nothing here that
 * could say which.
 */
export function Overview(): React.JSX.Element {
  const [tools, setTools] = useState<DoctorReport['tools'] | null>(null)
  useEffect(() => { void rpc('tool.detect').then(setTools).catch(() => {}) }, [])
  const missing = tools?.filter((tool) => !tool.found) ?? []
  return (
    <div className="stack">
      {missing.length > 0 && (
        <section className="panel dashboard-tools">
          <header className="panel-head">
            <div>
              <h2>Tools to finish setup</h2>
              <p className="panel-sub">Warmstart found these host dependencies missing from PATH.</p>
            </div>
          </header>
          <ToolTable tools={missing} />
        </section>
      )}
      <LooseEnds />
    </div>
  )
}
