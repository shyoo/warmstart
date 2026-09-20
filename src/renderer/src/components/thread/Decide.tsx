/**
 * The cards that ask the operator for something, above the composer where they cannot be missed.
 *
 * ⛔ **A decision card is drawn from what the daemon says, never from what was clicked.** Each of
 * these can be refused — a landing that does not land, an override that cannot lift an exhausted
 * window — and the refusal is what is shown. ⚠️ `QuotaOverride` draws a `Fact` row, which is the
 * only reason this file imports from `Facts.tsx`.
 */
import { canWork } from '@shared/protocol'
import { useCallback, useEffect, useState } from 'react'
import {
  FINISH_LABELS,
  FINISH_SHORT,
  type FinishPolicy,
  resolveModelChoice,
  type PendingWork,
  type ResolvedFinishPolicy,
  type Task,
  type WorkspaceMode
} from '@shared/tasks'
import type { ModelOptions } from '@shared/protocol'
import { rpc, useNow, type FleetEntry } from '../../lib/daemon'
import { SettingButtonSelect } from '../SettingButtonSelect'
import { SplitButton } from '../SplitButton'
import {
  COMMIT_FALLBACK,
  commitRungsForMode,
  defaultRung,
  effectiveWorkspaceMode,
  LAND_FALLBACK,
  landRungsForMode,
  rungOrigin,
  TRUNK_LAND_FALLBACK
} from '../../lib/finishrung'
import { duration } from '../../lib/format'
import { effortLabel, modelLabel } from '../../lib/modelname'
import {
  canRelandTask,
  holdLine,
  resolveRetryCauses,
  type ResolveRetryCause,
  reassignmentModel
} from '../../lib/taskview'
import { Fact } from './Facts'

/**
 * Quota decision card with Override, Resume, and Reassign controls.
 *
 * ⛔ Displayed around the composer / prompt area (matching `Decide`), because quota preemption
 * or gate holds require an operator decision: override the gate, wait for reset, or reassign.
 */
export function QuotaDecide({
  task,
  fleet,
  modelOptions,
  now,
  onStop,
  onRefresh
}: {
  task: Task
  fleet: FleetEntry[]
  modelOptions: ModelOptions[]
  now: number
  onStop?: () => Promise<void>
  onRefresh: () => Promise<void>
}): React.JSX.Element | null {
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>(task.constraints.workerId ?? '')
  const [selectedModel, setSelectedModel] = useState<string>(
    task.constraints.model ?? (task.constraints.modelPolicy === 'auto' ? '__auto__' : '')
  )
  const [selectedEffort, setSelectedEffort] = useState<string>(task.constraints.effort ?? '')
  // ⭐ What the operator wants said alongside the move, if anything. A reassignment used to be the
  // move alone: the successor got the thread's outstanding turns and nothing about *why* it was
  // being handed the work, so the operator had to reassign, wait for the run to open, and then
  // type the instruction into it. One box, sent as the person's own message on the same press.
  const [reassignNote, setReassignNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelectedWorkerId(task.constraints.workerId ?? '')
    setSelectedModel(task.constraints.model ?? (task.constraints.modelPolicy === 'auto' ? '__auto__' : ''))
    setSelectedEffort(task.constraints.effort ?? '')
  }, [task.constraints.workerId, task.constraints.model, task.constraints.modelPolicy, task.constraints.effort])

  const selectedWorker = fleet.find((e) => e.worker.id === selectedWorkerId)?.worker ?? null
  const selectedEntry = fleet.find((e) => e.worker.id === selectedWorkerId) ?? null
  const adapterOptions = modelOptions.find((o) => o.adapterId === selectedWorker?.adapterId)
  const offeredModels = adapterOptions?.models ?? []
  const canSetEffort = adapterOptions?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, selectedWorker, canSetEffort, selectedEntry?.quota).model
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === selectedModel)?.effortLevels ?? [])
    : []

  const isPaused = task.status === 'paused_quota'
  const isReadyHeld = task.status === 'ready' && /% of its .* window/i.test(task.holdReason ?? '')
  // This prefix is written only by the daemon's failed-turn quota path. Unlike a percentage
  // watermark, an explicit vendor refusal cannot be overridden locally.
  const vendorRefused = task.holdReason?.startsWith('Vendor refused this turn: ') ?? false
  const warning = task.status === 'running' ? task.quotaPreemptWarning : null
  const live = task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now

  if (!isPaused && !isReadyHeld && !warning && !live) return null

  // ⛔ Same `action: 'handoff'` either way — "pause" and "reassign" are told apart only by whether a
  // redirect destination rode along, never by a second action value. See `reassignWorkerId` on
  // `quotaPreemptWarning` (shared/tasks.ts).
  const handoffPauseActive = warning?.action === 'handoff' && warning.reassignWorkerId === undefined
  const handoffReassignActive = warning?.action === 'handoff' && warning.reassignWorkerId !== undefined
  const reassignMatchesSelection =
    handoffReassignActive && (warning?.reassignWorkerId ?? '') === selectedWorkerId

  const handleOverride = async (withdraw = false) => {
    setBusy(true)
    try {
      await rpc('task.overrideQuota', { id: task.id, ...(withdraw ? { until: null } : {}) })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleResume = async () => {
    setBusy(true)
    try {
      await rpc('task.resume', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handlePreemptionAction = async (action: 'compact' | 'handoff', reassignWorkerId?: string | null) => {
    setBusy(true)
    try {
      await rpc('task.overrideQuota', {
        id: task.id,
        preemptionAction: action,
        ...(reassignWorkerId !== undefined ? { reassignWorkerId } : {})
      })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleReassign = async () => {
    setBusy(true)
    try {
      const modelPolicy =
        selectedModel === '__auto__' ? 'auto' : !selectedModel || selectedModel === '__inherit__' ? 'inherit' : null
      const model = selectedModel === '__auto__' || selectedModel === '__inherit__' ? null : selectedModel || null
      // ⛔ One write. The scheduler can dispatch after the worker write, so a following model write
      // is too late — it was how an explicit Opus reassignment resumed on the account's Haiku default.
      await rpc('task.setWorker', {
        id: task.id,
        workerId: selectedWorkerId || null,
        ...(selectedWorkerId ? { model, modelPolicy, effort: selectedEffort || null } : {})
      })
      const note = reassignNote.trim()
      if (note) {
        // ⛔ The note is the resume. `task.message` requeues a `paused_quota` task itself
        // (`continueTask`) and, on a task still `ready` behind the gate, rides along undelivered
        // into the run the new account opens — so a second `task.resume` after it would find
        // nothing to resume and say so.
        await rpc('task.message', { id: task.id, text: note })
        setReassignNote('')
      } else if (isPaused) {
        await rpc('task.resume', { id: task.id })
      }
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const canReassign = isPaused || isReadyHeld

  return (
    <div className="decide decide--quota">
      <div className="decide-head">
        <span>
          {live
            ? 'quota gate — overridden'
            : isPaused
              ? 'quota gate — preempted'
              : warning
                ? 'quota gate — preemption warning'
                : 'quota gate — held'}
        </span>
        <span className="decide-why">
          {live
            ? `Overridden for ${duration((task.quotaOverrideUntil ?? 0) - now)}`
            : warning
              ? `${warning.action === 'compact' ? 'Compacts' : 'Hands off'} in ${duration(Math.max(0, warning.preemptAt - now))}: ${warning.reason}`
              : holdLine(task, now) || task.holdReason || 'Account is past quota watermark'}
        </span>
      </div>

      {live ? (
        <div className="decide-option">
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="Withdraw the quota override and restore normal quota enforcement."
            onClick={() => void handleOverride(true)}
          >
            Withdraw
          </button>
          <span className="decide-what">
            <strong>Override active.</strong> Overridden for{' '}
            {duration((task.quotaOverrideUntil ?? 0) - now)}. Withdraw restores the usual quota gate.
          </span>
        </div>
      ) : (
        <>
          {warning && (
            <div className="decide-option">
              <div className="decide-buttons">
                {warning.canCompact && (
                  <button
                    type="button"
                    className={warning.action === 'compact' ? 'btn btn--primary' : 'btn'}
                    disabled={busy || warning.action === 'compact'}
                    onClick={() => void handlePreemptionAction('compact')}
                  >
                    Compact & pause
                  </button>
                )}
                <button
                  type="button"
                  className={handoffPauseActive ? 'btn btn--primary' : 'btn'}
                  disabled={busy || handoffPauseActive}
                  onClick={() => void handlePreemptionAction('handoff')}
                >
                  Hand off & pause
                </button>
                <button
                  type="button"
                  className={handoffReassignActive ? 'btn btn--primary' : 'btn'}
                  disabled={busy || (handoffReassignActive && reassignMatchesSelection)}
                  title="Writes the same handoff, then moves this task to the account below (or lets the scheduler pick) instead of waiting for this account's own window."
                  onClick={() => void handlePreemptionAction('handoff', selectedWorkerId || null)}
                >
                  Hand off & reassign
                </button>
              </div>
              <div className="decide-what">
                <strong>Choose the wrap-up.</strong>{' '}
                {warning.canCompact
                  ? 'Compact preserves this conversation for its next run; either hand-off commits safe ' +
                    'work and briefs whichever agent picks it up next. '
                  : 'This account cannot compact, so the wrap-up is always a hand-off that commits safe ' +
                    'work and briefs whichever agent picks it up next. '}
                Pause waits for this account's own window to reopen; reassign moves on immediately to the
                account chosen below instead. The highlighted choice is the one that runs when the
                countdown expires.
                <div className="reassign-row">
                  <SettingButtonSelect
                    className="reassign-select"
                    value={selectedWorkerId}
                    disabled={busy}
                    ariaLabel="Redirect the hand-off to"
                    options={[
                      { value: '', label: 'Auto (scheduler decides)' },
                      ...fleet
                        .filter((e) => (e.worker.enabled && canWork(e.worker.role)) || e.worker.id === selectedWorkerId)
                        .map((e) => ({
                          value: e.worker.id,
                          label: `${e.worker.label} (${e.worker.adapterId})`
                        }))
                    ]}
                    onChange={setSelectedWorkerId}
                  />
                </div>
              </div>
            </div>
          )}
          {!vendorRefused && <div className="decide-option">
            <button
              type="button"
              className="btn btn--warn"
              disabled={busy}
              title={
                warning
                  ? 'Keep this run going until the quota window resets rather than wrapping it up now.'
                  : isPaused
                    ? 'Override preemption and resume this task immediately even though the account is at or past its window watermark.'
                    : 'Dispatch this task immediately even though the account is at or past its quota watermark.'
              }
              onClick={() => void handleOverride(false)}
            >
              {warning
                ? 'Override preemption'
                : isPaused
                  ? 'Override & continue'
                  : 'Run now anyway'}
            </button>
            <span className="decide-what">
              <strong>Override the quota gate.</strong>{' '}
              {warning
                ? `Keeps this run going until ${new Date(warning.resumeAt).toLocaleTimeString()} rather than wrapping it up now.`
                : isPaused
                  ? 'Resumes immediately and overrides the quota gate until the window resets.'
                  : 'Dispatches this task immediately even though the account is past its quota watermark.'}{' '}
              ⚠️ A turn the vendor actually refuses will still stop it.
            </span>
          </div>}

          {isPaused && (
            <div className="decide-option">
              <button
                type="button"
                className="btn"
                disabled={busy}
                title="Puts the task back in the queue right now without waiting for the reset timer (dispatches if quota is available)."
                onClick={() => void handleResume()}
              >
                Resume
              </button>
              <span className="decide-what">
                {vendorRefused ? (
                  <><strong>The vendor refused this turn.</strong> Resume retries it now, but it remains parked until the account's quota resets unless the vendor accepts it sooner.</>
                ) : (
                  <><strong>Resume without override.</strong> Puts the task back in the queue right now without waiting for the reset timer (dispatches if quota is available).</>
                )}
              </span>
            </div>
          )}

          {warning && onStop && (
            <div className="decide-option">
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                title="Stop the work now and return this task to a resting state."
                onClick={() => void onStop()}
              >
                Stop here
              </button>
              <span className="decide-what">
                <strong>Stop now.</strong> Parks the task in a resting state immediately without waiting
                for preemption. Destroys nothing.
              </span>
            </div>
          )}

          {canReassign && (
            <div className="decide-option">
              <button
                type="button"
                className="btn btn--primary"
                title="Reassigns this task to another worker or Auto and resumes it immediately."
                disabled={busy}
                onClick={() => void handleReassign()}
              >
                Reassign
              </button>
              <div className="decide-what">
                <div style={{ marginBottom: 'var(--sp-1)' }}>
                  <strong>Reassign to another agent.</strong> Switches worker or model{' '}
                  {isPaused ? 'and resumes immediately' : 'to continue with available quota'}.
                </div>
                <div className="reassign-row">
                  <SettingButtonSelect
                    className="reassign-select"
                    value={selectedWorkerId}
                    disabled={busy}
                    ariaLabel="Reassign worker"
                    options={[
                      { value: '', label: 'Auto (scheduler decides)' },
                      ...fleet
                        .filter((e) => (e.worker.enabled && canWork(e.worker.role)) || e.worker.id === selectedWorkerId)
                        .map((e) => ({
                          value: e.worker.id,
                          label: `${e.worker.label} (${e.worker.adapterId})`
                        }))
                    ]}
                    onChange={(nextWorkerId) => {
                      setSelectedWorkerId(nextWorkerId)
                      if (!nextWorkerId) {
                        setSelectedModel('')
                        setSelectedEffort('')
                      } else {
                        const w = fleet.find((entry) => entry.worker.id === nextWorkerId)?.worker
                        const offered = modelOptions.find((o) => o.adapterId === w?.adapterId)?.models ?? []
                        if (
                          selectedModel &&
                          selectedModel !== '__auto__' &&
                          selectedModel !== '__inherit__' &&
                          !offered.some((m) => m.id === selectedModel)
                        ) {
                          setSelectedModel(reassignmentModel(selectedModel, offered))
                          setSelectedEffort('')
                        }
                      }
                    }}
                  />

                  {offeredModels.length > 0 && (
                    <SettingButtonSelect
                      className="reassign-select"
                      value={selectedModel}
                      disabled={busy}
                      ariaLabel="Reassign model"
                      options={[
                        ...(offeredModels.length > 1
                          ? [{ value: '__auto__', label: 'Auto Model (scheduler decides)' }]
                          : []),
                        {
                          value: '',
                          label: inheritedModel
                            ? `account default (${modelLabel(inheritedModel) ?? inheritedModel})`
                            : 'CLI default model'
                        },
                        ...offeredModels.map((m) => ({ value: m.id, label: modelLabel(m.id) ?? m.id }))
                      ]}
                      displayLabel={
                        selectedModel === '__auto__'
                          ? 'Auto Model'
                          : !selectedModel || selectedModel === '__inherit__'
                            ? inheritedModel
                              ? (modelLabel(inheritedModel) ?? inheritedModel)
                              : 'CLI default model'
                            : undefined
                      }
                      onChange={(val) => {
                        setSelectedModel(val)
                        setSelectedEffort('')
                      }}
                    />
                  )}

                  {offeredEfforts.length > 0 && (
                    <SettingButtonSelect
                      className="reassign-select"
                      value={selectedEffort}
                      disabled={busy}
                      ariaLabel="Reassign effort"
                      options={[
                        {
                          value: '',
                          label: selectedWorker?.defaultEffort
                            ? `account default (${effortLabel(selectedWorker.defaultEffort)})`
                            : 'CLI default effort'
                        },
                        ...offeredEfforts.map((level) => ({
                          value: level,
                          label: effortLabel(level) ?? level
                        }))
                      ]}
                      onChange={(val) => setSelectedEffort(val)}
                    />
                  )}
                </div>
                <ReassignNote
                  value={reassignNote}
                  disabled={busy}
                  onChange={setReassignNote}
                  onSubmit={() => void handleReassign()}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The optional message that goes with a reassignment, sent as the person's own turn.
 *
 * ⚠️ Kept out of `.reassign-row`: that row is the one-line contract the selectors share, and this
 * is a second line by design. Ctrl/⌘+Enter presses the button beside it, as the composer does.
 */
function ReassignNote({
  value,
  disabled,
  onChange,
  onSubmit
}: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <textarea
      className="compose-input reassign-note"
      rows={1}
      value={value}
      disabled={disabled}
      aria-label="Message to send with the reassignment"
      placeholder="Optional: a message for the next agent, sent with Reassign…"
      title="Sent as your message on the same press, so the next run opens with it. Leave it empty to reassign and continue as-is."
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          onSubmit()
        }
      }}
    />
  )
}

/**
 * The two ways to settle a task that is waiting on a person, each next to what it actually does.
 *
 * ⛔ They were indistinguishable, and the tooltips were the reason: *"records that you are
 * satisfied"* and *"stops here and rests the task"* are two ways of saying **it stops**. The
 * difference is not in how it feels, it is in the DAG. `admit()` unblocks a dependent only when its
 * dependency reaches `completed`, so **Mark done releases everything waiting on this task and Stop
 * here does not** — and with nothing on screen saying so, the choice looked like a matter of taste
 * while it was quietly the difference between the rest of a plan running and not.
 *
 * ⚠️ The count is drawn, not implied. "2 tasks start" is a fact somebody can check; "unblocks
 * dependents" is a sentence they have to take on trust and cannot see the scope of.
 */
export function Decide({
  task,
  blocking,
  fleet,
  modelOptions,
  inheritedFinish,
  inheritedWorkspaceMode,
  onResolve,
  onStop,
  onRefresh
}: {
  task: Task
  blocking: number
  fleet: FleetEntry[]
  modelOptions: ModelOptions[]
  /**
   * What this task's *project* (else the fleet) says a finish does — the tier below the task itself.
   *
   * ⛔ Passed in rather than read off `resolvedFinish`, because on a conversation that answers
   * `await-human` from the kind and would make every settle-it button here default to doing nothing.
   * See `defaultRung`.
   */
  inheritedFinish?: ResolvedFinishPolicy
  /**
   * The project's resolved workspace mode, so the rung menus answer to where this task's work
   * actually sits. A trunk task's commits are already on the landing target, so the merge and
   * pull-request rungs are not offered (t583).
   */
  inheritedWorkspaceMode?: WorkspaceMode
  onResolve: () => Promise<void>
  onStop: () => Promise<void>
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>(task.constraints.workerId ?? '')
  const [selectedModel, setSelectedModel] = useState<string>(
    task.constraints.model ?? (task.constraints.modelPolicy === 'auto' ? '__auto__' : '')
  )
  const [selectedEffort, setSelectedEffort] = useState<string>(task.constraints.effort ?? '')
  // ⭐ Same box as the quota card's: the message that goes with the move. See `ReassignNote`.
  const [reassignNote, setReassignNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelectedWorkerId(task.constraints.workerId ?? '')
    setSelectedModel(task.constraints.model ?? (task.constraints.modelPolicy === 'auto' ? '__auto__' : ''))
    setSelectedEffort(task.constraints.effort ?? '')
  }, [task.constraints.workerId, task.constraints.model, task.constraints.modelPolicy, task.constraints.effort])

  const selectedWorker = fleet.find((e) => e.worker.id === selectedWorkerId)?.worker ?? null
  const selectedEntry = fleet.find((e) => e.worker.id === selectedWorkerId) ?? null
  const adapterOptions = modelOptions.find((o) => o.adapterId === selectedWorker?.adapterId)
  const offeredModels = adapterOptions?.models ?? []
  const canSetEffort = adapterOptions?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, selectedWorker, canSetEffort, selectedEntry?.quota).model
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === selectedModel)?.effortLevels ?? [])
    : []

  // ⚠️ Both numbers agree with their verb. "The 2 tasks waiting on it stays blocked" is the kind of
  // sentence somebody stops reading, and this one is load-bearing.
  const releases =
    blocking === 0
      ? 'No tasks depend on this one. It marks as completed.'
      : blocking === 1
        ? 'Releases the 1 dependent task to become ready for dispatch.'
        : `Releases the ${blocking} dependent tasks to become ready for dispatch.`
  const holds =
    blocking === 0
      ? 'No dependent tasks are waiting on this.'
      : blocking === 1
        ? 'The 1 dependent task stays blocked until completed.'
        : `The ${blocking} dependent tasks stay blocked until completed.`

  /**
   * What is sitting uncommitted in this task's workspace, for a conversation.
   *
   * ⛔ Fetched rather than derived, and only for the kind that needs it. Finish releases the
   * workspace, so on a conversation it can walk away from files nothing else on this page mentions —
   * see `PendingWork`. ⚠️ `null` while it is being read, which is *not* the same as "nothing there":
   * the Commit button appears when the answer arrives and the Finish warning with it, rather than
   * either being drawn on a guess.
   */
  const [pending, setPending] = useState<PendingWork | null>(null)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const conversation = task.kind === 'conversation'

  const readPending = useCallback(async (): Promise<void> => {
    if (!task.projectId) return
    try {
      const answer = await rpc('task.pendingWork', { id: task.id })
      setPending(answer)
      // ⚠️ An arming that outlives the thing it warned about is a trap. Once the tree is clean the
      // next press of Finish must be an ordinary press again.
      if (!answer.supported || !answer.hasDiff) setConfirmFinish(false)
    } catch {
      // ⚠️ A tree that cannot be read is not a tree with nothing in it. Leaving `pending` alone keeps
      // whatever the last successful read said rather than replacing it with a reassuring absence.
    }
  }, [task.id, task.projectId])

  // ⚠️ Re-read when the task moves, because every action on this card changes the tree: a commit
  // empties it, a reply can fill it again. `updatedAt` is the cheapest honest trigger.
  useEffect(() => {
    void readPending()
  }, [readPending, task.updatedAt])

  // ⚠️ `hasDiff` only, and only once the read has come back. `pending === null` means *not yet
  // known*, and drawing a warning or a Commit button off an unknown is how a card ends up telling
  // somebody there is nothing to lose a moment before there is.
  const uncommittedNow = conversation && pending?.supported === true && pending.hasDiff

  /**
   * Committed work sitting on the branch with nowhere to go.
   *
   * ⛔ **The state that had no button on this card at all.** Commit has nothing to ask an agent for,
   * Finish only records that a person is satisfied, and Retry landing is drawn solely after a landing
   * has already failed — so a conversation whose agent committed left its commits on the branch and
   * offered no way to move them. This is where the tool does the last part.
   */
  const unlandedNow =
    pending?.supported === true && !pending.hasDiff && pending.unlandedCommits > 0

  /**
   * The rung each settle-it button starts on, and where that answer came from.
   *
   * ⭐ **t283.** Both controls used to open on `commit-only` — not as a decision, but because a
   * picker with no value shows the first item in its list, and `commit-only` is the bottom rung of
   * the ladder. On a project configured for commit·verify·merge the offered answer was therefore the
   * one that leaves the work sitting on the branch, every single time.
   */
  // ⛔ The menus answer to where this task's work sits, not to the fleet default. On the trunk the
  // merge rung would promise a merge that cannot happen and the pull-request rung a branch the task
  // does not have — both are refused or meaningless downstream, so they are not offered (t583).
  const mode = effectiveWorkspaceMode(task.workspaceMode, inheritedWorkspaceMode)
  const commitOffered = commitRungsForMode(mode)
  const landOffered = landRungsForMode(mode)
  const landFallback = mode === 'trunk' ? TRUNK_LAND_FALLBACK : LAND_FALLBACK
  const commitRung = defaultRung(task.finishPolicy, inheritedFinish?.policy, commitOffered, COMMIT_FALLBACK)
  const commitRungWhere = rungOrigin(task.finishPolicy, inheritedFinish, commitRung)
  const landRung = defaultRung(task.finishPolicy, inheritedFinish?.policy, landOffered, landFallback)
  const landRungWhere = rungOrigin(task.finishPolicy, inheritedFinish, landRung)

  /**
   * ⛔ **"I could not look" is not "there is nothing there", and it must not render as one.** The
   * measurement can fail — no workspace has the branch, git could not be read — and hiding every
   * settle-it control on that answer is what left t280's thread telling an operator to press a Commit
   * button it had decided not to draw. The control is shown with the reason instead: committing
   * dispatches a run, which checks the branch out again wherever it has to.
   */
  const cannotLook = conversation && pending !== null && !pending.supported

  const canReland = canRelandTask(task)

  /**
   * Every cause whose explanation the operator gets, under one button (t289). The copy lives
   * here because it is presentation; which causes match lives in `resolveRetryCauses`, because
   * that is the rule a test can pin. ⚠️ Plain strings, because they go into the button's tooltip.
   */
  const resolveCauseCopy: Record<ResolveRetryCause, string> = {
    conflicted:
      'The work is fine, the branch is stale: sends the branch back to an agent to rebase onto the ' +
      'landing target, resolve the conflicts and report complete again. Nothing is discarded and ' +
      'the branch is never reset.',
    checksFailed:
      'Project checks failed: sends the check output back to the agent to fix the lint, type or test ' +
      `errors, commit the fix on ${task.branch} and report complete again.`,
    uncommitted:
      `Uncommitted work: sends the branch back to an agent to commit the changes on ${task.branch} ` +
      'and report complete again.',
    trunkMoved:
      'The trunk moved and the branch is empty: sends the branch back to an agent to rebase onto the ' +
      `landing target, make sure every intended change is committed on ${task.branch}, run the ` +
      'project checks and report complete again.'
  }
  const resolveCauses = resolveRetryCauses(task).map((key) => resolveCauseCopy[key])

  const handleResolveRetry = async () => {
    setBusy(true)
    try {
      const modelPolicy = selectedModel === '__auto__' ? 'auto' : 'inherit'
      const model = selectedModel === '__auto__' ? null : selectedModel || null
      await rpc('task.resolveRetry', {
        id: task.id,
        workerId: selectedWorkerId || null,
        model,
        modelPolicy,
        effort: selectedEffort || null
      })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleReland = async () => {
    setBusy(true)
    try {
      await rpc('task.land', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleCommit = async (finishPolicy: FinishPolicy): Promise<void> => {
    setBusy(true)
    try {
      const result = await rpc('task.commitConversation', { id: task.id, finishPolicy })
      setCommitError(result.ok ? null : (result.reason ?? 'the commit could not be started'))
      await onRefresh()
      await readPending()
    } finally {
      setBusy(false)
    }
  }

  // ⚠️ The same shape as `handleCommit` and a different call, because it is a different action: this
  // one spends no turn. Its failure lands in the same place, so one line on the card carries either.
  const handleLand = async (finishPolicy: FinishPolicy): Promise<void> => {
    setBusy(true)
    try {
      if (conversation) {
        const result = await rpc('task.landConversation', { id: task.id, finishPolicy })
        setCommitError(result.ok ? null : (result.reason ?? 'the branch could not be landed'))
      } else {
        if (finishPolicy !== task.finishPolicy) {
          const update = await rpc('task.setFinishPolicy', { id: task.id, finishPolicy })
          if (update.landed) {
            setCommitError(null)
          } else if (update.reason) {
            setCommitError(update.reason)
          } else if (finishPolicy !== 'commit-only') {
            const result = await rpc('task.land', { id: task.id })
            setCommitError(result.landed ? null : (result.reason ?? 'the branch could not be landed'))
          }
        } else {
          const result = await rpc('task.land', { id: task.id })
          setCommitError(result.landed ? null : (result.reason ?? 'the branch could not be landed'))
        }
      }
      await onRefresh()
      await readPending()
    } finally {
      setBusy(false)
    }
  }

  const handleReassign = async () => {
    setBusy(true)
    try {
      const modelPolicy =
        selectedModel === '__auto__' ? 'auto' : !selectedModel || selectedModel === '__inherit__' ? 'inherit' : null
      const model = selectedModel === '__auto__' || selectedModel === '__inherit__' ? null : selectedModel || null
      // ⛔ Same atomic reassignment as the quota card above; this handler dispatches immediately.
      await rpc('task.setWorker', {
        id: task.id,
        workerId: selectedWorkerId || null,
        ...(selectedWorkerId ? { model, modelPolicy, effort: selectedEffort || null } : {})
      })
      // ⛔ **Not a sentence in the person's voice.** This used to post *"Reassigned worker to X and
      // continued."* as a human message — words nobody typed, read back to them in their own bubble
      // and sent to the agent as though they had said it. The daemon already writes the *Worker
      // switched to …* system line when the worker changes, so the thread needs no second account
      // of it. What it still needs is a run: `task.message` is the one RPC that continues a resting
      // task (`task.resume` only leaves `paused_*`), and it takes a text, so the note is the
      // smallest thing a person could plausibly have meant by pressing the button — unless they
      // typed what they meant into the box beside it, in which case that is the message.
      const note = reassignNote.trim()
      await rpc('task.message', { id: task.id, text: note || 'Continue.' })
      setReassignNote('')
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  /**
   * The labels, once. A conversation *finishes* and *stops*; an ordinary task is *marked done* and
   * *stopped here*. Both pairs are the same two actions, and the tooltips below say what each does
   * to the DAG — the thing the buttons used to spell out beside themselves.
   */
  const finishLabel = conversation ? (confirmFinish && uncommittedNow ? 'Finish anyway' : 'Finish') : 'Mark done'
  const stopLabel = conversation ? 'Stop' : 'Stop here'
  const uncommittedCount = pending ? pending.dirtyFiles + pending.untrackedFiles : 0
  const uncommittedShort = `${uncommittedCount} uncommitted file${uncommittedCount === 1 ? '' : 's'}`
  const branchName = pending?.branch ?? task.branch

  // ⛔ **The prose moved into the tooltips, and none of it was dropped.** The card used to carry a
  // paragraph beside every button — what it does, what it does to the DAG, which rung, where the
  // rung came from — and six of them stacked under a resting conversation was a wall nobody read.
  // Each button's `title` now says the whole of it; what stays on the card is what protects work.
  const finishTitle = conversation
    ? (uncommittedNow
        ? `⚠️ ${uncommittedShort} in this workspace. Finish releases the workspace, and ${uncommittedCount === 1 ? 'it goes' : 'they go'} back to the pool with it — Commit first, or press Finish twice to finish anyway. `
        : '') +
      `Ends this conversation and records your judgement that it is finished. ${releases} ` +
      'The branch is kept. ⚠️ Nothing verified the work — task_complete remains the only signal that an agent finished.'
    : `Records your judgement that this is finished. ${releases} ` +
      '⚠️ Nothing verified the work — task_complete remains the only signal that an agent finished.'
  const stopTitle =
    (conversation ? 'Ends this conversation and parks the task as paused_user' : 'Parks the task as paused_user') +
    `, which Resume picks back up. ${holds} The branch and the workspace are kept; nothing is destroyed.`
  const commitTitle =
    'Asks this conversation’s agent — in the same session, so it still has the context — to commit ' +
    (uncommittedNow ? `the ${uncommittedShort} on ${branchName}` : `whatever is uncommitted on ${branchName}`) +
    ` and then land it: ${FINISH_LABELS[commitRung]} (${commitRungWhere}). ` +
    'With the land_work MCP tool the agent lands it itself; on an adapter without MCP it says the ' +
    'commit is ready and you press Land. “Commit only” asks for the commit and no landing. ' +
    'This spends a turn and does not finish the task: the conversation stays open, on the next ' +
    'numbered branch once it lands. ▼ picks a different rung for this press.' +
    (uncommittedNow && pending?.unclaimed
      ? ' This task is not holding that workspace any more; the branch and these files are still in it, and the run prefers that tree.'
      : '') +
    (cannotLook
      ? ` ⚠️ Could not read this task’s workspace (${pending?.reason}), so there is no telling what is uncommitted; the run checks the branch out again.`
      : '')
  const landTitle = conversation
    ? `Lands ${pending?.unlandedCommits === 1 ? '1 commit' : `${pending?.unlandedCommits ?? 0} commits`} ` +
      `sitting on ${branchName} without spending a turn: ${FINISH_LABELS[landRung]} (${landRungWhere}). ` +
      'The tool rebases onto the landing target, runs the project’s checks where the rung asks for ' +
      'them, and merges or pushes as the rung says; a refusal leaves the branch exactly where it is. ' +
      'Landing does not finish this conversation — only Finish and Stop do — so the thread comes back ' +
      'open on the next numbered branch, ready to land again. ▼ picks another rung for this press.'
    : `Lands ${pending?.unlandedCommits === 1 ? '1 commit' : `${pending?.unlandedCommits ?? 0} commits`} ` +
      `sitting on ${branchName} without spending a turn: ${FINISH_LABELS[landRung]} (${landRungWhere}). ` +
      'The tool rebases onto the landing target, runs the project’s checks where the rung asks for ' +
      'them, and merges or pushes as the rung says; a refusal leaves the branch exactly where it is. ' +
      '▼ picks another rung for this press.'
  const resolveTitle =
    'Dispatches a landing-repair run on this thread with the worker and model selected below. It carries ' +
    'the landing failure, check output, branch and required landing procedure into that run, so the new ' +
    'agent knows it is repairing and landing existing work rather than starting the task over. ' +
    'resolve what stopped it and report complete again. ' +
    resolveCauses.join(' ')
  const relandTitle =
    `Rebases and lands ${task.branch} again now, without dispatching an agent. Use it once the ` +
    'trunk is clean or another task has finished landing.'
  const reassignTitle =
    'Sets the worker, model and effort for this task’s next run and dispatches it now, on this same ' +
    'thread, carrying the message typed below it if there is one. Auto lets the scheduler pick by ' +
    'quota and capacity.'

  // ⚠️ One inline line for the DAG, and only when there is a DAG. "2 tasks wait on this one" is a
  // fact somebody can check, and it is the difference between the rest of a plan running and not —
  // which is why it does not live only behind a hover. With nothing waiting, nothing is said.
  const finishVerb = conversation ? 'Finish' : 'Mark done'
  const waitingLine =
    blocking === 0
      ? null
      : `${blocking === 1 ? '1 task waits' : `${blocking} tasks wait`} on this one — ${finishVerb} releases ${blocking === 1 ? 'it' : 'them'}; ${stopLabel} keeps ${blocking === 1 ? 'it' : 'them'} blocked.`

  // ⚠️ The head repeats the hold reason only when it says something. 'your turn' is what every
  // resting conversation reads, and the card's own label already says it.
  const holdReason = task.holdReason?.trim() ?? ''
  const showHold = holdReason !== '' && holdReason.toLowerCase() !== 'your turn'

  return (
    <div className="decide">
      <div className="decide-head">
        <span>your call</span>
        {/* The reason it stopped, where the answer is given rather than only in the ledger. */}
        {showHold && <span className="decide-why">{holdReason}</span>}
      </div>

      {/* ⛔ One row, every action on it, and what each one does on its tooltip. Commit and Land are
          drawn on what the workspace actually holds — `pendingWork` runs git rather than reading the
          task — and as **two** controls, because committing costs a turn and landing does not. */}
      <div className="decide-actions">
        <button
          className="btn btn--ok"
          title={finishTitle}
          disabled={busy}
          onClick={() => {
            // ⛔ **The warning is a first press, not a dialog**, and it is armed only when something
            // would actually be lost. Finish releases the workspace back to the pool, so on a
            // conversation carrying uncommitted files it is the one irreversible button on this
            // card — and nothing else on the page says those files exist. A confirmation that fired
            // on every finish would be trained away within a day; this one only ever appears when it
            // is telling the truth.
            if (uncommittedNow && !confirmFinish) {
              setConfirmFinish(true)
              return
            }
            void onResolve()
          }}
        >
          {finishLabel}
        </button>

        <button className="btn btn--danger" title={stopTitle} disabled={busy} onClick={() => void onStop()}>
          {stopLabel}
        </button>

        {(uncommittedNow || cannotLook) && (
          <SplitButton
            className="commit-select"
            label="Commit"
            tone="warn"
            value={commitRung}
            disabled={busy}
            title={commitTitle}
            ariaLabel="Commit this conversation"
            menuAriaLabel="Landing strategy for this commit"
            options={commitOffered.map((rung) => ({
              value: rung,
              label: `${FINISH_SHORT[rung]} — ${FINISH_LABELS[rung]}`
            }))}
            onAct={(rung) => void handleCommit(rung as FinishPolicy)}
          />
        )}

        {/* ⛔ The clean-tree half: committed work with nowhere to go. No agent, no turn — the tool
            rebases, runs the project's checks and merges, exactly as it would have at the end of an
            ordinary task. ⚠️ And unlike an ordinary task, it ends nothing: the thread stays open on
            the next numbered branch and can be landed again. See docs/landing.md. */}
        {unlandedNow && (
          <SplitButton
            className="commit-select"
            label="Land"
            tone="primary"
            value={landRung}
            disabled={busy}
            title={landTitle}
            ariaLabel={conversation ? 'Land this conversation' : 'Land this task'}
            menuAriaLabel="Landing strategy for this branch"
            options={landOffered.map((rung) => ({
              value: rung,
              label: `${FINISH_SHORT[rung]} — ${FINISH_LABELS[rung]}`
            }))}
            onAct={(rung) => void handleLand(rung as FinishPolicy)}
          />
        )}

        {resolveCauses.length > 0 && (
          <button
            className="btn btn--primary"
            title={resolveTitle}
            disabled={busy}
            onClick={() => void handleResolveRetry()}
          >
            Resolve &amp; retry
          </button>
        )}

        {canReland && !unlandedNow && (
          <button className="btn btn--primary" title={relandTitle} disabled={busy} onClick={() => void handleReland()}>
            Retry landing
          </button>
        )}
      </div>

      {/* ⛔ What stays inline is what protects work: the files Finish would walk away from, a tree
          the card could not read, and a commit or landing that was refused. Everything else about
          each button is on its tooltip. ⚠️ Warning colour inside the card rather than a banner above
          it: each line qualifies one button, not the whole card. */}
      {uncommittedNow && (
        <div className="decide-note decide-warn">
          ⚠️ {uncommittedShort} —{' '}
          {confirmFinish
            ? 'press again to finish anyway'
            : `Finish releases ${uncommittedCount === 1 ? 'it' : 'them'}; Commit first, or press Finish twice`}
        </div>
      )}
      {cannotLook && (
        <div className="decide-note decide-warn">
          ⚠️ Could not read this task’s workspace ({pending?.reason}) — Commit checks the branch out again
        </div>
      )}
      {commitError && <div className="decide-note decide-warn">⚠️ {commitError}</div>}
      {waitingLine && <div className="decide-note">{waitingLine}</div>}
      {resolveCauses.length > 0 && (
        <div className="decide-note">
          Choose a worker or model below to hand this landing repair to another agent; Resolve &amp; retry sends it the failure details and landing procedure.
        </div>
      )}

      {/* ⚠️ One row, and it stays one row. Each selector used to size itself to its own longest
          label — "Auto (scheduler decides)", "account default (claude-opus-5)" — so the three of
          them asked for more width than the column has and wrapped onto a line each, turning one
          decision into a stack. They share the row equally now and ellipsize instead; the full
          label is still on the button that opens the menu, and in the menu itself. */}
      <div className="reassign-row">
        <button className="btn btn--primary" title={reassignTitle} disabled={busy} onClick={() => void handleReassign()}>
          Reassign
        </button>
        <SettingButtonSelect
          className="reassign-select"
          value={selectedWorkerId}
          disabled={busy}
          ariaLabel="Reassign worker"
          options={[
            { value: '', label: 'Auto (scheduler decides)' },
            /* ⛔ Deactivated accounts are not offered. Reassigning to a disabled worker
               parks the task on an account the scheduler will never hand a turn, so the menu
               lists only what can actually pick the work up. The one exception is the account
               this task is already pinned to — if it was deactivated after assignment it stays
               in the list, so the button reads its label instead of a bare id. */
            ...fleet
              .filter((e) => (e.worker.enabled && canWork(e.worker.role)) || e.worker.id === selectedWorkerId)
              .map((e) => ({
                value: e.worker.id,
                label: `${e.worker.label} (${e.worker.adapterId})`
              }))
          ]}
          onChange={(nextWorkerId) => {
            setSelectedWorkerId(nextWorkerId)
            if (!nextWorkerId) {
              setSelectedModel('')
              setSelectedEffort('')
            } else {
              const w = fleet.find((entry) => entry.worker.id === nextWorkerId)?.worker
              const offered = modelOptions.find((o) => o.adapterId === w?.adapterId)?.models ?? []
              if (
                selectedModel &&
                selectedModel !== '__auto__' &&
                selectedModel !== '__inherit__' &&
                !offered.some((m) => m.id === selectedModel)
              ) {
                setSelectedModel(reassignmentModel(selectedModel, offered))
                setSelectedEffort('')
              }
            }
          }}
        />

        {offeredModels.length > 0 && (
          <SettingButtonSelect
            className="reassign-select"
            value={selectedModel}
            disabled={busy}
            ariaLabel="Reassign model"
            options={[
              ...(offeredModels.length > 1
                ? [{ value: '__auto__', label: 'Auto Model (scheduler decides)' }]
                : []),
              {
                value: '',
                label: inheritedModel
                  ? `account default (${modelLabel(inheritedModel) ?? inheritedModel})`
                  : 'CLI default model'
              },
              // ⚠️ The label is written for a person; the value stays the id, which is what is
              // sent to the CLI and what the cost model is keyed by.
              ...offeredModels.map((m) => ({ value: m.id, label: modelLabel(m.id) ?? m.id }))
            ]}
            displayLabel={
              selectedModel === '__auto__'
                ? 'Auto Model'
                : !selectedModel || selectedModel === '__inherit__'
                  ? inheritedModel
                    ? (modelLabel(inheritedModel) ?? inheritedModel)
                    : 'CLI default model'
                  : undefined
            }
            onChange={(val) => {
              setSelectedModel(val)
              setSelectedEffort('')
            }}
          />
        )}

        {offeredEfforts.length > 0 && (
          <SettingButtonSelect
            className="reassign-select"
            value={selectedEffort}
            disabled={busy}
            ariaLabel="Reassign effort"
            options={[
              {
                value: '',
                label: selectedWorker?.defaultEffort
                  ? `account default (${effortLabel(selectedWorker.defaultEffort)})`
                  : 'CLI default effort'
              },
              ...offeredEfforts.map((level) => ({
                value: level,
                label: effortLabel(level) ?? level
              }))
            ]}
            displayLabel={
              !selectedEffort
                ? selectedWorker?.defaultEffort
                  ? (effortLabel(selectedWorker.defaultEffort) ?? selectedWorker.defaultEffort)
                  : 'CLI default effort'
                : undefined
            }
            onChange={(val) => setSelectedEffort(val)}
          />
        )}
      </div>
      <ReassignNote
        value={reassignNote}
        disabled={busy}
        onChange={setReassignNote}
        onSubmit={() => void handleReassign()}
      />

      <p className="decide-hint">Or reply below to carry on in this same thread.</p>
    </div>
  )
}

/**
 * Run this now anyway, at 92% of a window — or keep a run alive through the minute before an
 * automatic quota preemption.
 *
 * ⛔ **The countdown is the daemon's, not this component's.** `quotaPreemptWarning` is written to
 * the database before it is ever shown, so the deadline survives a reload and a restart of the app
 * that is displaying it; the renderer only subtracts a ticking clock from a number it was given. A
 * vendor **refusal** never appears here, because that turn has already been declined and there is
 * nothing left to choose.
 *
 * ⛔ **Otherwise shown only when the hold is one the fleet invented for itself.** The water mark is
 * a caution computed from a reading — the vendor served every turn up to it — and on a task pinned to one
 * account there was no way to say *"8% is more than this needs"*. Every other hold on this row ends
 * when something else happens (a run finishes, a dependency completes, somebody signs in) and has
 * nothing here to overrule, so no button appears on one. ⚠️ Matched on the sentence the gate writes,
 * for the same reason the conflict button is: that sentence is where the scheduler records *which*
 * gate refused, and re-deriving it in the renderer would be a second opinion on a settled question.
 *
 * ⚠️ It says what it does **not** buy, because the honest failure mode is an operator who overrides
 * at 92%, sees the run stop anyway on a vendor refusal, and concludes the button is broken.
 */
export function QuotaOverride({
  task,
  onChanged
}: {
  task: Task
  onChanged?: () => Promise<void>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  // ⚠️ One ticking clock, not `Date.now()` in the render: the countdown below has to move, and a
  // component that reads the wall clock while rendering only updates when something else makes it.
  const now = useNow(1000)
  const vendorRefused = task.holdReason?.startsWith('Vendor refused this turn: ') ?? false
  const held =
    (task.status === 'ready' && /% of its .* window/.test(task.holdReason ?? '')) ||
    (task.status === 'paused_quota' && !vendorRefused)
  const warning = task.status === 'running' ? task.quotaPreemptWarning : null
  const live = task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now
  if (!held && !live && !warning) return null

  // ⚠️ `withdraw` sends an explicit `null`; granting sends no `until` at all, so the daemon dates
  // the permission from the window it measured rather than from a clock in the renderer.
  const set = async (withdraw: boolean): Promise<void> => {
    setBusy(true)
    try {
      await rpc('task.overrideQuota', { id: task.id, ...(withdraw ? { until: null } : {}) })
      if (onChanged) await onChanged()
    } finally {
      setBusy(false)
    }
  }

  const choose = async (action: 'compact' | 'handoff'): Promise<void> => {
    setBusy(true)
    try {
      await rpc('task.overrideQuota', { id: task.id, preemptionAction: action })
      if (onChanged) await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Fact label="quota gate">
      {live ? (
        <>
          <span>overridden for {duration((task.quotaOverrideUntil ?? 0) - now)}</span>{' '}
          <button className="btn" disabled={busy} onClick={() => void set(true)}>
            Withdraw
          </button>
        </>
      ) : (
        <>
          {warning && (
            <>
              <span className="quota-countdown">
                {warning.action === 'compact' ? 'Compacts' : 'Hands off'} in{' '}
                {duration(Math.max(0, warning.preemptAt - now))}: {warning.reason}.{' '}
              </span>
              {warning.canCompact && (
                <>
                  <button
                    className={warning.action === 'compact' ? 'btn btn--active' : 'btn'}
                    disabled={busy || warning.action === 'compact'}
                    onClick={() => void choose('compact')}
                  >
                    Compact & pause
                  </button>{' '}
                  <button
                    className={warning.action === 'handoff' ? 'btn btn--active' : 'btn'}
                    disabled={busy || warning.action === 'handoff'}
                    onClick={() => void choose('handoff')}
                  >
                    Hand off & pause
                  </button>{' '}
                </>
              )}
            </>
          )}
          <button
            className="btn btn--warn"
            disabled={busy}
            title={
              warning
                ? 'Keep this run going until the quota window resets rather than wrapping it up now. A turn the vendor actually refuses will still stop it.'
                : task.status === 'paused_quota'
                  ? 'Override preemption and resume this task immediately even though the account is at or past 92% of its window.'
                  : 'Dispatch this task even though the account is at or past 92% of its window. Expires when that window resets. ⚠️ A turn the vendor actually refuses still stops the run, and so does the window boundary itself.'
            }
            onClick={() => void set(false)}
          >
            {warning
              ? 'Override preemption'
              : task.status === 'paused_quota'
                ? 'Override & continue'
                : 'Run now anyway'}
          </button>{' '}
          <span className="dim">
            {warning
              ? `keeps this run going until ${new Date(warning.resumeAt).toLocaleTimeString()}`
              : task.status === 'paused_quota'
                ? 'resumes immediately and overrides the quota gate'
                : 'spends into the window this task is waiting on'}
          </span>
        </>
      )}
    </Fact>
  )
}
