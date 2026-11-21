import { useEffect, useState } from 'react'
import type { Task } from '@shared/tasks'
import { BUILTIN_TAGS, cleanTags, tagDisplay, tagKey } from '@shared/modeltags'
import { errorMessage } from '@shared/errors.js'
import { rpc } from '../../lib/daemon'
import { modelLabel } from '../../lib/modelname'
import { Pill } from '../Pill'

export interface DelegationCatalog {
  availableTiers: string[]
  availableModels: string[]
  modelTiers: Record<string, string[]>
}

export interface DelegationPolicyValue {
  on: boolean
  allowedTiers: string[]
  allowedModels: string[]
}

export interface DelegateSplitPillProps {
  on: boolean
  allowedTiers: string[]
  allowedModels: string[]
  availableTiers?: string[]
  availableModels?: string[]
  modelTiers?: Record<string, string[]>
  busy?: boolean
  align?: 'left' | 'right'
  onChange: (next: DelegationPolicyValue) => void
}

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

/**
 * Fetches available capability tiers, offered models, and tier-by-model tags for the delegation
 * popover when the caller does not pass them explicitly.
 */
export function useDelegationCatalog(enabled = true): DelegationCatalog {
  const [catalog, setCatalog] = useState<DelegationCatalog>({
    availableTiers: [...BUILTIN_TAGS],
    availableModels: [],
    modelTiers: {}
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void Promise.all([rpc('settings.get'), rpc('model.options')])
      .then(([s, opts]) => {
        if (cancelled) return
        const tiers =
          s.autoModelTiers && s.autoModelTiers.length > 0
            ? cleanTags(s.autoModelTiers.map((t) => t.tag))
            : [...BUILTIN_TAGS]
        const models = new Set<string>()
        for (const group of opts) {
          for (const m of group.models) models.add(m.id)
        }
        for (const t of s.autoModelTiers ?? []) {
          for (const e of t.entries) models.add(e.model)
        }
        const tiersByModel: Record<string, string[]> = {}
        for (const tier of s.autoModelTiers ?? []) {
          for (const entry of tier.entries) {
            tiersByModel[entry.model] = cleanTags([...(tiersByModel[entry.model] ?? []), tier.tag])
          }
        }
        setCatalog({
          availableTiers: tiers.length > 0 ? tiers : [...BUILTIN_TAGS],
          availableModels: [...models],
          modelTiers: tiersByModel
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled])

  return catalog
}

/** Concise restriction summary shown on the right half of `DelegateSplitPill` when ON and narrowed. */
export function delegationSummary(on: boolean, allowedTiers: readonly string[], allowedModels: readonly string[]): string {
  if (!on) return ''
  const parts: string[] = []
  if (allowedTiers.length > 0) {
    parts.push(allowedTiers.map((t) => tagDisplay(t)).join(', '))
  }
  if (allowedModels.length > 0) {
    parts.push(`${allowedModels.length} model${allowedModels.length === 1 ? '' : 's'}`)
  }
  return parts.length > 0 ? ` (${parts.join(' · ')})` : ''
}

/** Portalled popover content listing allowed tiers and allowed models with configured tier badges. */
export function DelegationMenu({
  on,
  allowedTiers,
  allowedModels,
  availableTiers,
  availableModels,
  modelTiers,
  busy = false,
  onChange
}: {
  on: boolean
  allowedTiers: string[]
  allowedModels: string[]
  availableTiers: string[]
  availableModels: string[]
  modelTiers: Record<string, string[]>
  busy?: boolean
  onChange: (next: DelegationPolicyValue) => void
}): React.JSX.Element {
  const allTiers = cleanTags([...availableTiers, ...allowedTiers])
  const allModels = [...new Set([...availableModels, ...allowedModels])]
  return (
    <div className="delegation-picker" role="group" aria-label="Delegation settings">
      <div className="delegation-picker-section">
        <div className="delegation-picker-heading">Allowed tiers</div>
        {allTiers.map((tier) => {
          const key = tagKey(tier)
          const checked = allowedTiers.some((t) => tagKey(t) === key)
          return (
            <label key={key} className="delegation-picker-row">
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={() =>
                  onChange({
                    on,
                    allowedTiers: checked
                      ? allowedTiers.filter((t) => tagKey(t) !== key)
                      : [...allowedTiers, tier],
                    allowedModels
                  })
                }
              />
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
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={() =>
                    onChange({
                      on,
                      allowedTiers,
                      allowedModels: checked
                        ? allowedModels.filter((m) => m !== modelId)
                        : [...allowedModels, modelId]
                    })
                  }
                />
                <span>{modelLabel(modelId) ?? modelId}</span>
                {tiers.length > 0 && (
                  <span className="delegation-picker-tiers">{tiers.map(tagDisplay).join(', ')}</span>
                )}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Pure split-pill body `[ON/OFF | Delegate ▼]` shared by `DelegateSplitPill` and unit tests.
 */
export function DelegateSplitPillView({
  on,
  allowedTiers,
  allowedModels,
  availableTiers,
  availableModels,
  modelTiers,
  busy = false,
  align = 'left',
  onChange
}: Omit<DelegateSplitPillProps, 'availableTiers' | 'availableModels' | 'modelTiers'> & {
  availableTiers: string[]
  availableModels: string[]
  modelTiers: Record<string, string[]>
}): React.JSX.Element {
  const normTiers = cleanTags(allowedTiers)
  const normModels = allowedModels.map((m) => m.trim()).filter((m) => m.length > 0)
  const summary = delegationSummary(on, normTiers, normModels)

  return (
    <span className={`split-pill${on ? ' split-pill--on' : ' split-pill--off'}`}>
      <button
        type="button"
        className={`split-pill-toggle${on ? ' split-pill-toggle--on' : ''}`}
        aria-label="Toggle delegation"
        aria-pressed={on}
        disabled={busy}
        title={
          on
            ? 'Delegation is on: the agent may hand parts of this work to other agents. Click to turn off.'
            : 'Delegation is off: the agent does all of this work itself. Click to turn on.'
        }
        onClick={() => onChange({ on: !on, allowedTiers: normTiers, allowedModels: normModels })}
      >
        {on ? 'ON' : 'OFF'}
      </button>
      <Pill
        className="split-pill-menu-trigger"
        ariaLabel="Delegation"
        align={align}
        muted={!on}
        label={
          <>
            Delegate{summary} <span aria-hidden="true">▼</span>
          </>
        }
        title={
          on
            ? 'The agent may hand parts of this work to other agents using allowed tiers and models. Click to configure delegation.'
            : 'The agent does all of this work itself. /delegate switches this back on. Click to configure delegation.'
        }
        menu={() => (
          <DelegationMenu
            on={on}
            allowedTiers={normTiers}
            allowedModels={normModels}
            availableTiers={availableTiers}
            availableModels={availableModels}
            modelTiers={modelTiers}
            busy={busy}
            onChange={onChange}
          />
        )}
      />
    </span>
  )
}

/**
 * Unified `[ON/OFF | Delegate ▼]` split pill for configuring whether delegation is enabled and which
 * tiers/models delegated pieces may use. Fetches the fleet catalog automatically if omitted.
 */
export function DelegateSplitPill({
  availableTiers,
  availableModels,
  modelTiers,
  ...rest
}: DelegateSplitPillProps): React.JSX.Element {
  const hasFullCatalog =
    availableTiers !== undefined && availableModels !== undefined && modelTiers !== undefined
  const fetched = useDelegationCatalog(!hasFullCatalog)
  return (
    <DelegateSplitPillView
      {...rest}
      availableTiers={availableTiers ?? fetched.availableTiers}
      availableModels={availableModels ?? fetched.availableModels}
      modelTiers={modelTiers ?? fetched.modelTiers}
    />
  )
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
  onFailure,
  hasMcp = null,
  canToolSplit = null
}: {
  task: Task
  refresh: () => Promise<void>
  onFailure?: (err: string | null) => void
  /**
   * The next-dispatch worker's adapter MCP capability, or null while unknown (t706).
   * Deprecated in favor of `canToolSplit` (t1289).
   */
  hasMcp?: boolean | null
  /**
   * Whether the worker can file splits by tool (via native MCP or CLI helper) (t706, t1289).
   * Shown inline only when `onFailure` is omitted (TaskThread renders `DelegateNotice` below the row).
   */
  canToolSplit?: boolean | null
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [localFailure, setLocalFailure] = useState<string | null>(null)
  const catalog = useDelegationCatalog(delegationPillShown(task))

  if (!delegationPillShown(task)) return null
  const on = task.mandate.allowed.includes('spawn_tasks')
  const allowedTiers = cleanTags(task.mandate.allowedTiers ?? [])
  const allowedModels = (task.mandate.allowedModels ?? [])
    .map((m) => m.model.trim())
    .filter((m) => m.length > 0)

  const reportFailure = (err: string | null): void => {
    if (onFailure) onFailure(err)
    else setLocalFailure(err)
  }

  const updatePolicy = (next: DelegationPolicyValue): void => {
    setBusy(true)
    reportFailure(null)
    void rpc('task.update', {
      id: task.id,
      delegationPolicy: {
        on: next.on,
        allowedTiers: next.allowedTiers,
        allowedModels: next.allowedModels.flatMap((model) => {
          const existing = task.mandate.allowedModels?.filter((entry) => entry.model.trim() === model)
          return existing?.length ? existing : [{ model, effort: null }]
        })
      }
    })
      .then(() => refresh())
      .catch((err: unknown) => reportFailure(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  const pill = (
    <DelegateSplitPill
      on={on}
      allowedTiers={allowedTiers}
      allowedModels={allowedModels}
      availableTiers={catalog.availableTiers}
      availableModels={catalog.availableModels}
      modelTiers={catalog.modelTiers}
      busy={busy}
      onChange={updatePolicy}
    />
  )

  if (onFailure) return pill
  return (
    <>
      {pill}
      <DelegateNotice task={task} canToolSplit={canToolSplit ?? hasMcp} failure={localFailure} />
    </>
  )
}
