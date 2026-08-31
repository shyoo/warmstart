import { useCallback, useEffect, useState } from 'react'
import type { FinishPolicy, SessionSharing } from '@shared/tasks'
import { DEFAULT_FLEET_FINISH, FINISH_LABELS, FINISH_ORDER } from '@shared/tasks'
import type { Settings } from '@shared/protocol'
import { rpc } from '../lib/daemon'

/**
 * Fleet-wide settings: finishing policy, session interventions, and quota probe frequency.
 *
 * ⛔ These govern the *fleet*, unlike AppSettings which governs this window.
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
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setSwitch = useCallback(
    async (key: keyof Settings, next: boolean) => {
      setBusy(true)
      setError(null)
      try {
        setSettings(await rpc('settings.set', { [key]: next }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const chooseFinishPolicy = useCallback(
    async (next: FinishPolicy) => {
      setBusy(true)
      setError(null)
      try {
        setSettings(await rpc('settings.set', { finishPolicy: next }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const chooseSharing = useCallback(
    async (next: SessionSharing) => {
      setBusy(true)
      setError(null)
      try {
        setSettings(await rpc('settings.set', { sessionSharing: next }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const chooseProbeInterval = useCallback(
    async (minutes: number) => {
      setBusy(true)
      setError(null)
      try {
        setSettings(await rpc('settings.set', { probeIntervalMinutes: minutes }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const autoCompact = settings?.autoCompact ?? true
  const autoPreempt = settings?.autoPreempt ?? true
  const autoOverrunPreempt = settings?.autoOverrunPreempt ?? true
  const autoRunawayStop = settings?.autoRunawayStop ?? false
  const finishPolicy = settings?.finishPolicy ?? DEFAULT_FLEET_FINISH
  const sessionSharing = settings?.sessionSharing ?? 'off'
  const probeIntervalMinutes = settings?.probeIntervalMinutes ?? 5

  return (
    <div>
      {error && <div className="alert">{error}</div>}

      <section className="doc-section">
        <h3>Reusing conversations</h3>
        <div className="picker-row">
          <div className="picker-row-head">
            <p className="switch-state">
              <strong>Session sharing</strong> · {sessionSharing}
              <span className="dim"> — may a task join a conversation already open?</span>
            </p>
            <select
              className="finish-picker picker-row-control"
              aria-label="Fleet session sharing"
              value={sessionSharing}
              disabled={busy || settings === null}
              onChange={(e) => void chooseSharing(e.target.value as SessionSharing)}
            >
              <option value="off">every task starts a new one</option>
              <option value="on">reuse one in the same project</option>
            </select>
          </div>
          <p className="note">
            ⛔ <strong>Off by default, and this is an information boundary rather than a
            performance switch.</strong> An agent that joins a conversation sees everything said in
            it, so sharing only ever happens within one project, on one account, and never into a
            conversation somebody else is mid-turn in. What it buys is real and measured: a cold
            turn on this machine rebuilt <strong>41,542</strong> tokens of prompt prefix that a
            reused conversation read back for <strong>65</strong>.{' '}
            ⚠️ It changes nothing about <em>authority</em> — a task&rsquo;s mandate still decides what
            it may do. Overridden per project with <code>session.share</code> in{' '}
            <code>project.json</code>, and per task from its detail pane.
          </p>
        </div>
      </section>

      <section className="doc-section">
        <h3>When a task finishes</h3>
        <div className="picker-row">
          <div className="picker-row-head">
            <p className="switch-state">
              <strong>Finish policy</strong> · {finishPolicy}
              <span className="dim"> — default landing strategy for completed tasks.</span>
            </p>
            <select
              className="finish-picker picker-row-control"
              aria-label="Fleet finish policy"
              value={finishPolicy}
              disabled={busy || settings === null}
              onChange={(e) => void chooseFinishPolicy(e.target.value as FinishPolicy)}
            >
              {FINISH_ORDER.map((p) => (
                <option key={p} value={p}>
                  {FINISH_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <p className="note">
            The fleet-wide default, used by any project that has not set <code>landing.finish</code> in
            its <code>project.json</code>, and by any task left on <em>inherit</em>. ⛔ Multi Agent
            Controller never writes a commit for an agent and never discards work it declines to land —
            anything it will not land appears under <strong>Loose ends</strong> on Overview.{' '}
            <em>agent lands it</em> additionally requires the project to define check commands and for
            them to pass. See <code>docs/landing.md</code>.
          </p>
        </div>
      </section>

      <section className="doc-section">
        <h3>Automatic compaction</h3>
        <SwitchRow
          label="Automatic compaction"
          on={autoCompact}
          busy={busy || settings === null}
          onToggle={() => void setSwitch('autoCompact', !autoCompact)}
          state={
            autoCompact
              ? 'the clock may compact a session when the arithmetic favours it.'
              : 'the clock never compacts on its own. A session that would have been compacted' +
                ' hands off and closes instead, including when the reserve is at risk.'
          }
        >
          Compaction is what stops a long session being stranded when a quota window closes, so this
          is on by default — running out of room to <em>save</em> is the one loss that is not
          recoverable. Turn it off when compaction is not reaching your sessions: on the{' '}
          <code>stream</code> transport it is <strong>unverified</strong> whether <code>/compact</code>{' '}
          is honoured at all, and every attempt that is not costs real tokens. This switch is
          fleet-wide and takes effect on the next tick.
        </SwitchRow>
      </section>

      <section className="doc-section">
        <h3>Stopping a run early</h3>
        <SwitchRow
          label="Wrap up before a quota window closes"
          on={autoPreempt}
          busy={busy || settings === null}
          onToggle={() => void setSwitch('autoPreempt', !autoPreempt)}
          state={
            autoPreempt
              ? 'a run inside the margin is told to commit and hand off, then parked until the reset.'
              : 'runs are left alone at a window boundary and are cut off mid-thought when it closes.'
          }
        >
          On by default: this is the intervention the tool exists to make, and it acts on a{' '}
          <em>measured</em> reset time rather than a guess. The task goes to{' '}
          <code>paused_quota</code> carrying the reset as its resume time, so it restarts itself —
          nothing is cancelled. With this off, a run caught by a closing window loses its
          uncommitted work and the next session pays to rediscover the branch.
        </SwitchRow>
        <SwitchRow
          label="Preempt a run when 5-hour quota is near exhaustion"
          on={autoOverrunPreempt}
          busy={busy || settings === null}
          onToggle={() => void setSwitch('autoOverrunPreempt', !autoOverrunPreempt)}
          state={
            autoOverrunPreempt
              ? 'a run reaching >=95% 5h quota or a rate-limit warning wraps up cleanly before failing.'
              : 'runs continue until quota is 100% exhausted and fail on hard API errors.'
          }
        >
          <strong>On by default.</strong> Detects live in-stream rate limit warnings and near-exhaustion (&gt;=95%) of the
          5-hour window during an active run. The agent is prompted to commit and hand off, and the task is paused
          as <code>paused_quota</code> until the window resets, avoiding disruptive 429 API failures.
        </SwitchRow>
        <SwitchRow
          label="Stop a run that is far past its estimate"
          on={autoRunawayStop}
          busy={busy || settings === null}
          onToggle={() => void setSwitch('autoRunawayStop', !autoRunawayStop)}
          state={
            autoRunawayStop
              ? 'a run past 3× the estimate is wrapped up and handed back to you.'
              : 'a long run is never stopped for cost alone. Nothing else changes.'
          }
        >
          <strong>Off by default, deliberately.</strong> The estimate is a median over completed runs
          and the overrun is counted in raw tokens — which on these CLIs are ~98% cache reads, and
          those accumulate with how <em>long</em> a session is rather than how wasteful. Measured on
          t5 (2026-08-28): 6,271,722 tokens against an estimate of 1,557,974 was called a runaway at
          4.0×, of which 6,155,066 were cache reads and 27,338 were output. Turn this on once the
          factor is measured in cost rather than tokens.
        </SwitchRow>
      </section>

      <section className="doc-section">
        <h3>Quota probe frequency</h3>
        <div className="picker-row">
          <div className="picker-row-head">
            <p className="switch-state">
              <strong>Background poller</strong> · Every {probeIntervalMinutes} minute{probeIntervalMinutes === 1 ? '' : 's'}
              <span className="dim"> — how often orchestratord sweeps workers for updated quota data.</span>
            </p>
            <select
              className="finish-picker picker-row-control"
              aria-label="Quota probe frequency"
              value={probeIntervalMinutes}
              disabled={busy || settings === null}
              onChange={(e) => void chooseProbeInterval(Number(e.target.value))}
            >
              <option value={1}>Every 1 minute</option>
              <option value={2}>Every 2 minutes</option>
              <option value={5}>Every 5 minutes (default)</option>
              <option value={10}>Every 10 minutes</option>
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every 60 minutes</option>
            </select>
          </div>
          <p className="note">
            Reading the local CLI usage cache is free. Refreshing a stale cache opens a background
            interactive session without spending tokens. Lower intervals keep quota readings fresh
            at the cost of occasional background subprocesses; higher intervals reduce background
            activity.
          </p>
        </div>
      </section>
    </div>
  )
}

function SwitchRow({
  label,
  on,
  busy,
  onToggle,
  state,
  children
}: {
  label: string
  on: boolean
  busy: boolean
  onToggle: () => void
  state: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={busy}
        className={`switch ${on ? 'switch--on' : ''}`}
        onClick={onToggle}
      >
        <span className="switch-knob" />
      </button>
      <div>
        <p className="switch-state">
          <strong>{label}</strong> · {on ? 'On' : 'Off'}
          <span className="dim"> — {state}</span>
        </p>
        <p className="note">{children}</p>
      </div>
    </div>
  )
}
