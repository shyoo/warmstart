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
  type ModelClass,
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
  commitLevelsForMode,
  defaultLevel,
  effectiveWorkspaceMode,
  LAND_FALLBACK,
  landLevelsForMode,
  levelOrigin,
  settleControls,
  TRUNK_LAND_FALLBACK
} from '../../lib/finishlevel'
import { duration } from '../../lib/format'
import { effortLabel, modelLabel } from '../../lib/modelname'
import {
  canRelandTask,
  effortLookupModel,
  holdLine,
  resolveRetryCauses,
  type ResolveRetryCause,
  reassignmentModel
} from '../../lib/taskview'
import { Fact } from './Facts'
import { initialSelectedModel, type ReassignChoice } from './Reassign'

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
    initialSelectedModel(task.constraints.model, task.constraints.modelPolicy, task.constraints.modelClass)
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
    setSelectedModel(
      initialSelectedModel(task.constraints.model, task.constraints.modelPolicy, task.constraints.modelClass)
    )
    setSelectedEffort(task.constraints.effort ?? '')
  }, [task.constraints.workerId, task.constraints.model, task.constraints.modelPolicy, task.constraints.modelClass, task.constraints.effort])

  const warning = task.status === 'running' ? task.quotaPreemptWarning : null
  const [preemptReassignWorkerId, setPreemptReassignWorkerId] = useState<string>(
    warning?.reassignWorkerId ?? ''
  )
  const [preemptModel, setPreemptModel] = useState(warning?.reassignModelPolicy === 'auto'
    ? `__auto__${warning.reassignModelClass ? `:${warning.reassignModelClass}` : ''}`
    : warning?.reassignModel ?? '')
  const [preemptEffort, setPreemptEffort] = useState(warning?.reassignEffort ?? '')
  useEffect(() => {
    setPreemptReassignWorkerId(warning?.reassignWorkerId ?? '')
    setPreemptModel(warning?.reassignModelPolicy === 'auto'
      ? `__auto__${warning.reassignModelClass ? `:${warning.reassignModelClass}` : ''}`
      : warning?.reassignModel ?? '')
    setPreemptEffort(warning?.reassignEffort ?? '')
  }, [warning?.reassignWorkerId, warning?.reassignModel, warning?.reassignModelPolicy, warning?.reassignModelClass, warning?.reassignEffort])
  const preemptWorker = fleet.find((e) => e.worker.id === preemptReassignWorkerId)?.worker
  const preemptEntry = fleet.find((e) => e.worker.id === preemptReassignWorkerId)
  const preemptOptions = modelOptions.find((o) => o.adapterId === preemptWorker?.adapterId)
  const preemptModels = preemptOptions?.models ?? []
  const preemptDefault = preemptWorker
    ? resolveModelChoice(null, preemptWorker, preemptOptions?.selectableEffort ?? false, preemptEntry?.quota).model
    : null
  const preemptEfforts = preemptOptions?.selectableEffort
    ? preemptModels.find((m) => m.id === effortLookupModel(preemptModel, preemptDefault))?.effortLevels ?? []
    : []

  const selectedWorker = fleet.find((e) => e.worker.id === selectedWorkerId)?.worker ?? null
  const selectedEntry = fleet.find((e) => e.worker.id === selectedWorkerId) ?? null
  const adapterOptions = modelOptions.find((o) => o.adapterId === selectedWorker?.adapterId)
  const offeredModels = adapterOptions?.models ?? []
  const canSetEffort = adapterOptions?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, selectedWorker, canSetEffort, selectedEntry?.quota).model
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === effortLookupModel(selectedModel, inheritedModel))?.effortLevels ?? [])
    : []

  const isPaused = task.status === 'paused_quota'
  const isReadyHeld = task.status === 'ready' && /% of its .* window/i.test(task.holdReason ?? '')
  // This prefix is written only by the daemon's failed-turn quota path. Unlike a percentage
  // watermark, an explicit vendor refusal cannot be overridden locally.
  const vendorRefused = task.holdReason?.startsWith('Vendor refused this turn: ') ?? false
  const live = task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now

  if (!isPaused && !isReadyHeld && !warning && !live) return null

  const currentPreemptWorkerId = task.assignee || task.constraints.workerId
  const redirectOptions = [
    { value: '', label: 'Auto (scheduler decides)' },
    ...fleet
      .filter(
        (e) =>
          (e.worker.enabled && canWork(e.worker.role) && e.worker.id !== currentPreemptWorkerId) ||
          e.worker.id === preemptReassignWorkerId
      )
      .map((e) => ({
        value: e.worker.id,
        label: `${e.worker.label} (${e.worker.adapterId})`
      }))
  ]

  // ⛔ Same `action: 'handoff'` either way — "pause" and "reassign" are told apart only by whether a
  // redirect destination rode along, never by a second action value. See `reassignWorkerId` on
  // `quotaPreemptWarning` (shared/tasks.ts).
  const handoffPauseActive = warning?.action === 'handoff' && warning.reassignWorkerId === undefined
  const handoffReassignActive = warning?.action === 'handoff' && warning.reassignWorkerId !== undefined
  const reassignMatchesSelection = handoffReassignActive &&
    (warning?.reassignWorkerId ?? '') === preemptReassignWorkerId &&
    (warning?.reassignModelPolicy === 'auto'
      ? `__auto__${warning.reassignModelClass ? `:${warning.reassignModelClass}` : ''}`
      : warning?.reassignModel ?? '') === preemptModel &&
    (warning?.reassignEffort ?? '') === preemptEffort

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
        ...(reassignWorkerId !== undefined ? {
          reassignWorkerId,
          ...(reassignWorkerId ? {
            reassignModel: preemptModel.startsWith('__auto__') ? null : preemptModel || null,
            reassignModelPolicy: preemptModel.startsWith('__auto__') ? 'auto' : 'inherit',
            reassignModelClass: preemptModel.startsWith('__auto__:')
              ? preemptModel.split(':')[1] as ModelClass : null,
            reassignEffort: preemptEffort || null
          } : {})
        } : {})
      })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleReassign = async () => {
    setBusy(true)
    try {
      const isAuto = selectedModel.startsWith('__auto__')
      const modelPolicy =
        isAuto ? 'auto' : !selectedModel || selectedModel === '__inherit__' ? 'inherit' : null
      const modelClass =
        isAuto && selectedModel.includes(':') ? (selectedModel.split(':')[1] as ModelClass) : null
      const model = isAuto || selectedModel === '__inherit__' ? null : selectedModel || null
      // ⛔ One write. The scheduler can dispatch after the worker write, so a following model write
      // is too late — it was how an explicit Opus reassignment resumed on the account's Haiku default.
      await rpc('task.setWorker', {
        id: task.id,
        workerId: selectedWorkerId || null,
        ...(selectedWorkerId ? { model, modelPolicy, modelClass, effort: selectedEffort || null } : {})
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
            <section className="quota-scheduled" aria-label="When the countdown expires">
              <div className="quota-scheduled-head">When the countdown expires <span>Choose one until the timer ends</span></div>
              {warning.canCompact && (
                <div className="decide-option">
                  <button type="button" className={warning.action === 'compact' ? 'btn btn--primary' : 'btn'}
                    disabled={busy || warning.action === 'compact'} onClick={() => void handlePreemptionAction('compact')}>
                    Compact & pause
                  </button>
                  <span className="decide-what">Preserves context for its next run after quota resets.</span>
                </div>
              )}
              <div className="decide-option">
                <button type="button" className={handoffPauseActive ? 'btn btn--primary' : 'btn'}
                  disabled={busy || handoffPauseActive} onClick={() => void handlePreemptionAction('handoff')}>
                  Hand off & pause
                </button>
                <span className="decide-what">Commits safe work, writes a handoff brief, and waits for this account's quota to reset.</span>
              </div>
              <div className="decide-option">
                <button type="button" className={handoffReassignActive ? 'btn btn--primary' : 'btn'}
                  disabled={busy || reassignMatchesSelection}
                  onClick={() => void handlePreemptionAction('handoff', preemptReassignWorkerId || null)}>
                  Hand off & reassign
                </button>
                <div className="decide-what">
                  Commits safe work and writes a handoff brief. After the timer expires and the handoff finishes, the task moves to the destination below.
                  <div className="reassign-row quota-destination">
                    <SettingButtonSelect className="reassign-select" value={preemptReassignWorkerId} disabled={busy}
                      ariaLabel="Handoff destination worker" options={redirectOptions}
                      onChange={(nextId) => {
                        setPreemptReassignWorkerId(nextId)
                        setPreemptModel('')
                        setPreemptEffort('')
                      }} />
                    {preemptReassignWorkerId && preemptModels.length > 0 && (
                      <SettingButtonSelect className="reassign-select" value={preemptModel} disabled={busy}
                        ariaLabel="Handoff destination model"
                        options={[
                          { value: '', label: preemptDefault ? `Account default (${modelLabel(preemptDefault) ?? preemptDefault})` : 'CLI default model' },
                          { value: '__auto__', label: 'Auto Model' },
                          { value: '__auto__:high', label: 'Auto Model (high)' },
                          { value: '__auto__:med', label: 'Auto Model (med)' },
                          { value: '__auto__:low', label: 'Auto Model (low)' },
                          ...preemptModels.map((m) => ({ value: m.id, label: modelLabel(m.id) ?? m.id }))
                        ]}
                        onChange={(value) => { setPreemptModel(value); setPreemptEffort('') }} />
                    )}
                    {preemptReassignWorkerId && preemptEfforts.length > 0 && (
                      <SettingButtonSelect className="reassign-select" value={preemptEffort} disabled={busy}
                        ariaLabel="Handoff destination effort"
                        options={[{ value: '', label: 'Auto effort' }, ...preemptEfforts.map((level) => ({ value: level, label: effortLabel(level) ?? level }))]}
                        onChange={setPreemptEffort} />
                    )}
                  </div>
                  {handoffReassignActive && !reassignMatchesSelection && <span>Press Hand off & reassign to save this destination.</span>}
                </div>
              </div>
            </section>
          )}
          {warning && <div className="quota-immediate-head">Take action now</div>}          {!vendorRefused && <div className="decide-option">
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
                          ? [
                              { value: '__auto__', label: 'Auto Model (scheduler decides)' },
                              { value: '__auto__:high', label: 'Auto Model (high)' },
                              { value: '__auto__:med', label: 'Auto Model (med)' },
                              { value: '__auto__:low', label: 'Auto Model (low)' }
                            ]
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
                          : selectedModel === '__auto__:high'
                            ? 'Auto Model (high)'
                            : selectedModel === '__auto__:med'
                              ? 'Auto Model (med)'
                              : selectedModel === '__auto__:low'
                                ? 'Auto Model (low)'
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
                            ? `Auto effort (${effortLabel(selectedWorker.defaultEffort)})`
                            : 'Auto effort (CLI default)'
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
 * What is sitting uncommitted or unlanded in a resting task's workspace, read once and shared by the
 * settle strip (Commit, Land) and the composer (Complete, which arms over uncommitted files).
 *
 * ⛔ Fetched rather than derived, and only while the task rests on a person. Complete releases the
 * workspace, so on a conversation it can walk away from files nothing else on this page mentions —
 * see `PendingWork`. ⚠️ `null` while it is being read, which is *not* the same as "nothing there":
 * the Commit button appears when the answer arrives and the Complete warning with it, rather than
 * either being drawn on a guess.
 */
export interface PendingWorkState {
  pending: PendingWork | null
  reread: () => Promise<void>
  controls: ReturnType<typeof settleControls>
  /** Complete was pressed once over uncommitted files; the next press completes anyway. */
  confirmFinish: boolean
  setConfirmFinish: (armed: boolean) => void
}

export function usePendingWork(task: Task, enabled: boolean): PendingWorkState {
  const [pending, setPending] = useState<PendingWork | null>(null)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const reread = useCallback(async (): Promise<void> => {
    if (!task.projectId || !enabled) return
    try {
      const answer = await rpc('task.pendingWork', { id: task.id })
      setPending(answer)
      // ⚠️ An arming that outlives the thing it warned about is a trap. Once the tree is clean the
      // next press of Complete must be an ordinary press again.
      if (!answer.supported || !answer.hasDiff) setConfirmFinish(false)
    } catch {
      // ⚠️ A tree that cannot be read is not a tree with nothing in it. Leaving `pending` alone keeps
      // whatever the last successful read said rather than replacing it with a reassuring absence.
    }
  }, [task.id, task.projectId, enabled])
  // ⚠️ Re-read when the task moves, because every settle action changes the tree: a commit empties
  // it, a reply can fill it again. `updatedAt` is the cheapest honest trigger.
  useEffect(() => {
    void reread()
  }, [reread, task.updatedAt])
  // ⛔ **Which controls are drawn is a decision, so it lives where a test can reach it** —
  // `settleControls`, which carries why Land no longer waits for a pristine tree (t581).
  const controls = settleControls(task.kind === 'conversation', pending)
  return { pending, reread, controls, confirmFinish, setConfirmFinish }
}

function uncommittedPhrase(pending: PendingWork | null): { count: number; short: string } {
  const count = pending ? pending.dirtyFiles + pending.untrackedFiles : 0
  return { count, short: `${count} uncommitted file${count === 1 ? '' : 's'}` }
}

/**
 * What Complete does, said on its tooltip.
 *
 * ⛔ The difference between Complete and Stop is in the DAG, not in how it feels: `admit()` unblocks
 * a dependent only when its dependency reaches `completed`, so **Complete releases everything waiting
 * on this task and Stop does not**.
 */
export function completeTitle(task: Task, blocking: number, work: PendingWorkState): string {
  const releases =
    blocking === 0
      ? 'No tasks depend on this one. It marks as completed.'
      : blocking === 1
        ? 'Releases the 1 dependent task to become ready for dispatch.'
        : `Releases the ${blocking} dependent tasks to become ready for dispatch.`
  const { count, short } = uncommittedPhrase(work.pending)
  const warn = work.controls.uncommitted
    ? `⚠️ ${short} in this workspace. Completing releases the workspace, and ${count === 1 ? 'it goes' : 'they go'} back to the pool with it — Commit first, or press Complete twice to complete anyway. `
    : ''
  return (
    warn +
    `Records your judgement that this ${task.kind === 'conversation' ? 'conversation' : 'task'} is finished. ${releases} ` +
    'The branch is kept. ⚠️ Nothing verified the work — task_complete remains the only signal that an agent finished.'
  )
}

/**
 * The actions a resting task may still owe its work, as one slim strip above the composer.
 *
 * ⛔ **Drawn only when one applies** (t669). This used to be the *your call* card on every
 * `awaiting_human` turn — Finish, Stop, Reassign, three selectors and a message box — and a
 * conversation rests at `awaiting_human` after every reply, so the card sat between the operator
 * and the agent on every single turn and made a chat read as a form. Stop and Complete now live
 * beside Send, reassignment in the pills under the box; what is left here is what protects work:
 * Commit and Land (drawn on what the workspace actually holds — `pendingWork` runs git), the
 * landing repairs, and the one-line notes that qualify them.
 */
export function Decide({
  task,
  blocking,
  work,
  choice,
  inheritedFinish,
  inheritedWorkspaceMode,
  onRefresh
}: {
  task: Task
  blocking: number
  work: PendingWorkState
  /** The composer's worker / model / effort pick, which Resolve & retry hands the repair to. */
  choice: ReassignChoice
  /**
   * What this task's *project* (else the fleet) says a finish does — the tier below the task itself.
   *
   * ⛔ Passed in rather than read off `resolvedFinish`, because on a conversation that answers
   * `await-human` from the kind and would make every settle-it button here default to doing nothing.
   * See `defaultLevel`.
   */
  inheritedFinish?: ResolvedFinishPolicy
  /**
   * The project's resolved workspace mode, so the level menus answer to where this task's work
   * actually sits. A trunk task's commits are already on the landing target, so the merge and
   * pull-request levels are not offered (t583).
   */
  inheritedWorkspaceMode?: WorkspaceMode
  onRefresh: () => Promise<void>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const conversation = task.kind === 'conversation'
  const { pending, controls, confirmFinish } = work
  const uncommittedNow = controls.uncommitted
  const unlandedNow = controls.land
  // ⛔ "I could not look" is not "there is nothing there", and it must not render as one (t280).
  const cannotLook = controls.cannotLook

  /**
   * The level each settle-it button starts on, and where that answer came from.
   *
   * ⭐ **t283.** Both controls used to open on `commit-only` — the bottom of the ladder — because a
   * picker with no value shows its first item. ⛔ The menus answer to where this task's work sits:
   * on the trunk the merge and pull-request levels mean nothing, so they are not offered (t583).
   */
  const mode = effectiveWorkspaceMode(task.workspaceMode, inheritedWorkspaceMode)
  const commitOffered = commitLevelsForMode(mode)
  const landOffered = landLevelsForMode(mode)
  const landFallback = mode === 'trunk' ? TRUNK_LAND_FALLBACK : LAND_FALLBACK
  const commitLevel = defaultLevel(task.finishPolicy, inheritedFinish?.policy, commitOffered, COMMIT_FALLBACK)
  const commitLevelWhere = levelOrigin(task.finishPolicy, inheritedFinish, commitLevel)
  const landLevel = defaultLevel(task.finishPolicy, inheritedFinish?.policy, landOffered, landFallback)
  const landLevelWhere = levelOrigin(task.finishPolicy, inheritedFinish, landLevel)

  const canReland = canRelandTask(task)

  /**
   * Every cause whose explanation the operator gets, under one button (t289). The copy lives
   * here because it is presentation; which causes match lives in `resolveRetryCauses`.
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

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const handleResolveRetry = () =>
    act(async () => {
      const selected = choice.model
      const isAuto = selected.startsWith('__auto__')
      await rpc('task.resolveRetry', {
        id: task.id,
        workerId: choice.workerId || null,
        model: isAuto ? null : selected || null,
        modelPolicy: isAuto ? 'auto' : 'inherit',
        modelClass: isAuto && selected.includes(':') ? (selected.split(':')[1] as ModelClass) : null,
        effort: choice.effort || null
      })
      await onRefresh()
    })

  const handleReland = () =>
    act(async () => {
      await rpc('task.land', { id: task.id })
      await onRefresh()
    })

  const handleCommit = (finishPolicy: FinishPolicy) =>
    act(async () => {
      const result = await rpc('task.commitConversation', { id: task.id, finishPolicy })
      setCommitError(result.ok ? null : (result.reason ?? 'the commit could not be started'))
      await onRefresh()
      await work.reread()
    })

  // ⚠️ The same shape as `handleCommit` and a different call, because it is a different action: this
  // one spends no turn. Its failure lands in the same place, so one line carries either.
  const handleLand = (finishPolicy: FinishPolicy) =>
    act(async () => {
      if (conversation) {
        const result = await rpc('task.landConversation', { id: task.id, finishPolicy })
        setCommitError(result.ok ? null : (result.reason ?? 'the branch could not be landed'))
      } else if (finishPolicy !== task.finishPolicy) {
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
      await onRefresh()
      await work.reread()
    })

  const { count: uncommittedCount, short: uncommittedShort } = uncommittedPhrase(pending)
  const branchName = pending?.branch ?? task.branch

  // ⛔ The prose lives in the tooltips. What stays on the strip is what protects work.
  const commitTitle =
    'Asks this conversation’s agent — in the same session, so it still has the context — to commit ' +
    (uncommittedNow ? `the ${uncommittedShort} on ${branchName}` : `whatever is uncommitted on ${branchName}`) +
    ` and then land it: ${FINISH_LABELS[commitLevel]} (${commitLevelWhere}). ` +
    'With the land_work MCP tool the agent lands it itself; on an adapter without MCP it says the ' +
    'commit is ready and the tool lands it when the turn ends. “Commit only” asks for the commit ' +
    'and no landing. ' +
    'This spends a turn and does not finish the task: the conversation stays open, on the next ' +
    'numbered branch once it lands. ▼ picks a different level for this press.' +
    (uncommittedNow && pending?.unclaimed
      ? ' This task is not holding that workspace any more; the branch and these files are still in it, and the run prefers that tree.'
      : '') +
    (cannotLook
      ? ` ⚠️ Could not read this task’s workspace (${pending?.reason}), so there is no telling what is uncommitted; the run checks the branch out again.`
      : '')
  const landCommon =
    `Lands ${pending?.unlandedCommits === 1 ? '1 commit' : `${pending?.unlandedCommits ?? 0} commits`} ` +
    `sitting on ${branchName} without spending a turn: ${FINISH_LABELS[landLevel]} (${landLevelWhere}). ` +
    'The tool rebases onto the landing target, runs the project’s checks where the level asks for ' +
    'them, and merges or pushes as the level says; a refusal leaves the branch exactly where it is. '
  const landTitle = conversation
    ? landCommon +
      'Landing does not finish this conversation — only Complete and Stop do — so the thread comes back ' +
      'open on the next numbered branch, ready to land again. ▼ picks another level for this press.' +
      // ⛔ Untracked files are not touched by a rebase — measured — and stay in the workspace; a
      // tracked change stops the rebase outright and has to be committed or reverted first (t578).
      (pending && pending.untrackedFiles > 0
        ? ` The ${pending.untrackedFiles} untracked file(s) here stay exactly where they are: landing moves only what is committed.`
        : '') +
      (pending && pending.dirtyFiles > 0
        ? ` ⚠️ ${pending.dirtyFiles} tracked file(s) are modified — a rebase will not run over those, so Commit or revert them first.`
        : '')
    : landCommon + '▼ picks another level for this press.'
  const resolveTitle =
    'Dispatches a landing-repair run on this thread with the worker and model chosen under the message ' +
    'box. It carries the landing failure, check output, branch and required landing procedure into that ' +
    'run, so the new agent knows it is repairing and landing existing work rather than starting the ' +
    'task over. ' +
    resolveCauses.join(' ')
  const relandTitle =
    `Rebases and lands ${task.branch} again now, without dispatching an agent. Use it once the ` +
    'trunk is clean or another task has finished landing.'

  // ⚠️ One inline line for the DAG, and only when there is a DAG — the difference between the rest
  // of a plan running and not, which is why it does not live only behind a hover.
  const waitingLine =
    blocking === 0
      ? null
      : `${blocking === 1 ? '1 task waits' : `${blocking} tasks wait`} on this one — Complete releases ${blocking === 1 ? 'it' : 'them'}; Stop keeps ${blocking === 1 ? 'it' : 'them'} blocked.`

  const anyAction = controls.commit || unlandedNow || resolveCauses.length > 0 || (canReland && !unlandedNow)
  if (!anyAction && !uncommittedNow && !cannotLook && !commitError && !waitingLine) return null

  return (
    <div className="decide decide--strip">
      {anyAction && (
        <div className="decide-actions">
          {controls.commit && (
            <SplitButton
              className="commit-select"
              label="Commit"
              tone="warn"
              value={commitLevel}
              disabled={busy}
              title={commitTitle}
              ariaLabel="Commit this conversation"
              menuAriaLabel="Landing strategy for this commit"
              options={commitOffered.map((level) => ({
                value: level,
                label: `${FINISH_SHORT[level]} — ${FINISH_LABELS[level]}`
              }))}
              onAct={(level) => void handleCommit(level as FinishPolicy)}
            />
          )}

          {/* ⛔ The clean-tree half: committed work with nowhere to go. No agent, no turn. ⚠️ On a
              conversation it ends nothing: the thread stays open on the next numbered branch. */}
          {unlandedNow && (
            <SplitButton
              className="commit-select"
              label="Land"
              tone="primary"
              value={landLevel}
              disabled={busy}
              title={landTitle}
              ariaLabel={conversation ? 'Land this conversation' : 'Land this task'}
              menuAriaLabel="Landing strategy for this branch"
              options={landOffered.map((level) => ({
                value: level,
                label: `${FINISH_SHORT[level]} — ${FINISH_LABELS[level]}`
              }))}
              onAct={(level) => void handleLand(level as FinishPolicy)}
            />
          )}

          {resolveCauses.length > 0 && (
            <button className="btn btn--primary" title={resolveTitle} disabled={busy} onClick={() => void handleResolveRetry()}>
              Resolve &amp; retry
            </button>
          )}

          {canReland && !unlandedNow && (
            <button className="btn btn--primary" title={relandTitle} disabled={busy} onClick={() => void handleReland()}>
              Retry landing
            </button>
          )}
        </div>
      )}

      {uncommittedNow && (
        <div className="decide-note decide-warn">
          ⚠️ {uncommittedShort} —{' '}
          {confirmFinish
            ? 'press Complete again to complete anyway'
            : `Commit first; Complete releases ${uncommittedCount === 1 ? 'it' : 'them'} with the workspace`}
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
          Pick a worker or model under the message box to hand this repair to another agent.
        </div>
      )}
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
