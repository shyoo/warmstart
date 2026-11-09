import { useEffect, useState } from 'react'
import type { Task } from '@shared/tasks'
import { BUILTIN_TAGS, cleanTags, tagDisplay, tagKey, tierSlug } from '@shared/modeltags'
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

export function DelegatePill({
  task,
  refresh,
  hasMcp = null,
  canToolSplit = null
}: {
  task: Task
  refresh: () => Promise<void>
  /**
   * The next-dispatch worker's adapter MCP capability, or null while unknown (t706).
   * Deprecated in favor of `canToolSplit` (t1289).
   */
  hasMcp?: boolean | null
  /**
   * Whether the worker can file splits by tool (via native MCP or CLI helper) (t706, t1289).
   * Shown only when delegation is on and the worker is known to lack both — a delegation
   * the agent cannot file by tool.
   */
  canToolSplit?: boolean | null
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [availableTiers, setAvailableTiers] = useState<string[]>([...BUILTIN_TAGS])
  const [availableModels, setAvailableModels] = useState<string[]>([])

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
  const canSplit = canToolSplit ?? hasMcp

  const summaryParts: string[] = []
  if (on && allowedTiers.length > 0) {
    summaryParts.push(allowedTiers.map((t) => tagDisplay(t)).join(', '))
  }
  if (on && allowedModels.length > 0) {
    summaryParts.push(`${allowedModels.length} model${allowedModels.length === 1 ? '' : 's'}`)
  }
  const summary = summaryParts.length > 0 ? ` (${summaryParts.join(' · ')})` : ''
  const pillLabel = `${on ? 'Delegate on' : 'Delegate off'}${summary} ▾`

  const updatePolicy = (next: { on: boolean; allowedTiers?: string[]; allowedModels?: string[] }): void => {
    setBusy(true)
    setFailure(null)
    const nextModels = next.allowedModels ?? allowedModels
    void rpc('task.update', {
      id: task.id,
      delegationPolicy: {
        on: next.on,
        allowedTiers: next.allowedTiers ?? allowedTiers,
        allowedModels: nextModels.map((model) => ({ model, effort: null }))
      }
    })
      .then(() => refresh())
      .catch((err: unknown) => setFailure(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  const allTiers = cleanTags([...availableTiers, ...allowedTiers])
  const allModels = [...new Set([...availableModels, ...allowedModels])]

  return (
    <>
      <Pill
        className="compose-assign-pill"
        ariaLabel="Delegation"
        muted={!on}
        disabled={busy}
        label={pillLabel}
        title={
          on
            ? 'The agent may hand parts of this work to other agents using allowed tiers and models. Click to configure delegation.'
            : 'The agent does all of this work itself. /delegate switches this back on. Click to configure delegation.'
        }
        menu={() => (
          <div className="tag-picker" role="group" aria-label="Delegation settings">
            <div className="tag-picker-section">
              <div className="tag-picker-heading">
                <span>Delegation</span>
                <span className="tag-picker-heading-hint">{on ? 'enabled' : 'disabled'}</span>
              </div>
              <div className="tag-picker-list">
                <div className="tag-picker-row">
                  <label className="tag-picker-item">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy}
                      onChange={() => updatePolicy({ on: !on })}
                    />
                    <span className="tag-picker-label">Allow agent delegation (task_split)</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="tag-picker-section">
              <div className="tag-picker-heading">
                <span>Allowed capability tiers</span>
                <span className="tag-picker-heading-hint">
                  {allowedTiers.length === 0 ? 'all tiers' : `${allowedTiers.length} selected`}
                </span>
              </div>
              <div className="tag-picker-list">
                {allTiers.map((tier) => {
                  const key = tagKey(tier)
                  const checked = allowedTiers.some((t) => tagKey(t) === key)
                  const slug = tierSlug(tier)
                  return (
                    <div key={key} className="tag-picker-row">
                      <label className="tag-picker-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy}
                          onChange={() => {
                            const nextTiers = checked
                              ? allowedTiers.filter((t) => tagKey(t) !== key)
                              : [...allowedTiers, tier]
                            updatePolicy({ on: true, allowedTiers: nextTiers })
                          }}
                        />
                        <span className="tag-picker-label">{tagDisplay(tier)}</span>
                      </label>
                      {slug && <span className="tag-picker-heading-hint">[{slug}]</span>}
                    </div>
                  )
                })}
              </div>
            </div>

            {allModels.length > 0 && (
              <div className="tag-picker-section">
                <div className="tag-picker-heading">
                  <span>Allowed specific models</span>
                  <span className="tag-picker-heading-hint">
                    {allowedModels.length === 0 ? 'all in tier' : `${allowedModels.length} selected`}
                  </span>
                </div>
                <div className="tag-picker-list">
                  {allModels.map((modelId) => {
                    const checked = allowedModels.includes(modelId)
                    return (
                      <div key={modelId} className="tag-picker-row">
                        <label className="tag-picker-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy}
                            onChange={() => {
                              const nextModels = checked
                                ? allowedModels.filter((m) => m !== modelId)
                                : [...allowedModels, modelId]
                              updatePolicy({ on: true, allowedModels: nextModels })
                            }}
                          />
                          <span className="tag-picker-label">{modelLabel(modelId) ?? modelId}</span>
                        </label>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      />
      {failure && <span className="compose-hint warn">{failure}</span>}
      {on && canSplit === false && (
        <span className="compose-hint warn">
          This worker has no MCP or CLI tools: the agent cannot file splits by tool. Send /delegate and
          it writes each piece out for you to file.
        </span>
      )}
    </>
  )
}
