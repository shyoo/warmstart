import { useEffect, useState } from 'react'
import type { AdapterDetection, AdapterInfo, Session } from '@shared/protocol'
import { rpc, useDaemonEvents, type FleetEntry } from '../lib/daemon'
import { age, percent, quotaGap } from '../lib/format'
import { TerminalPane } from './Terminal'

/**
 * Settings → Workers, and the commissioning wizard.
 *
 * ⛔ Nothing about one machine may be hard-coded here. A stranger with one account and no Claude
 * install has to reach a working fleet from this panel: adapters are detected, isolation roots are
 * created by the app, and login runs the vendor's own CLI in a terminal they type into.
 *
 * agentyard never reads, stores, copies or proxies a credential. The login session below is the
 * vendor's flow, hosted; what it writes goes into that worker's isolation root and stays there.
 */
export function Workers({
  fleet,
  refresh
}: {
  fleet: FleetEntry[]
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [detections, setDetections] = useState<AdapterDetection[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loginSession, setLoginSession] = useState<Session | null>(null)
  const [loginEnded, setLoginEnded] = useState(false)

  // ⚠️ The panel used to give no signal at all when the vendor's login finished. The terminal printed
  // `-- session exited (0) --` and nothing else changed, so there was no way to tell a completed
  // sign-in from a hung one, and Done looked like it had done nothing.
  useDaemonEvents((event) => {
    if (event.type === 'session.exit' && event.sessionId === loginSession?.id) setLoginEnded(true)

    // ⛔ The daemon watches the worker's own config and re-reads identity the moment the vendor
    // writes it, so this arrives without anybody pressing anything. Before it existed, a completed
    // sign-in left the row saying "not signed in" and a completed first-run left it saying "setup
    // unfinished" until somebody found the right button.
    if (
      event.type === 'worker.changed' &&
      event.worker.id === loginSession?.workerId &&
      event.worker.identity?.loggedIn === true &&
      event.worker.identity?.setupComplete !== false
    ) {
      setLoginSession(null)
      setLoginEnded(false)
      setNotice(`${event.worker.label} is signed in and set up. Its terminal closed itself.`)
      void refresh()
    }
  })

  useEffect(() => {
    void rpc('adapter.list').then(setAdapters)
    void rpc('adapter.detect').then(setDetections)
  }, [])

  const guard = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Open a plain terminal on a worker so a person can answer the CLI's first-run screens.
   *
   * ⛔ Not a login, and not something the app can do on the operator's behalf: one of the screens is
   * a choice of login method and another is a theme. Measured 2026-08-27 - signing in writes the
   * credential into the isolation root but not `hasCompletedOnboarding`, so the first real terminal
   * there lands on onboarding. Print mode never sees it, which is why scheduled work runs fine on a
   * worker that still cannot answer `/usage`.
   */
  const startFirstRun = (workerId: string, adapterId: string) =>
    guard(`setup:${workerId}`, async () => {
      const info = adapters.find((a) => a.id === adapterId)
      if (!info?.firstRun) throw new Error(`${adapterId} declares no first-run setup`)
      const session = await rpc('session.spawn', {
        workerId,
        cwd: '.',
        purpose: 'login',
        argv: info.firstRun.argv,
        cols: 100,
        rows: 30
      })
      setLoginEnded(false)
      setLoginSession(session)
      setNotice(info.firstRun.reason)
    })

  /**
   * ⚠️ `worker.probe` resolves with the failure inside its payload rather than rejecting, so
   * `guard`'s catch never fired and a failed probe was indistinguishable from a successful one:
   * the same busy flash, the same "unknown" left in the cell, and a button that looked dead.
   * Report the outcome either way, and when there is no number say what would produce one.
   */
  /**
   * ⚠️ Looked up from the *worker* rather than passed in, so the Probe button and the table row
   * answer the same question the same way. Them disagreeing is how one of them ends up telling
   * somebody to retry something that can never work.
   */
  const probeKind = (workerId: string): 'cli' | 'api' | 'none' | undefined => {
    const worker = fleet.find((f) => f.worker.id === workerId)?.worker
    return adapters.find((a) => a.id === worker?.adapterId)?.capabilities.quotaProbe
  }

  const probe = (workerId: string, label: string) =>
    guard(`probe:${workerId}`, async () => {
      const quota = await rpc('worker.probe', { id: workerId })
      const gap = quotaGap(quota, probeKind(workerId))
      setNotice(
        gap
          ? `${label}: ${gap.label}. ${gap.hint}`
          : `${label}: ${quota.windows.map((w) => `${w.label} ${percent(w.percent)}`).join(' · ')}`
      )
    })

  const startLogin = (workerId: string, adapterId: string) =>
    guard(`login:${workerId}`, async () => {
      const info = adapters.find((a) => a.id === adapterId)
      if (!info) throw new Error(`no adapter named ${adapterId}`)

      // ⛔ Some vendors have no CLI login to run. Spawning a terminal for one produces a pane that
      // can only fail - which is exactly what commissioning an Antigravity account did, with
      // *unexpected argument "login"*. Say where the credential actually comes from instead.
      if (info.login.kind === 'external') {
        setNotice(`${info.label}: ${info.login.reason}`)
        return
      }

      const session = await rpc('session.spawn', {
        workerId,
        // The login flow needs a directory; the user's home is the least surprising one and needs
        // no project to exist yet.
        cwd: '.',
        purpose: 'login',
        argv: info.login.argv,
        cols: 100,
        rows: 26
      })
      setLoginEnded(false)
      setLoginSession(session)
    })

  /**
   * Re-read who this account belongs to.
   *
   * ⛔ `worker.probe` refreshes identity as well as quota, and identity is the thing a login can have
   * changed. The daemon does this by itself when a login session exits, so this button is for the
   * cases it cannot see - a sign-in completed in a browser the CLI had already handed off to, or a
   * credential edited outside agentyard entirely.
   */
  const recheck = (workerId: string) => guard(`probe:${workerId}`, () => rpc('worker.probe', { id: workerId }))

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Workers</h2>
          <p className="panel-sub">
            One worker is one account or endpoint — one quota bucket. Adding a second subscription
            here is what turns two separate windows into one fleet.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add worker'}
        </button>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {adding && (
        <AddWorker
          adapters={adapters}
          detections={detections}
          onDone={async (workerId, adapterId) => {
            setAdding(false)
            await refresh()
            await startLogin(workerId, adapterId)
          }}
          onError={setError}
        />
      )}

      {fleet.length === 0 && !adding ? (
        <div className="empty-inline">
          <p>No workers yet.</p>
          <p className="dim">
            Add one to point Multi Agent Controller at an account. It creates an isolation directory, runs the
            vendor&rsquo;s own login in a terminal, and never sees the credential itself.
          </p>
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Adapter</th>
              <th>Account</th>
              <th>Quota</th>
              <th className="tbl-num">Max</th>
              <th>Role</th>
              <th>Policy</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {fleet.map(({ worker, quota, sessions }) => {
              // ⛔ The stored field, not a substring of `raw`. This is the same mistake the
              // scheduler's dispatch gate made and had fixed: grepping the probe's raw output for
              // `"loggedIn": true` depends on one adapter's exact JSON spacing, so a worker that
              // *was* signed in still read as "not signed in" here.
              // ⚠️ `null` means unknown - no CLI, or an adapter that cannot tell - and must not be
              // drawn as a confident "not signed in".
              const loggedIn = worker.identity?.loggedIn === true
              const signInUnknown = worker.identity?.loggedIn == null
              const needsFirstRun = worker.identity?.setupComplete === false
              const suspect = worker.health?.state === 'suspect' ? worker.health : null
              const gap = quotaGap(quota, probeKind(worker.id))
              return (
                <tr key={worker.id} className={worker.enabled ? undefined : 'tbl-row--off'}>
                  <td>
                    <span className="tbl-strong">{worker.label}</span>
                    {/* ⚠️ A disabled worker used to be a cleared checkbox in the last column and
                        nothing else - identical at a glance to one that simply had no work. The
                        fleet strip had said `off` on its card since M2; the table that owns the
                        control did not. */}
                    {!worker.enabled && <span className="tag tag--off">disabled</span>}
                    {sessions.length > 0 && (
                      <span className="tag tag--running">{sessions.length} live</span>
                    )}
                    <div className="tbl-path mono" title={worker.isolationRoot}>
                      {worker.isolationRoot}
                    </div>
                  </td>
                  <td className="dim">{worker.adapterId}</td>
                  <td>
                    {worker.identity?.account ?? (
                      <span className={loggedIn ? 'dim' : 'warn'}>
                        {loggedIn ? 'signed in' : signInUnknown ? 'unknown' : 'not signed in'}
                      </span>
                    )}
                    {/* ⚠️ Shown verbatim, and nothing branches on it. It is the only thing the CLI
                        says for free about *which plan* this worker is spending — and an account
                        whose plan has lapsed previously had nowhere at all to say so. */}
                    {worker.identity?.subscriptionType && (
                      <div className="dim tbl-sub">{worker.identity.subscriptionType}</div>
                    )}
                    {/* ⛔ Signed in and set up are different questions, and only one of them was
                        ever asked here. A worker can be signed in, run scheduled work all day, and
                        still be unable to open a terminal. */}
                    {needsFirstRun && (
                      <div className="warn tbl-sub">setup unfinished</div>
                    )}
                    {/* ⛔ A third question again, and the only one answered by evidence: whether
                        work has actually survived on this account. Identity cannot see it — an
                        expired subscription answers `auth status` exactly as a live one does — so
                        this comes from a run that started and produced nothing. */}
                    {suspect && (
                      <div className="danger tbl-sub" title={suspect.reason}>
                        {/* ⛔ The instruction first, the evidence after. `held out of dispatch`
                            describes what this app did; `re-sign-in required` is the only part
                            that tells the operator what to do about it, and it was buried in a
                            sentence of the vendor's own words. */}
                        {suspect.needsReauth ? 're-sign-in required' : 'held out of dispatch'} —{' '}
                        {suspect.reason}
                      </div>
                    )}
                    {/* ⚠️ Said where the quota would be read, because the absence is otherwise
                        indistinguishable from a probe that has not run yet. */}
                    {suspect && (
                      <div className="dim tbl-sub">
                        not probed in the background while held out
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {gap ? (
                      <span className="warn" title={gap.hint}>
                        {gap.label}
                        {quota?.ageMs !== undefined && quota.windows.length > 0 && (
                          <span className="dim"> · {age(quota.ageMs)}</span>
                        )}
                      </span>
                    ) : (
                      quota?.windows.map((w) => `${w.label} ${percent(w.percent)}`).join(' · ')
                    )}
                  </td>
                  <td className="num tbl-num">{worker.maxConcurrent}</td>
                  <td>
                    <select
                      value={worker.role}
                      title={
                        'Whether this account may be asked for judgment. A controller near the top of ' +
                        'its window stops being asked and the next call routes elsewhere — which is ' +
                        'why a dedicated one is worth having, and why nothing breaks without one.'
                      }
                      onChange={(e) =>
                        void guard(`role:${worker.id}`, () =>
                          rpc('worker.update', {
                            id: worker.id,
                            role: e.target.value as 'worker' | 'controller' | 'both'
                          })
                        )
                      }
                    >
                      <option value="both">work + judgment</option>
                      <option value="worker">work only</option>
                      <option value="controller">judgment only</option>
                    </select>
                  </td>
                  <td>
                    {/* ⛔ Off is not retirement and must not read as it. Retiring is destructive
                        and one-way; this holds a commissioned account out of dispatch and leaves
                        its isolation root, identity and quota history exactly where they are.
                        ⚠️ It does not touch a session already running - see the title text. Killing
                        live work from a settings toggle is the kind of surprise nobody forgives. */}
                    <div className="switch-row switch-row--cell">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={worker.enabled}
                        aria-label={`${worker.label} enabled`}
                        disabled={busy === `en:${worker.id}`}
                        className={`switch switch--sm ${worker.enabled ? 'switch--on' : ''}`}
                        title={
                          worker.enabled
                            ? 'On — may be chosen for new work and for judgment. Turn it off to hold ' +
                              'this account out of dispatch without retiring it: nothing is deleted and ' +
                              'its quota keeps being read.'
                            : 'Off — held out of dispatch. Nothing new is scheduled here and it is never ' +
                              'asked for judgment. A session already running is left alone; stop that from ' +
                              'Overview if you want it gone.'
                        }
                        onClick={() =>
                          void guard(`en:${worker.id}`, () =>
                            rpc('worker.update', { id: worker.id, enabled: !worker.enabled })
                          )
                        }
                      >
                        <span className="switch-knob" />
                      </button>
                      <span className={worker.enabled ? 'dim' : 'warn'}>
                        {worker.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>
                    <label className="check" title="Quota is tracked but never spent by Multi Agent Controller.">
                      <input
                        type="checkbox"
                        checked={worker.humanOccupied}
                        onChange={(e) =>
                          void guard(`hu:${worker.id}`, () =>
                            rpc('worker.update', { id: worker.id, humanOccupied: e.target.checked })
                          )
                        }
                      />
                      human-occupied
                    </label>
                  </td>
                  <td className="tbl-actions">
                    <button
                      className="btn btn--ghost"
                      disabled={busy === `login:${worker.id}`}
                      onClick={() => void startLogin(worker.id, worker.adapterId)}
                    >
                      Sign in
                    </button>
                    {needsFirstRun && (
                      <button
                        className="btn btn--primary"
                        disabled={busy === `setup:${worker.id}`}
                        onClick={() => void startFirstRun(worker.id, worker.adapterId)}
                        title="Opens a terminal so you can answer the CLI's first-run screens once."
                      >
                        Finish setup
                      </button>
                    )}
                    <button
                      className="btn btn--ghost"
                      disabled={busy === `probe:${worker.id}`}
                      onClick={() => void probe(worker.id, worker.label)}
                      title={
                        suspect
                          ? 'Re-reads this account and offers it work again. Press it once you have ' +
                            'fixed what stopped the last run — this is the only thing that lifts the hold.'
                          : "Reads the vendor CLI's own usage cache off disk. It never spends a token."
                      }
                    >
                      {suspect ? 'Recheck' : 'Probe'}
                    </button>
                    <button
                      className="btn btn--ghost btn--danger"
                      onClick={() =>
                        void guard(`ret:${worker.id}`, () => rpc('worker.retire', { id: worker.id }))
                      }
                      title="Closes the worker to new work. The isolation root stays on disk."
                    >
                      Retire
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {loginSession && (
        <section className="login">
          <header className="login-head">
            <h3>Sign in</h3>
            <p className="dim">
              This is the vendor&rsquo;s own login running in a terminal. Type here as you normally
              would — Multi Agent Controller is hosting the process, not reading what it writes.
            </p>
            <div className="login-actions">
              <button
                className="btn btn--ghost"
                disabled={busy === `probe:${loginSession.workerId}`}
                onClick={() => void recheck(loginSession.workerId)}
              >
                {busy === `probe:${loginSession.workerId}` ? 'Checking…' : 'Check sign-in again'}
              </button>
              <button
                className="btn btn--primary"
                disabled={busy === `probe:${loginSession.workerId}`}
                onClick={() => {
                  const { id, workerId } = loginSession
                  setLoginSession(null)
                  setLoginEnded(false)
                  // ⛔ Awaited, in this order. Done used to fire `session.close` and drop the panel
                  // without waiting, so the fleet was re-read before the CLI had exited and the row
                  // still said "not signed in" - which is what made a successful sign-in look like a
                  // failure.
                  void guard(`probe:${workerId}`, async () => {
                    await rpc('session.close', { id }).catch(() => {
                      // Already exited on its own, which is the normal path. Nothing to close.
                    })
                    await rpc('worker.probe', { id: workerId })
                  })
                }}
              >
                {loginEnded ? 'Done' : 'Cancel sign-in'}
              </button>
            </div>
          </header>
          {loginEnded && (
            <p className="login-note">
              The login session has ended. Multi Agent Controller re-read the account by itself — the Account
              column above shows what it found.
            </p>
          )}
          <TerminalPane sessionId={loginSession.id} interactive />
        </section>
      )}
    </div>
  )
}

/**
 * What this adapter can and cannot do, before you commit an account to it.
 *
 * ⛔ Shown at commissioning rather than buried in a doc, because these are the things that decide
 * whether a second account is even possible and whether agentyard can tell you what its work cost.
 * Finding out afterwards means finding out from a bill.
 */
function AdapterFacts({ adapter }: { adapter: AdapterInfo }): React.JSX.Element {
  const c = adapter.capabilities
  const facts: Array<{ ok: boolean; text: string }> = [
    {
      ok: c.maxAccounts === null,
      text:
        c.maxAccounts === null
          ? `Any number of accounts — ${adapter.isolationEnvVar} points it at one credential directory each`
          : `${c.maxAccounts} account only — it keeps credentials in the OS keyring, with no way to point it elsewhere`
    },
    {
      ok: c.metering !== 'none',
      text:
        c.metering === 'transcript'
          ? 'Metered exactly, from the transcript it writes — survives a restart'
          : c.metering === 'stream'
            ? 'Metered from its live stream — a run whose daemon restarted loses the turns nobody saw'
            : 'Not metered at all — runs on it cost an unknown amount, not nothing'
    },
    {
      ok: c.manualCompact,
      text: c.manualCompact
        ? 'Can compact, so a long session can be shrunk rather than abandoned'
        : 'Cannot compact — a session near its limit is handed off and closed instead'
    },
    {
      ok: c.classifierBackedAuto,
      text: c.classifierBackedAuto
        ? 'A classifier reviews each action, so unattended work needs fewer approvals'
        : 'Nothing reviews but you — this app writes an allowlist and expects more refusals'
    },
    {
      ok: c.quotaProbe !== 'none',
      text:
        c.quotaProbe === 'none'
          ? 'No free usage probe — its quota is always unknown, and its runs are marked unverified'
          : 'Reports its own usage'
    }
  ]

  return (
    <div className="note">
      <strong>{adapter.label}</strong>{' '}
      <span className={adapter.verification.level === 'measured' ? 'ok' : 'warn'}>
        {adapter.verification.level === 'measured'
          ? `measured ${adapter.verification.asOf}`
          : `documented only, ${adapter.verification.asOf}`}
      </span>
      <ul className="facts">
        {facts.map((f) => (
          <li key={f.text} className={f.ok ? 'dim' : 'warn'}>
            {f.ok ? '✓' : '⚠'} {f.text}
          </li>
        ))}
      </ul>
      <p className="dim">{adapter.verification.note}</p>
    </div>
  )
}

function AddWorker({
  adapters,
  detections,
  onDone,
  onError
}: {
  adapters: AdapterInfo[]
  detections: AdapterDetection[]
  onDone: (workerId: string, adapterId: string) => void | Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  const [adapterId, setAdapterId] = useState(adapters[0]?.id ?? 'claude-code')
  const [label, setLabel] = useState('')
  const [adopt, setAdopt] = useState(false)
  const [root, setRoot] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!adapterId && adapters[0]) setAdapterId(adapters[0].id)
  }, [adapters, adapterId])

  const detection = detections.find((d) => d.adapterId === adapterId)
  const selected = adapters.find((a) => a.id === adapterId)

  const submit = async () => {
    setSaving(true)
    try {
      const worker = await rpc('worker.create', {
        adapterId,
        label: label.trim() || 'worker',
        ...(adopt && root.trim() ? { isolationRoot: root.trim() } : {})
      })
      await onDone(worker.id, worker.adapterId)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="form">
      <div className="form-row">
        <label>Adapter</label>
        <select value={adapterId} onChange={(e) => setAdapterId(e.target.value)}>
          {adapters.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="form-hint">
          {detection?.found ? (
            <>
              found <span className="mono">{detection.path}</span> · v{detection.version}
              {detection.error && <div className="warn">{detection.error}</div>}
            </>
          ) : (
            <span className="warn">
              {detection?.error ?? 'not on PATH — install it, or point Multi Agent Controller at it (M6)'}
            </span>
          )}
        </span>
      </div>

      {selected && <AdapterFacts adapter={selected} />}

      <div className="form-row">
        <label>Label</label>
        <input
          value={label}
          placeholder="e.g. personal, work, second seat"
          onChange={(e) => setLabel(e.target.value)}
        />
        <span className="form-hint">Whatever you will recognise in a quota bar at a glance.</span>
      </div>

      <div className="form-row">
        <label>Credentials</label>
        <div>
          <label className="check">
            <input type="radio" checked={!adopt} onChange={() => setAdopt(false)} />
            Create a new isolation directory
          </label>
          <label className="check">
            <input type="radio" checked={adopt} onChange={() => setAdopt(true)} />
            Adopt an existing one
          </label>
          {adopt && (
            <input
              className="form-wide mono"
              value={root}
              placeholder="path to an existing config directory"
              onChange={(e) => setRoot(e.target.value)}
            />
          )}
        </div>
        <span className="form-hint">
          A new directory keeps this account&rsquo;s login entirely separate, which is what lets
          several subscriptions run side by side. Adopt an existing one if you are already signed in
          there and would rather not log in again.
        </span>
      </div>

      <div className="form-actions">
        <button className="btn btn--primary" disabled={saving} onClick={() => void submit()}>
          {saving ? 'Creating…' : 'Create and sign in'}
        </button>
      </div>
    </div>
  )
}
