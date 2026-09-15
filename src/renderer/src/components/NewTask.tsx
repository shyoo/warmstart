import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FinishPolicyChoice,
  Project,
  SessionSharingChoice,
  Task,
  WorkspaceModeChoice
} from '@shared/tasks'
import {
  FINISH_LABELS,
  FINISH_ORDER,
  FINISH_SHORT,
  MAX_DEBATE_ROUNDS,
  MAX_DEBATE_SEATS,
  MIN_DEBATE_ROUNDS,
  MIN_DEBATE_SEATS,
  SHARING_LABELS,
  SHARING_SHORT,
  WORKSPACE_MODE_LABELS,
  projectWorkspaceModeChoice,
  resolveModelChoice,
} from '@shared/tasks'
import type { DebateExchange, DebateSeat } from '@shared/tasks'
import { resolveFinishPolicy, resolveSessionSharing } from '@shared/policy'
import type { DebatePreview, ModelOptions, Settings } from '@shared/protocol'
import type { ModelReportRow } from '@shared/routing'
import { canWork } from '@shared/protocol'
import { debateNotices } from '../lib/debatenotice'
import { ImageChips, usePastedImages } from '../lib/pasteimages.js'
import { rpc, type FleetEntry } from '../lib/daemon'
import { isSubmitKey, useUiSettings } from '../lib/uisettings'
import { candidatesFor, useTaskCandidates } from './Dependencies'
import { effortLabel, modelLabel } from '../lib/modelname'
import { taskLabelShort } from '../lib/taskview'
import { Pill, PillOptions, PillSelect, SegmentedControl, type PillOption } from './Pill'
import {
  MAX_PIECES,
  MIN_PIECES,
  modelChoiceFor,
  readComposerPrefs,
  rememberModelChoice,
  writeComposerPrefs,
  type ComposerKind,
  type ComposerPrefs,
  type ModelPolicy
} from '../lib/composerprefs'
import {
  EMPTY_SCRATCH,
  readComposerScratch,
  scratchAttachments,
  scratchImages,
  writeComposerScratch,
  type ScheduleOption
} from '../lib/composerscratch'
import { errorMessage } from '@shared/errors.js'
import { useIsRemote } from '../lib/target'

/**
 * When a task is allowed to start, as offered on the clock beside Send.
 *
 * ⚠️ `now` is not a schedule and never becomes `notBefore`. It is the absence of one, kept in the
 * same list so that turning a scheduled send back off is one click in the place that armed it
 * rather than a separate control somewhere else.
 *
 * ⚠️ Declared in `composerscratch.ts` rather than here, because it is one of the values that has
 * to survive leaving this screen — and a persisted union needs its members somewhere the reader
 * that validates them can see.
 */

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
 * ⚠️ Four. Multi-task belongs here next and is deliberately not listed yet: an option that files
 * nothing is worse than a missing one, because somebody picks it and nothing happens.
 */
const KIND_OPTIONS: PillOption[] = [
  // ⚠️ Named for what it is *not*. Beside Plan&Split, which files several tasks, plain "Task"
  // read as the category rather than as one of three shapes — "Single Task" says the difference the
  // option next to it is offering.
  { value: 'task', label: 'Single Task', hint: 'one thread of work, dispatched to an agent' },
  {
    value: 'plan',
    label: 'Plan&Split',
    hint: 'an agent plans it with you, then files and delegates the pieces'
  },
  {
    value: 'conversation',
    label: 'Conversation',
    hint: 'a thread you keep talking in — it stops after each turn and commits when you say so'
  },
  {
    value: 'debate',
    label: 'Debate',
    hint: 'several agents answer independently, then argue it out under an organizer'
  }
]

/**
 * ⛔ Starts at 2 and stops at 5, and both ends are the daemon's own. A debate of one is an ordinary
 * task and cheaper; five is `ROOT_MANDATE.maxChildren`, which is what `createTask` enforces, so the
 * number on the pill is the number that will be allowed.
 */
const SEAT_OPTIONS: PillOption[] = Array.from(
  { length: MAX_DEBATE_SEATS - MIN_DEBATE_SEATS + 1 },
  (_, i) => ({ value: String(MIN_DEBATE_SEATS + i), label: `${MIN_DEBATE_SEATS + i} seats` })
)

/** ⚠️ 1–3 is where the published gain lives; 4–5 sit behind the diminishing-return notice. */
const ROUND_OPTIONS: PillOption[] = Array.from(
  { length: MAX_DEBATE_ROUNDS - MIN_DEBATE_ROUNDS + 1 },
  (_, i) => {
    const n = MIN_DEBATE_ROUNDS + i
    return {
      value: String(n),
      label: n === 1 ? '1 round' : `up to ${n} rounds`,
      ...(n > 3 ? { hint: 'published gains flatten past about 3–4 rounds' } : {})
    }
  }
)

/** D4, the operator's pill. ⚠️ Data in `debate_json`, never a branch on a seat count. */
const EXCHANGE_OPTIONS: PillOption[] = [
  { value: 'full', label: 'Verbatim', hint: 'each seat reads every other position word for word' },
  { value: 'digest', label: 'Organizer’s digest', hint: 'each seat reads only the brief written for it' }
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

/**
 * The two answers on the model pill that are not a model.
 *
 * ⛔ **Both used to be the same empty string, and an operator could not tell which they had asked
 * for.** Filing with no model hands the choice to the router, which on an account with a
 * routable-model allowlist dispatches a model nobody on this screen ever saw — measured on a
 * CodexFirst pin that read *Inherit — GPT 5.6 Sol* and ran GPT 5.6 Terra. Neither answer was wrong;
 * the pill was offering one word for two of them.
 *
 * ⚠️ Prefixed rather than bare, because every other value on this control is a model id sent to a
 * CLI verbatim, and `auto` is a plausible name for one.
 */
const MODEL_AUTO = 'policy:auto'
const MODEL_INHERIT = 'policy:inherit'

const ATTACH_OPTIONS: PillOption[] = [
  { value: 'file', label: 'Add a file or photo' },
  { value: 'folder', label: 'Add a folder' }
]

const KIND_SHORT: Record<ComposerKind, string> = {
  task: 'Single Task',
  plan: 'Plan&Split',
  conversation: 'Conversation',
  debate: 'Debate'
}

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
 * Grow or shrink a roster to `n` seats, keeping every seat somebody has already filled in.
 *
 * ⛔ **Ordered, and the order is load-bearing.** A roster is seat *1* is exactly this account, seat
 * *2* is exactly that one — not a set the scheduler may choose from — so growing appends and
 * shrinking drops from the end. Re-deriving the list would silently move a model somebody chose for
 * one account onto another, and the debate would run as a different fleet than the one on screen.
 */
export function resizeRoster(seats: DebateSeat[], n: number): DebateSeat[] {
  const want = Math.min(MAX_DEBATE_SEATS, Math.max(MIN_DEBATE_SEATS, n))
  if (seats.length === want) return seats
  if (seats.length > want) return seats.slice(0, want)
  return [
    ...seats,
    ...Array.from({ length: want - seats.length }, () => ({ workerId: '', model: null, effort: null }))
  ]
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
  preselectedProjectId,
  fleet,
  onClose,
  onDone,
  onError
}: {
  projects: Project[]
  /** The project in view when the composer opened. It remains editable. */
  preselectedProjectId?: string
  /** The accounts that could take this, so one can be pinned and its CLI's models offered. */
  fleet: FleetEntry[]
  /** Dismiss, drawn in this component's own head row beside the project it is filing into. */
  onClose: () => void
  onDone: () => void | Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  /**
   * What was left half-written here last time.
   *
   * ⛔ **Read once, at first render, and never filed as a task.** A composer that auto-saved a draft
   * would put rows in the fleet's table nobody asked to create; a composer that kept nothing lost a
   * paragraph every time somebody opened a task to look something up mid-sentence. See
   * `composerscratch.ts` for what is kept and what deliberately is not.
   */
  const scope = preselectedProjectId ?? ''
  const [restored] = useState(() => readComposerScratch(scope))
  const [prompt, setPrompt] = useState(restored.prompt)
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
  const [projectId, setProjectId] = useState(preselectedProjectId ?? '')
  /**
   * ⛔ Not remembered, unlike everything on the pill row. A prerequisite is a fact about *this* piece
   * of work, and a schedule is a moment that has usually passed by the next time the form opens —
   * a composer that quietly re-armed "in 4 hours" would file a task that goes nowhere and say
   * nothing about it.
   */
  const [dependsOn, setDependsOn] = useState<string[]>(restored.dependsOn)
  /**
   * ⛔ **Not a remembered pill.** Every other composer choice carries over to the next task, because
   * filing one task is good evidence about the next. Working in the trunk is the opposite: a
   * one-off chosen for a particular job, and a sticky `trunk` would put every later task in the
   * operator's checkout. It goes back to `inherit` after each send.
   */
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceModeChoice>('inherit')
  const [plannerFinishPolicy, setPlannerFinishPolicy] = useState<FinishPolicyChoice>('commit-and-merge')
  const [piecePriority, setPiecePriority] = useState<ComposerPrefs['priority']>('P2')
  const [pieceLimit, setPieceLimit] = useState<number>(5)
  const [pieceSessionSharing, setPieceSessionSharing] = useState<SessionSharingChoice>('on')
  const [pieceFinishPolicy, setPieceFinishPolicy] = useState<FinishPolicyChoice>('commit-and-merge')
  const [pieceWorkerIds, setPieceWorkerIds] = useState<string[]>([])
  const [pieceModels, setPieceModels] = useState<Record<string, string>>({})
  const [pieceEfforts, setPieceEfforts] = useState<Record<string, string>>({})
  /**
   * The roster, the round budget and the exchange rule, held as one so a seat change is one write.
   *
   * ⚠️ Seeded from `composerprefs` at first render like every other pill, and written back through
   * `setPrefs` so the row a person tuned is the row they meet next time.
   */
  const [debatePrefs, setDebatePrefsState] = useState(() => readComposerPrefs().debate)
  /** ⛔ From the daemon. The renderer does not compute money — see `task.estimatePreview`. */
  const [preview, setPreview] = useState<DebatePreview | null>(null)
  const [scheduleOption, setScheduleOption] = useState<ScheduleOption>(restored.schedule)
  const [customTime, setCustomTime] = useState(restored.customTime)
  const [saving, setSaving] = useState<'draft' | 'ready' | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentPickerRef = useRef<HTMLInputElement>(null)
  const remoteFleet = useIsRemote()

  /**
   * ⚠️ Focus lands in the prompt, not on the close button. This opens as a modal over the whole
   * window, and the one thing everybody who opened it came to do is type — including anyone
   * returning to a paragraph the scratch kept, whose caret this puts at its end.
   */
  useEffect(() => {
    const box = textareaRef.current
    if (!box) return
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
  }, [])
  // ⚠️ Uploaded the moment they are added, so what the form carries is a list of ids.
  // ⚠️ Seeded from the scratch, which holds ids and no bytes: a restored attachment is the same
  // upload wearing a name instead of a thumbnail.
  const paste = usePastedImages(useMemo(() => scratchImages(restored), [restored]))

  /**
   * ⛔ Fetched, not compiled in. The renderer holds no cost models, and a second table of model facts
   * here would drift from the first the day a model was added to a file and not to this bundle.
   */
  const [options, setOptions] = useState<ModelOptions[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [modelFitness, setModelFitness] = useState<ModelReportRow[]>([])
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
    /**
     * ⛔ **For ordering the organizer picker, and for nothing else.** A judge's own failure mode is
     * preferring what looks familiar to it, and the answer published work gives is to use the
     * strongest judge available — so the Debate row sorts accounts by the fitness this fleet has
     * already measured and says so. ⚠️ Advisory: `fitness` gates nothing here, exactly as it gates
     * nothing in `objective.ts`, and a fleet with no measurements simply keeps its own order.
     */
    void rpc('routing.models')
      .then((report) => setModelFitness(report.rows))
      .catch(() => setModelFitness([]))
  }, [])

  /**
   * Keep the scratch in step with the box.
   *
   * ⛔ On every change rather than on unmount. A cleanup does not run when the window is closed or
   * the app is quit, and "I typed a paragraph and it went" is the same complaint whichever of those
   * happened. Each write is a few hundred bytes to `localStorage` and is guarded internally.
   *
   * ⚠️ The pill row is not in here. Priority, worker, model and the rest are already remembered by
   * `composerprefs`, which is a different kind of memory — those are how this operator files *every*
   * task, and these are the one they are in the middle of.
   */
  useEffect(() => {
    writeComposerScratch(scope, {
      prompt,
      dependsOn,
      schedule: scheduleOption,
      customTime,
      attachments: scratchAttachments(paste.images)
    })
  }, [scope, prompt, dependsOn, scheduleOption, customTime, paste.images])

  /** One place writes the remembered state, so nothing can update the pill and forget the disk. */
  const setPrefs = (next: ComposerPrefs): void => {
    setPrefsState(next)
    writeComposerPrefs(next)
  }

  /** ⚠️ The same rule one level down: the Debate row is remembered exactly like the pills above it. */
  const setDebatePrefs = (next: ComposerPrefs['debate']): void => {
    setDebatePrefsState(next)
    setPrefs({ ...prefs, debate: next })
  }

  const selectedProject = projectId ? (projects.find((p) => p.id === projectId) ?? null) : null
  const inheritedFinish = resolveFinishPolicy(null, selectedProject, settings?.finishPolicy)
  const inheritedWorkspace = projectWorkspaceModeChoice(selectedProject)
  const inheritedSharing = resolveSessionSharing(null, selectedProject, settings?.sessionSharing)
  const inheritedFinishShort = inheritedFinish.policy
    ? (FINISH_SHORT[inheritedFinish.policy] ?? inheritedFinish.policy)
    : 'Await human'
  const inheritedFinishLong = inheritedFinish.policy
    ? (FINISH_LABELS[inheritedFinish.policy] ?? inheritedFinish.policy)
    : 'agent lands it'
  const inheritedSharingShort = SHARING_SHORT[inheritedSharing.sharing] ?? inheritedSharing.sharing
  const inheritedSharingLong = SHARING_LABELS[inheritedSharing.sharing] ?? inheritedSharing.sharing

  // ⛔ Only accounts that could actually take work. Offering a switched-off worker or a controller-only
  // worker as a pin produces a task that waits forever on a candidate loop that will never match it.
  const pinnable = fleet.filter((e) => e.worker.enabled && canWork(e.worker.role)).map((e) => e.worker)
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
  /**
   * What to do when no model is named — the router's choice, or the account's own default.
   *
   * ⚠️ Only asked while `model` is empty. A pin answers the question, and a pill showing a policy
   * beside a pinned model would be reporting a setting that changes nothing.
   */
  const modelPolicy: ModelPolicy = model ? 'auto' : remembered.policy
  const resolved = resolveModelChoice({ model: model || undefined }, pinned, canSetEffort)
  const effectiveModel = forAdapter?.models.find((m) => m.id === (resolved.model ?? '')) ?? null
  const efforts = canSetEffort ? (effectiveModel?.effortLevels ?? []) : []
  const effort = efforts.includes(remembered.effort) ? remembered.effort : ''

  const hasMultiPoolDefaults =
    pinned?.defaultModels && Object.values(pinned.defaultModels).filter(Boolean).length > 1
  // ⚠️ With no account pinned there is no one default to name, and "CLI default" would name the
  // wrong thing — each account has its own. The pill says whose default it means instead.
  const inheritedModelLabel = !pinned
    ? 'Account default'
    : hasMultiPoolDefaults
      ? 'Auto-balance'
      : (modelLabel(pinned.defaultModel) ?? 'CLI default')
  const inheritedEffortLabel = effortLabel(pinned?.defaultEffort) ?? 'CLI default'

  /**
   * The model control's three kinds of answer, in one list both rows draw from.
   *
   * ⛔ The planner row and the ordinary row share `model`, `modelPolicy` and `chooseModel`, so they
   * have to offer the same options. They did not: the plan row offered `''` for inherit, which is
   * not a value this control has any more, and picking the account's default there was unreachable.
   */
  const modelPillValue = model || (modelPolicy === 'inherit' ? MODEL_INHERIT : MODEL_AUTO)
  const modelPillLabel = model
    ? (modelLabel(model) ?? model)
    : modelPolicy === 'inherit'
      ? inheritedModelLabel
      : 'Auto Model'
  const modelPillOptions: PillOption[] = [
    {
      value: MODEL_AUTO,
      label: 'Auto Model',
      hint: pinned
        ? `the scheduler scores each of ${pinned.label}’s routable models and dispatches the winner`
        : 'the scheduler picks the account, then scores that account’s routable models'
    },
    {
      value: MODEL_INHERIT,
      label: `Inherit — ${inheritedModelLabel}`,
      hint: pinned
        ? 'this account’s own default model; the router is not asked'
        : 'whichever account is chosen uses its own default model'
    },
    // ⚠️ Named for reading, valued by id — what is sent is the exact string the CLI takes.
    ...(forAdapter?.models ?? []).map((m) => ({
      value: m.id,
      label: modelLabel(m.id) ?? m.id,
      hint: m.id
    }))
  ]

  const kind = prefs.kind
  const isPlan = kind === 'plan'
  /**
   * ⛔ A conversation's Finish and Conversation pills are not disabled, they are **absent**. Both
   * answers come from the kind — `resolveFinishPolicy` reads `await-human` and
   * `resolveSessionSharing` reads `on` off a conversation task, above the project and the fleet — so
   * a control showing either would be offering a choice that is not on the table. The rest of the
   * row is unchanged: priority, project, dependencies, worker and model all still mean what they
   * always did on a conversation.
   */
  const isConversation = kind === 'conversation'
  const isDebate = kind === 'debate'
  /**
   * ⛔ **The seats as they will actually be filed**, clamped to what the daemon accepts. The roster
   * is an *ordered* list of exactly-one-(account, model, effort) pins, not a candidate set — so an
   * entry naming an account this fleet no longer has is dropped rather than sent, and a roster left
   * short of two seats cannot be filed at all.
   */
  /**
   * ⭐ **A lens is offered only on a one-family roster, and filed only when offered.** Published
   * work finds the gain of debate comes from different model families; when the roster has one,
   * an evidence base per seat is the only diversity left to buy, and it is bought as *what to
   * examine*, never *what to hold* (`seatPromptFor`). With two families in the room the roster has
   * already bought its diversity and an assigned role would re-introduce the role-variance penalty
   * the same work measures — so the field is not shown, and a lens typed before a second family
   * was added is not sent. Counted on the adapter by the daemon (`DebatePreview.adapterSpread`),
   * which is the only place an account resolves to one.
   */
  const lensesOffered = preview?.adapterSpread === 1
  const filedSeats: DebateSeat[] = debatePrefs.seats.map((seat) => ({
    workerId: seat.workerId,
    ...(seat.model ? { model: seat.model } : {}),
    ...(seat.effort ? { effort: seat.effort } : {}),
    ...(lensesOffered && seat.lens?.trim() ? { lens: seat.lens.trim() } : {})
  }))
  /** The roster without its lenses: what the cost preview is keyed on, since a lens prices nothing. */
  const pinsKey = JSON.stringify(filedSeats.map(({ workerId, model, effort }) => [workerId, model, effort]))
  const rosterComplete =
    filedSeats.length >= MIN_DEBATE_SEATS &&
    filedSeats.every((seat) => pinnable.some((w) => w.id === seat.workerId))
  const depTasks = dependsOn
    .map((id) => candidateTasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t)


  /**
   * What this debate would cost, before it exists.
   *
   * ⛔ **Fetched, never computed here.** `task.estimatePreview` reuses `complexityOf` and
   * `estimateTask` unchanged; the only new thing about it is that it accepts a description instead
   * of a row, because the whole point of the cost notice is that it appears before anything is
   * filed. ⚠️ A failed preview clears the notice rather than showing a stale one — a cost figure
   * that belongs to a roster somebody has since changed is worse than no figure.
   */
  useEffect(() => {
    if (!isDebate || !rosterComplete) {
      setPreview(null)
      return
    }
    let live = true
    void rpc('task.estimatePreview', {
      title: prompt.trim() || 'a debate',
      projectId: projectId || null,
      kind: 'debate',
      seats: filedSeats.map(({ workerId, model, effort }) => ({ workerId, model, effort })),
      rounds: debatePrefs.rounds,
      organizerWorkerId: prefs.workerId || null,
      organizerModel: model || null
    })
      .then((p) => {
        if (live) setPreview(p)
      })
      .catch(() => {
        if (live) setPreview(null)
      })
    return () => {
      live = false
    }
    // ⚠️ On the roster rather than on every keystroke: the estimate is sized from the task's
    // complexity band, which a word in the prompt does not move, and one RPC per character would be
    // a request storm for a figure that would not change. And keyed without the lens: it prices
    // nothing, and its keystrokes would refetch the figure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDebate, rosterComplete, projectId, debatePrefs.rounds, pinsKey, prefs.workerId, model])

  /**
   * The Worker pill's options, and on a debate the order they are in.
   *
   * ⛔ **Sorted by the fitness this fleet has measured, and it says so — advisory, never a gate.**
   * The organizer *judges*, and a judge is what makes a diverse roster pay off; published work also
   * finds judges favour their own generations, which is why the hint names the adapter as well as
   * the score. A weak organizer is not refused, and an unmeasured account is not demoted below a
   * measured bad one — it keeps the fleet's own order, because `null` is unknown and not zero.
   */
  const bestFitnessFor = (workerId: string): number | null => {
    const scores = modelFitness
      .filter((r) => r.workerId === workerId && r.fitness !== null)
      .map((r) => r.fitness as number)
    return scores.length > 0 ? Math.max(...scores) : null
  }
  const organizerOptions: PillOption[] = [
    { value: '', label: 'Auto Worker', hint: 'the scheduler picks' },
    ...[...pinnable]
      .sort((a, b) => (bestFitnessFor(b.id) ?? -1) - (bestFitnessFor(a.id) ?? -1))
      .map((w) => {
        const fitness = bestFitnessFor(w.id)
        return {
          value: w.id,
          label: w.label,
          hint:
            fitness !== null
              ? `fitness ${fitness.toFixed(2)} · ${w.adapterId}`
              : `not measured yet · ${w.adapterId}`
        }
      })
  ]

  const chooseWorker = (workerId: string): void => {
    // ⛔ The model is not cleared, it is *re-read for the account now pinned*. Clearing was right
    // when there was one model slot — an id belongs to one CLI and would be handed to an adapter
    // that cannot start on it — but it also threw away a choice somebody had made, every time they
    // looked at another account. `byWorker` keeps both properties.
    setPrefs({ ...prefs, workerId })
  }

  const chooseModel = (next: string): void => {
    // ⚠️ Two of the options on this pill are not models. Picking one clears the pin and records
    // *which* of the two answers was meant, which is the whole point of them being separate.
    if (next === MODEL_AUTO || next === MODEL_INHERIT) {
      const policy: ModelPolicy = next === MODEL_INHERIT ? 'inherit' : 'auto'
      setPrefs(rememberModelChoice(prefs, prefs.workerId, { model: '', effort, policy }))
      return
    }
    const levels = forAdapter?.models.find((m) => m.id === next)?.effortLevels ?? []
    // ⚠️ The effort survives a model change only where the new model has that level. Anything else
    // would send a level the CLI would refuse, or silently keep one the pill has stopped showing.
    const keptEffort = canSetEffort && levels.includes(effort) ? effort : ''
    setPrefs(
      rememberModelChoice(prefs, prefs.workerId, {
        model: next,
        effort: keptEffort,
        policy: modelPolicy
      })
    )
  }

  const chooseEffort = (next: string): void => {
    setPrefs(rememberModelChoice(prefs, prefs.workerId, { model, effort: next, policy: modelPolicy }))
  }

  const submit = async (targetStatus: 'draft' | 'ready'): Promise<void> => {
    setSaving(targetStatus)
    try {
      if (isPlan) {
        const notBefore = plannedStart(scheduleOption, customTime, readClock())
        if (notBefore === 'invalid') {
          onError('Pick a date and time for the scheduled send, or set the clock back to Send now')
          setSaving(null)
          return
        }
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
          status: targetStatus,
          ...(notBefore ? { notBefore } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          maxChildren: pieceLimit,
          childDefaults: {
            priority: piecePriority,
            finishPolicy: pieceFinishPolicy,
            sessionSharing: pieceSessionSharing,
            maxChildren: pieceLimit,
            // ⛔ All three, and they are what `applySplit` actually files each piece with. The
            // efforts used to be sent in `pieceConstraints` only, so a split read from
            // `childDefaults` — which is the field `task_split` is handed — silently lost them.
            ...(pieceWorkerIds.length > 0 ? { workerIds: pieceWorkerIds } : {}),
            ...(Object.keys(pieceModels).length > 0 ? { modelsByWorker: pieceModels } : {}),
            ...(Object.keys(pieceEfforts).length > 0 ? { effortsByWorker: pieceEfforts } : {})
          },
          constraints: {
            ...(prefs.workerId ? { workerId: prefs.workerId } : {}),
            ...(model ? { model } : {}),
            ...(modelPolicy === 'inherit' && !model ? { modelPolicy: 'inherit' as const } : {}),
            ...(effort ? { effort } : {}),
            piecePriority,
            pieceLimit,
            pieceFinishPolicy,
            pieceSessionSharing,
            ...(pieceConstraints ? { pieceConstraints } : {})
          }
        })
      } else if (isDebate) {
        const notBefore = plannedStart(scheduleOption, customTime, readClock())
        if (notBefore === 'invalid') {
          onError('Pick a date and time for the scheduled send, or set the clock back to Send now')
          setSaving(null)
          return
        }
        /**
         * ⛔ **One call files the task and seats it.** A debate's round 1 *is* the seats answering
         * blind, so there is no first organizer turn that opens them — the organizer is woken by
         * the `settled` edges once every seat has answered, and costs nothing while it waits.
         *
         * ⚠️ The daemon answers `{ ok: false, reason }` rather than throwing on a roster it will
         * not take, so the refusal has to be read out of the result. A composer that treated a
         * declined debate as a send would clear the prompt somebody has to retype.
         */
        const filed = await rpc('task.debate', {
          title: prompt.trim(),
          projectId: projectId || null,
          ...(paste.ids.length > 0 ? { attachmentIds: paste.ids } : {}),
          priority: prefs.priority,
          finishPolicy: prefs.finishPolicy,
          status: targetStatus,
          ...(notBefore ? { notBefore } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          seats: filedSeats,
          rounds: debatePrefs.rounds,
          exchange: debatePrefs.exchange,
          // ⚠️ The organizer's own pin: a debate task is its organizer, so this is the ordinary
          // Worker and Model answer rather than a second control saying the same thing.
          ...(prefs.workerId || model || effort || modelPolicy === 'inherit'
            ? {
                constraints: {
                  ...(prefs.workerId ? { workerId: prefs.workerId } : {}),
                  ...(model ? { model } : {}),
                  ...(modelPolicy === 'inherit' && !model ? { modelPolicy: 'inherit' as const } : {}),
                  ...(effort ? { effort } : {})
                }
              }
            : {})
        })
        if (!filed.ok) {
          onError(filed.reason ?? 'This debate could not be filed.')
          setSaving(null)
          return
        }
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
          // ⚠️ `inherit` on a conversation, and that is the value that *means* something: the kind
          // answers both of these, and it can only keep answering them while nothing has been
          // written over the top. See `isOpenConversation`.
          finishPolicy: isConversation ? 'inherit' : prefs.finishPolicy,
          sessionSharing: isConversation ? 'inherit' : prefs.sessionSharing,
          ...(workspaceMode !== 'inherit' ? { workspaceMode } : {}),
          ...(isConversation ? { kind: 'conversation' as const } : {}),
          status: targetStatus,
          ...(notBefore ? { notBefore } : {}),
          // ⚠️ Absent, not empty here too - `dependsOn: []` is an empty list of edges, which is what
          // the daemon would do anyway, but sending one says a choice was made where none was.
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          // ⚠️ Absent, not empty. The daemon reads a *present* `constraints` as an instruction to
          // validate one, and an object of empty strings would be three constraints that name
          // nothing rather than three questions left to the scheduler.
          // ⚠️ `modelPolicy: 'inherit'` counts as a constraint on its own — it is the one answer on
          // that pill the daemon cannot infer from silence, since silence is what `auto` means.
          ...(prefs.workerId || model || effort || modelPolicy === 'inherit'
            ? {
                constraints: {
                  ...(prefs.workerId ? { workerId: prefs.workerId } : {}),
                  ...(model ? { model } : {}),
                  ...(modelPolicy === 'inherit' && !model ? { modelPolicy: 'inherit' as const } : {}),
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
      setWorkspaceMode('inherit')
      setScheduleOption('now')
      setCustomTime('')
      paste.clear()
      // ⛔ Explicitly, and not only through the effect above. The task now owns those attachment
      // ids, and a scratch that outlived the send would re-attach them to the next one.
      writeComposerScratch(scope, EMPTY_SCRATCH)
      await onDone()
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setSaving(null)
    }
  }

  const armed = scheduleOption !== 'now'
  // ⛔ A send waits for an upload. Otherwise a click between selecting a file and its RPC completing
  // would create the task without the context the person just chose.
  // ⛔ And a debate additionally waits for a roster the daemon would accept. Sending a half-filled
  // one would file an organizer with nothing to arbitrate — a task nothing can ever release.
  const canSend =
    !saving && !paste.busy && prompt.trim().length > 0 && !!projectId && (!isDebate || rosterComplete)
  const sendLabel =
    saving === 'ready'
      ? '…'
      : armed
          ? 'Schedule'
          : isPlan
            ? 'Plan & Split'
          : isDebate
            ? 'Open Debate'
          : isConversation
            ? 'Start'
            : 'Send'

  return (
    <div className="composer">
      {/*
        ⛔ **The project is the first control, not one of the pills.** It is the only setting with no
        usable default — it decides the workspace, the branch and the policy every other control
        inherits from, and `Send` is disabled until it is answered. On the pill row under the prompt
        it read as one more remembered preference and sat at the far end of a line the eye has
        already left; here it is where the person looks first, and it still just says its answer.
      */}
      <header className="composer-head">
        <h2 id="new-task-title">New task</h2>
        <PillSelect
          className="composer-head-project"
          ariaLabel="Project"
          title="The project this task belongs to. It supplies the workspace, branch and project policy. Preselected from the project you were looking at, and always changeable."
          muted={!projectId}
          value={projectId}
          label={
            <>
              {projectId ? (projectNames.get(projectId) ?? projectId) : 'Choose project'}
              <span className="project-picker-caret" aria-hidden="true"> ▼</span>
            </>
          }
          options={[
            {
              value: '',
              label: 'Choose project',
              hint: 'required before this task can be saved or sent'
            },
            ...projects.map((p) => ({ value: p.id, label: p.name }))
          ]}
          onChange={setProjectId}
        />
        <button
          className="dialog-close"
          aria-label="Close new task"
          title="Close"
          onClick={onClose}
        >
          ×
        </button>
      </header>

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
              : isDebate
              ? 'Ask the question. Every seat answers it independently first, then reads the others under an organizer.'
              : isConversation
                ? 'Start the conversation. The agent answers and stops; you reply in the same thread, and commit when you are ready.'
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
            className="composer-attachment"
            ariaLabel="Add attachment"
            title="Add a file, photo, or folder"
            label="+"
            menu={(close) => (
              <PillOptions
                // ⚠️ A folder is attached by *path*, and the OS picker only knows this computer's disk;
                // on a remote fleet that path would name nothing. Files upload their bytes, so they stay.
                options={remoteFleet ? ATTACH_OPTIONS.filter((o) => o.value !== 'folder') : ATTACH_OPTIONS}
                value=""
                ariaLabel="Add attachment"
                onPick={(next) => {
                  close()
                  if (next === 'file') attachmentPickerRef.current?.click()
                  else if (next === 'folder') void paste.addFolders()
                }}
              />
            )}
          />
          <button
            className="btn btn--quiet"
            disabled={!canSend}
            title="File it without dispatching. A draft sits still until you promote it."
            onClick={() => void submit('draft')}
          >
            {saving === 'draft' ? '…' : 'Save as Draft'}
          </button>
          <button className="btn btn--primary" disabled={!canSend} onClick={() => void submit('ready')}>
            {sendLabel}
          </button>
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
        </div>
      </div>

      {/*
        ⛔ Under the prompt, and every one of them showing an answer rather than a label. A row of
        controls reading `Priority` `Finish` `Worker` would be a form again; reading `P1`
        `Commit·Verify·Merge` `Auto` it is a status line you can click, and the dim ones are the
        answers nobody has chosen.
      */}
      <div
        className={`composer-bar${isPlan ? ' composer-bar--plan' : ''}${isDebate ? ' composer-bar--debate' : ''}`}
        role="group"
        aria-label="Task settings"
      >
        {isDebate ? (
          /*
            ⛔ **Two rows, and the split is the feature.** The Organizer row is this task's own
            settings — it *is* the organizer — and the Seats row is the roster, which is an ordered
            list of exactly-one-(account, model, effort) pins rather than a set the scheduler may
            pick from. Reusing the piece-worker control here would let three seats land on one
            account and still be called a debate.
          */
          <table className="composer-plan-table">
            <tbody>
              <tr>
                <td>
                  <PillSelect
                    ariaLabel="What this files"
                    title="A debate seats several agents on one question, then arbitrates them."
                    muted={false}
                    value={kind}
                    label={KIND_SHORT[kind]}
                    options={KIND_OPTIONS}
                    onChange={(v) => setPrefs({ ...prefs, kind: v as ComposerKind })}
                  />
                </td>
                <th className="composer-plan-label">Organizer</th>
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
                  <Pill
                    ariaLabel="Wait for other tasks"
                    title="This debate is held at blocked until every task named here has completed."
                    muted={dependsOn.length === 0}
                    label={
                      dependsOn.length === 0
                        ? 'Depends on'
                        : dependsOn.length === 1
                          ? `Depends on t${depTasks[0]?.seq ?? '?'}`
                          : `Depends on [${dependsOn.length}] tasks`
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
                </td>
                <td>
                  <PillSelect
                    ariaLabel="Finish policy"
                    title={
                      'What happens if you send this organizer on to do the work. A debate that ' +
                      'stops at its agreement commits nothing whatever this says.'
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
                      ...FINISH_ORDER.map((p) => ({ value: p, label: FINISH_LABELS[p] }))
                    ]}
                    onChange={(v) => setPrefs({ ...prefs, finishPolicy: v as FinishPolicyChoice })}
                  />
                </td>
                <td>
                  <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                    <PillSelect
                      ariaLabel="Worker"
                      align="right"
                      title={
                        'Who arbitrates. Sorted by the fitness this fleet has measured, and an ' +
                        'organizer whose adapter is not the only one in the room is the stronger ' +
                        'choice — both advisory, neither a gate.'
                      }
                      muted={!prefs.workerId}
                      value={prefs.workerId}
                      label={pinned?.label ?? 'Auto Worker'}
                      options={organizerOptions}
                      onChange={chooseWorker}
                    />
                    <PillSelect
                      ariaLabel="Model"
                      align="right"
                      muted={!model}
                      value={modelPillValue}
                      label={modelPillLabel}
                      options={modelPillOptions}
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
                <td></td>
                <th className="composer-plan-label">Seats</th>
                <td>
                  <PillSelect
                    ariaLabel="Seats"
                    title="How many agents answer this question. Two to five — five is the fan-out cap this task is filed with, so the number here is the number that will be allowed."
                    value={String(debatePrefs.seats.length)}
                    label={`${debatePrefs.seats.length} seats`}
                    options={SEAT_OPTIONS}
                    onChange={(v) =>
                      setDebatePrefs({ ...debatePrefs, seats: resizeRoster(debatePrefs.seats, Number(v)) })
                    }
                  />
                </td>
                <td>
                  <PillSelect
                    ariaLabel="Rounds"
                    title="The round budget you authorise. The organizer may converge early — that only saves money — and may never ask for more."
                    muted={debatePrefs.rounds === 3}
                    value={String(debatePrefs.rounds)}
                    label={debatePrefs.rounds === 1 ? '1 round' : `≤${debatePrefs.rounds} rounds`}
                    options={ROUND_OPTIONS}
                    onChange={(v) => setDebatePrefs({ ...debatePrefs, rounds: Number(v) })}
                  />
                </td>
                <td>
                  <PillSelect
                    ariaLabel="Exchange"
                    title="What each seat reads from round 2 on: every other position word for word, or only the brief the organizer wrote for it."
                    muted={debatePrefs.exchange === 'full'}
                    value={debatePrefs.exchange}
                    label={debatePrefs.exchange === 'full' ? 'Verbatim' : 'Digest'}
                    options={EXCHANGE_OPTIONS}
                    onChange={(v) => setDebatePrefs({ ...debatePrefs, exchange: v as DebateExchange })}
                  />
                </td>
                <td>
                  <DebateRoster
                    workers={pinnable}
                    modelOptions={options}
                    seats={debatePrefs.seats}
                    lensesOffered={lensesOffered}
                    onChange={(seats) => setDebatePrefs({ ...debatePrefs, seats })}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        ) : !isPlan ? (
          <>
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
                    ? `Depends on t${depTasks[0]?.seq ?? '?'}`
                    : `Depends on [${dependsOn.length}] tasks`
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

            <span className="composer-gap" aria-hidden="true" />
            {selectedProject?.vcs === 'git' && (
              <SegmentedControl
                ariaLabel="Workspace"
                title={
                  'Where the agent works. Worktree: a pooled checkout on a branch of its own, landed ' +
                  'by the finish policy. Trunk: the project checkout itself, committing straight onto ' +
                  'the landing target — for trunk work, like pulling and resolving a conflict. One ' +
                  'trunk task runs at a time, and worktree landings into the trunk wait for it.' +
                  (workspaceMode === 'inherit' ? `\n\nInherited from the project: ${inheritedWorkspace}.` : '')
                }
                muted={workspaceMode === 'inherit'}
                value={workspaceMode}
                options={[
                  {
                    value: 'inherit',
                    label: `Project · ${inheritedWorkspace}`,
                    title: `Follow the project setting: ${WORKSPACE_MODE_LABELS[inheritedWorkspace]}`
                  },
                  { value: 'worktree', label: 'Worktree', title: WORKSPACE_MODE_LABELS.worktree },
                  { value: 'trunk', label: 'Trunk', title: WORKSPACE_MODE_LABELS.trunk }
                ]}
                onChange={(v) => setWorkspaceMode(v as WorkspaceModeChoice)}
              />
            )}

            {!isConversation && (
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
            )}

            {!isConversation && (
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
            )}

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

            {/*
              ⛔ **Never disabled, including on Auto Worker.** It used to be, on the reasoning that a
              model list belongs to one CLI and there is none to draw until an account is pinned.
              That is true of the *list* and false of the control: *let the router choose* and *use
              whatever the account defaults to* are answerable without knowing which account, and
              locking the pill said the opposite — that nothing about the model was decidable yet.
            */}
            <PillSelect
              ariaLabel="Model"
              align="right"
              title={
                forAdapter
                  ? 'Only models this account’s cost model can price are offered — one it cannot ' +
                    'price is one that cannot be gated, estimated for, or reasoned about the ' +
                    'context window of.'
                  : 'Pin an account to choose a model by name — a model list belongs to one CLI. ' +
                    'Auto and the account default are answerable either way.'
              }
              muted={!model}
              value={modelPillValue}
              label={modelPillLabel}
              options={modelPillOptions}
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
            <table className="composer-plan-table">
              <tbody>
                <tr>
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
                  <th className="composer-plan-label">Planner</th>
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
                    <Pill
                      ariaLabel="Wait for other tasks"
                      title="This task is held at blocked until every task named here has completed."
                      muted={dependsOn.length === 0}
                      label={
                        dependsOn.length === 0
                          ? 'Depends on'
                          : dependsOn.length === 1
                            ? `Depends on t${depTasks[0]?.seq ?? '?'}`
                            : `Depends on [${dependsOn.length}] tasks`
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
                      muted={plannerFinishPolicy === 'commit-and-merge'}
                      value={plannerFinishPolicy}
                      label={
                        plannerFinishPolicy === 'inherit'
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
                        muted={!model}
                        value={modelPillValue}
                        label={modelPillLabel}
                        options={modelPillOptions}
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
                  <td></td>
                  <th className="composer-plan-label">Executor</th>
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


      {isDebate && (
        /*
          ⛔ **Every notice carries its basis**, which is the rule this codebase applies to a routing
          score applied here to a piece of advice. None of them is a gate: not every operator has a
          second provider, and a gate that cannot be satisfied on a one-account fleet is a feature
          that cannot be used.
        */
        <ul className="composer-notices" aria-label="What this debate will cost and what to expect">
          {rosterComplete && preview ? (
            debateNotices(preview, debatePrefs.rounds).map((notice) => (
              <li key={notice.id} className={`composer-notice composer-notice--${notice.tone}`}>
                {notice.text}
              </li>
            ))
          ) : (
            <li className="composer-notice composer-notice--caution">
              Name an account for every seat. A debate needs at least {MIN_DEBATE_SEATS} of them, and the
              cost is only knowable once they are named.
            </li>
          )}
        </ul>
      )}

      <p className="composer-hint">
        {isPlan
          ? 'An agent plans this with you first — it reads the repository and asks what it needs to ' +
            'know. You approve the whole split before anything is filed. The pieces branch off this ' +
            'plan’s branch and merge back into it, and only the finished plan reaches the trunk.'
          : isDebate
            ? 'Each seat answers blind, in its own session — none of them can see another’s answer. The ' +
              'organizer then reads all of them, may send each a brief for another round, and finally ' +
              'reports an agreement with its dissent and asks you what happens next. Seats read and ' +
              'argue; they never commit.'
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


/**
 * The roster: one row per seat, each pinned to exactly one (account, model, effort).
 *
 * ⛔ **Not `WorkersPicker`, and the difference is the whole of §4.3.** That control answers *which
 * accounts may run a piece* — a closed list the scheduler picks from — and reusing it here would
 * let three seats land on one account and still be called a debate. This one answers *who sits in
 * seat 2*, which is a different question with a different shape.
 *
 * ⚠️ **A duplicate (account, model, effort) triple is allowed**, because a homogeneous debate is a
 * thing a one-account operator may well want. It is what the heterogeneity notice under this row
 * counts, and that notice is advice rather than a gate.
 */
function DebateRoster({
  workers,
  modelOptions,
  seats,
  lensesOffered,
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
  seats: DebateSeat[]
  /** ⚠️ True only on a one-family roster; see `lensesOffered` in the composer. */
  lensesOffered: boolean
  onChange: (seats: DebateSeat[]) => void
}): React.JSX.Element {
  const named = seats.filter((s) => s.workerId).length
  const label = named === 0 ? 'Roster' : named < seats.length ? `Roster ${named}/${seats.length}` : 'Roster'

  const set = (index: number, patch: Partial<DebateSeat>): void => {
    onChange(seats.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)))
  }

  return (
    <Pill
      ariaLabel="Debate roster"
      title="Who sits in each seat. A seat is exactly one account, model and effort — not a list the scheduler chooses from."
      align="right"
      muted={named < seats.length}
      label={label}
      menu={() => (
        <div className="workers-menu">
          <div className="workers-menu-head">
            <span className="workers-menu-title">Seats</span>
          </div>
          <div className="workers-menu-list">
            {seats.map((seat, i) => {
              const worker = workers.find((w) => w.id === seat.workerId) ?? null
              const forAdapter = worker ? (modelOptions.find((o) => o.adapterId === worker.adapterId) ?? null) : null
              const models = forAdapter?.models ?? []
              const canEffort = forAdapter?.selectableEffort ?? false
              const chosenModel = models.find((m) => m.id === (seat.model ?? ''))
              const effortLevels = canEffort ? (chosenModel?.effortLevels ?? []) : []
              return (
                <div key={`seat-${i}`} className="workers-menu-item">
                  <div className="workers-menu-worker-row">
                    <div className="workers-menu-worker-info">
                      <span className="workers-menu-worker-name">Seat {i + 1}</span>
                    </div>
                  </div>
                  <div className="workers-menu-model-row">
                    <select
                      aria-label={`Account for seat ${i + 1}`}
                      className="workers-menu-model-select"
                      value={seat.workerId}
                      onChange={(e) =>
                        // ⚠️ The model and effort go with the account, never across it: an id
                        // belongs to exactly one CLI, and keeping one would hand an adapter a model
                        // it cannot start on.
                        set(i, { workerId: e.target.value, model: null, effort: null })
                      }
                    >
                      <option value="">Choose an account…</option>
                      {workers.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                    {worker && (
                      <select
                        aria-label={`Model for seat ${i + 1}`}
                        className="workers-menu-model-select"
                        value={seat.model ?? ''}
                        onChange={(e) => set(i, { model: e.target.value || null, effort: null })}
                      >
                        <option value="">
                          CLI default (
                          {worker.defaultModel ? (modelLabel(worker.defaultModel) ?? worker.defaultModel) : 'default'}
                          )
                        </option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {modelLabel(m.id) ?? m.id}
                          </option>
                        ))}
                      </select>
                    )}
                    {effortLevels.length > 0 && (
                      <select
                        aria-label={`Effort for seat ${i + 1}`}
                        className="workers-menu-model-select"
                        value={seat.effort ?? ''}
                        onChange={(e) => set(i, { effort: e.target.value || null })}
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
                  {lensesOffered && worker && (
                    <div className="workers-menu-model-row">
                      <input
                        aria-label={`Lens for seat ${i + 1}`}
                        className="workers-menu-model-select"
                        type="text"
                        placeholder="Lens: what this seat examines first (optional)"
                        title="An evidence base, never a stance: what this seat is asked to read first and most carefully. It may still reach the answer every other seat reaches. Offered because every seat here is one model family."
                        value={seat.lens ?? ''}
                        onChange={(e) => set(i, { lens: e.target.value || null })}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {lensesOffered && (
            <div className="workers-menu-note">
              One model family in every seat, so a lens per seat is the diversity left to buy: an
              evidence base to examine first, never a position to hold.
            </div>
          )}
        </div>
      )}
    />
  )
}
