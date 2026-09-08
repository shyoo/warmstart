import { canJudge, canWork, roleOf, sessionEnded } from '@shared/protocol'
import { Fragment, useEffect, useState } from 'react'
import type { AdapterDetection, AdapterInfo, ModelOptions, Session, Settings, Worker } from '@shared/protocol'
import { rpc, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { isWorkerSubscriptionExpired, QUOTA_STALE_AFTER_MS, quotaFreshness } from '@shared/tasks'
import { age, percent, quotaGap } from '../lib/format'
import { SettingButtonSelect, type SettingOption } from './SettingButtonSelect'
import { Pill } from './Pill'
import { TerminalPane } from './Terminal'
import { errorMessage } from '@shared/errors.js'

/**
 * The (i) beside a column heading whose number needs a sentence.
 *
 * ⛔ A glyph with a `title`, not a paragraph under the table. A heading like `Max` is a word an
 * operator either already knows or cannot guess from three letters, and the answer — *how many tasks
 * this account may run at once* — is one sentence that nobody needs on screen twice.
 */
function ColumnInfo({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="th-info" title={text} aria-label={text} role="img">
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="8" cy="8" r="6.4" />
        <path d="M8 7.2 L8 11.2" strokeLinecap="round" />
        <circle cx="8" cy="4.9" r="0.85" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

/**
 * ⚠️ "CLI default" is a real option, not a blank — it means the vendor picks, which is what every
 * install did before this control existed. It leads the list because it is the value a fresh worker
 * holds, and a picker whose first entry is not its own default reads as one that has been changed.
 */
function modelChoices(models: Array<{ id: string }>): SettingOption[] {
  return [{ value: '', label: 'CLI default' }, ...models.map((m) => ({ value: m.id, label: m.id }))]
}

/**
 * How many tasks one account may run at once — the sentence behind the `Max` column's (i).
 *
 * ⛔ One string, used by the heading's tooltip and the input's alike. Two copies of this is how the
 * header ends up describing a different setting from the box underneath it.
 */
const MAX_HELP =
  'How many tasks this account may run at once. Raising it is what lets one worker do parallel ' +
  'work — a second task on a busy account waits as `queued` until a slot frees. ⚠️ Not free: ' +
  'parallel requests against one cached prefix each pay a cache write, and both sessions spend the ' +
  'same quota window. Lowering it never interrupts work already running; it only holds later tasks ' +
  'until capacity frees.'

/**
 * The (i) beside `Routable models` — the sentence behind why an empty box is not "nothing routes
 * here" but "routing uses this account's current default model only".
 *
 * ⛔ **Opt-in, and inert until touched.** Leaving this empty is not a gap in the fleet's model-aware
 * routing — it is the honest default, because widening every worker to every model it can price
 * would hand a scorer dozens of candidates a tick that nobody chose. Checking a model here adds it
 * to what this account may be *routed to*; it does not change what the account reaches for by
 * default, which is still the `Model` column beside it.
 */
const ROUTABLE_MODELS_HELP =
  "Which models this account may be routed to, beyond the one it uses by default. Leave every box " +
  "unchecked to route this worker only to its current default model — that is the safe, inert " +
  'starting point, not a missing setting. Only models this account\'s adapter can price appear here.'

/**
 * What the **Routable models** pill reads. Pure so the L1 suite can pin it without a table.
 *
 * ⛔ **Names, not a count.** `2 models` says nothing an operator choosing where a task lands needs —
 * the pill names the allowlist (`sonnet, opus`, truncated by the pill's own ellipsis with the full
 * list on the tooltip), and the menu behind the pill is the editor: checkboxes add or drop models,
 * and Reset returns to the default. The empty state reads as what it is — a deliberate, inert
 * default, matching `ROUTABLE_MODELS_HELP` — because a blank beside `Model` would read as
 * "nothing chosen yet" rather than its opposite.
 */
export function routableModelsLabel(selected: string[]): string {
  if (selected.length === 0) return 'default model only'
  return selected.join(', ')
}
function RoutableModelsPill({
  worker,
  models,
  disabled,
  busy,
  onChange
}: {
  worker: Worker
  models: Array<{ id: string }>
  disabled: boolean
  busy: boolean
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const selected = worker.routableModels ?? []
  const label = routableModelsLabel(selected)

  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id])
  }

  return (
    <Pill
      ariaLabel={`Routable models for ${worker.label}`}
      title={selected.length > 0 ? `Routable models: ${selected.join(', ')}` : ROUTABLE_MODELS_HELP}
      muted={selected.length === 0}
      disabled={disabled || models.length === 0}
      label={label}
      menu={() => (
        <div className="workers-menu">
          <div className="workers-menu-head">
            <span className="workers-menu-title">Routable models</span>
            {selected.length > 0 && (
              <button type="button" className="workers-menu-action" onClick={() => onChange([])} disabled={busy}>
                Reset to default model only
              </button>
            )}
          </div>
          <div className="workers-menu-list">
            {models.map((m) => (
              <label key={m.id} className="workers-menu-worker-row">
                <div className="workers-menu-worker-info">
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={() => toggle(m.id)}
                    disabled={busy}
                  />
                  <span className="workers-menu-worker-name">{m.id}</span>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}
    />
  )
}

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
  // ⚠️ Half a minute, not a second. The only thing on this page that moves with the clock is the
  // age beside a quota reading, and that is a figure like "read 20m ago" — a per-second re-render
  // of the whole worker table would buy nothing anybody can see.
  const now = useNow(30_000)
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  /**
   * ⛔ Fetched from the daemon, never compiled in. The renderer holds no cost models, and a second
   * table of model facts here would drift from the first the day a model was added to a file and
   * not to this bundle — the same argument the New Task form's picker already makes.
   */
  const [modelOptions, setModelOptions] = useState<ModelOptions[]>([])
  const [detections, setDetections] = useState<AdapterDetection[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loginSession, setLoginSession] = useState<Session | null>(null)
  const [loginEnded, setLoginEnded] = useState(false)
  /**
   * Which row's actions are open, if any.
   *
   * ⛔ One id rather than a flag per row, so opening a second menu closes the first without anybody
   * having to remember to. Sign in, Probe and Retire used to sit in the row itself — three buttons
   * on every account, of which two are pressed once at commissioning and the third is destructive
   * and sat one mis-click away from a quota reading somebody was only trying to refresh.
   */
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
    void rpc('settings.get').then(setSettings).catch(() => setSettings(null))
    // A fleet with no priceable model list still runs work; the column falls back to CLI default.
    void rpc('model.options').then(setModelOptions).catch(() => setModelOptions([]))
    void rpc('adapter.detect').then(setDetections)
  }, [])

  const modelsFor = (adapterId: string): ModelOptions | null =>
    modelOptions.find((o) => o.adapterId === adapterId) ?? null

  /**
   * The effort levels this account could actually be given.
   *
   * ⛔ Both halves required: the CLI must take an effort flag *and* the chosen model must have
   * levels. `claude-haiku-4-5` lists none — the API rejects effort on it — so a control there would
   * offer a choice that fails at dispatch.
   */
  const effortsFor = (worker: Worker): string[] => {
    const options = modelsFor(worker.adapterId)
    if (!options?.selectableEffort || !worker.defaultModel) return []
    return options.models.find((m) => m.id === worker.defaultModel)?.effortLevels ?? []
  }

  const guard = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
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
      const worker = fleet.find((f) => f.worker.id === workerId)?.worker
      const gap = quotaGap(quota, probeKind(workerId), worker)
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

  /**
   * Move one worker up or down the fleet.
   *
   * ⛔ Sends the **whole order**, not "move this one up". This list is the order the daemon last
   * served, so the neighbour being swapped with is the one on screen; posting a full ordering means
   * a second window that reordered in between loses the race cleanly and visibly on the next
   * `worker.changed`, instead of both windows applying a relative move to different lists.
   *
   * ⚠️ Cosmetic, and the title text says so. Nothing routes on this order — the scheduler scores —
   * so a control that looked like a priority list would be a lie about what it does.
   */
  const move = (workerId: string, delta: -1 | 1) => {
    const ids = fleet.map((f) => f.worker.id)
    const from = ids.indexOf(workerId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved as string)
    void guard(`order:${workerId}`, () => rpc('worker.reorder', { ids: next }))
  }

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
        <table className="tbl tbl-workers">
          {/* ⛔ Ten columns, ten <col>s. There were nine here against ten headers and the nine
              summed to 100% — so under `table-layout: fixed` the actions column was allotted
              nothing at all, and Sign in / Probe / Retire wrapped one per line inside a cell the
              width of a button. Every width below is a share of the same 100%; adding a column
              means taking the room for it from the others, not appending to the list.
              ⭐ The three actions are one 6% menu now rather than a 19% row of buttons, and the
              fourteen points that freed went where the content was actually being squeezed: Quota
              (which now sets one window per line), Account, Model and Role. */}
          <colgroup>
            <col style={{ width: '3%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '9%' }} />
          </colgroup>
          <thead>
            <tr>
              {/* ⚠️ No word in the header. The column is two arrows and a rank; `Order` above them
                  reads as *sort this table by*, which is a different and absent feature. */}
              <th />
              <th>Worker</th>
              <th>Adapter</th>
              <th>Config location</th>
              <th>Account</th>
              <th>Quota</th>
              {/* ⚠️ `Max` is three letters that say what is being counted and not what it does. The
                  (i) carries the sentence rather than the column carrying a second word nobody has
                  room for. */}
              <th className="tbl-num">
                <span className="th-with-info">
                  Max
                  <ColumnInfo text={MAX_HELP} />
                </span>
              </th>
              <th>Model</th>
              <th>
                <span className="th-with-info">
                  Routable models
                  <ColumnInfo text={ROUTABLE_MODELS_HELP} />
                </span>
              </th>
              <th>Grading model</th>
              <th>Role</th>
              <th>Usage credits</th>
              <th className="tbl-num">Action</th>
            </tr>
          </thead>
          <tbody>
            {fleet.map(({ worker, quota, sessions }, index) => {
              // ⛔ The stored field, not a substring of `raw`. This is the same mistake the
              // scheduler's dispatch gate made and had fixed: grepping the probe's raw output for
              // `"loggedIn": true` depends on one adapter's exact JSON spacing, so a worker that
              // *was* signed in still read as "not signed in" here.
              // ⚠️ `null` means unknown - no CLI, or an adapter that cannot tell - and must not be
              // drawn as a confident "not signed in".
              const loggedIn = worker.identity?.loggedIn === true
              const signInUnknown = worker.identity?.loggedIn == null
              const isSubscriptionExpired = isWorkerSubscriptionExpired(worker)
              const needsFirstRun = !isSubscriptionExpired && worker.identity?.setupComplete === false
              const suspect = worker.health?.state === 'suspect' ? worker.health : null
              // ⛔ The age is recomputed here rather than trusted off the payload. `ageMs` and
              // `stale` are stamped on when the daemon sends a reading, so a row patched by an
              // event froze at the age it arrived with — "read 2m ago" an hour later, and a fresh
              // reading that never went stale on screen. See `quotaFreshness` (t86).
              const reading = quota ? { ...quota, ...quotaFreshness(quota, now) } : null
              // A failed refresh makes this number ineligible for scheduling immediately, but the
              // account table follows the same display rule as the fleet card: a few-minute-old
              // last good reading does not need an age label or an amber warning.
              const readingIsOld = Boolean(reading && reading.ageMs > QUOTA_STALE_AFTER_MS)
              const gap = quotaGap(reading, probeKind(worker.id), worker)
              /**
               * ⛔ Out of the Account cell and onto a row of their own.
               *
               * These are sentences — one of them is the vendor's own words about why a run
               * produced nothing — and they were being set in a 13% column beside the account
               * name. Each wrapped over four or five lines and dragged every other cell in the row
               * down with it, so a fleet of four accounts filled the panel and the table read as a
               * wall rather than a list. A full-width row under the account is the shape the task
               * table already uses for a line that is prose rather than a field.
               *
               * ⚠️ Still on the row, not behind a hover. What they say is *this account is not
               * working, and here is what to do about it* — the one thing on this table nobody
               * should have to go looking for.
               */
              const notes: Array<{
                key: string
                tone: string
                label: string
                text: string
                fix?: { label: string; busyKey: string; run: () => void }
              }> = []
              if (needsFirstRun) {
                notes.push({
                  key: 'setup',
                  tone: 'warn',
                  label: 'setup unfinished',
                  text:
                    'The CLI’s own first-run screens have never been answered on this account. ' +
                    'Scheduled work still runs — print mode never sees them — but a terminal here ' +
                    'lands on onboarding. This answers them once.',
                  // ⛔ On the note, not in the actions column. It is the only action here that
                  // exists because of a condition, and it was being appended to the three that are
                  // always there — so the one row in the fleet with something wrong with it was
                  // also the only row whose buttons wrapped onto a second line. Beside the sentence
                  // explaining why it is needed, it reads as an answer rather than as a fourth
                  // permanent control.
                  fix: {
                    label: 'Finish setup',
                    busyKey: `setup:${worker.id}`,
                    run: () => void startFirstRun(worker.id, worker.adapterId)
                  }
                })
              }
              if (suspect) {
                if (isSubscriptionExpired) {
                  notes.push({
                    key: 'suspect',
                    tone: 'danger',
                    label: 'Subscription Expired',
                    text:
                      `${suspect.reason} — not probed in the background while it is held out. ` +
                      'Renew the subscription to restore access; Recheck reads the account again once renewed.'
                  })
                } else {
                  notes.push({
                    key: 'suspect',
                    tone: 'danger',
                    // ⛔ The instruction first, the evidence after. `held out of dispatch` describes
                    // what this app did; `re-sign-in required` is the only part that tells the
                    // operator what to do about it.
                    label: suspect.needsReauth ? 're-sign-in required' : 'held out of dispatch',
                    text:
                      `${suspect.reason} — not probed in the background while it is held out. ` +
                      'Recheck reads the account again and offers it work.'
                  })
                }
              } else if (isSubscriptionExpired) {
                notes.push({
                  key: 'subscription',
                  tone: 'danger',
                  label: 'Subscription Expired',
                  text:
                    'The subscription for this account has expired. ' +
                    'Renew the subscription to restore access.'
                })
              }
              return (
                <Fragment key={worker.id}>
                  <tr
                    className={
                      `${worker.enabled ? '' : 'tbl-row--off '}${
                        notes.length > 0 ? 'tbl-row--has-note' : ''
                      }`.trim() || undefined
                    }
                  >
                    {/* ⭐ This order is the fleet strip's order — the cards up there are these rows,
                        top to bottom. It is the only place the strip can be arranged from, because the
                        strip itself has no room for a control that is used once and then never again. */}
                    {/* ⛔ The flex box is the div, never the <td>. `display: flex` on a table cell
                        takes it out of the table's own layout: it stops sharing the row's height,
                        so its bottom border was drawn at the height of two little arrows while
                        every other cell's was drawn at the height of the row — which is the step in
                        the rule that made the left edge of this table look torn. */}
                    <td className="tbl-order-cell">
                      <div className="tbl-order">
                        <button
                          type="button"
                          className="order-btn"
                          aria-label={`Move ${worker.label} up`}
                          title="Move up in the fleet strip. Display order only — it changes nothing about which worker gets the next task."
                          disabled={index === 0 || busy === `order:${worker.id}`}
                          onClick={() => move(worker.id, -1)}
                        >
                          <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 10 L8 5 L13 10" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="order-btn"
                          aria-label={`Move ${worker.label} down`}
                          title="Move down in the fleet strip. Display order only — it changes nothing about which worker gets the next task."
                          disabled={index === fleet.length - 1 || busy === `order:${worker.id}`}
                          onClick={() => move(worker.id, 1)}
                        >
                          <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6 L8 11 L13 6" />
                          </svg>
                        </button>
                      </div>
                    </td>
                    <td className="worker-cell">
                      <div className="worker-identity">
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
                        <div className="worker-identity-info">
                          <span className="tbl-strong">{worker.label}</span>
                          {!worker.enabled && <span className="tag tag--off">disabled</span>}
                          {(() => {
                            const liveCount = sessions.filter((s) => !sessionEnded(s.state)).length
                            return liveCount > 0 ? (
                              <span className="tag tag--running">{liveCount} live</span>
                            ) : null
                          })()}
                        </div>
                      </div>
                    </td>
                    <td className="dim">{worker.adapterId}</td>
                    <td>
                      <div className="tbl-path mono" title={worker.isolationRoot}>
                        {worker.isolationRoot}
                      </div>
                    </td>
                    {/* ⚠️ Who this account is, and nothing else. Everything that is a *sentence*
                        about it is on the note row below. ⛔ `tbl-account` breaks the string: an
                        account is usually an email, an email has no spaces to wrap at, and under a
                        fixed layout an unbreakable word does not widen its column — it is painted
                        past the edge, straight across the quota reading beside it. */}
                    {/* ⛔ One grid item, not two. Each <td> in this card layout is a
                        `label | value` grid, so a second child after the account div was laid into
                        the *label* column of the next row — `pro` printed under the word `Account`
                        rather than under the address it qualifies. Account and plan are one fact
                        read together, so they are one line: the id, then the plan beside it. */}
                    <td>
                      <div className="worker-account">
                        <span className="tbl-account" title={worker.identity?.account ?? undefined}>
                          {worker.identity?.account ?? (
                            <span className={loggedIn ? 'dim' : 'warn'}>
                              {loggedIn ? 'signed in' : signInUnknown ? 'unknown' : 'not signed in'}
                            </span>
                          )}
                        </span>
                        {/* ⚠️ Shown verbatim, and nothing branches on it. It is the only thing the CLI
                            says for free about *which plan* this worker is spending — and an account
                            whose plan has lapsed previously had nowhere at all to say so. */}
                        {worker.identity?.subscriptionType && (
                          <span className="dim worker-account-plan">{worker.identity.subscriptionType}</span>
                        )}
                      </div>
                      {/* ⛔ The labels are gone from here, deliberately. `setup unfinished · held
                          out of dispatch` was printed in this cell and then again, word for word,
                          as the label of the note row directly underneath — so the one account with
                          something wrong with it said each thing twice, in a column narrow enough
                          that saying it once already wrapped. The note row below is the single
                          place these are stated, and it carries the sentence and the fix with
                          them. */}
                    </td>
                    {/* ⛔ A reading that exists is shown, however old. Replacing the numbers with the
                        word `stale` made an account read as unmeasured when what was true is that it
                        was measured a while ago — and the operator's next move differs between the
                        two. The label stays, underneath, carrying the age. ⚠️ The states with *no*
                        reading at all still yield to `gap`: never probed, no usage data yet, a failed
                        probe and a provider that reports none are four different absences and the
                        hint is what tells them apart. */}
                    {/* ⛔ One window per line, not a ` · `-joined string. Every reading here is two
                        or three short pairs — `5h 11%`, `7d 13%` — and joining them made one long
                        unbreakable-looking run that the column wrapped wherever it happened to
                        run out, so `Claude 5h 34% ·` and `Claude 7d 34%` landed on four ragged
                        lines and dragged the row down with them. A line each is both shorter and
                        the shape the numbers are actually compared in: window against window. */}
                    <td className="num">
                      {gap ? (
                        <span className={gap.label.toLowerCase().includes('expired') ? 'danger' : 'warn'} title={gap.hint}>
                          {gap.label}
                        </span>
                      ) : reading && reading.windows.length > 0 ? (
                        <>
                          <div className={`quota-windows${reading.stale ? ' dim' : ''}`}>
                            {reading.windows.map((w) => (
                              <div key={w.label} className="quota-window">
                                <span className="quota-window-label">{w.label}</span>
                                <span className="quota-window-pct">{percent(w.percent)}</span>
                              </div>
                            ))}
                          </div>
                          {/* ⛔ The age, not the word `stale`. An idle account's reading is old
                              because nothing has used the account, not because anything failed, and
                              the two need different next moves from the operator. A reading that is
                              old *because every check failed* is the fault, and it says so. */}
                          {readingIsOld && (
                            <div className={reading.error ? 'warn tbl-sub' : 'dim tbl-sub'} title={reading.error ?? undefined}>
                              read {age(reading.ageMs)}
                              {reading.error ? ' · last check failed' : ''}
                            </div>
                          )}
                        </>
                      ) : null}
                    </td>
                    {/* ⭐ Editable, because the daemon has enforced this number since M1 and nothing
                        could ever change it. `atCapacity` and `spawnSession` both gate on it, the
                        commissioning default is 1, and the only place it appeared was here, as text -
                        so a fleet of one account could run exactly one task at a time and the reason
                        read as a fact about the provider rather than a setting.
                        ⚠️ A number input, not a dropdown: there is no measured ceiling to offer, and a
                        list of options would present a guess as a rule. The floor is enforced in
                        `boundedConcurrency`, not here, so a hand-written RPC cannot get under it. */}
                    <td>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        className="num-input"
                        value={worker.maxConcurrent}
                        disabled={busy === `max:${worker.id}`}
                        title={MAX_HELP}
                        onChange={(e) => {
                          const next = Number.parseInt(e.target.value, 10)
                          // ⛔ An empty box is somebody mid-edit, not a request for zero workers.
                          if (!Number.isFinite(next) || next < 1) return
                          if (next === worker.maxConcurrent) return
                          void guard(`max:${worker.id}`, () =>
                            rpc('worker.update', { id: worker.id, maxConcurrent: next })
                          )
                        }}
                      />
                    </td>
                    {/* ⭐ The account's default model and effort — what every task routed here runs
                        on unless it pins something of its own (`resolveModelChoice`, task → worker →
                        the CLI itself).
                        ⛔ On the worker and nowhere higher: a model id belongs to one CLI, so the same
                        control on a project or the fleet would hold a value that is invalid for every
                        task routed to a different adapter.
                        ⚠️ "CLI default" is a real option, not a blank. It means the vendor picks, which
                        is what every install did before this control existed. */}
                    <td>
                      {modelsFor(worker.adapterId)?.pools && (modelsFor(worker.adapterId)?.pools?.length ?? 0) > 1 ? (
                        <div
                          className="pool-defaults-container"
                          title={
                            'Default models per quota pool. The scheduler automatically balance-picks ' +
                            'between pools based on available quota/budget on the next run.'
                          }
                        >
                          {modelsFor(worker.adapterId)!.pools!.map((p) => {
                            const poolModels = (modelsFor(worker.adapterId)?.models ?? []).filter((m) =>
                              p.models.includes(m.id)
                            )
                            const currentVal = worker.defaultModels?.[p.id] ?? ''
                            return (
                              <div key={p.id} className="pool-default-row">
                                <span className="pool-default-label">{p.label}:</span>
                                <SettingButtonSelect
                                  value={currentVal}
                                  options={modelChoices(poolModels)}
                                  ariaLabel={`${p.label} default model for ${worker.label}`}
                                  disabled={busy === `model:${worker.id}:${p.id}`}
                                  onChange={(value) =>
                                    void guard(`model:${worker.id}:${p.id}`, () =>
                                      rpc('worker.update', {
                                        id: worker.id,
                                        defaultModels: {
                                          ...(worker.defaultModels ?? {}),
                                          [p.id]: value || null
                                        }
                                      })
                                    )
                                  }
                                />
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="worker-model-row">
                          <SettingButtonSelect
                            className="worker-model-select"
                            value={worker.defaultModel ?? ''}
                            options={modelChoices(modelsFor(worker.adapterId)?.models ?? [])}
                            ariaLabel={`Default model for ${worker.label}`}
                            disabled={busy === `model:${worker.id}`}
                            title={
                              'The model tasks on this account run on unless they pin their own. ' +
                              'Changing it affects the next run — a conversation already open keeps the ' +
                              'model it started with, because switching mid-conversation throws away its ' +
                              'prompt cache.'
                            }
                            onChange={(value) =>
                              void guard(`model:${worker.id}`, () =>
                                rpc('worker.update', {
                                  id: worker.id,
                                  // ⛔ `null`, not `''` — the daemon reads undefined as "not mentioned" and
                                  // null as "clear it", and an empty string is neither.
                                  defaultModel: value || null,
                                  // ⚠️ Effort is cleared with the model it belonged to. A level that was
                                  // legal for the old model is not necessarily legal for the new one, and
                                  // the daemon would refuse the pair — so the operator re-picks it.
                                  ...(value !== worker.defaultModel ? { defaultEffort: null } : {})
                                })
                              )
                            }
                          />
                          {/* Effort appears only where the CLI takes a flag for it *and* the chosen model
                              has levels. Antigravity has neither: it bakes effort into the model id and
                              refuses `--effort` outright, measured 2026-08-29. */}
                          {effortsFor(worker).length > 0 && (
                            <SettingButtonSelect
                              className="worker-effort-select"
                              value={worker.defaultEffort ?? ''}
                              options={[
                                { value: '', label: 'CLI default' },
                                ...effortsFor(worker).map((level) => ({ value: level, label: level }))
                              ]}
                              ariaLabel={`Default reasoning effort for ${worker.label}`}
                              disabled={busy === `effort:${worker.id}`}
                              title={
                                'How hard the model thinks. Like the model, this is read at launch and ' +
                                'applies to the next run.'
                              }
                              onChange={(value) =>
                                void guard(`effort:${worker.id}`, () =>
                                  rpc('worker.update', {
                                    id: worker.id,
                                    defaultEffort: value || null
                                  })
                                )
                              }
                            />
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <RoutableModelsPill
                        worker={worker}
                        models={modelsFor(worker.adapterId)?.models ?? []}
                        disabled={false}
                        busy={busy === `routable:${worker.id}`}
                        onChange={(next) =>
                          void guard(`routable:${worker.id}`, () =>
                            rpc('worker.update', {
                              id: worker.id,
                              routableModels: next.length > 0 ? next : null
                            })
                          )
                        }
                      />
                    </td>
                    <td>
                      <SettingButtonSelect
                        className="worker-grading-select"
                        value={worker.gradingModel ?? ''}
                        options={modelChoices(modelsFor(worker.adapterId)?.models ?? [])}
                        ariaLabel={`Grading model for ${worker.label}`}
                        disabled={busy === `grading-model:${worker.id}`}
                        title="The model this account uses for peer reviews. New workers start on the adapter's smallest configured model."
                        onChange={(value) =>
                          void guard(`grading-model:${worker.id}`, () =>
                            rpc('worker.update', { id: worker.id, gradingModel: value || null })
                          )
                        }
                      />
                    </td>
                    <td>
                      <div className="worker-role-checks" aria-label={`Roles for ${worker.label}`}>
                        {/* ⛔ Both boxes are read off the pair (work, judgment) and written back as
                            the role that pair spells - never as an edit to the role name. Each box
                            used to compute its own `next` by comparing the old name, so unticking
                            the *only* ticked box mapped the role onto itself: `controller` with
                            Judgment unticked came out `controller` again. The write succeeded, the
                            value never moved, and the box sprang back with nothing to explain it. */}
                        <label><input type="checkbox" checked={canWork(worker.role)} onChange={(e) =>
                          void guard(`role:${worker.id}`, () =>
                            rpc('worker.update', { id: worker.id, role: roleOf(e.target.checked, canJudge(worker.role)) })
                          )
                        } /> Work</label>
                        <label><input type="checkbox" checked={canJudge(worker.role)} onChange={(e) =>
                          void guard(`role:${worker.id}`, () =>
                            rpc('worker.update', { id: worker.id, role: roleOf(canWork(worker.role), e.target.checked) })
                          )
                        } /> Judgment</label>
                        <label><input type="checkbox" checked={worker.gradingEnabled} onChange={() =>
                          void guard(`grading-role:${worker.id}`, () => rpc('worker.update', { id: worker.id, gradingEnabled: !worker.gradingEnabled }))
                        } /> Grading</label>
                      </div>
                    </td>
                    <td>
                      {(() => {
                        const globalCreditsOn = settings?.spendCreditsPastLimit === true
                        const workerCreditsOn = worker.creditsIntent?.asked === true
                        const unavailable = !globalCreditsOn
                        return (
                          <div className={`worker-credits${unavailable ? ' worker-credits--disabled' : ''}`}>
                            <label title={
                              unavailable
                                ? 'Disabled until “Spend usage credits past the plan limit” is enabled in Settings › Global.'
                                : 'Allow this worker to spend usage credits past its plan limit. The vendor must also report credits enabled.'
                            }>
                              <input
                                type="checkbox"
                                checked={workerCreditsOn}
                                disabled={unavailable || busy === `credits:${worker.id}`}
                                onChange={() =>
                                  void guard(`credits:${worker.id}`, () =>
                                    rpc('worker.setCreditsIntent', { id: worker.id, asked: !workerCreditsOn })
                                  )
                                }
                              /> Allow credits
                            </label>
                            {!globalCreditsOn && workerCreditsOn && (
                              <span className="worker-credits-warning">Disabled: turn on the global setting first.</span>
                            )}
                            {globalCreditsOn && worker.credits && !worker.credits.enabled && (
                              <span className="worker-credits-warning">Vendor reports credits off.</span>
                            )}
                          </div>
                        )
                      })()}
                    </td>
                    {/* ⛔ The buttons live in a div, never directly in the <td>. The cell is a
                        `label | value` grid, so three loose buttons were laid out as grid items:
                        Sign in in the label column, Probe stretched across the whole value column,
                        Retire wrapped onto a line of its own. One flex row in the value column
                        keeps all three together, each only as wide as its own word. */}
                    <td className="tbl-action-cell">
                      <div className="worker-actions">
                        <button className="btn" disabled={busy === `login:${worker.id}`} onClick={() => void startLogin(worker.id, worker.adapterId)}>Sign in</button>
                        <button className="btn" disabled={busy === `probe:${worker.id}`} onClick={() => void probe(worker.id, worker.label)}>{suspect ? 'Recheck' : 'Probe'}</button>
                        <button className="btn btn--danger" disabled={busy === `ret:${worker.id}`} onClick={() => void guard(`ret:${worker.id}`, () => rpc('worker.retire', { id: worker.id }))}>Retire</button>
                      </div>
                    </td>
                  </tr>
                  {/* ⚠️ One row per account, however many things are wrong with it, and it draws
                      nothing at all when nothing is. A row that is always present — empty most of
                      the time — is one an operator learns to stop reading. */}
                  {notes.length > 0 && (
                    <tr className={`tbl-row--note${worker.enabled ? '' : ' tbl-row--off'}`}>
                       <td colSpan={13}>
                        {notes.map((n) => (
                          <div key={n.key} className="tbl-note">
                            <span className={`tbl-note-label ${n.tone}`}>{n.label}</span>
                            <span className="tbl-note-text">{n.text}</span>
                            {n.fix && (
                              <button
                                className="btn btn--primary"
                                disabled={busy === n.fix.busyKey}
                                onClick={n.fix.run}
                                title="Opens a terminal so you can answer the CLI's first-run screens once."
                              >
                                {n.fix.label}
                              </button>
                            )}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
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
      // ⚠️ The headless mode is the one that decides this sentence where an adapter declares one.
      // Claude Code's classifier is real and reviews an interactive session; it is simply not
      // reachable under `-p`, and saying "a classifier reviews each action" of a dispatched task
      // that runs without one is how t250 came to cost nine approvals nobody expected.
      ok: c.classifierBackedAuto && !adapter.policy.headlessPermissionMode,
      text: adapter.policy.headlessPermissionMode
        ? `Its classifier is interactive-only, so unattended work runs ` +
          `${adapter.policy.headlessPermissionMode} inside a throwaway worktree instead`
        : c.classifierBackedAuto
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
        label: label.trim() || (adapterId === 'local-llm' ? 'local-llm' : 'worker'),
        ...(adapterId === 'local-llm'
          ? { isolationRoot: root.trim() || 'http://127.0.0.1:8080' }
          : adopt && root.trim()
            ? { isolationRoot: root.trim() }
            : {})
      })
      await onDone(worker.id, worker.adapterId)
    } catch (err) {
      onError(errorMessage(err))
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
          placeholder={adapterId === 'local-llm' ? 'e.g. qwen3-coder, llama-local' : 'e.g. personal, work, second seat'}
          onChange={(e) => setLabel(e.target.value)}
        />
        <span className="form-hint">Whatever you will recognise in a quota bar at a glance.</span>
      </div>

      {adapterId === 'local-llm' ? (
        <div className="form-row">
          <label>Endpoint</label>
          <input
            className="form-wide mono"
            value={root}
            placeholder="http://127.0.0.1:8080"
            onChange={(e) => setRoot(e.target.value)}
          />
          <span className="form-hint">
            The base URL of your llama.cpp or OpenAI-compatible server (default: http://127.0.0.1:8080).
          </span>
        </div>
      ) : (
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
      )}

      <div className="form-actions">
        <button className="btn btn--primary" disabled={saving} onClick={() => void submit()}>
          {saving ? 'Creating…' : selected?.login.kind === 'external' ? 'Commission worker' : 'Create and sign in'}
        </button>
      </div>
    </div>
  )
}
