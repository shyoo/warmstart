import { useEffect, useState } from 'react'
import type { Task } from '@shared/tasks'
import { BUILTIN_TAGS, cleanTags, tagDisplay, tagKey } from '@shared/modeltags'
import { errorMessage } from '@shared/errors.js'
import { rpc } from '../../lib/daemon'
import { modelLabel } from '../../lib/modelname'
import { Pill } from '../Pill'

/**
 * Whether this thread's agent may hand work to other agents (t704, t1322).
 *
 * ⛔ **Authority, applied at once — not a next-run choice like the pills beside it.** It writes the
 * task's `spawn_tasks`, `allowedTiers`, and `allowedModels`, which the daemon checks when the agent
 * calls `task_split` or `delegation_status`; the agent is told of the change on its next turn.
 * Turning it on is refused, with the reason, when the task was filed by one that cannot delegate.
 *
 * ⚠️ Shown on work tasks and conversations only — a plan or a debate splits through its own contract.
 */
export function delegationPillShown(task: Pick<Task, 'kind'>): boolean {
  return task.kind === 'work' || task.kind === 'conversation'
}

export function DelegateNotice({
  task,
  canToolSplit = null,
  failure = null
}: {
  task: Task
  /**
   * Whether the worker can file splits by tool (via native MCP or CLI helper) (t706, t1289).
   * Shown only when delegation is on and the worker is known to lack both — a delegation
   * the agent cannot file by tool.
   */
  canToolSplit?: boolean | null
  failure?: string | null
}): React.JSX.Element | null {
  if (!delegationPillShown(task)) return null
  const on = task.mandate.allowed.includes('spawn_tasks')
  if (!failure && !(on && canToolSplit === false)) return null
  return (
    <>
      {failure && <span className="compose-hint warn">{failure}</span>}
      {on && canToolSplit === false && (
        <span className="compose-hint warn">
          This worker has no MCP or CLI tools: the agent cannot file splits by tool. Send /delegate and
          it writes each piece out for you to file.
        </span>
      )}
    </>
  )
}

export function DelegatePill({
  task,
  refresh,
  onFailure
}: {
  task: Task
  refresh: () => Promise<void>
  onFailure?: (err: string | null) => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [availableTiers, setAvailableTiers] = useState<string[]>([...BUILTIN_TAGS])
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelTiers, setModelTiers] = useState<Record<string, string[]>>({})

  useEffect(() => {
    let cancelled = false
    void Promise.all([rpc('settings.get'), rpc('model.options')])
      .then(([s, opts]) => {
        if (cancelled) return
        const tiers =
          s.autoModelTiers && s.autoModelTiers.length > 0
            ? cleanTags(s.autoModelTiers.map((t) => t.tag))
            : [...BUILTIN_TAGS]
        setAvailableTiers(tiers.length > 0 ? tiers : [...BUILTIN_TAGS])
        const models = new Set<string>()
        for (const group of opts) {
          for (const m of group.models) models.add(m.id)
        }
        for (const t of s.autoModelTiers ?? []) {
          for (const e of t.entries) models.add(e.model)
        }
        setAvailableModels([...models])
        const tiersByModel: Record<string, string[]> = {}
        for (const tier of s.autoModelTiers ?? []) {
          for (const entry of tier.entries) {
            tiersByModel[entry.model] = cleanTags([...(tiersByModel[entry.model] ?? []), tier.tag])
          }
        }
        setModelTiers(tiersByModel)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!delegationPillShown(task)) return null
  const on = task.mandate.allowed.includes('spawn_tasks')
  const allowedTiers = cleanTags(task.mandate.allowedTiers ?? [])
  const allowedModels = (task.mandate.allowedModels ?? [])
    .map((m) => m.model.trim())
    .filter((m) => m.length > 0)

  const summaryParts: string[] = []
  if (on && allowedTiers.length > 0) {
    summaryParts.push(allowedTiers.map((t) => tagDisplay(t)).join(', '))
  }
  if (on && allowedModels.length > 0) {
    summaryParts.push(`${allowedModels.length} model${allowedModels.length === 1 ? '' : 's'}`)
  }
  const summary = summaryParts.length > 0 ? ` (${summaryParts.join(' · ')})` : ''
  const toggleLabel = `${on ? 'Delegate on' : 'Delegate off'}${summary}`

  const updatePolicy = (next: { on: boolean; allowedTiers?: string[]; allowedModels?: string[] }): void => {
    setBusy(true)
    onFailure?.(null)
    const nextModels = next.allowedModels ?? allowedModels
    void rpc('task.update', {
      id: task.id,
      delegationPolicy: {
        on: next.on,
        allowedTiers: next.allowedTiers ?? allowedTiers,
        allowedModels: nextModels.flatMap((model) => {
          const existing = task.mandate.allowedModels?.filter((entry) => entry.model.trim() === model)
          return existing?.length ? existing : [{ model, effort: null }]
        })
      }
    })
      .then(() => refresh())
      .catch((err: unknown) => onFailure?.(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  const allTiers = cleanTags([...availableTiers, ...allowedTiers])
  const allModels = [...new Set([...availableModels, ...allowedModels])]

  return (
    <div className="delegate-split">
      <button
        type="button"
        className={`pill delegate-split-main${on ? '' : ' pill--muted'}`}
        aria-label="Toggle delegation"
        aria-pressed={on}
        disabled={busy}
        title={
          on
            ? 'Delegation is on — click to turn it off.'
            : 'Delegation is off — click to turn it on.'
        }
        onClick={() => updatePolicy({ on: !on })}
      >
        {toggleLabel}
      </button>
      <Pill
        className="delegate-split-more"
        ariaLabel="Delegation settings"
        muted={!on}
        disabled={busy}
        align="right"
        label={<span aria-hidden="true">▾</span>}
        title={
          on
            ? 'The agent may hand parts of this work to other agents using allowed tiers and models. Click to configure delegation.'
            : 'The agent does all of this work itself. /delegate switches this back on. Click to configure delegation.'
        }
        menu={() => (
          <div className="delegation-picker" role="group" aria-label="Delegation settings">
            <div className="delegation-picker-section">
              <div className="delegation-picker-heading">Allowed tiers</div>
              {allTiers.map((tier) => {
                const key = tagKey(tier)
                const checked = allowedTiers.some((t) => tagKey(t) === key)
                return (
                  <label key={key} className="delegation-picker-row">
                    <input type="checkbox" checked={checked} disabled={busy}
                      onChange={() => updatePolicy({ on, allowedTiers: checked
                        ? allowedTiers.filter((t) => tagKey(t) !== key) : [...allowedTiers, tier] })} />
                    <span>{tagDisplay(tier)}</span>
                  </label>
                )
              })}
            </div>
            {allModels.length > 0 && (
              <div className="delegation-picker-section">
                <div className="delegation-picker-heading">Allowed models</div>
                {allModels.map((modelId) => {
                  const checked = allowedModels.includes(modelId)
                  const tiers = modelTiers[modelId] ?? []
                  return (
                    <label key={modelId} className="delegation-picker-row">
                      <input type="checkbox" checked={checked} disabled={busy}
                        onChange={() => updatePolicy({ on, allowedModels: checked
                          ? allowedModels.filter((m) => m !== modelId) : [...allowedModels, modelId] })} />
                      <span>{modelLabel(modelId) ?? modelId}</span>
                      {tiers.length > 0 && <span className="delegation-picker-tiers">{tiers.map(tagDisplay).join(', ')}</span>}
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )}
      />
    </div>
  )
}
