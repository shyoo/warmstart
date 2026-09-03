import { useCallback, useEffect, useState } from 'react'
import {
  COMPLETION_LABELS,
  DEFAULT_FINISH_INSTRUCTION,
  DEFAULT_FLEET_COMPLETION,
  DEFAULT_FLEET_FINISH,
  DEFAULT_FLEET_SHARING,
  FINISH_LABELS,
  FINISH_ORDER,
  projectCompletionChoice,
  projectFinishChoice,
  projectSharingChoice,
  resolveCompletionMode,
  resolveFinishPolicy,
  resolveSessionSharing,
  SHARING_LABELS,
  verificationWarning,
  type CompletionModeChoice,
  type FinishPolicyChoice,
  type Project as ProjectRecord,
  type ProjectPolicyPatch,
  type ResourceAvailability,
  type SessionSharingChoice
} from '@shared/tasks'
import type { Settings } from '@shared/protocol'
import { rpc } from '../lib/daemon'
import { SettingButtonSelect, type SettingOption } from './SettingButtonSelect'
import { SettingRow } from './SettingRow'

/**
 * Everything about one project that is a *setting* rather than a task.
 *
 * ⛔ **What the project is comes first, then the policy it sets, then the commands that verify it.**
 * Until 2026-08-31 this page opened with Verification — a list of shell commands — and the project's
 * own identity was three panels down inside the fleet-wide project table, which also dragged in
 * every other project's row and the whole fleet's resource list. A page called *Project settings*
 * that showed other projects' rows was answering a question nobody on it had asked.
 *
 * ⛔ **Every tier that resolves as *task → project → fleet* is settable here.** It was readable and
 * unsettable before: `resolveFinishPolicy`, `resolveSessionSharing` and `resolveCompletionMode` have
 * always consulted the project, the task pane has always offered `inherit (…)`, and the middle tier
 * of all three could only be reached by hand-editing committed JSON. Writing it goes through
 * `project.setPolicy`, which patches the same keys in the same spellings that `project.json` already
 * uses — a project configured from here and one configured in an editor are the same file.
 */
export function ProjectSettings({
  project,
  resources,
  refreshProjects
}: {
  project: ProjectRecord
  resources: ResourceAvailability[]
  refreshProjects: () => Promise<void>
}): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // ⚠️ Read for one reason: to name what `inherit` currently means. A project page that says
    // "inherit" without saying *inherit what* makes somebody open a second page to find out.
    void rpc('settings.get')
      .then(setSettings)
      .catch(() => setSettings(null))
  }, [])

  const fleetFinish = settings?.finishPolicy ?? DEFAULT_FLEET_FINISH
  const fleetSharing = settings?.sessionSharing ?? DEFAULT_FLEET_SHARING

  const setPolicy = useCallback(
    async (patch: ProjectPolicyPatch): Promise<void> => {
      setError(null)
      try {
        await rpc('project.setPolicy', { id: project.id, ...patch })
        await refreshProjects()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        throw err
      }
    },
    [project.id, refreshProjects]
  )

  return (
    <div className="stack">
      <ProjectIdentity
        project={project}
        resources={resources}
        refreshProjects={refreshProjects}
        fleetFinish={fleetFinish}
      />
      {error && <div className="alert">{error}</div>}
      <PolicyPanel
        project={project}
        fleetFinish={fleetFinish}
        fleetSharing={fleetSharing}
        setPolicy={setPolicy}
      />
      <ChecksPanel project={project} fleetFinish={fleetFinish} />
      <ProjectResources project={project} resources={resources} />
    </div>
  )
}

/**
 * What this project *is*: where it lives, whether it has a repo, where its policy was read from, and
 * what that policy currently resolves to.
 *
 * ⚠️ The two actions belong here rather than under the settings they affect. `Reload` re-reads the
 * committed file — the answer to *somebody else changed project.json* — and `Write config` creates
 * the file the rest of this page writes into. Both are about the file, not about one setting in it.
 */
function ProjectIdentity({
  project,
  resources,
  refreshProjects,
  fleetFinish
}: {
  project: ProjectRecord
  resources: ResourceAvailability[]
  refreshProjects: () => Promise<void>
  fleetFinish: Settings['finishPolicy']
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const pool = resources.find((r) => r.resource.id === `workspace:${project.id}`)
  const landing = resolveFinishPolicy(null, project, fleetFinish)

  const act = async (call: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await call()
      await refreshProjects()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Project settings</h2>
          <p className="panel-sub">
            A directory plus policy. Git is optional — branching and parallel workspaces are
            capabilities a project declares, not assumptions this app makes.
          </p>
        </div>
        <div className="tbl-actions">
          <button
            className="btn btn--ghost"
            disabled={busy}
            title="Re-read .multi_agent_controller/project.json from disk."
            onClick={() => void act(() => rpc('project.reload', { id: project.id }))}
          >
            Reload
          </button>
          {!project.configPath && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              title="Write a starter .multi_agent_controller/project.json into the repository."
              onClick={() => void act(() => rpc('project.writeConfig', { id: project.id }))}
            >
              Write config
            </button>
          )}
        </div>
      </header>

      <table className="tbl">
        <thead>
          <tr>
            <th>Project</th>
            <th>VCS</th>
            <th>Config</th>
            <th>Landing</th>
            <th>Workspaces</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="tbl-strong">{project.name}</span>
              <div className="tbl-path mono" title={project.root}>
                {project.root}
              </div>
            </td>
            <td className="dim">{project.vcs}</td>
            <td>
              {project.configPath ? (
                <>
                  <span className="ok">committed</span>
                  <div className="tbl-path mono" title={project.configPath}>
                    {project.configPath}
                  </div>
                </>
              ) : (
                <>
                  <span className="dim">defaults</span>
                  <div className="tbl-path">nothing committed — this project runs on fleet defaults</div>
                </>
              )}
            </td>
            <td className="dim">
              {FINISH_LABELS[landing.policy]} →{' '}
              <span className="mono">{project.config.landing?.target ?? 'main'}</span>
              {landing.source !== 'project' && (
                <div className="tbl-path">inherited from the {landing.source}</div>
              )}
            </td>
            <td className="num">
              {pool ? `${pool.free}/${pool.resource.capacity} free` : 'not created yet'}
            </td>
          </tr>
        </tbody>
      </table>

      {!project.configPath && (
        <p className="note">
          ⚠️ Changing anything below <strong>creates</strong>{' '}
          <span className="mono">.multi_agent_controller/project.json</span> in this repository — the
          file is committed, so the policy travels with the repo rather than living in this install.
        </p>
      )}
    </div>
  )
}

/**
 * The middle tier: what this project decides, for every task in it that has not decided otherwise.
 *
 * ⛔ **`inherit` is an option, not the absence of one.** A project that deliberately follows the
 * fleet and one nobody has ever configured are the same to a resolver and different to a person, and
 * only the first should survive the fleet default changing later. Each row therefore says what the
 * value resolves to *and where that came from*, so nothing here is a setting whose origin is
 * invisible.
 */
function PolicyPanel({
  project,
  fleetFinish,
  fleetSharing,
  setPolicy
}: {
  project: ProjectRecord
  fleetFinish: Settings['finishPolicy']
  fleetSharing: Settings['sessionSharing']
  setPolicy: (patch: ProjectPolicyPatch) => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const apply = (patch: ProjectPolicyPatch): void => {
    setBusy(true)
    void setPolicy(patch)
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  const finishChoice = projectFinishChoice(project)
  const resolvedFinish = resolveFinishPolicy(null, project, fleetFinish)
  const sharingChoice = projectSharingChoice(project)
  const resolvedSharing = resolveSessionSharing(null, project, fleetSharing)
  const completionChoice = projectCompletionChoice(project)
  const resolvedCompletion = resolveCompletionMode(null, project, DEFAULT_FLEET_COMPLETION)

  const finishOptions: SettingOption[] = [
    { value: 'inherit', label: `inherit (${FINISH_LABELS[fleetFinish]})` },
    ...FINISH_ORDER.map((p) => ({ value: p, label: FINISH_LABELS[p] }))
  ]

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Policy</h2>
          <p className="panel-sub">
            Defaults for this project&rsquo;s tasks. A task may override them; <em>inherit</em> follows
            the fleet setting.
          </p>
        </div>
      </header>

      <div className="setting-list">
        <SettingRow
          title="Finish policy"
          description={`${FINISH_LABELS[resolvedFinish.policy]} — from the ${resolvedFinish.source}. Work that cannot land stays in Loose ends.`}
          control={
            <SettingButtonSelect
              className="finish-picker setting-row-control-select"
              value={finishChoice}
              options={finishOptions}
              disabled={busy}
              ariaLabel="Project finish policy"
              title="What happens to a task's work in this project when it is done."
              onChange={(val) => apply({ finish: val as FinishPolicyChoice })}
            />
          }
        />

        <TextPolicyRow
          title="Landing target"
          value={project.config.landing?.target ?? 'main'}
          placeholder="main"
          disabled={busy}
          ariaLabel="Landing target branch"
          onSave={(val) => apply({ landingTarget: val })}
          description={`New task branches start from ${project.config.landing?.target ?? 'main'}; existing branches do not move.`}
        />

        {resolvedFinish.policy === 'custom' && (
          <TextPolicyRow
            title="Custom finish instruction"
            value={project.config.landing?.finishInstruction ?? ''}
            placeholder={DEFAULT_FINISH_INSTRUCTION}
            multiline
            disabled={busy}
            ariaLabel="Custom finish instruction"
            onSave={(val) => apply({ finishInstruction: val })}
            description={
              project.config.landing?.finishInstruction
                ? 'The instruction sent to the agent when it finishes.'
                : 'Empty uses the default instruction.'
            }
          />
        )}

        <SettingRow
          title="Session sharing"
          description={`${SHARING_LABELS[resolvedSharing.sharing]} — from the ${resolvedSharing.source}. Reused context is visible to the task.`}
          control={
            <SettingButtonSelect
              className="finish-picker setting-row-control-select"
              value={sharingChoice}
              options={[
                { value: 'inherit', label: `inherit (${SHARING_LABELS[fleetSharing]})` },
                { value: 'on', label: SHARING_LABELS.on },
                { value: 'off', label: SHARING_LABELS.off }
              ]}
              disabled={busy}
              ariaLabel="Project session sharing"
              title="May a task in this project join a conversation another task here already has open?"
              onChange={(val) => apply({ sessionShare: val as SessionSharingChoice })}
            />
          }
        />

        <SettingRow
          title="Completion mode"
          description={`${COMPLETION_LABELS[resolvedCompletion.mode]} — from the ${resolvedCompletion.source}. Tasks still ask when they need direction.`}
          control={
            <SettingButtonSelect
              className="finish-picker setting-row-control-select"
              value={completionChoice}
              options={[
                { value: 'inherit', label: `inherit (${COMPLETION_LABELS[DEFAULT_FLEET_COMPLETION]})` },
                { value: 'autonomous', label: COMPLETION_LABELS.autonomous },
                { value: 'checkpointed', label: COMPLETION_LABELS.checkpointed }
              ]}
              disabled={busy}
              ariaLabel="Project completion mode"
              title="How far an agent working in this project goes before it stops."
              onChange={(val) => apply({ completion: val as CompletionModeChoice })}
            />
          }
        />

        <SettingRow
          title="Workspace pool"
          description={
            project.vcs === 'git'
              ? `${project.config.workspaces?.poolSize ?? 3} parallel worktree${(project.config.workspaces?.poolSize ?? 3) === 1 ? '' : 's'}. A full pool holds new tasks.`
              : 'One workspace — this project has no repository.'
          }
          control={
            <input
              className="num-input"
              type="number"
              min={1}
              max={32}
              disabled={busy || project.vcs !== 'git'}
              aria-label="Workspace pool size"
              defaultValue={project.config.workspaces?.poolSize ?? 3}
              key={project.config.workspaces?.poolSize ?? 3}
              onBlur={(e) => {
                const next = Number(e.target.value)
                if (Number.isFinite(next) && next !== (project.config.workspaces?.poolSize ?? 3)) {
                  apply({ poolSize: next })
                }
              }}
            />
          }
        />
      </div>
    </div>
  )
}

/**
 * A setting whose value is typed rather than chosen.
 *
 * ⚠️ Saved on a button, never on every keystroke: each save rewrites a **committed file**, and a
 * branch name half-typed is a branch name that does not exist.
 */
function TextPolicyRow({
  title,
  value,
  placeholder,
  description,
  disabled,
  ariaLabel,
  multiline,
  onSave
}: {
  title: string
  value: string
  placeholder: string
  description: string
  disabled: boolean
  ariaLabel: string
  multiline?: boolean
  onSave: (value: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const dirty = text.trim() !== value.trim()

  return (
    <SettingRow
      title={title}
      description={description}
      control={
        <div className="project-setting-text-control">
          {multiline ? (
            <textarea
              className="text-input project-setting-textarea"
              rows={4}
              value={text}
              placeholder={placeholder}
              disabled={disabled}
              aria-label={ariaLabel}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <input
              className="text-input"
              value={text}
              placeholder={placeholder}
              disabled={disabled}
              aria-label={ariaLabel}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <button
            className="btn btn--primary"
            disabled={disabled || !dirty}
            onClick={() => onSave(text)}
          >
            Save
          </button>
        </div>
      }
    />
  )
}

/**
 * The commands that decide whether work is verified.
 *
 * ⛔ **This list is what the verifying finish policies are trusting.** `commit-and-verify` and
 * `commit-and-merge` say the work was checked; what they actually did was run these, in this order,
 * stopping at the first failure. An empty list means they verified nothing — which is every project
 * on its first day — so the emptiness is stated here rather than left to be discovered when a policy
 * called something verified.
 *
 * ⚠️ One command per line, because that is what it is: an ordered list of shell commands, and the
 * cheap ones belong first so a red one stops the run before the slow ones start.
 */
function ChecksPanel({
  project,
  fleetFinish
}: {
  project: ProjectRecord
  fleetFinish: Settings['finishPolicy']
}): React.JSX.Element {
  // ⚠️ Joined once and depended on as a string. The array identity changes on every refresh of an
  // unchanged project, so depending on the array would reset the box under somebody mid-edit.
  const declaredText = (project.config?.check ?? []).join('\n')
  const declared = declaredText ? declaredText.split('\n') : []
  const [text, setText] = useState(declaredText)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [suggested, setSuggested] = useState<string[]>([])

  useEffect(() => setText(declaredText), [declaredText])
  useEffect(() => {
    void rpc('project.proposeChecks', { id: project.id })
      .then((r) => setSuggested(r.checks))
      .catch(() => setSuggested([]))
  }, [project.id])

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const dirty = lines.join('\n') !== declared.join('\n')
  // ⛔ Asked of the policy this project actually resolves to, not of the fleet's. A project that has
  // overridden its finish policy to `commit-only` is not verifying anything and is not lying about
  // it, and warning it about an empty list would be noise.
  const warning = verificationWarning(resolveFinishPolicy(null, project, fleetFinish).policy, declared.length)

  const save = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await rpc('project.setChecks', { id: project.id, checks: lines })
      setNote(`Saved ${lines.length} command(s) to project.json.`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // ⛔ A task, not an edit. An agent working out what a project's checks should be is ordinary work
  // with a reviewable diff; an agent quietly rewriting the gate that decides whether its own work is
  // verified is not. The button files the first and can never do the second.
  const fileTask = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const task = await rpc('task.create', {
        title: `Work out the check commands for ${project.name}`,
        projectId: project.id,
        prompt:
          'Work out which commands should verify this project before work is landed, and write them ' +
          'into `.multi_agent_controller/project.json` under `check`, as an ordered array of shell ' +
          'commands. Cheap and fast ones first, so a failure stops the run early. They must exit ' +
          'non-zero on failure and must not need a network or an interactive terminal. ' +
          `Currently declared: ${declared.length > 0 ? declared.join(', ') : 'nothing'}. ` +
          'Do not weaken or remove an existing check without saying why in the commit message.'
      })
      setNote(`Filed as t${task.seq}.`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel checks-panel">
      <header className="panel-head">
        <div>
          <h2>Verification</h2>
          <p className="panel-sub">
            Run in the task&rsquo;s workspace after the agent commits, in this order, stopping at the
            first failure. A failure rests the task with the output; nothing is merged.
          </p>
        </div>
      </header>
      {warning && <p className="warn">{warning}</p>}
      <textarea
        className="text-input checks-input"
        rows={Math.max(4, lines.length + 1)}
        value={text}
        disabled={busy}
        spellCheck={false}
        placeholder="npm run typecheck&#10;npm run lint&#10;npm test"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="checks-actions">
        <button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save to project.json'}
        </button>
        {suggested.length > 0 && (
          <button
            className="btn btn--ghost"
            disabled={busy || suggested.join('\n') === lines.join('\n')}
            title={`Suggested from this project’s package.json: ${suggested.join(', ')}`}
            onClick={() => setText(suggested.join('\n'))}
          >
            Use suggested ({suggested.length})
          </button>
        )}
        <button
          className="btn btn--ghost"
          disabled={busy}
          title="Files an ordinary task. The agent proposes the list as a commit you review — it never edits this in place."
          onClick={() => void fileTask()}
        >
          File a task to work them out
        </button>
      </div>
      {note && <p className="note">{note}</p>}
    </div>
  )
}

/**
 * What this project contends for.
 *
 * ⛔ **This project's, not the fleet's.** The page used to end with every resource in the install —
 * a browser profile belonging to another project, another project's landing lock — under a heading
 * that explained the concept and not the rows. The fleet-wide table still exists, on Settings ›
 * Global, where a fleet-wide list belongs.
 *
 * ⚠️ Shown because it is the answer to *why has nothing started yet*: a task whose project has no
 * free workspace is **held**, not failed, and a held task looks identical to an idle one until you
 * can see that the pool is full.
 */
function ProjectResources({
  project,
  resources
}: {
  project: ProjectRecord
  resources: ResourceAvailability[]
}): React.JSX.Element | null {
  const mine = resources.filter((r) => r.resource.projectId === project.id)
  if (mine.length === 0) return null

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>What this project contends for</h2>
          <p className="panel-sub">
            The scheduler hands these out rather than letting runs lock against each other. A task
            that cannot get one waits — it is never failed for want of a workspace.
          </p>
        </div>
      </header>
      <table className="tbl">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Kind</th>
            <th>Free</th>
            <th>Held by</th>
          </tr>
        </thead>
        <tbody>
          {mine.map((r) => (
            <tr key={r.resource.id}>
              <td>
                <span className="tbl-strong">{r.resource.label}</span>
                <div className="tbl-path mono">{r.resource.id}</div>
              </td>
              <td className="dim">{r.resource.kind}</td>
              <td className="num">
                {r.free}/{r.resource.capacity}
              </td>
              <td className="dim">
                {r.inUse === 0
                  ? 'nothing'
                  : r.claims
                      .filter((c) => c.releasedAt === null)
                      .map((c) => c.holder)
                      .join(', ') || `${r.inUse} in use`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
