import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMPLETION_LABELS,
  DEFAULT_FLEET_COMPLETION,
  DEFAULT_FLEET_FINISH,
  DEFAULT_FLEET_SHARING,
  FINISH_LABELS,
  FINISH_ORDER,
  SHARING_LABELS,
  verificationWarning,
  type CompletionModeChoice,
  type FinishPolicyChoice,
  type Project,
  type ProjectInspection,
  type ScaffoldingGitChoice,
  type SessionSharingChoice
} from '@shared/tasks'
import type { Settings } from '@shared/protocol'
import { rpc } from '../lib/daemon'
import { SettingButtonSelect, type SettingOption } from './SettingButtonSelect'
import { SettingRow } from './SettingRow'
import {
  checksFromText,
  creationPlan,
  docSignature,
  EMPTY_DRAFT,
  NEW_PROJECT_STEPS,
  stepBlockers,
  STEP_TITLES,
  willHaveRepo,
  type DocDraftState,
  type NewProjectDraft,
  type NewProjectStep
} from '../lib/newproject'
import { errorMessage } from '@shared/errors.js'
import { useIsRemote, useTarget } from '../lib/target'

/**
 * Adding a project, as a setup step.
 *
 * ⛔ **It replaced a text box.** Until this existed the only way to add a project was to paste an
 * absolute path into a field on Settings › Global, whose entire validation was that the directory
 * existed — so the workspace directory, all five policies and the check list were things you found
 * out about afterwards, on three different screens, if you knew to look. Every field here already
 * had a writer; what was missing was a place that asks the questions in the order somebody setting
 * up a project actually has them.
 *
 * ⛔ **Three steps, and the third is the one that writes.** Nothing touches the disk until Create:
 * `project.inspect` and `project.docTemplates` are read-only, and `project.create` does the whole
 * sequence in the daemon so a half-registered project is not a state this can produce.
 *
 * ⚠️ **The directory picker is the OS picker.** `window.agentyard.pickFolders()` is the same bridge
 * the composer's *Add folder* uses; typing a path still works, because a path pasted from a terminal
 * is how half of these will be added.
 */
export function NewProject({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (project: Project) => void
}): React.JSX.Element {
  const [step, setStep] = useState<NewProjectStep>('directory')
  const [draft, setDraft] = useState<NewProjectDraft>(EMPTY_DRAFT)
  const [inspection, setInspection] = useState<ProjectInspection | null>(null)
  const [inspectError, setInspectError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  const patch = useCallback((next: Partial<NewProjectDraft>) => {
    setDraft((current) => ({ ...current, ...next }))
  }, [])

  // ⚠️ Read for one reason: to name what `inherit` currently means, exactly as ProjectSettings does.
  // A wizard that offers "inherit" without saying inherit *what* makes somebody open another screen.
  useEffect(() => {
    void rpc('settings.get')
      .then(setSettings)
      .catch(() => setSettings(null))
  }, [])

  // Escape closes — the dialog listens on every render of `onClose` since a parent re-render can
  // hand it a new closure, but must not itself re-fire the effect below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The dialog takes focus once, when it opens — it is modal, so the keyboard has to be inside it
  // or the sidebar behind it still answers arrow keys. ⛔ Deliberately mount-only: the wizard's own
  // state (and an `onClose` a re-rendering parent hands it fresh) must never steal focus back from
  // whatever field the operator is typing in.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  /**
   * Ask the daemon what is in there.
   *
   * ⚠️ Debounced, because it runs while somebody types a path and each call does a `git rev-parse`.
   * ⛔ The *last* answer wins rather than the last to arrive: a slow inspection of a half-typed path
   * must not overwrite the answer for the path that is now in the box.
   */
  const inspectSeq = useRef(0)
  useEffect(() => {
    const root = draft.root.trim()
    if (!root) {
      setInspection(null)
      setInspectError(null)
      return
    }
    const seq = ++inspectSeq.current
    const timer = setTimeout(() => {
      void rpc('project.inspect', { root, workspaceRoot: draft.workspaceRoot.trim() || undefined })
        .then((result) => {
          if (seq !== inspectSeq.current) return
          setInspection(result)
          setInspectError(null)
        })
        .catch((err: unknown) => {
          if (seq !== inspectSeq.current) return
          setInspection(null)
          setInspectError(errorMessage(err))
        })
    }, 200)
    return () => clearTimeout(timer)
  }, [draft.root, draft.workspaceRoot])

  /**
   * Fill in the answers the directory itself gives, once, when a new directory is inspected.
   *
   * ⛔ Keyed on the inspected root so it never fights the operator: re-inspecting the *same*
   * directory (because the workspace field changed) must not throw away a name they retyped.
   */
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!inspection || seededFor.current === inspection.root) return
    seededFor.current = inspection.root
    setDraft((current) => ({
      ...current,
      name: inspection.suggestedName,
      // ⚠️ Offered, not assumed, and only where it is the obvious answer: an *empty* directory with
      // no repository is a project that would otherwise get one workspace and no branches, which is
      // almost never what somebody adding an empty project meant. Anything else starts unticked.
      gitInit: inspection.vcs !== 'git' && inspection.empty,
      landingTarget: inspection.config?.landing?.target ?? current.landingTarget,
      finish: inspection.config?.landing?.finish ?? current.finish,
      sessionShare: inspection.config?.session?.share ?? current.sessionShare,
      completion: inspection.config?.session?.completion ?? current.completion,
      poolSize: inspection.config?.workspaces?.poolSize ?? current.poolSize,
      // ⚠️ What the repo already declared beats what the manifests suggest. A committed check list is
      // a decision; a proposal is a guess about a project nobody has run.
      checksText: (inspection.config?.check ?? inspection.proposedChecks).join('\n')
    }))
  }, [inspection])

  /**
   * The starter files, fetched when the review step opens so they carry the final name, branch and
   * check list.
   *
   * ⛔ **Regenerated when those change, and never over text somebody typed.** Going Back to rename
   * the project or change the landing target has to leave the templates agreeing with it — they
   * quote both — but a doc the operator has edited is theirs, and rewriting it would discard their
   * work with no undo. `edited` is what separates the two.
   */
  const docsFrom = useRef<string | null>(null)
  const loadDocs = useCallback(async (): Promise<void> => {
    if (!inspection) return
    const signature = docSignature({
      name: draft.name,
      landingTarget: draft.landingTarget,
      checksText: draft.checksText
    })
    if (docsFrom.current === signature) return
    try {
      const { docs } = await rpc('project.docTemplates', {
        root: inspection.root,
        name: draft.name,
        checks: checksFromText(draft.checksText),
        landingTarget: draft.landingTarget
      })
      docsFrom.current = signature
      setDraft((current) => ({
        ...current,
        docs: docs.map<DocDraftState>((doc) => {
          const existing = current.docs.find((d) => d.name === doc.name)
          if (existing?.edited) return existing
          return {
            name: doc.name,
            include: existing?.include ?? true,
            content: doc.content,
            edited: false
          }
        })
      }))
    } catch (err) {
      // ⚠️ Not fatal and not a blocker: the project can be created without a scaffold, so this says
      // so and leaves the step usable.
      setWarnings([`could not build the starter files: ${errorMessage(err)}`])
    }
  }, [inspection, draft.name, draft.checksText, draft.landingTarget])

  const blockers = stepBlockers(step, draft, inspection)
  const index = NEW_PROJECT_STEPS.indexOf(step)

  const goNext = (): void => {
    if (blockers.length > 0) return
    const next = NEW_PROJECT_STEPS[index + 1]
    if (!next) return
    setStep(next)
    if (next === 'review') void loadDocs()
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setWarnings([])
    try {
      const result = await rpc('project.create', {
        root: draft.root.trim(),
        name: draft.name.trim(),
        createDirectory: draft.createDirectory,
        gitInit: draft.gitInit,
        workspaceRoot: draft.workspaceRoot.trim(),
        policy: {
          finish: draft.finish,
          landingTarget: draft.landingTarget.trim(),
          sessionShare: draft.sessionShare,
          completion: draft.completion,
          poolSize: draft.poolSize
        },
        checks: checksFromText(draft.checksText),
        docs: draft.docs
          .filter((d) => d.include)
          .map((d) => ({ name: d.name, content: d.content })),
        scaffoldingGit: draft.scaffoldingGit
      })
      if (result.warnings.length > 0) {
        // ⛔ Shown, and the wizard stays open. The project exists — closing over a list of things
        // that did not happen is how somebody never finds out their AGENTS.md was skipped.
        setWarnings(result.warnings)
        setBusy(false)
        return
      }
      onCreated(result.project)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const created = warnings.length > 0 && step === 'review' && !busy

  return (
    <div className="confirm-shade" role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
      >
        <header className="wizard-head">
          <div>
            <h3 id="new-project-title">Add a project</h3>
            <p className="wizard-sub">
              Configure project settings and workspace policies. Settings are saved to{' '}
              <span className="mono">.warmstart/project.json</span> in the project root.
            </p>
          </div>
          <button className="btn btn--ghost" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <ol className="wizard-steps">
          {NEW_PROJECT_STEPS.map((s, i) => (
            <li
              key={s}
              className={`wizard-step ${s === step ? 'wizard-step--active' : ''} ${i < index ? 'wizard-step--done' : ''}`}
              aria-current={s === step ? 'step' : undefined}
            >
              <span className="wizard-step-num num">{i + 1}</span>
              <span>{STEP_TITLES[s]}</span>
            </li>
          ))}
        </ol>

        <div className="wizard-body">
          {step === 'directory' && (
            <DirectoryStep
              draft={draft}
              patch={patch}
              inspection={inspection}
              inspectError={inspectError}
            />
          )}
          {step === 'setup' && (
            <SetupStep draft={draft} patch={patch} inspection={inspection} settings={settings} />
          )}
          {step === 'review' && (
            <ReviewStep draft={draft} patch={patch} inspection={inspection} />
          )}
        </div>

        {error && <div className="alert">{error}</div>}
        {warnings.length > 0 && (
          <div className="wizard-warnings">
            <p className="warn">
              {created
                ? 'The project was created, but not everything was done:'
                : 'Not everything could be done:'}
            </p>
            <ul>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <footer className="wizard-foot">
          <div className="wizard-blockers">
            {blockers.map((b) => (
              <p key={b} className="warn">
                {b}
              </p>
            ))}
          </div>
          <div className="confirm-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            {index > 0 && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => setStep(NEW_PROJECT_STEPS[index - 1] ?? 'directory')}
              >
                Back
              </button>
            )}
            {step === 'review' ? (
              <button
                className="btn btn--primary"
                disabled={busy || blockers.length > 0}
                onClick={() => void create()}
              >
                {busy ? 'Creating…' : 'Create project'}
              </button>
            ) : (
              <button className="btn btn--primary" disabled={blockers.length > 0} onClick={goNext}>
                Next
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

/** A path field with the OS picker beside it. ⚠️ Typing still works — a pasted path is half of these. */
export function PathField({
  label,
  value,
  placeholder,
  onChange,
  disabled
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const { active } = useTarget()
  const remote = useIsRemote()
  const pick = async (): Promise<void> => {
    // ⚠️ The picker is multi-select because one bridge serves both callers; a project has one
    // directory, so the first is the answer and the rest are ignored.
    const picked = await window.agentyard.pickFolders()
    const first = picked[0]
    if (first) onChange(first)
  }

  return (
    <div className="wizard-field">
      <label className="wizard-label">{label}</label>
      <div className="wizard-path">
        <input
          className="text-input mono"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
        {/* ⛔ The OS picker browses *this* computer's disk; on a remote fleet the path must be typed. */}
        {!remote && (
          <button className="btn" disabled={disabled} onClick={() => void pick()}>
            Choose…
          </button>
        )}
      </div>
      {remote && <p className="dim">A path on {active.label}, not on this computer.</p>}
    </div>
  )
}

function Checkbox({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="wizard-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="wizard-check-label">{label}</span>
        {hint && <span className="wizard-check-hint">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * Step one: which directory, and what is in it.
 *
 * ⛔ The findings are the point of the step. *Already a project*, *no repository*, *no README* and
 * *nothing here at all* are four different situations with four different next moves, and none of
 * them was visible from the text box this replaced.
 */
function DirectoryStep({
  draft,
  patch,
  inspection,
  inspectError
}: {
  draft: NewProjectDraft
  patch: (next: Partial<NewProjectDraft>) => void
  inspection: ProjectInspection | null
  inspectError: string | null
}): React.JSX.Element {
  const missingDocs = inspection
    ? Object.entries(inspection.docs)
        .filter(([, present]) => !present)
        .map(([name]) => name)
    : []

  return (
    <div className="stack">
      <PathField
        label="Project directory"
        value={draft.root}
        placeholder="Path to project root directory"
        onChange={(root) => patch({ root })}
      />

      {inspectError && <div className="alert">{inspectError}</div>}

      {inspection && (
        <div className="wizard-findings">
          <h4>Directory inspection</h4>
          <dl className="wizard-facts">
            <div>
              <dt>Path</dt>
              <dd className="mono">{inspection.root}</dd>
            </div>
            <div>
              <dt>Directory</dt>
              <dd>
                {!inspection.exists ? (
                  <span className="warn">does not exist yet</span>
                ) : !inspection.isDirectory ? (
                  <span className="warn">a file, not a directory</span>
                ) : inspection.empty ? (
                  'Empty directory'
                ) : (
                  'Existing files detected'
                )}
              </dd>
            </div>
            <div>
              <dt>Repository</dt>
              <dd>{inspection.vcs === 'git' ? <span className="ok">git</span> : <span className="dim">none</span>}</dd>
            </div>
            <div>
              <dt>Stack</dt>
              <dd className="dim">
                {inspection.stack.length > 0 ? inspection.stack.join(', ') : 'not detected'}
              </dd>
            </div>
            <div>
              <dt>Config</dt>
              <dd>
                {inspection.hasConfig ? (
                  <span className="ok">Found existing project.json</span>
                ) : (
                  <span className="dim">Not found — will create .warmstart/project.json</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Orientation docs</dt>
              <dd className="dim">
                {missingDocs.length === 0
                  ? 'All standard project docs present (README.md, AGENTS.md, HANDOFF.md)'
                  : `missing ${missingDocs.join(', ')}`}
              </dd>
            </div>
          </dl>

          {inspection.alreadyAdded && (
            <p className="warn">
              This directory is already registered as project &ldquo;{inspection.alreadyAdded.name}&rdquo;. Select it from the sidebar to modify settings.
            </p>
          )}

          {!inspection.exists && (
            <Checkbox
              label="Create it"
              hint="Directory does not exist. Check to create it."
              checked={draft.createDirectory}
              onChange={(createDirectory) => patch({ createDirectory })}
            />
          )}

          {inspection.vcs !== 'git' && (
            <Checkbox
              label="Initialise a git repository"
              hint="Initializes a git repository for worktree branching and landing."
              checked={draft.gitInit}
              onChange={(gitInit) => patch({ gitInit })}
            />
          )}
        </div>
      )}

      <div className="wizard-field">
        <label className="wizard-label" htmlFor="new-project-name">
          Name
        </label>
        <input
          id="new-project-name"
          className="text-input"
          value={draft.name}
          placeholder="Project display name"
          aria-label="Project name"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>
    </div>
  )
}

/** Step two: where the worktrees go, how tasks finish, and what verifies them. */
function SetupStep({
  draft,
  patch,
  inspection,
  settings
}: {
  draft: NewProjectDraft
  patch: (next: Partial<NewProjectDraft>) => void
  inspection: ProjectInspection | null
  settings: Settings | null
}): React.JSX.Element {
  const fleetFinish = settings?.finishPolicy ?? DEFAULT_FLEET_FINISH
  const fleetSharing = settings?.sessionSharing ?? DEFAULT_FLEET_SHARING
  const workspace = inspection?.workspace ?? null
  const repo = willHaveRepo(inspection, draft)
  const checks = checksFromText(draft.checksText)
  const suggested = inspection?.proposedChecks ?? []

  const finishOptions: SettingOption[] = [
    { value: 'inherit', label: `inherit (${FINISH_LABELS[fleetFinish]})` },
    ...FINISH_ORDER.map((p) => ({ value: p, label: FINISH_LABELS[p] }))
  ]

  return (
    <div className="stack">
      <div className="wizard-section">
        <h4>Workspace directory</h4>
        <p className="wizard-sub">
          Directory where isolated git worktrees are stored for parallel task execution.
        </p>
        <PathField
          label="Workspace directory"
          value={draft.workspaceRoot}
          placeholder={workspace?.path ?? 'Default: ../<project>_workspaces'}
          onChange={(workspaceRoot) => patch({ workspaceRoot })}
        />
        {workspace && (
          <p className={workspace.usable ? 'note' : 'warn'}>
            <span className="mono">{workspace.path}</span>
            {' — '}
            {workspace.state === 'free' && 'Directory does not exist yet; will be created when first task runs.'}
            {workspace.state === 'empty' && 'Directory exists and is empty.'}
            {workspace.state !== 'free' && workspace.state !== 'empty' && workspace.note}
            {draft.workspaceRoot.trim() && workspace.relative && (
              <>
                {' '}
                Recorded in project.json as <span className="mono">{workspace.relative}</span>.
              </>
            )}
          </p>
        )}
      </div>

      <div className="wizard-section">
        <h4>Policy</h4>
        <p className="wizard-sub">
          Default policies for tasks in this project. Can be overridden per task or updated in Project Settings.
        </p>
        <div className="setting-list">
          <SettingRow
            title="Finish policy"
            description="Action taken upon task completion. Unmerged work remains in Loose Ends."
            control={
              <SettingButtonSelect
                className="finish-picker setting-row-control-select"
                value={draft.finish}
                options={finishOptions}
                ariaLabel="Project finish policy"
                onChange={(val) => patch({ finish: val as FinishPolicyChoice })}
              />
            }
          />
          <SettingRow
            title="Landing target"
            description={
              repo
                ? `Base branch for new tasks, landing changes against origin/${draft.landingTarget.trim() || 'main'}.`
                : 'Target git branch for landings once a repository is initialized.'
            }
            control={
              <input
                className="text-input"
                value={draft.landingTarget}
                placeholder="main"
                aria-label="Landing target branch"
                onChange={(e) => patch({ landingTarget: e.target.value })}
              />
            }
          />
          <SettingRow
            title="Session sharing"
            description="Allow tasks to reuse existing conversation sessions in this project to save tokens."
            control={
              <SettingButtonSelect
                className="finish-picker setting-row-control-select"
                value={draft.sessionShare}
                options={[
                  { value: 'inherit', label: `inherit (${SHARING_LABELS[fleetSharing]})` },
                  { value: 'on', label: SHARING_LABELS.on },
                  { value: 'off', label: SHARING_LABELS.off }
                ]}
                ariaLabel="Project session sharing"
                onChange={(val) => patch({ sessionShare: val as SessionSharingChoice })}
              />
            }
          />
          <SettingRow
            title="Completion mode"
            description="Determines whether tasks run autonomously to completion or pause at checkpoints."
            control={
              <SettingButtonSelect
                className="finish-picker setting-row-control-select"
                value={draft.completion}
                options={[
                  {
                    value: 'inherit',
                    label: `inherit (${COMPLETION_LABELS[DEFAULT_FLEET_COMPLETION]})`
                  },
                  { value: 'autonomous', label: COMPLETION_LABELS.autonomous },
                  { value: 'checkpointed', label: COMPLETION_LABELS.checkpointed }
                ]}
                ariaLabel="Project completion mode"
                onChange={(val) => patch({ completion: val as CompletionModeChoice })}
              />
            }
          />
          <SettingRow
            title="Workspace pool"
            description={
              repo
                ? `Maximum concurrent task workspaces (${draft.poolSize}). Additional tasks wait in queue.`
                : 'Requires a git repository to support concurrent worktree workspaces.'
            }
            control={
              <input
                className="num-input"
                type="number"
                min={1}
                max={32}
                disabled={!repo}
                aria-label="Workspace pool size"
                value={repo ? draft.poolSize : 1}
                onChange={(e) => patch({ poolSize: Math.trunc(Number(e.target.value)) })}
              />
            }
          />
        </div>
      </div>

      <div className="wizard-section">
        <h4>Verification</h4>
        <p className="wizard-sub">
          Commands executed in the workspace after agent commits. Executes line by line, stopping on first error.
        </p>
        {verificationWarning(
          draft.finish === 'inherit' ? fleetFinish : draft.finish,
          checks.length
        ) && (
          <p className="warn">
            {verificationWarning(draft.finish === 'inherit' ? fleetFinish : draft.finish, checks.length)}
          </p>
        )}
        <textarea
          className="text-input checks-input"
          rows={Math.max(3, checks.length + 1)}
          value={draft.checksText}
          spellCheck={false}
          aria-label="Check commands"
          placeholder="npm run typecheck&#10;npm run lint&#10;npm test"
          onChange={(e) => patch({ checksText: e.target.value })}
        />
        {suggested.length > 0 && (
          <button
            className="btn btn--ghost"
            disabled={suggested.join('\n') === checks.join('\n')}
            title={`Detected from project manifests: ${suggested.join(', ')}`}
            onClick={() => patch({ checksText: suggested.join('\n') })}
          >
            Use suggested ({suggested.length})
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Step three: the starter files, and exactly what Create will write.
 *
 * ⛔ **The templates are editable and nothing in them is invented.** The tool has read a manifest and
 * a directory listing; every line that would need to be *learned* about the project is a marked TODO,
 * because a confident paragraph about a codebase nobody read is worse than a blank one.
 */
function ReviewStep({
  draft,
  patch,
  inspection
}: {
  draft: NewProjectDraft
  patch: (next: Partial<NewProjectDraft>) => void
  inspection: ProjectInspection | null
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const plan = creationPlan(draft, inspection)

  const setDoc = (name: string, next: Partial<DocDraftState>): void => {
    patch({ docs: draft.docs.map((d) => (d.name === name ? { ...d, ...next } : d)) })
  }

  return (
    <div className="stack">
      <div className="wizard-section">
        <h4>Starter files</h4>
        {draft.docs.length === 0 ? (
          <p className="dim">
            Standard documentation files (README.md, AGENTS.md, HANDOFF.md) already exist and will not be overwritten.
          </p>
        ) : (
          <>
            <p className="wizard-sub">
              Scaffold standard project documentation files: <strong>README.md</strong> (overview and setup), <strong>AGENTS.md</strong> (agent guidelines and architecture invariants), and <strong>HANDOFF.md</strong> (current progress and next steps).
            </p>
            {draft.docs.map((doc) => (
              <div key={doc.name} className="wizard-doc">
                <div className="wizard-doc-head">
                  <Checkbox
                    label={doc.name}
                    checked={doc.include}
                    onChange={(include) => setDoc(doc.name, { include })}
                  />
                  <button
                    className="btn btn--ghost"
                    onClick={() => setOpen(open === doc.name ? null : doc.name)}
                  >
                    {open === doc.name ? 'Hide' : 'Edit'}
                  </button>
                </div>
                {open === doc.name && (
                  <textarea
                    className="text-input wizard-doc-text mono"
                    rows={16}
                    spellCheck={false}
                    value={doc.content}
                    aria-label={`${doc.name} content`}
                    onChange={(e) => setDoc(doc.name, { content: e.target.value, edited: true })}
                  />
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="wizard-section">
        <h4>project.json in git</h4>
        <p className="wizard-sub">
          Committed policy travels to every clone; an ignored config stays local to this checkout.
          Either way the trunk starts clean — nothing here happens silently.
        </p>
        <div className="setting-list">
          <SettingRow
            title="project.json"
            description="Commit it with the scaffolding, or leave it untracked behind a committed .gitignore entry."
            control={
              <SettingButtonSelect
                className="setting-row-control-select"
                value={draft.scaffoldingGit}
                options={[
                  { value: 'commit', label: 'Commit' },
                  { value: 'ignore', label: 'Ignore' }
                ]}
                ariaLabel="project.json in git"
                onChange={(val) => patch({ scaffoldingGit: val as ScaffoldingGitChoice })}
              />
            }
          />
        </div>
      </div>

      <div className="wizard-section">
        <h4>Actions on create</h4>
        <ol className="wizard-plan">
          {plan.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </div>
    </div>
  )
}
