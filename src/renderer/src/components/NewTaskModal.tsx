import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/tasks'
import type { FleetEntry } from '../lib/daemon'
import { NewTask } from './NewTask'

/**
 * The one task composer surface. It belongs to shell chrome so every entry point opens the same
 * dialog and a project in view can preselect — but never lock — its project.
 */
export function NewTaskModal({
  projects,
  fleet,
  preselectedProjectId,
  onClose,
  onDone
}: {
  projects: Project[]
  fleet: FleetEntry[]
  preselectedProjectId?: string
  onClose: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="confirm-shade" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="task-composer-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <header className="task-composer-modal-head">
          <h2 id="new-task-title">New task</h2>
          <button ref={closeRef} className="dialog-close" aria-label="Close new task" title="Close" onClick={onClose}>×</button>
        </header>
        {error && <div className="alert">{error}</div>}
        <NewTask
          projects={projects}
          fleet={fleet}
          preselectedProjectId={preselectedProjectId}
          onDone={async () => {
            await onDone()
            onClose()
          }}
          onError={setError}
        />
      </section>
    </div>
  )
}
