import { useCallback, useEffect, useState } from 'react'
import type { FinishPolicy, Objective, ObjectivePreset, SessionSharing } from '@shared/tasks'
import {
  DEFAULT_FLEET_FINISH,
  DEFAULT_FLEET_SHARING,
  DEFAULT_OBJECTIVE,
  FINISH_LABELS,
  FINISH_ORDER,
  OBJECTIVE_PRESET_LABELS,
  OBJECTIVE_PRESET_ORDER,
  PRESETS,
  presetOf
} from '@shared/tasks'
import { normalise } from '@shared/policy'
import type { Settings } from '@shared/protocol'
import { rpc } from '../lib/daemon'
import { SettingRow, SettingSwitch } from './SettingRow'
import { SettingButtonSelect } from './SettingButtonSelect'
import { errorMessage } from '@shared/errors.js'

/**
 * Fleet-wide settings: what the scheduler optimizes for, how it intervenes, how often it probes.
 *
 * ⛔ These govern the *fleet*, unlike AppSettings which governs this window.
 *
 * ⚠️ One flat list of `SettingRow`s, deliberately. It carried six sub-headings that each restated
 * the one setting beneath them ("Automatic compaction" under a heading reading "Automatic
 * compaction") and a paragraph of reasoning per row, which is a page nobody reads twice. Each row
 * now says what the current state *does*; the reasoning lives in `docs/` and in the comments here,
 * where it is not re-read on every glance.
 */
export function FleetSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSettings(await rpc('settings.get'))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** ⛔ The row always paints what the daemon returned, never the value that was clicked. */
  const save = useCallback(async (patch: Partial<Settings>) => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await rpc('settings.set', patch))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const chooseObjectivePreset = useCallback(
    async (presetOrCustom: ObjectivePreset | 'custom') => {
      if (presetOrCustom === 'custom') return
      await save({ objective: PRESETS[presetOrCustom] })
    },
    [save]
  )

  const updateCustomObjective = useCallback(
    async (partial: Partial<Objective>) => {
      if (!settings) return
      const current = settings.objective ?? DEFAULT_OBJECTIVE
      await save({ objective: normalise({ ...current, ...partial }) })
    },
    [save, settings]
  )

  const autoCompact = settings?.autoCompact ?? true
  const autoPreempt = settings?.autoPreempt ?? true
  const autoOverrunPreempt = settings?.autoOverrunPreempt ?? true
  const spendCreditsPastLimit = settings?.spendCreditsPastLimit ?? false
  const autoRunawayStop = settings?.autoRunawayStop ?? false
  const summariseTitles = settings?.summariseTitles ?? false
  const modelExploration = settings?.modelExploration ?? false
  const modelExplorationRate = settings?.modelExplorationRate ?? 0.1
  const liveNarration = settings?.liveNarration ?? 'summary'
  const finishPolicy = settings?.finishPolicy ?? DEFAULT_FLEET_FINISH
  const sessionSharing = settings?.sessionSharing ?? DEFAULT_FLEET_SHARING
  const probeIntervalMinutes = settings?.probeIntervalMinutes ?? 5
  const idleProbeIntervalMinutes = settings?.idleProbeIntervalMinutes ?? 20
  const objective = settings?.objective ?? DEFAULT_OBJECTIVE
  const currentPreset = presetOf(objective)
  const disabled = busy || settings === null

  return (
    <div>
      {error && <div className="alert">{error}</div>}

      <div className="setting-list">
        <SettingRow
          title="Optimization objective"
          description="What the scheduler and cache clock weigh fleet-wide. Overridden per project and per task."
          control={
            <select
              className="finish-picker setting-row-control-select"
              aria-label="Fleet optimization objective"
              value={currentPreset ?? 'custom'}
              disabled={disabled}
              onChange={(e) => void chooseObjectivePreset(e.target.value as ObjectivePreset | 'custom')}
            >
              {OBJECTIVE_PRESET_ORDER.map((p) => (
                <option key={p} value={p}>
                  {OBJECTIVE_PRESET_LABELS[p]}
                </option>
              ))}
              <option value="custom">custom weight vector</option>
            </select>
          }
        >
          {/* The preset labels already carry their weights, so the sliders appear only when there is
              no preset to read them off. */}
          {!currentPreset && (
            <>
              <ObjectiveSlider
                label="Cost"
                value={objective.cost}
                disabled={disabled}
                onChange={(cost) => void updateCustomObjective({ cost })}
              />
              <ObjectiveSlider
                label="Velocity"
                value={objective.velocity}
                disabled={disabled}
                onChange={(velocity) => void updateCustomObjective({ velocity })}
              />
              <ObjectiveSlider
                label="Quality"
                value={objective.quality}
                disabled={disabled}
                onChange={(quality) => void updateCustomObjective({ quality })}
              />
            </>
          )}
        </SettingRow>

        {/* ⛔ An information boundary, not a performance switch: an agent joining a conversation
            sees everything said in it, which is why sharing never crosses a project or an account
            and the description leads with who sees what rather than with the tokens it saves. */}
        <SettingRow
          title="Session sharing"
          description={
            sessionSharing === 'on'
              ? 'A task may join a conversation already open in the same project, on the same account, and sees everything said in it.'
              : 'Every task starts its own conversation. Nothing sees another task’s context.'
          }
          control={
            <select
              className="finish-picker setting-row-control-select"
              aria-label="Fleet session sharing"
              value={sessionSharing}
              disabled={disabled}
              onChange={(e) => void save({ sessionSharing: e.target.value as SessionSharing })}
            >
              <option value="off">every task starts a new one</option>
              <option value="on">reuse one in the same project</option>
            </select>
          }
        />

        <SettingRow
          title="Finish policy"
          description={
            <>
              Default landing strategy for completed tasks. Anything not landed is kept and listed
              under <strong>Loose ends</strong>; nothing is discarded.
            </>
          }
          control={
            <select
              className="finish-picker setting-row-control-select"
              aria-label="Fleet finish policy"
              value={finishPolicy}
              disabled={disabled}
              onChange={(e) => void save({ finishPolicy: e.target.value as FinishPolicy })}
            >
              {FINISH_ORDER.map((p) => (
                <option key={p} value={p}>
                  {FINISH_LABELS[p]}
                </option>
              ))}
            </select>
          }
        />

        {/* ⚠️ Off has to state its consequence: running out of room to *save* is the one loss that
            is not recoverable, so the row says where a session goes instead of compacting. */}
        <SettingRow
          title="Automatic compaction"
          description={
            autoCompact
              ? 'Automatically compacts session context when cost/token efficiency thresholds are met.'
              : 'The clock never compacts on its own; a session that reaches token limits hands off and closes instead.'
          }
          control={
            <SettingSwitch
              label="Automatic compaction"
              on={autoCompact}
              busy={disabled}
              onToggle={() => void save({ autoCompact: !autoCompact })}
            />
          }
        />

        <SettingRow
          title="Wrap up before a quota window closes"
          description={
            autoPreempt
              ? 'Commits and pauses runs approaching quota reset window, resuming automatically after reset.'
              : 'Runs continue until window resets, risking abrupt termination and uncommitted changes.'
          }
          control={
            <SettingSwitch
              label="Wrap up before a quota window closes"
              on={autoPreempt}
              busy={disabled}
              onToggle={() => void save({ autoPreempt: !autoPreempt })}
            />
          }
        />

        <SettingRow
          title="Preempt near 5-hour quota exhaustion"
          description={
            autoOverrunPreempt
              ? 'A run at 95% of the 5-hour window, or one warned in-stream, wraps up and parks until the reset instead of failing on a 429.'
              : 'Runs continue until quota is exhausted and fail on hard API errors.'
          }
          control={
            <SettingSwitch
              label="Preempt a run when 5-hour quota is near exhaustion"
              on={autoOverrunPreempt}
              busy={disabled}
              onToggle={() => void save({ autoOverrunPreempt: !autoOverrunPreempt })}
            />
          }
        />

        {/* ⛔ The only switch here that lets the fleet spend real money, so it is off by default and
            says so. ⚠️ It is also the only one that is inert on its own: it reaches a worker only
            where the vendor itself reports usage credits enabled on that account, which is why the
            description names both halves rather than promising something the switch cannot deliver
            alone. */}
        <SettingRow
          title="Spend usage credits past the plan limit"
          description={
            spendCreditsPastLimit
              ? 'A worker whose Allow credits switch is also on, and whose vendor reports credits enabled, is no longer wrapped up or held at the plan limit — work carries on and is billed against those credits. Accounts without that worker setting, without credits, or with monthly credits spent are unaffected.'
              : 'A run is wrapped up at the plan limit even on an account that has usage credits. Worker-level Allow credits switches are disabled until this safeguard is turned on.'
          }
          control={
            <SettingSwitch
              label="Let a run continue past the plan limit on credit-enabled accounts"
              on={spendCreditsPastLimit}
              busy={disabled}
              onToggle={() => void save({ spendCreditsPastLimit: !spendCreditsPastLimit })}
            />
          }
        />

        {/* ⛔ Off by default: the overrun is counted in raw tokens, which on these CLIs are ~98%
            cache reads and grow with how *long* a session is rather than how wasteful. */}
        <SettingRow
          title="Stop a run that is far past its estimate"
          description={
            autoRunawayStop
              ? 'Automatically terminates and flags runs exceeding 3× median token estimates.'
              : 'Runs are not stopped based on token overrun estimates.'
          }
          control={
            <SettingSwitch
              label="Stop a run that is far past its estimate"
              on={autoRunawayStop}
              busy={disabled}
              onToggle={() => void save({ autoRunawayStop: !autoRunawayStop })}
            />
          }
        />

        {/* ⚠️ A task's title *is* its prompt — sent to the agent verbatim — so this writes a label
            the UI reads and never touches the prompt itself. */}
        <SettingRow
          title="Ask the controller to name long tasks"
          description={
            summariseTitles
              ? 'Generates a concise task title for long prompts using a short background model call.'
              : 'Displays the first line of the prompt as the task title.'
          }
          control={
            <SettingSwitch
              label="Ask the controller to name long tasks"
              on={summariseTitles}
              busy={disabled}
              onToggle={() => void save({ summariseTitles: !summariseTitles })}
            />
          }
        />

        <SettingRow
          title="Explore alternative models"
          description={
            modelExploration
              ? `The scheduler occasionally dispatches tasks to an alternative routable model on the chosen worker (${Math.round(modelExplorationRate * 100)}% of eligible decisions) to measure fitness and price.`
              : 'The scheduler always dispatches to the highest-scoring model. No turns are spent exploring.'
          }
          control={
            <SettingSwitch
              label="Explore alternative models"
              on={modelExploration}
              busy={disabled}
              onToggle={() => void save({ modelExploration: !modelExploration })}
            />
          }
        >
          {modelExploration && (
            <div className="setting-row-slider">
              <label>Exploration rate</label>
              <input
                type="range"
                min="1"
                max="50"
                aria-label="Model exploration rate"
                value={Math.round(modelExplorationRate * 100)}
                disabled={disabled}
                onChange={(e) => void save({ modelExplorationRate: Number(e.target.value) / 100 })}
              />
              <span className="num">{Math.round(modelExplorationRate * 100)}%</span>
            </div>
          )}
        </SettingRow>

        {/* ⛔ What this buys is *smaller* than it sounds, and the description says so rather than
            selling it. Measured 2026-09-13 on claude 2.1.270: the flag does not carry the thinking
            words (the vendor sends an empty string for those either way) and does not carry the
            thinking token estimate (that arrives free on every turn). It carries the typing. */}
        <SettingRow
          title="Live narration"
          description={
            liveNarration === 'streaming'
              ? 'Streams agent output word by word in real time on supported CLIs. Uses more stream events; consumes no extra tokens.'
              : 'Displays completed messages, tool calls, and thinking phases.'
          }
          control={
            <SettingButtonSelect
              value={liveNarration}
              aria-label="Live narration"
              disabled={disabled}
              onChange={(value) =>
                void save({ liveNarration: value as 'summary' | 'streaming' })
              }
              options={[
                { value: 'summary', label: 'Summary' },
                { value: 'streaming', label: 'Streaming' }
              ]}
            />
          }
        />

        {/* ⛔ Two cadences, not one. A single interval had to serve an account spending its window
            right now and a fleet with nothing running, and it answered neither: the number said five
            minutes while the reading behind it could be two hours old. */}
        <SettingRow
          title="Quota probe while running"
          description="Polls CLI usage cache for active worker accounts via background process (zero tokens consumed)."
          control={
            <select
              className="finish-picker setting-row-control-select"
              aria-label="Quota probe frequency while running"
              value={probeIntervalMinutes}
              disabled={disabled}
              onChange={(e) => void save({ probeIntervalMinutes: Number(e.target.value) })}
            >
              <option value={1}>Every 1 minute</option>
              <option value={2}>Every 2 minutes</option>
              <option value={5}>Every 5 minutes (default)</option>
              <option value={10}>Every 10 minutes</option>
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every 60 minutes</option>
            </select>
          }
        />

        <SettingRow
          title="Quota probe when idle"
          description={
            <>
              Polls CLI usage cache when workers are idle. Always runs <strong>within 30 seconds of the reset time</strong> for parked tasks and immediately after a rate-limit warning.
            </>
          }
          control={
            <select
              className="finish-picker setting-row-control-select"
              aria-label="Quota probe frequency when idle"
              value={idleProbeIntervalMinutes}
              disabled={disabled}
              onChange={(e) => void save({ idleProbeIntervalMinutes: Number(e.target.value) })}
            >
              <option value={5}>Every 5 minutes</option>
              <option value={10}>Every 10 minutes</option>
              <option value={20}>Every 20 minutes (default)</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every 60 minutes</option>
              <option value={120}>Every 2 hours</option>
            </select>
          }
        />
      </div>
    </div>
  )
}

function ObjectiveSlider({
  label,
  value,
  disabled,
  onChange
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (next: number) => void
}): React.JSX.Element {
  return (
    <div className="setting-row-slider">
      <label>{label}</label>
      <input
        type="range"
        min="0"
        max="100"
        aria-label={`${label} weight`}
        value={Math.round(value * 100)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="num">{(value * 100).toFixed(0)}%</span>
    </div>
  )
}
