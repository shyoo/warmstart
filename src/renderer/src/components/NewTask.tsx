import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FinishPolicyChoice,
  Project,
  SessionSharingChoice,
  Task
} from '@shared/tasks'
import {
  FINISH_LABELS,
  FINISH_ORDER,
  FINISH_SHORT,
  SHARING_LABELS,
  SHARING_SHORT,
  resolveFinishPolicy,
  resolveModelChoice,
  resolveSessionSharing
} from '@shared/tasks'
import type { ModelOptions, Settings } from '@shared/protocol'
import { ImageChips, usePastedImages } from '../lib/pasteimages.js'
import { rpc, type FleetEntry } from '../lib/daemon'
import { isSubmitKey, useUiSettings } from '../lib/uisettings'
import { candidatesFor, useTaskCandidates } from './Dependencies'
import { effortLabel, modelLabel } from '../lib/modelname'
import { taskLabelShort } from '../lib/taskview'
import { Pill, PillOptions, PillSelect, type PillOption } from './Pill'
import {
  MAX_PIECES,
  MIN_PIECES,
  modelChoiceFor,
  readComposerPrefs,
  rememberModelChoice,
  writeComposerPrefs,
  type ComposerKind,
  type ComposerPrefs
} from '../lib/composerprefs'

/**
 * When a task is allowed to start, as offered on the clock beside Send.
 *
 * ⚠️ `now` is not a schedule and never becomes `notBefore`. It is the absence of one, kept in the
 * same list so that turning a scheduled send back off is one click in the place that armed it
 * rather than a separate control somewhere else.
 */
type ScheduleOption = 'now' | '30m' | '1h' | '2h' | '4h' | 'custom'

const SCHEDULE_DELAYS: Record<Exclude<ScheduleOption, 'now' | 'custom'>, number> = {
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000
}

const SCHEDULE_OPTIONS: PillOption[] = [
  { value: 'now', label: 'Send now', hint: 'routed as soon as an account is free' },
  { value: '30m', label: 'In 30 minutes' },
  { value: '1h', label: 'In 1 hour' },
  { value: '2h', label: 'In 2 hours' },
  { value: '4h', label: 'In 4 hours' },
  { value: 'custom', label: 'At a time…' }
]

const PRIORITY_OPTIONS: PillOption[] = [
  { value: 'P0', label: 'P0', hint: 'ahead of everything' },
  { value: 'P1', label: 'P1', hint: 'before the ordinary queue' },
  { value: 'P2', label: 'P2', hint: 'the default' },
  { value: 'P3', label: 'P3', hint: 'whenever there is room' }
]

/**
 * ⚠️ Two, and the second one is the existing goal-decomposition path under its own name. Multi-task
 * and conversation belong here next and are deliberately not listed yet: an option that files
 * nothing is worse than a missing one, because somebody picks it and nothing happens.
 */
const KIND_OPTIONS: PillOption[] = [
  { value: 'task', label: 'Task', hint: 'one thread of work, dispatched to an agent' },
  {
    value: 'plan',
    label: 'Plan&Split',
    hint: 'an agent plans it with you, then files and delegates the pieces'
  }
]

/**
 * ⛔ Starts at 2 and stops at 8. The floor is the daemon's own rule — a split of one is refused,
 * because it buys a round trip and a cold context and delivers no parallelism. The ceiling is what
 * `validateSplit` enforces, so the number on the pill is the number that will actually be allowed.
 */
const FANOUT_OPTIONS: PillOption[] = Array.from({ length: MAX_PIECES - MIN_PIECES + 1 }, (_, i) => ({
  value: String(MIN_PIECES + i),
  label: `Up to ${MIN_PIECES + i} pieces`
}))

const ATTACH_OPTIONS: PillOption[] = [
  { value: 'file', label: 'Add a file or photo' },
  { value: 'folder', label: 'Add a folder' }
]

const KIND_SHORT: Record<ComposerKind, string> = { task: 'Task', plan: 'Plan&Split' }

/** `2026-09-02T14:30` — what `datetime-local` wants, in the operator's own timezone. */
function localInputValue(at: number): string {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

/**
 * When the task may start, or `invalid` where the operator armed a custom time and never set one.
 *
 * ⛔ `now` is `null` rather than the current instant: `notBefore` is omitted from the call entirely,
 * so an unscheduled task is `ready` and not a scheduled one whose moment has just passed. The two
 * take different paths through admission — `admitScheduled()` reads only `scheduled` rows.
 */
export function plannedStart(
  option: ScheduleOption,
  customTime: string,
  now: number
): number | null | 'invalid' {
  if (option === 'now') return null
  if (option === 'custom') {
    if (!customTime) return 'invalid'
    const parsed = new Date(customTime).getTime()
    return Number.isNaN(parsed) ? 'invalid' : parsed
  }
  return now + SCHEDULE_DELAYS[option]
}

/** The clock's own label: short enough to sit beside two buttons. */
function scheduleLabel(option: ScheduleOption, customTime: string): string {
  if (option === 'now') return '⏱'
  if (option !== 'custom') return `⏱ ${option}`
  const at = customTime ? new Date(customTime).getTime() : NaN
  if (Number.isNaN(at)) return '⏱ …'
  return `⏱ ${new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })}`
}

/**
 * The prompt, and every setting that narrows it, under it.
 *
 * ⛔ **The prompt is first now, and that is a reversal.** It used to sit under five labelled rows,
 * on the reasoning that settings narrow what the task *is* and the prompt says what it is *for*. The
 * reasoning held and the shape did not: every one of those rows was answered the same way on almost
 * every task, so what a person met before the one field they came here to fill in was five controls
 * they were about to leave alone. They are still all here, one click deep, on a row of pills under
 * the box — the arrangement every chat composer has converged on, and the same one the task thread
 * uses one screen away.
 *
 * ⭐ **And they remember.** A pill shows what it was last set to, not what this project inherits;
 * inheritance supplies the first value each control ever shows and nothing after that. See
 * `composerprefs.ts` for why that is the useful default and what it costs.
 */
export function NewTask({
  projects,
  fixedProjectId,
  fleet,
  onDone,
  onError
}: {
  projects: Project[]
  /** Set when filed from inside a project. The project pill is not drawn — the page above says it. */
  fixedProjectId?: string
  /** The accounts that could take this, so one can be pinned and its CLI's models offered. */
  fleet: FleetEntry[]
  onDone: () => void | Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  /**
   * ⚠️ The clock, read through a callback rather than inline. `Date.now()` in a body defined during
   * render is what React's purity rule exists to catch — a re-render would quietly re-answer it —
   * and *when this was filed* is the one input here that is not state.
   */
  const readClock = useCallback(() => Date.now(), [])
  /**
   * ⚠️ Read from disk at first render, not in an effect — the same rule the task list's view filter
   * follows. Seeded from an effect, every pill would draw one frame of `inherit` and then flick to
   * what the operator actually left it on.
   */
  const [prefs, setPrefsState] = useState<ComposerPrefs>(readComposerPrefs)
  const [projectId, setProjectId] = useState(fixedProjectId ?? projects[0]?.id ?? '')
  /**
   * ⛔ Not remembered, unlike everything on the pill row. A prerequisite is a fact about *this* piece
   * of work, and a schedule is a moment that has usually passed by the next time the form opens —
   * a composer that quietly re-armed "in 4 hours" would file a task that goes nowhere and say
   * nothing about it.
   */
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [plannerFinishPolicy, setPlannerFinishPolicy] = useState<FinishPolicyChoice>('commit-only')
  const [piecePriority, setPiecePriority] = useState<ComposerPrefs['priority']>('P2')
  const [pieceLimit, setPieceLimit] = useState<number>(5)
  const [pieceSessionSharing, setPieceSessionSharing] = useState<SessionSharingChoice>('on')
  const [pieceFinishPolicy, setPieceFinishPolicy] = useState<FinishPolicyChoice>('commit-and-merge')
  const [pieceWorkerIds, setPieceWorkerIds] = useState<string[]>([])
  const [pieceModels, setPieceModels] = useState<Record<string, string>>({})
  const [pieceEfforts, setPieceEfforts] = useState<Record<string, string>>({})
  const [scheduleOption, setScheduleOption] = useState<ScheduleOption>('now')
  const [customTime, setCustomTime] = useState('')
  const [saving, setSaving] = useState<'draft' | 'ready' | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentPickerRef = useRef<HTMLInputElement>(null)
  // ⚠️ Uploaded the moment they are added, so what the form carries is a list of ids.
  const paste = usePastedImages()

  /**
   * ⛔ Fetched, not compiled in. The renderer holds no cost models, and a second table of model facts
   * here would drift from the first the day a model was added to a file and not to this bundle.
   */
  const [options, setOptions] = useState<ModelOptions[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const { settings: uiSettings } = useUiSettings()
  // ⚠️ Every task in the fleet, not the page behind this form. A prerequisite is often the task you
  // filed a minute ago, and whether it happens to match the bucket the table is filtered to says
  // nothing about whether this one should wait for it.
  const { tasks: candidateTasks } = useTaskCandidates()
  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects]
  )

  useEffect(() => {
    void rpc('model.options')
      .then(setOptions)
      // A fleet with no priceable model list is still a fleet that can run work. The form falls back
      // to whatever each CLI defaults to, which is what it did before there was a picker at all.
      .catch(() => setOptions([]))
    void rpc('settings.get')
      .then(setSettings)
      .catch(() => setSettings(null))
  }, [])

  /** One place writes the remembered state, so nothing can update the pill and forget the disk. */
  const setPrefs = (next: ComposerPrefs): void => {
    setPrefsState(next)
    writeComposerPrefs(next)
  }

  const selectedProject = projectId ? (projects.find((p) => p.id === projectId) ?? null) : null
  const inheritedFinish = resolveFinishPolicy(null, selectedProject, settings?.finishPolicy)
  const inheritedSharing = resolveSessionSharing(null, selectedProject, settings?.sessionSharing)
  const inheritedFinishShort = inheritedFinish.policy
    ? (FINISH_SHORT[inheritedFinish.policy] ?? inheritedFinish.policy)
    : 'Await human'
  const inheritedFinishLong = inheritedFinish.policy
    ? (FINISH_LABELS[inheritedFinish.policy] ?? inheritedFinish.policy)
    : 'agent lands it'
  const inheritedSharingShort = SHARING_SHORT[inheritedSharing.sharing] ?? inheritedSharing.sharing
  const inheritedSharingLong = SHARING_LABELS[inheritedSharing.sharing] ?? inheritedSharing.sharing

  // ⛔ Only accounts that could actually take work. Offering a switched-off worker as a pin produces
  // a task that waits forever on a candidate loop that will never match it.
  const pinnable = fleet.filter((e) => e.worker.enabled).map((e) => e.worker)
  const pinned = pinnable.find((w) => w.id === prefs.workerId) ?? null
  const forAdapter = pinned ? (options.find((o) => o.adapterId === pinned.adapterId) ?? null) : null
  const canSetEffort = forAdapter?.selectableEffort ?? false

  /**
   * The remembered model for this account, **checked against what the account can actually run.**
   *
   * ⛔ A remembered id is not a valid one. Model lists come from a cost model file that gets edited,
   * and the answer to *is this still offered* is only knowable once `model.options` has arrived — so
   * an unrecognised id resolves to inherit and is never sent. It is left in storage rather than
   * cleared: the picker being momentarily empty is not evidence that a choice was wrong.
   */
  const remembered = modelChoiceFor(prefs, prefs.workerId)
  const model =
    forAdapter && forAdapter.models.some((m) => m.id === remembered.model) ? remembered.model : ''
  const resolved = resolveModelChoice({ model: model || undefined }, pinned, canSetEffort)
  const effectiveModel = forAdapter?.models.find((m) => m.id === (resolved.model ?? '')) ?? null
  const efforts = canSetEffort ? (effectiveModel?.effortLevels ?? []) : []
  const effort = efforts.includes(remembered.effort) ? remembered.effort : ''

  const hasMultiPoolDefaults =
    pinned?.defaultModels && Object.values(pinned.defaultModels).filter(Boolean).length > 1
  const inheritedModelLabel = hasMultiPoolDefaults
    ? 'Auto-balance'
    : (modelLabel(pinned?.defaultModel) ?? 'CLI default')
  const inheritedEffortLabel = effortLabel(pinned?.defaultEffort) ?? 'CLI default'

  const kind = prefs.kind
  const isPlan = kind === 'plan'
  const depTasks = dependsOn
    .map((id) => candidateTasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t)


  const chooseWorker = (workerId: string): void => {
    // ⛔ The model is not cleared, it is *re-read for the account now pinned*. Clearing was right
    // when there was one model slot — an id belongs to one CLI and would be handed to an adapter
    // that cannot start on it — but it also threw away a choice somebody had made, every time they
    // looked at another account. `byWorker` keeps both properties.
    setPrefs({ ...prefs, workerId })
  }

  const chooseModel = (next: string): void => {
    const levels = forAdapter?.models.find((m) => m.id === next)?.effortLevels ?? []
    // ⚠️ The effort survives a model change only where the new model has that level. Anything else
    // would send a level the CLI would refuse, or silently keep one the pill has stopped showing.
    const keptEffort = canSetEffort && levels.includes(effort) ? effort : ''
    setPrefs(rememberModelChoice(prefs, prefs.workerId, { model: next, effort: keptEffort }))
  }

  const chooseEffort = (next: string): void => {
    setPrefs(rememberModelChoice(prefs, prefs.workerId, { model, effort: next }))
  }

  const submit = async (targetStatus: 'draft' | 'ready'): Promise<void> => {
    setSaving(targetStatus)
    try {
      if (isPlan) {
        const pieceConstraints =
          pieceWorkerIds.length > 0 || Object.keys(pieceModels).length > 0 || Object.keys(pieceEfforts).length > 0
            ? {
                ...(pieceWorkerIds.length > 0 ? { workerIds: pieceWorkerIds } : {}),
                ...(Object.keys(pieceModels).length > 0 ? { modelsByWorker: pieceModels } : {}),
                ...(Object.keys(pieceEfforts).length > 0 ? { effortsByWorker: pieceEfforts } : {})
              }
            : undefined

        await rpc('task.plan', {
          title: prompt.trim(),
          projectId: projectId || null,
          ...(paste.ids.length > 0 ? { attachmentIds: paste.ids } : {}),
          priority: prefs.priority,
          finishPolicy: plannerFinishPolicy,
          sessionSharing: prefs.sessionSharing,
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          maxChildren: pieceLimit,
          childDefaults: {
            priority: piecePriority,
            finishPolicy: pieceFinishPolicy,
            sessionSharing: pieceSessionSharing,
            maxChildren: pieceLimit,
            ...(pieceWorkerIds.length > 0 ? { workerIds: pieceWorkerIds } : {}),
            ...(Object.keys(pieceModels).length > 0 ? { modelsByWorker: pieceModels } : {})
          },
          constraints: {
            ...(prefs.workerId ? { workerId: prefs.workerId } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            piecePriority,
            pieceLimit,
            pieceFinishPolicy,
            pieceSessionSharing,
            ...(pieceConstraints ? { pieceConstraints } : {})
          }
        })
      } else {
        const notBefore = plannedStart(scheduleOption, customTime, readClock())
        if (notBefore === 'invalid') {
          onError('Pick a date and time for the scheduled send, or set the clock back to Send now')
          setSaving(null)
          return
        }
        await rpc('task.create', {
          title: prompt.trim(),
          projectId: projectId || null,
          // ⚠️ Absent, not empty, like every other optional field on this call.
          ...(paste.ids.length > 0 ? { attachmentIds: paste.ids } : {}),
          priority: prefs.priority,
          finishPolicy: prefs.finishPolicy,
          sessionSharing: prefs.sessionSharing,
          status: targetStatus,
          ...(notBefore ? { notBefore } : {}),
          // ⚠️ Absent, not empty here too - `dependsOn: []` is an empty list of edges, which is what
          // the daemon would do anyway, but sending one says a choice was made where none was.
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          // ⚠️ Absent, not empty. The daemon reads a *present* `constraints` as an instruction to
          // validate one, and an object of empty strings would be three constraints that name
          // nothing rather than three questions left to the scheduler.
          ...(prefs.workerId || model || effort
            ? {
                constraints: {
                  ...(prefs.workerId ? { workerId: prefs.workerId } : {}),
                  ...(model ? { model } : {}),
                  ...(effort ? { effort } : {})
                }
              }
            : {})
        })
      }
      // ⚠️ The prompt and what belonged to it go; the pills stay exactly where they were. Filing one
      // task is the strongest evidence there is about how the next one should be set up.
      setPrompt('')
      setDependsOn([])
      setScheduleOption('now')
      setCustomTime('')
      paste.clear()
      await onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(null)
    }
  }

  const armed = scheduleOption !== 'now'
  // ⛔ A send waits for an upload. Otherwise a click between selecting a file and its RPC completing
  // would create the task without the context the person just chose.
  const canSend = !saving && !paste.busy && prompt.trim().length > 0
  const sendLabel = saving === 'ready' ? '…' : isPlan ? 'Plan & Split' : armed ? 'Schedule' : 'Send'

  return (
    <div className="composer">
      {/*
        The ask itself, first and largest.

        ⚠️ A textarea, not a single-line input. What goes here is the prompt an agent receives
        verbatim, and a prompt worth writing usually has a second sentence in it. Enter breaks the
        line or sends, per the app's own Enter setting; the buttons say which is which.
      */}
      <div className="ask composer-ask">
        <textarea
          ref={textareaRef}
          className="ask-input"
          rows={3}
          wrap="soft"
          value={prompt}
          aria-label="Prompt"
          placeholder={
            isPlan
              ? 'Describe the outcome. An agent plans it with you, then files and delegates the pieces.'
              : 'Describe the work as you would to a colleague. You can paste an image in here as well.'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={paste.onPaste}
          onDrop={paste.onDrop}
          onDragOver={paste.onDragOver}
          onKeyDown={(e) => {
            if (isSubmitKey(e, uiSettings.enterBehavior) && canSend) {
              e.preventDefault()
              void submit('ready')
            }
          }}
        />
        <ImageChips paste={paste} />
        <div className="composer-send">
          {!isPlan && (
            <button
              className="btn btn--quiet"
              disabled={!canSend}
              title="File it without dispatching. A draft sits still until you promote it."
              onClick={() => void submit('draft')}
            >
              {saving === 'draft' ? '…' : 'Draft'}
            </button>
          )}
          <button className="btn btn--primary" disabled={!canSend} onClick={() => void submit('ready')}>
            {sendLabel}
          </button>
          {!isPlan && (
            <Pill
              className="pill--clock"
              align="right"
              muted={!armed}
              ariaLabel="When to send"
              title={
                armed
                  ? 'This task waits at scheduled until its time arrives, then is routed and dispatched.'
                  : 'Send now, or pick a time to file it as scheduled.'
              }
              label={scheduleLabel(scheduleOption, customTime)}
              menu={(close) => (
                <>
                  <PillOptions
                    options={SCHEDULE_OPTIONS}
                    value={scheduleOption}
                    ariaLabel="When to send"
                    onPick={(next) => {
                      setScheduleOption(next as ScheduleOption)
                      if (next === 'custom') {
                        // The moment is not chosen yet — the field below is what chooses it, so the
                        // menu stays open rather than arming a schedule with no time on it.
                        if (!customTime) setCustomTime(localInputValue(readClock() + 60 * 60 * 1000))
                        return
                      }
                      close()
                    }}
                  />
                  {scheduleOption === 'custom' && (
                    <div className="pill-menu-foot">
                      <input
                        type="datetime-local"
                        aria-label="Custom schedule time"
                        value={customTime}
                        onChange={(e) => setCustomTime(e.target.value)}
                      />
                      <button className="btn btn--quiet" disabled={!customTime} onClick={close}>
                        Set
                      </button>
                    </div>
                  )}
                </>
              )}
            />
          )}
        </div>
      </div>

      {/*
        ⛔ Under the prompt, and every one of them showing an answer rather than a label. A row of
        controls reading `Priority` `Finish` `Worker` would be a form again; reading `P1`
        `Commit·Verify·Merge` `Auto` it is a status line you can click, and the dim ones are the
        answers nobody has chosen.
      */}
      <div className={`composer-bar${isPlan ? ' composer-bar--plan' : ''}`} role="group" aria-label="Task settings">
        {!isPlan ? (
          <>
            <input
              ref={attachmentPickerRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.currentTarget.files ?? [])]
                e.currentTarget.value = ''
                void paste.addFiles(files)
              }}
            />
            <Pill
              ariaLabel="Add attachment"
              title="Add a file, photo, or folder"
              label="+"
              menu={(close) => (
                <PillOptions
                  options={ATTACH_OPTIONS}
                  value=""
                  ariaLabel="Add attachment"
                  onPick={(next) => {
                    close()
                    if (next === 'file') {
                      attachmentPickerRef.current?.click()
                    } else if (next === 'folder') {
                      void paste.addFolders()
                    }
                  }}
                />
              )}
            />

            <PillSelect
              ariaLabel="What this files"
              title="A task is dispatched to an agent. A plan is decomposed into drafts first."
              muted={kind === 'task'}
              value={kind}
              label={KIND_SHORT[kind]}
              options={KIND_OPTIONS}
              onChange={(v) => setPrefs({ ...prefs, kind: v as ComposerKind })}
            />

            <PillSelect
              ariaLabel="Priority"
              title="Priority orders the queue. It does not jump a task past its dependencies."
              muted={prefs.priority === 'P2'}
              value={prefs.priority}
              label={prefs.priority}
              options={PRIORITY_OPTIONS}
              onChange={(v) => setPrefs({ ...prefs, priority: v as ComposerPrefs['priority'] })}
            />

            <Pill
              ariaLabel="Wait for other tasks"
              title="This task is held at blocked until every task named here has completed. You can add or drop a prerequisite later from its thread."
              muted={dependsOn.length === 0}
              label={
                dependsOn.length === 0
                  ? 'Depends on'
                  : dependsOn.length === 1
                    ? `Dep t${depTasks[0]?.seq ?? '?'}`
                    : `Dep ×${dependsOn.length}`
              }
              menu={() => (
                <DependencyMenu
                  all={candidateTasks}
                  chosen={dependsOn}
                  onChange={setDependsOn}
                  projectNames={projectNames}
                />
              )}
            />

            {!fixedProjectId && (
              <PillSelect
                ariaLabel="Project"
                title="A git project gets a pooled worktree and a branch named after the task. Agents never work in the trunk."
                muted={!projectId}
                value={projectId}
                label={projectId ? (projectNames.get(projectId) ?? projectId) : 'No project'}
                options={[
                  { value: '', label: 'No project', hint: 'runs without a workspace or a branch' },
                  ...projects.map((p) => ({ value: p.id, label: p.name }))
                ]}
                onChange={setProjectId}
              />
            )}
            <span className="composer-gap" aria-hidden="true" />
            <PillSelect
              ariaLabel="Conversation policy"
              title={
                'Whether this task may continue in a conversation another task in this project has ' +
                'already been having. Cheaper — a cold start rebuilt 41,542 tokens of prefix that a ' +
                'reused one read back for 65 — but the agent sees everything said in that conversation.' +
                (prefs.sessionSharing === 'inherit'
                  ? `\n\nInherited from the ${inheritedSharing.source}: ${inheritedSharingLong}.`
                  : '')
              }
              muted={prefs.sessionSharing === 'inherit'}
              value={prefs.sessionSharing}
              label={
                prefs.sessionSharing === 'inherit'
                  ? inheritedSharingShort
                  : SHARING_SHORT[prefs.sessionSharing]
              }
              options={[
                {
                  value: 'inherit',
                  label: `Inherit — ${inheritedSharingLong}`,
                  hint: `from the ${inheritedSharing.source}, and follows it as it changes`
                },
                { value: 'on', label: SHARING_LABELS.on },
                { value: 'off', label: SHARING_LABELS.off }
              ]}
              onChange={(v) => setPrefs({ ...prefs, sessionSharing: v as SessionSharingChoice })}
            />

            <PillSelect
              ariaLabel="Finish policy"
              title={
                'What happens when the agent says it is done. Each rung does everything the one ' +
                'below does plus one thing.' +
                (prefs.finishPolicy === 'inherit'
                  ? `\n\nInherited from the ${inheritedFinish.source}: ${inheritedFinishLong}.`
                  : '')
              }
              muted={prefs.finishPolicy === 'inherit'}
              value={prefs.finishPolicy}
              label={
                prefs.finishPolicy === 'inherit'
                  ? inheritedFinishShort
                  : (FINISH_SHORT[prefs.finishPolicy] ?? prefs.finishPolicy)
              }
              options={[
                {
                  value: 'inherit',
                  label: `Inherit — ${inheritedFinishLong}`,
                  hint: `from the ${inheritedFinish.source}, and follows it as it changes`
                },
                // ⛔ From FINISH_ORDER, never a hand-written copy. Three dropdowns each carried their
                // own list of these and all three still offered `agent-lands` after the rename.
                ...FINISH_ORDER.map((p) => ({ value: p, label: FINISH_LABELS[p] }))
              ]}
              onChange={(v) => setPrefs({ ...prefs, finishPolicy: v as FinishPolicyChoice })}
            />

            <span className="composer-gap" aria-hidden="true" />
            <PillSelect
              ariaLabel="Worker"
              align="right"
              title={
                'Auto weighs quota, cache warmth and what each account has proved. Choosing one ' +
                'pins the task: it waits for that account rather than routing around it.'
              }
              muted={!prefs.workerId}
              value={prefs.workerId}
              label={pinned?.label ?? 'Auto Worker'}
              options={[
                { value: '', label: 'Auto Worker', hint: 'the scheduler picks' },
                ...pinnable.map((w) => ({ value: w.id, label: w.label }))
              ]}
              onChange={chooseWorker}
            />

            <PillSelect
              ariaLabel="Model"
              align="right"
              // ⛔ Disabled rather than absent. A model list belongs to one CLI, so until an account
              // is pinned there is genuinely nothing to draw — and a pill that vanished would take
              // the row's shape with it every time somebody moved back to Auto.
              disabled={!forAdapter}
              title={
                forAdapter
                  ? 'Only models this account’s cost model can price are offered — one it cannot ' +
                    'price is one that cannot be gated, estimated for, or reasoned about the ' +
                    'context window of.'
                  : 'Pin an account first. A model list belongs to one CLI, so there is nothing to ' +
                    'offer until one is chosen.'
              }
              muted={!model}
              value={model}
              label={model ? (modelLabel(model) ?? model) : inheritedModelLabel}
              options={[
                {
                  value: '',
                  label: `Inherit — ${inheritedModelLabel}`,
                  hint: pinned ? 'whatever this account reaches for' : undefined
                },
                // ⚠️ Named for reading, valued by id — what is sent is the exact string the CLI takes.
                ...(forAdapter?.models ?? []).map((m) => ({
                  value: m.id,
                  label: modelLabel(m.id) ?? m.id,
                  hint: m.id
                }))
              ]}
              onChange={chooseModel}
            />

            {/* Effort appears only where the CLI can be told one *and* the model in effect has
                levels to offer. A control that cannot be honoured is worse than no control. */}
            {efforts.length > 0 && (
              <PillSelect
                ariaLabel="Effort"
                align="right"
                title="How hard this account is asked to think. Sent as its own flag, so it resolves independently of the model."
                muted={!effort}
                value={effort}
                label={effort ? (effortLabel(effort) ?? effort) : inheritedEffortLabel}
                options={[
                  { value: '', label: `Inherit — ${inheritedEffortLabel}` },
                  ...efforts.map((level) => ({ value: level, label: effortLabel(level) ?? level }))
                ]}
                onChange={chooseEffort}
              />
            )}
          </>
        ) : (
          <>
            <input
              ref={attachmentPickerRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.currentTarget.files ?? [])]
                e.currentTarget.value = ''
                void paste.addFiles(files)
              }}
            />
            <table className="composer-plan-table">
              <tbody>
                <tr>
                  <th className="composer-plan-label">Planner</th>
                  <td>
                    <Pill
                      ariaLabel="Add attachment"
                      title="Add a file, photo, or folder"
                      label="+"
                      menu={(close) => (
                        <PillOptions
                          options={ATTACH_OPTIONS}
                          value=""
                          ariaLabel="Add attachment"
                          onPick={(next) => {
                            close()
                            if (next === 'file') {
                              attachmentPickerRef.current?.click()
                            } else if (next === 'folder') {
                              void paste.addFolders()
                            }
                          }}
                        />
                      )}
                    />
                  </td>
                  <td>
                    <PillSelect
                      ariaLabel="What this files"
                      title="A task is dispatched to an agent. A plan is decomposed into drafts first."
                      muted={false}
                      value={kind}
                      label={KIND_SHORT[kind]}
                      options={KIND_OPTIONS}
                      onChange={(v) => setPrefs({ ...prefs, kind: v as ComposerKind })}
                    />
                  </td>
                  <td>
                    <PillSelect
                      ariaLabel="Priority"
                      title="Priority orders the queue. It does not jump a task past its dependencies."
                      muted={prefs.priority === 'P2'}
                      value={prefs.priority}
                      label={prefs.priority}
                      options={PRIORITY_OPTIONS}
                      onChange={(v) => setPrefs({ ...prefs, priority: v as ComposerPrefs['priority'] })}
                    />
                  </td>
                  <td>
                    <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                      <Pill
                        ariaLabel="Wait for other tasks"
                        title="This task is held at blocked until every task named here has completed."
                        muted={dependsOn.length === 0}
                        label={
                          dependsOn.length === 0
                            ? 'Depends on'
                            : dependsOn.length === 1
                              ? `Dep t${depTasks[0]?.seq ?? '?'}`
                              : `Dep ×${dependsOn.length}`
                        }
                        menu={() => (
                          <DependencyMenu
                            all={candidateTasks}
                            chosen={dependsOn}
                            onChange={setDependsOn}
                            projectNames={projectNames}
                          />
                        )}
                      />
                      {!fixedProjectId && (
                        <PillSelect
                          ariaLabel="Project"
                          title="A git project gets a pooled worktree and a branch named after the task."
                          muted={!projectId}
                          value={projectId}
                          label={projectId ? (projectNames.get(projectId) ?? projectId) : 'No project'}
                          options={[
                            { value: '', label: 'No project', hint: 'runs without a workspace or a branch' },
                            ...projects.map((p) => ({ value: p.id, label: p.name }))
                          ]}
                          onChange={setProjectId}
                        />
                      )}
                    </div>
                  </td>
                  <td>
                    <PillSelect
                      ariaLabel="Conversation policy"
                      title="Whether this task may continue in a conversation another task in this project has already been having."
                      muted={prefs.sessionSharing === 'inherit'}
                      value={prefs.sessionSharing}
                      label={
                        prefs.sessionSharing === 'inherit'
                          ? inheritedSharingShort
                          : SHARING_SHORT[prefs.sessionSharing]
                      }
                      options={[
                        {
                          value: 'inherit',
                          label: `Inherit — ${inheritedSharingLong}`,
                          hint: `from the ${inheritedSharing.source}, and follows it as it changes`
                        },
                        { value: 'on', label: SHARING_LABELS.on },
                        { value: 'off', label: SHARING_LABELS.off }
                      ]}
                      onChange={(v) => setPrefs({ ...prefs, sessionSharing: v as SessionSharingChoice })}
                    />
                  </td>
                  <td>
                    <PillSelect
                      ariaLabel="Finish policy"
                      title="What happens when the agent says it is done."
                      muted={plannerFinishPolicy === 'commit-only'}
                      value={plannerFinishPolicy}
                      label={
                        plannerFinishPolicy === 'commit-only'
                          ? 'Commit'
                          : plannerFinishPolicy === 'inherit'
                            ? inheritedFinishShort
                            : (FINISH_SHORT[plannerFinishPolicy] ?? plannerFinishPolicy)
                      }
                      options={[
                        { value: 'commit-only', label: 'Commit' },
                        ...FINISH_ORDER.filter((p) => p !== 'commit-only').map((p) => ({
                          value: p,
                          label: FINISH_LABELS[p]
                        }))
                      ]}
                      onChange={(v) => setPlannerFinishPolicy(v as FinishPolicyChoice)}
                    />
                  </td>
                  <td>
                    <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                      <PillSelect
                        ariaLabel="Worker"
                        align="right"
                        muted={!prefs.workerId}
                        value={prefs.workerId}
                        label={pinned?.label ?? 'Auto Worker'}
                        options={[
                          { value: '', label: 'Auto Worker', hint: 'the scheduler picks' },
                          ...pinnable.map((w) => ({ value: w.id, label: w.label }))
                        ]}
                        onChange={chooseWorker}
                      />
                      <PillSelect
                        ariaLabel="Model"
                        align="right"
                        disabled={!forAdapter}
                        muted={!model}
                        value={model}
                        label={model ? (modelLabel(model) ?? model) : inheritedModelLabel}
                        options={[
                          {
                            value: '',
                            label: `Inherit — ${inheritedModelLabel}`,
                            hint: pinned ? 'whatever this account reaches for' : undefined
                          },
                          ...(forAdapter?.models ?? []).map((m) => ({
                            value: m.id,
                            label: modelLabel(m.id) ?? m.id,
                            hint: m.id
                          }))
                        ]}
                        onChange={chooseModel}
                      />
                      {efforts.length > 0 && (
                        <PillSelect
                          ariaLabel="Effort"
                          align="right"
                          muted={!effort}
                          value={effort}
                          label={effort ? (effortLabel(effort) ?? effort) : inheritedEffortLabel}
                          options={[
                            { value: '', label: `Inherit — ${inheritedEffortLabel}` },
                            ...efforts.map((level) => ({ value: level, label: effortLabel(level) ?? level }))
                          ]}
                          onChange={chooseEffort}
                        />
                      )}
                    </div>
                  </td>
                </tr>
                <tr>
                  <th className="composer-plan-label">Each Piece</th>
                  <td></td>
                  <td></td>
                  <td>
                    <PillSelect
                      ariaLabel="Piece Priority"
                      title="Priority applied to each decomposed piece."
                      muted={piecePriority === 'P2'}
                      value={piecePriority}
                      label={piecePriority}
                      options={PRIORITY_OPTIONS}
                      onChange={(v) => setPiecePriority(v as ComposerPrefs['priority'])}
                    />
                  </td>
                  <td>
                    <PillSelect
                      ariaLabel="Piece Limit"
                      title="Maximum number of pieces to decompose the goal into."
                      value={String(pieceLimit)}
                      label={`<=${pieceLimit}`}
                      options={FANOUT_OPTIONS}
                      onChange={(v) => setPieceLimit(Number(v))}
                    />
                  </td>
                  <td>
                    <PillSelect
                      ariaLabel="Piece Session Sharing"
                      title="Session sharing policy for each decomposed piece."
                      muted={pieceSessionSharing === 'on'}
                      value={pieceSessionSharing}
                      label={
                        pieceSessionSharing === 'inherit'
                          ? inheritedSharingShort
                          : (SHARING_SHORT[pieceSessionSharing] ?? pieceSessionSharing)
                      }
                      options={[
                        { value: 'on', label: SHARING_LABELS.on },
                        { value: 'off', label: SHARING_LABELS.off },
                        {
                          value: 'inherit',
                          label: `Inherit — ${inheritedSharingLong}`,
                          hint: `from the ${inheritedSharing.source}`
                        }
                      ]}
                      onChange={(v) => setPieceSessionSharing(v as SessionSharingChoice)}
                    />
                  </td>
                  <td>
                    <PillSelect
                      ariaLabel="Piece Finish Policy"
                      title="Finish policy for each decomposed piece. Split work merges into the Planner branch."
                      muted={pieceFinishPolicy === 'commit-and-merge'}
                      value={pieceFinishPolicy}
                      label={
                        pieceFinishPolicy === 'commit-and-merge'
                          ? 'Commit·Verify·Merge Branch'
                          : pieceFinishPolicy === 'inherit'
                            ? inheritedFinishShort
                            : (FINISH_SHORT[pieceFinishPolicy] ?? pieceFinishPolicy)
                      }
                      options={[
                        { value: 'commit-and-merge', label: 'Commit·Verify·Merge Branch' },
                        ...FINISH_ORDER.filter((p) => p !== 'commit-and-merge').map((p) => ({
                          value: p,
                          label: FINISH_LABELS[p]
                        }))
                      ]}
                      onChange={(v) => setPieceFinishPolicy(v as FinishPolicyChoice)}
                    />
                  </td>
                  <td>
                    <WorkersPicker
                      workers={pinnable}
                      modelOptions={options}
                      selectedWorkerIds={pieceWorkerIds}
                      selectedModels={pieceModels}
                      selectedEfforts={pieceEfforts}
                      onChange={(workerIds, models, efforts) => {
                        setPieceWorkerIds(workerIds)
                        setPieceModels(models)
                        setPieceEfforts(efforts)
                      }}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </div>


      <p className="composer-hint">
        {isPlan
          ? 'An agent plans this with you first — it reads the repository and asks what it needs to ' +
            'know. You approve the whole split before anything is filed. The pieces branch off this ' +
            'plan’s branch and merge back into it, and only the finished plan reaches the trunk.'
          : 'Sent to the agent as written, after any handoff from an earlier run. These settings are ' +
            'remembered for the next task; dimmed ones are inherited.'}
      </p>
    </div>
  )
}

/**
 * Prerequisites, chosen inside a pill menu.
 *
 * ⛔ Toggle, and the menu stays open. Waiting on three tasks is one gesture here and would be three
 * round trips through a menu that shut itself after each one. The filter is not decoration either:
 * this list is every task in the fleet, and on a working install that is hundreds.
 *
 * ⚠️ `candidatesFor` is the shared cycle filter, so nothing that already waits on a task — directly
 * or four edges away — is offered. The daemon's copy is still the one that decides; this one exists
 * so a person is not offered a choice that will be refused.
 */
function DependencyMenu({
  all,
  chosen,
  onChange,
  projectNames
}: {
  all: Task[]
  chosen: string[]
  onChange: (next: string[]) => void
  projectNames: Map<string, string>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const picked = chosen
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is Task => !!t)
  const candidates = useMemo(() => candidatesFor(all, null, chosen), [all, chosen])
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? candidates.filter(
        (t) =>
          `t${t.seq}`.includes(needle) ||
          t.title.toLowerCase().includes(needle) ||
          (t.projectId ? (projectNames.get(t.projectId) ?? '') : '').toLowerCase().includes(needle)
      )
    : candidates

  const row = (task: Task, on: boolean): React.JSX.Element => (
    <button
      key={task.id}
      type="button"
      className={`pill-option${on ? ' pill-option--on' : ''}`}
      onClick={() => onChange(on ? chosen.filter((c) => c !== task.id) : [...chosen, task.id])}
    >
      <span className="pill-option-text">
        <span className="pill-option-label">
          t{task.seq} · {taskLabelShort(task, 44)}
        </span>
        <span className="pill-option-hint">
          {task.status}
          {task.projectId && projectNames.get(task.projectId)
            ? ` · ${projectNames.get(task.projectId)}`
            : ''}
        </span>
      </span>
      <span className="pill-option-check" aria-hidden="true">
        {on ? '✓' : '+'}
      </span>
    </button>
  )

  return (
    <div className="pill-picker">
      <input
        className="pill-filter"
        placeholder="wait on a task…"
        aria-label="Filter tasks"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pill-options">
        {picked.map((t) => row(t, true))}
        {shown.slice(0, 40).map((t) => row(t, false))}
        {picked.length === 0 && shown.length === 0 && (
          <p className="pill-empty">
            {all.length === 0 ? 'No other tasks to wait for yet.' : 'Nothing matches that.'}
          </p>
        )}
      </div>
    </div>
  )
}

function WorkersPicker({
  workers,
  modelOptions,
  selectedWorkerIds,
  selectedModels,
  selectedEfforts,
  onChange
}: {
  workers: Array<{
    id: string
    label: string
    adapterId: string
    defaultModel?: string | null
    defaultEffort?: string | null
  }>
  modelOptions: ModelOptions[]
  selectedWorkerIds: string[]
  selectedModels: Record<string, string>
  selectedEfforts: Record<string, string>
  onChange: (
    workerIds: string[],
    models: Record<string, string>,
    efforts: Record<string, string>
  ) => void
}): React.JSX.Element {
  const label = useMemo(() => {
    if (selectedWorkerIds.length === 0) return 'Workers'
    if (selectedWorkerIds.length === 1) {
      const w = workers.find((x) => x.id === selectedWorkerIds[0])
      return w ? w.label : '1 Worker'
    }
    return `${selectedWorkerIds.length} Workers`
  }, [selectedWorkerIds, workers])

  const toggleWorker = (id: string): void => {
    if (selectedWorkerIds.includes(id)) {
      const next = selectedWorkerIds.filter((x) => x !== id)
      onChange(next, selectedModels, selectedEfforts)
    } else {
      onChange([...selectedWorkerIds, id], selectedModels, selectedEfforts)
    }
  }

  const setWorkerModel = (id: string, model: string): void => {
    const nextModels = { ...selectedModels, [id]: model }
    if (!model) delete nextModels[id]
    onChange(selectedWorkerIds, nextModels, selectedEfforts)
  }

  const setWorkerEffort = (id: string, effort: string): void => {
    const nextEfforts = { ...selectedEfforts, [id]: effort }
    if (!effort) delete nextEfforts[id]
    onChange(selectedWorkerIds, selectedModels, nextEfforts)
  }

  const selectAll = (): void => {
    onChange([], {}, {})
  }

  return (
    <Pill
      ariaLabel="Piece workers"
      title="Select which workers may run decomposed pieces, and their models"
      align="right"
      muted={selectedWorkerIds.length === 0}
      label={label}
      menu={() => (
        <div className="workers-menu">
          <div className="workers-menu-head">
            <span className="workers-menu-title">Workers & Models</span>
            {selectedWorkerIds.length > 0 && (
              <button type="button" className="workers-menu-action" onClick={selectAll}>
                Reset to Auto (All)
              </button>
            )}
          </div>
          <div className="workers-menu-list">
            {workers.map((w) => {
              const isChecked = selectedWorkerIds.includes(w.id)
              const forAdapter = modelOptions.find((o) => o.adapterId === w.adapterId)
              const models = forAdapter?.models ?? []
              const selectedModel = selectedModels[w.id] ?? ''
              const effectiveModel = models.find((m) => m.id === selectedModel)
              const canEffort = forAdapter?.selectableEffort ?? false
              const effortLevels = canEffort ? (effectiveModel?.effortLevels ?? []) : []
              const selectedEffort = selectedEfforts[w.id] ?? ''

              return (
                <div key={w.id} className="workers-menu-item">
                  <label className="workers-menu-worker-row">
                    <div className="workers-menu-worker-info">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleWorker(w.id)}
                      />
                      <span className="workers-menu-worker-name">{w.label}</span>
                    </div>
                  </label>
                  {(isChecked || selectedWorkerIds.length === 0) && (
                    <div className="workers-menu-model-row">
                      <select
                        aria-label={`Model for ${w.label}`}
                        className="workers-menu-model-select"
                        value={selectedModel}
                        onChange={(e) => setWorkerModel(w.id, e.target.value)}
                      >
                        <option value="">
                          CLI default (
                          {w.defaultModel
                            ? (modelLabel(w.defaultModel) ?? w.defaultModel)
                            : 'default'}
                          )
                        </option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {modelLabel(m.id) ?? m.id}
                          </option>
                        ))}
                      </select>
                      {effortLevels.length > 0 && (
                        <select
                          aria-label={`Effort for ${w.label}`}
                          className="workers-menu-model-select"
                          value={selectedEffort}
                          onChange={(e) => setWorkerEffort(w.id, e.target.value)}
                        >
                          <option value="">Default effort</option>
                          {effortLevels.map((l) => (
                            <option key={l} value={l}>
                              {effortLabel(l) ?? l}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    />
  )
}
