import { useState } from 'react'

const STEPS = [
  {
    title: 'Add a project',
    body: 'Choose a repository. Warmstart inspects it first, then lets you confirm its worktree location, landing policy, checks, and orientation files.',
    action: 'Add project'
  },
  {
    title: 'Add a worker',
    body: 'A worker is one agent account and its quota. Choose an installed agent CLI, create an isolated credential directory, and sign in through the vendor’s own flow.',
    action: 'Open Workers'
  },
  {
    title: 'File a task',
    body: 'Describe the outcome, choose its project, and review the priority, dependencies, workspace, conversation, and finish policy. Warmstart gives the run its own branch and workspace.',
    action: 'New task'
  }
] as const

export function WelcomeTour({ onClose, onAddProject, onWorkers, onNewTask }: {
  onClose: () => void
  onAddProject: () => void
  onWorkers: () => void
  onNewTask: () => void
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  const current = STEPS[step]!
  const actions = [onAddProject, onWorkers, onNewTask]
  return (
    <div className="confirm-shade" role="presentation">
      <section className="welcome-tour" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <div className="welcome-kicker">Welcome to Warmstart · {step + 1} of {STEPS.length}</div>
        <h2 id="welcome-title">{current.title}</h2>
        <p>{current.body}</p>
        <ol className="welcome-progress" aria-label="Tour progress">
          {STEPS.map((item, index) => <li key={item.title} className={index === step ? 'welcome-progress--active' : ''}>{item.title}</li>)}
        </ol>
        <div className="confirm-actions welcome-actions">
          <button className="btn btn--ghost" onClick={onClose}>Skip tour</button>
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
          <button className="btn" onClick={() => { onClose(); actions[step]!() }}>{current.action}</button>
          {step < STEPS.length - 1
            ? <button className="btn btn--primary" onClick={() => setStep(step + 1)}>Next</button>
            : <button className="btn btn--primary" onClick={onClose}>Start using Warmstart</button>}
        </div>
      </section>
    </div>
  )
}
