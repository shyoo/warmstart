import { useEffect, useState } from 'react'

function ProjectMockup(): React.JSX.Element {
  return (
    <svg viewBox="0 0 600 240" className="welcome-mockup-svg" aria-hidden="true">
      {/* Background */}
      <rect x="0" y="0" width="600" height="240" fill="var(--color-surface)" />

      {/* Window title bar */}
      <rect x="0" y="0" width="600" height="30" fill="var(--color-surface-2)" />
      <line x1="0" y1="30" x2="600" y2="30" stroke="var(--color-border)" strokeWidth="1" />
      <circle cx="16" cy="15" r="4" fill="var(--color-border-strong)" />
      <circle cx="28" cy="15" r="4" fill="var(--color-border-strong)" />
      <circle cx="40" cy="15" r="4" fill="var(--color-border-strong)" />
      <text x="56" y="19" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)" fontWeight="600">
        Add a project
      </text>

      {/* Directory input */}
      <text x="24" y="52" fill="var(--color-text-faint)" fontSize="10" fontFamily="var(--font-ui)" fontWeight="600" letterSpacing="0.06em">
        PROJECT DIRECTORY
      </text>
      <rect x="24" y="58" width="464" height="28" rx="4" fill="var(--color-bg)" stroke="var(--color-border-strong)" />
      <text x="36" y="76" fill="var(--color-text)" fontSize="12" fontFamily="var(--font-mono)">
        C:\Dev\storefront
      </text>
      <rect x="496" y="58" width="80" height="28" rx="4" fill="var(--color-surface-2)" stroke="var(--color-border)" />
      <text x="536" y="76" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)" textAnchor="middle">
        Choose…
      </text>

      {/* Inspection panel */}
      <rect x="24" y="96" width="552" height="92" rx="6" fill="var(--color-surface-2)" stroke="var(--color-border)" />
      <text x="40" y="116" fill="var(--color-accent)" fontSize="10" fontFamily="var(--font-ui)" fontWeight="600" letterSpacing="0.06em">
        WHAT IS THERE
      </text>

      {/* Column 1 */}
      <circle cx="46" cy="138" r="3.5" fill="var(--state-ok)" />
      <text x="58" y="141" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)">Repository</text>
      <text x="140" y="141" fill="var(--color-text)" fontSize="11" fontFamily="var(--font-mono)">git (main branch)</text>

      <circle cx="46" cy="162" r="3.5" fill="var(--state-ok)" />
      <text x="58" y="165" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)">Stack</text>
      <text x="140" y="165" fill="var(--color-text)" fontSize="11" fontFamily="var(--font-mono)">node · typescript</text>

      {/* Column 2 */}
      <circle cx="310" cy="138" r="3.5" fill="var(--state-ok)" />
      <text x="322" y="141" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)">Orientation docs</text>
      <text x="424" y="141" fill="var(--color-text)" fontSize="11" fontFamily="var(--font-mono)">AGENTS.md, HANDOFF.md</text>

      <circle cx="310" cy="162" r="3.5" fill="var(--color-accent)" />
      <text x="322" y="165" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)">Finish policy</text>
      <text x="424" y="165" fill="var(--color-text)" fontSize="11" fontFamily="var(--font-mono)">commit-and-merge</text>

      {/* Bottom status & action preview */}
      <text x="24" y="217" fill="var(--color-text-faint)" fontSize="11" fontFamily="var(--font-ui)">
        Inspects directory first · Worktrees configured automatically
      </text>
      <rect x="472" y="200" width="104" height="26" rx="4" fill="var(--color-accent)" />
      <text x="524" y="217" fill="#0e1013" fontSize="11" fontFamily="var(--font-ui)" fontWeight="600" textAnchor="middle">
        Create project
      </text>
    </svg>
  )
}

function WorkerMockup(): React.JSX.Element {
  return (
    <svg viewBox="0 0 600 240" className="welcome-mockup-svg" aria-hidden="true">
      {/* Background */}
      <rect x="0" y="0" width="600" height="240" fill="var(--color-surface)" />

      {/* Window title bar */}
      <rect x="0" y="0" width="600" height="30" fill="var(--color-surface-2)" />
      <line x1="0" y1="30" x2="600" y2="30" stroke="var(--color-border)" strokeWidth="1" />
      <circle cx="16" cy="15" r="4" fill="var(--color-border-strong)" />
      <circle cx="28" cy="15" r="4" fill="var(--color-border-strong)" />
      <circle cx="40" cy="15" r="4" fill="var(--color-border-strong)" />
      <text x="56" y="19" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)" fontWeight="600">
        Settings → Workers · Multi-agent Quota Fleet
      </text>
      <rect x="496" y="6" width="80" height="18" rx="3" fill="var(--color-accent)" />
      <text x="536" y="18" fill="#0e1013" fontSize="10" fontFamily="var(--font-ui)" fontWeight="600" textAnchor="middle">
        + Add worker
      </text>

      {/* Worker Card 1: Claude */}
      <rect x="24" y="40" width="552" height="82" rx="6" fill="var(--color-surface-2)" stroke="var(--color-border)" />

      {/* Claude icon & label */}
      <circle cx="42" cy="58" r="9" fill="#2d1e18" stroke="#D97757" strokeWidth="1.5" />
      <path d="M39 58 h6 M42 55 v6 M40 56 l4 4 M40 60 l4 -4" stroke="#D97757" strokeWidth="1.5" strokeLinecap="round" />
      <text x="58" y="62" fill="var(--color-text)" fontSize="12" fontFamily="var(--font-ui)" fontWeight="600">
        Claude · personal
      </text>
      <rect x="174" y="52" width="46" height="15" rx="3" fill="var(--color-bg)" stroke="var(--color-border)" />
      <text x="197" y="63" fill="var(--color-text-dim)" fontSize="9" fontFamily="var(--font-mono)" textAnchor="middle">
        1 LIVE
      </text>
      <text x="232" y="62" fill="var(--color-text-faint)" fontSize="11" fontFamily="var(--font-mono)">
        claude-opus-5
      </text>
      <text x="516" y="62" fill="var(--color-accent)" fontSize="10.5" fontFamily="var(--font-ui)">
        Probe ⟳
      </text>

      {/* Quota gauges */}
      <text x="42" y="86" fill="var(--color-text-faint)" fontSize="10" fontFamily="var(--font-mono)">5h</text>
      <rect x="62" y="79" width="130" height="7" rx="3.5" fill="var(--color-bg)" />
      <rect x="62" y="79" width="50" height="7" rx="3.5" fill="var(--state-ok)" />
      <text x="198" y="86" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-mono)">38% · 2h 20m</text>

      <text x="290" y="86" fill="var(--color-text-faint)" fontSize="10" fontFamily="var(--font-mono)">7d</text>
      <rect x="310" y="79" width="130" height="7" rx="3.5" fill="var(--color-bg)" />
      <rect x="310" y="79" width="79" height="7" rx="3.5" fill="var(--state-ok)" />
      <text x="446" y="86" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-mono)">61% · 3d 16h</text>

      {/* Roles */}
      <rect x="42" y="99" width="48" height="15" rx="3" fill="var(--color-bg)" stroke="var(--color-accent-dim)" />
      <text x="66" y="110" fill="var(--color-accent)" fontSize="9" fontFamily="var(--font-ui)" fontWeight="500" textAnchor="middle">✓ Work</text>
      <rect x="96" y="99" width="68" height="15" rx="3" fill="var(--color-bg)" stroke="var(--color-accent-dim)" />
      <text x="130" y="110" fill="var(--color-accent)" fontSize="9" fontFamily="var(--font-ui)" fontWeight="500" textAnchor="middle">✓ Judgment</text>
      <rect x="170" y="99" width="58" height="15" rx="3" fill="var(--color-bg)" stroke="var(--color-accent-dim)" />
      <text x="199" y="110" fill="var(--color-accent)" fontSize="9" fontFamily="var(--font-ui)" fontWeight="500" textAnchor="middle">✓ Grading</text>

      {/* Worker Card 2: Codex */}
      <rect x="24" y="130" width="552" height="76" rx="6" fill="var(--color-surface-2)" stroke="var(--color-border)" />
      <circle cx="42" cy="148" r="9" fill="#182522" stroke="#10a37f" strokeWidth="1.5" />
      <circle cx="42" cy="148" r="3.5" fill="none" stroke="#10a37f" strokeWidth="1.5" />
      <text x="58" y="152" fill="var(--color-text)" fontSize="12" fontFamily="var(--font-ui)" fontWeight="600">
        Codex · work
      </text>
      <text x="146" y="152" fill="var(--color-text-faint)" fontSize="11" fontFamily="var(--font-mono)">
        gpt-5.6-sol
      </text>

      <text x="42" y="174" fill="var(--color-text-faint)" fontSize="10" fontFamily="var(--font-mono)">5h</text>
      <rect x="62" y="167" width="130" height="7" rx="3.5" fill="var(--color-bg)" />
      <rect x="62" y="167" width="70" height="7" rx="3.5" fill="var(--state-ok)" />
      <text x="198" y="174" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-mono)">54% · 1h 02m</text>

      <rect x="42" y="186" width="48" height="14" rx="3" fill="var(--color-bg)" stroke="var(--color-accent-dim)" />
      <text x="66" y="197" fill="var(--color-accent)" fontSize="8.5" fontFamily="var(--font-ui)" fontWeight="500" textAnchor="middle">✓ Work</text>

      {/* Footer */}
      <text x="24" y="224" fill="var(--color-text-faint)" fontSize="10.5" fontFamily="var(--font-ui)">
        Credentials isolated per account in separate directories · Zero token usage probe
      </text>
    </svg>
  )
}

function TaskMockup(): React.JSX.Element {
  return (
    <svg viewBox="0 0 600 240" className="welcome-mockup-svg" aria-hidden="true">
      {/* Background */}
      <rect x="0" y="0" width="600" height="240" fill="var(--color-surface)" />

      {/* Window title bar */}
      <rect x="0" y="0" width="600" height="30" fill="var(--color-surface-2)" />
      <line x1="0" y1="30" x2="600" y2="30" stroke="var(--color-border)" strokeWidth="1" />
      <circle cx="16" cy="15" r="4" fill="var(--color-border-strong)" />
      <circle cx="28" cy="15" r="4" fill="var(--color-border-strong)" />
      <circle cx="40" cy="15" r="4" fill="var(--color-border-strong)" />
      <text x="56" y="19" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)" fontWeight="600">
        New task · storefront
      </text>

      {/* Task modes */}
      <rect x="24" y="38" width="80" height="20" rx="3" fill="var(--color-accent-dim)" stroke="var(--color-accent)" strokeWidth="1" />
      <text x="64" y="52" fill="var(--color-text)" fontSize="10" fontFamily="var(--font-ui)" fontWeight="600" textAnchor="middle">
        Single task
      </text>
      <rect x="110" y="38" width="80" height="20" rx="3" fill="var(--color-surface-2)" stroke="var(--color-border)" />
      <text x="150" y="52" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-ui)" textAnchor="middle">
        Plan &amp; Split
      </text>
      <rect x="196" y="38" width="64" height="20" rx="3" fill="var(--color-surface-2)" stroke="var(--color-border)" />
      <text x="228" y="52" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-ui)" textAnchor="middle">
        Debate
      </text>

      {/* Prompt textarea simulation */}
      <rect x="24" y="66" width="552" height="66" rx="6" fill="var(--color-bg)" stroke="var(--color-border-strong)" />
      <text x="36" y="88" fill="var(--color-text)" fontSize="12" fontFamily="var(--font-ui)">
        Add a "Recently viewed" strip to product pages, capped at 8 items.
      </text>
      <text x="36" y="108" fill="var(--color-text-dim)" fontSize="11.5" fontFamily="var(--font-ui)">
        Cover empty state and add vitest unit tests before landing.
      </text>
      <line x1="392" y1="97" x2="392" y2="110" stroke="var(--color-accent)" strokeWidth="2" />

      {/* Pills row */}
      <g transform="translate(24, 144)">
        {/* Priority */}
        <rect x="0" y="0" width="36" height="22" rx="11" fill="var(--color-surface-2)" stroke="var(--color-border)" />
        <text x="18" y="15" fill="var(--state-warn)" fontSize="10" fontFamily="var(--font-mono)" fontWeight="600" textAnchor="middle">P1</text>

        {/* Workspace */}
        <rect x="44" y="0" width="136" height="22" rx="11" fill="var(--color-surface-2)" stroke="var(--color-border)" />
        <text x="112" y="15" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-ui)" textAnchor="middle">⑂ worktree pool (ws1)</text>

        {/* Auto Worker */}
        <rect x="188" y="0" width="138" height="22" rx="11" fill="var(--color-surface-2)" stroke="var(--color-border)" />
        <text x="257" y="15" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-ui)" textAnchor="middle">⚡ Auto-routed worker</text>

        {/* Policy */}
        <rect x="334" y="0" width="136" height="22" rx="11" fill="var(--color-surface-2)" stroke="var(--color-border)" />
        <text x="402" y="15" fill="var(--color-text-dim)" fontSize="10" fontFamily="var(--font-ui)" textAnchor="middle">commit-and-merge</text>
      </g>

      {/* Footer */}
      <g transform="translate(24, 182)">
        <text x="0" y="18" fill="var(--color-text-faint)" fontSize="10.5" fontFamily="var(--font-ui)">
          Dispatches to dedicated branch with live narration &amp; cost tracking
        </text>
        <rect x="420" y="0" width="76" height="28" rx="4" fill="var(--color-surface-2)" stroke="var(--color-border)" />
        <text x="458" y="18" fill="var(--color-text-dim)" fontSize="11" fontFamily="var(--font-ui)" textAnchor="middle">Draft</text>
        <rect x="504" y="0" width="48" height="28" rx="4" fill="var(--color-accent)" />
        <text x="528" y="18" fill="#0e1013" fontSize="11" fontFamily="var(--font-ui)" fontWeight="600" textAnchor="middle">Send</text>
      </g>
    </svg>
  )
}

const STEPS = [
  {
    title: 'Add a project',
    body: 'Choose a repository. Warmstart inspects it first, then lets you confirm its worktree location, landing policy, checks, and orientation files.',
    mockup: <ProjectMockup />
  },
  {
    title: 'Add a worker',
    body: 'A worker is one agent account and its quota. Choose an installed agent CLI, create an isolated credential directory, and sign in through the vendor’s own flow.',
    mockup: <WorkerMockup />
  },
  {
    title: 'File a task',
    body: 'Describe the outcome, choose its project, and review the priority, dependencies, workspace, conversation, and finish policy. Warmstart gives the run its own branch and workspace.',
    mockup: <TaskMockup />
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
        <div className="welcome-mockup-frame">
          {current.mockup}
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
