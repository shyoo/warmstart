import { useEffect, useState } from 'react'
import type { Project } from '@shared/tasks'
import type { FleetEntry } from '../lib/daemon'
import { NewTask } from './NewTask'

/**
 * The one task composer surface. It belongs to shell chrome so every entry point opens the same
 * dialog and a project in view can preselect — but never lock — its project.
 *
 * ⚠️ This wrapper is the shade, the escape key and the error line, and nothing else. The head row —
 * the title, the project picker and the close button — is drawn by `NewTask`, because the project
 * is a value the composer owns and a control lifted out of the component holding its state is two
 * places to keep in step.
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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="confirm-shade"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="task-composer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        {error && <div className="alert">{error}</div>}
        <NewTask
          projects={projects}
          fleet={fleet}
          preselectedProjectId={preselectedProjectId}
          onClose={onClose}
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
