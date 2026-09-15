import { useEffect, useState } from 'react'
import type { ModelOptions, RpcResult } from '@shared/protocol'
import { resolveModelChoice, type Task } from '@shared/tasks'
import { rpc } from '../api.js'
import { decisionsFor, type TaskDecision } from '../lib/question.js'

type FleetList = RpcResult<'fleet.list'>

/**
 * What a person can do to one task from the phone: settle it, redirect it, or hand it back.
 *
 * ⛔ **Drawn from what the daemon says, never from what was clicked** — the desktop card's rule
 * (`renderer/components/thread/Decide.tsx`). Each of these can be refused: a landing that does not
 * land, an override that cannot lift an exhausted window, a retry the daemon will not start. The
 * refusal is what is shown, on the card, rather than a success the operator has to disbelieve.
 *
 * ⚠️ **Mark done and Stop are not the same button in two moods.** `admit()` releases a dependent
 * only when its dependency reaches `completed`, so Mark done starts whatever was waiting on this
 * task and Stop does not. That is the whole difference and it is stated on the card, because on a
 * phone there is no tooltip to put it in.
 */
export function Decide({
  task,
  fleet,
  modelOptions,
  now,
  onChanged
}: {
  task: Task
  fleet: FleetList
  modelOptions: ModelOptions[]
  now: number
  onChanged: () => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [workerId, setWorkerId] = useState(task.constraints.workerId ?? '')
  const [model, setModel] = useState(task.constraints.model ?? (task.constraints.modelPolicy === 'auto' ? '__auto__' : ''))
  const [effort, setEffort] = useState(task.constraints.effort ?? '')

  useEffect(() => {
    setWorkerId(task.constraints.workerId ?? '')
    setModel(task.constraints.model ?? (task.constraints.modelPolicy === 'auto' ? '__auto__' : ''))
    setEffort(task.constraints.effort ?? '')
  }, [task.constraints.workerId, task.constraints.model, task.constraints.modelPolicy, task.constraints.effort])

  const decisions = decisionsFor(task, now)
  if (decisions.length === 0) return null

  const entry = fleet.find((e) => e.worker.id === workerId) ?? null
  const adapter = modelOptions.find((o) => o.adapterId === entry?.worker.adapterId)
  const offeredModels = adapter?.models ?? []
  const canSetEffort = adapter?.selectableEffort ?? false
  const inherited = resolveModelChoice(null, entry?.worker ?? null, canSetEffort, entry?.quota).model
  const offeredEfforts = canSetEffort ? (offeredModels.find((m) => m.id === model)?.effortLevels ?? []) : []

  /** A task nothing is currently moving: reassigning one has to dispatch it as well. */
  const resting =
    task.status === 'awaiting_human' ||
    task.status === 'paused_user' ||
    task.status === 'paused_quota' ||
    task.status === 'failed'

  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    try {
      setRefusal(await fn())
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : 'That did not land. Try again.')
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const press = (decision: TaskDecision): void => {
    if (!confirm(CONFIRM[decision])) return
    void run(async () => {
      switch (decision) {
        case 'override':
          await rpc('task.overrideQuota', { id: task.id })
          return null
        case 'retry': {
          const answer = await rpc('task.resolveRetry', { id: task.id })
          return answer.started ? null : (answer.reason ?? 'the retry could not be started')
        }
        case 'reland': {
          const answer = await rpc('task.land', { id: task.id })
          return answer.landed ? null : (answer.reason ?? 'the branch could not be landed')
        }
        case 'resume':
          await rpc('task.resume', { id: task.id })
          return null
        case 'resolve':
          await rpc('task.resolve', { id: task.id })
          return null
        case 'stop':
          await rpc('task.cancel', { id: task.id })
          return null
        case 'reassign':
          return reassign()
      }
    })
  }

  /**
   * ⛔ The same atomic reassignment the desktop makes, and for the same reason: worker, model and
   * effort are one decision, and applying them in three calls lets the scheduler dispatch against
   * half of it. ⚠️ `task.message` is the one RPC that continues a resting task — `task.resume` only
   * leaves `paused_*` — and the daemon already writes the *Worker switched to …* system line, so
   * the note is the smallest thing a person could plausibly have meant by pressing the button.
   */
  const reassign = async (): Promise<string | null> => {
    const modelPolicy = model === '__auto__' ? 'auto' : 'inherit'
    const chosenModel = model === '__auto__' ? null : model || null
    if (workerId) {
      await rpc('task.setWorker', {
        id: task.id,
        workerId,
        model: chosenModel,
        modelPolicy,
        effort: effort || null
      })
    } else {
      // ⚠️ Two calls only because there is no worker to carry the model on: `task.setWorker`'s
      // atomic form takes one. Automatic means the scheduler picks, so nothing can dispatch
      // against a half-applied choice here.
      await rpc('task.setWorker', { id: task.id, workerId: null })
      await rpc('task.setModel', { id: task.id, model: chosenModel, effort: effort || null, modelPolicy })
    }
    if (resting) await rpc('task.message', { id: task.id, text: 'Continue.' })
    return null
  }

  const reassignLabel = resting ? 'Reassign & continue' : 'Reassign'
  return (
    <section className="m-card">
      <h3 className="m-section-title">What now</h3>
      {decisions.includes('resolve') && (
        <p className="m-detail">
          <strong>Mark done</strong> completes the task and releases anything waiting on it.{' '}
          <strong>Stop</strong> parks it in a resting state, which Resume picks back up; nothing waiting on it
          is released and nothing is destroyed.
        </p>
      )}
      <div className="m-actions">
        {decisions
          .filter((decision) => decision !== 'reassign')
          .map((decision) => (
            <button
              key={decision}
              className={`m-btn${PRIMARY.has(decision) ? ' m-btn--primary' : ''}${decision === 'stop' ? ' m-btn--danger' : ''}`}
              disabled={busy}
              onClick={() => press(decision)}
            >
              {LABEL[decision]}
            </button>
          ))}
      </div>
      {refusal && <p className="m-error">The daemon refused: {refusal}</p>}

      {decisions.includes('reassign') && (
        <div className="m-reassign">
          <label className="m-field">
            <span>Worker</span>
            <select className="m-input" value={workerId} disabled={busy} onChange={(e) => setWorkerId(e.target.value)}>
              <option value="">Automatic</option>
              {fleet.map((e) => (
                <option key={e.worker.id} value={e.worker.id}>
                  {e.worker.label}
                </option>
              ))}
            </select>
          </label>
          <label className="m-field">
            <span>Model</span>
            <select className="m-input" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
              <option value="">{inherited ? `Worker default — ${inherited}` : 'Worker default'}</option>
              <option value="__auto__">Automatic — pick per run</option>
              {offeredModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>
          {offeredEfforts.length > 0 && (
            <label className="m-field">
              <span>Effort</span>
              <select className="m-input" value={effort} disabled={busy} onChange={(e) => setEffort(e.target.value)}>
                <option value="">Default</option>
                {offeredEfforts.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="m-btn" disabled={busy} onClick={() => press('reassign')}>
            {reassignLabel}
          </button>
          <p className="m-meta">
            {resting
              ? 'Applies the worker and model together, then dispatches this task again on the same thread.'
              : 'Applies the worker and model together. The task keeps its place in the queue.'}
          </p>
        </div>
      )}
    </section>
  )
}

const LABEL: Record<TaskDecision, string> = {
  override: 'Override & continue',
  retry: 'Send back to an agent',
  reland: 'Retry landing',
  resume: 'Resume',
  reassign: 'Reassign',
  resolve: 'Mark done',
  stop: 'Stop'
}

const PRIMARY: ReadonlySet<TaskDecision> = new Set<TaskDecision>(['override', 'retry', 'reland', 'resume'])

const CONFIRM: Record<TaskDecision, string> = {
  override: 'Override the quota gate and let this task continue now?',
  retry: 'Hand this back to an agent to fix and report complete again?',
  reland: 'Try landing this branch again?',
  resume: 'Resume this task now?',
  reassign: 'Apply this worker and model to the task?',
  resolve: 'Mark this task done? It completes the task and releases anything waiting on it.',
  stop: 'Stop this task? It winds down into a resting state; nothing is destroyed.'
}
