import { useEffect, useState } from 'react'

// ⛔ Real screenshots of the real UI over an invented fleet, not drawings of it. Regenerate with
// `node scripts/generate-tour-assets.mjs` after a change to the wizard, the Workers card or the composer.
import projectShot from '../assets/welcome/project.png'
import workerShot from '../assets/welcome/worker.png'
import taskShot from '../assets/welcome/task.png'

function Shot({ src, alt }: { src: string; alt: string }): React.JSX.Element {
  return <img src={src} alt={alt} className="welcome-shot" draggable={false} />
}

const STEPS = [
  {
    title: 'Add a project',
    body: 'Choose a repository. Warmstart inspects it first, then lets you confirm its worktree location, landing policy, checks, and orientation files.',
    shot: <Shot src={projectShot} alt="The Add a project dialog inspecting a repository" />
  },
  {
    title: 'Add a worker',
    body: 'A worker is one agent account and its quota. Choose an installed agent CLI, create an isolated credential directory, and sign in through the vendor’s own flow.',
    shot: <Shot src={workerShot} alt="A worker card in Settings, showing its account, models and roles" />
  },
  {
    title: 'File a task',
    body: 'Describe the outcome, choose its project, and review the priority, dependencies, workspace, conversation, and finish policy. Warmstart gives the run its own branch and workspace.',
    shot: <Shot src={taskShot} alt="The New task composer with a prompt and its option pills" />
  }
] as const

export interface WelcomeTourProps {
  onClose: () => void
  onAddProject?: () => void
  onWorkers?: () => void
  onNewTask?: () => void
}

export function WelcomeTour({ onClose }: WelcomeTourProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const current = STEPS[step]!

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        setStep((s) => Math.min(STEPS.length - 1, s + 1))
      } else if (e.key === 'ArrowLeft') {
        setStep((s) => Math.max(0, s - 1))
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="confirm-shade" role="presentation">
      <section className="welcome-tour" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <div className="welcome-kicker">Welcome to Warmstart · Step {step + 1} of {STEPS.length}</div>
        <h2 id="welcome-title">{current.title}</h2>
        <p>{current.body}</p>
        <div className="welcome-shot-frame">
          {current.shot}
        </div>
        <ol className="welcome-progress" aria-label="Tour progress">
          {STEPS.map((item, index) => (
            <li
              key={item.title}
              className={index === step ? 'welcome-progress--active' : ''}
              onClick={() => setStep(index)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setStep(index)
              }}
            >
              {item.title}
            </li>
          ))}
        </ol>
        <div className="confirm-actions welcome-actions">
          <button className="btn btn--ghost" onClick={onClose}>Skip tour</button>
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn btn--primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button className="btn btn--primary" onClick={onClose}>
              Start using Warmstart
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
