import { sessionEnded, UNATTENDED_AUTHORITY_LABELS } from '@shared/protocol'
import { Fragment, useEffect, useState } from 'react'
import type {
  AdapterDetection,
  AdapterInfo,
  ModelOptions,
  Session,
  Settings,
  UnattendedAuthority
} from '@shared/protocol'
import { rpc, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { isWorkerSubscriptionExpired, QUOTA_STALE_AFTER_MS, quotaFreshness } from '@shared/tasks'
import { age, percent, quotaGap } from '../lib/format'
import { creditsMismatchKind, creditsMismatchNote } from '@shared/credits'
import { SettingButtonSelect } from './SettingButtonSelect'
import { TerminalPane } from './Terminal'
import { useTarget } from '../lib/target'
import { errorMessage } from '@shared/errors.js'
import { ModelTable, MODEL_TABLE_HELP } from './ModelTable'

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
 * Where a sign-in is actually going to happen, said before it happens.
 *
 * ⛔ **The login runs beside the credential, never beside the operator.** Warmstart hosts the
 * vendor's own CLI in a PTY on whichever machine owns the isolation root, and every CLI here hands
 * the OAuth step to a *browser on that machine*. When the window is driving another computer's
 * fleet, or is itself a remote-desktop view of one, the browser opens on a screen the operator is
 * not sitting at: the terminal below sits at "waiting for the browser" and nothing ever comes back.
 * Reported 2026-09-13, from a commissioning attempt over a remote desktop.
 *
 * ⚠️ Two wordings, because the two cases end differently. Driving a paired computer, Warmstart knows
 * which machine it is and can name it — the operator has to go to that machine's screen, and no
 * amount of waiting here will help. Locally it cannot know whether the window itself is being viewed
 * over RDP/VNC, so it states the rule and lets the operator decide whether it applies to them.
 *
 * ⛔ Shown at the point of no return and again during the login, not once in a doc. The first is
 * where the operator can still choose to walk over to the other machine; the second is where they
 * are staring at a terminal that looks hung.
 */
function SignInLocationWarning(): React.JSX.Element {
  const { active } = useTarget()
  const remote = active.kind === 'remote'
  return (
    <p className="login-remote-warning" role="note">
      {remote ? (
        <>
          <strong>This signs in on {active.label}, not here.</strong> The CLI runs on that computer,
          so a sign-in step that opens a browser opens it <em>on that computer&rsquo;s screen</em> —
          nothing will appear on this one, and the terminal below will simply wait. Finish the
          browser step at {active.label}, then come back here and use{' '}
          <strong>Check sign-in again</strong>. An adapter that can be signed in from a pasted code
          or a device link is the one to prefer from here.
        </>
      ) : (
        <>
          <strong>Signing in opens a browser on the computer running Warmstart.</strong> If you are
          looking at this window over a remote desktop (RDP, VNC, Screen Sharing), that browser
          appears on the <em>remote</em> machine&rsquo;s own screen rather than on the desk in front
          of you. Stay on the remote session&rsquo;s screen to complete it — or copy the URL the
          terminal prints and open it yourself.
        </>
      )}
    </p>
  )
}


/**
 * How many tasks one account may run at once — the sentence behind the `Max` column's (i).
 *
 * ⛔ One string, used by the heading's tooltip and the input's alike. Two copies of this is how the
 * header ends up describing a different setting from the box underneath it.
 *
 * ⭐ **It names the cost of raising it, because this is the one screen where somebody is about to.**
 * A task held at `<account> at capacity` points here (`capacityHoldReason`, `shared/capacity.ts`),
 * and the number goes up in one keystroke — so the three things a second parallel run actually costs
 * belong beside the box, not in a doc. ⚠️ The short form of the same three clauses is
 * `PARALLEL_TRADEOFF`; if one changes, both do.
 */
const MAX_HELP =
  'How many tasks this account may run at the same time. Anything beyond it waits, held as ' +
  '"<account> at capacity", and raising this number dispatches a waiting task on the next tick — ' +
  'there is nothing else to press. ' +
  'What running more at once costs: the quota window drains faster; the quota reading is less ' +
  'reliable while several runs share one window; and fewer tasks land on a warm session, so more of ' +
  'them start cold, which costs tokens and tends to give a weaker answer. ' +
  'Lowering it never interrupts a running task; it only holds the next dispatch.'

const UNATTENDED_AUTHORITY_HELP =
  'How much of this machine unattended work on this account may reach. "Sandboxed adapters only" ' +
  'holds a task rather than run it here if this account’s CLI has no real sandbox. "Full user ' +
  'authority" lets it run with permission checks bypassed, as your OS user — on Codex that means ' +
  '`--dangerously-bypass-approvals-and-sandbox`; on Claude Code and Antigravity it is what unattended ' +
  'work has always run as.'

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

  /**
   * The models one account can be set to. A worker whose models are its server's (local-llm) has an
   * entry of its own naming what *that* endpoint reported; everything else reads the adapter's list.
   */
  const modelsFor = (adapterId: string, workerId?: string): ModelOptions | null =>
    (workerId ? modelOptions.find((o) => o.adapterId === adapterId && o.workerId === workerId) : null) ??
    modelOptions.find((o) => o.adapterId === adapterId && !o.workerId) ??
    null

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

  /**
   * The turn this worker's adapter says it can spend to make its provider publish — or null.
   *
   * ⛔ Read off the adapter's declaration, never off its id. An adapter that grows a warm-up gets
   * the button by declaring one, and this file never learns another vendor's name. See `UsageWarmup`.
   */
  const warmupOf = (workerId: string): { prompt: string; completeMs: number; note: string } | null => {
    const worker = fleet.find((f) => f.worker.id === workerId)?.worker
    return adapters.find((a) => a.id === worker?.adapterId)?.usageRefresh?.warmup ?? null
  }

  const probe = (workerId: string, label: string) =>
    guard(`probe:${workerId}`, async () => {
      const quota = await rpc('worker.probe', { id: workerId })
      const worker = fleet.find((f) => f.worker.id === workerId)?.worker
      const gap = quotaGap(quota, probeKind(workerId), worker, Boolean(warmupOf(workerId)))
      setNotice(
        gap
          ? `${label}: ${gap.label}. ${gap.hint}`
          : `${label}: ${quota.windows.map((w) => `${w.label} ${percent(w.percent)}`).join(' · ')}`
      )
    })

  /**
   * Spend one small turn on this account, then read the panel again.
   *
   * ⚠️ Reports what it *found*, not that it ran. The turn is spent either way, so the one thing the
   * operator needs back is whether the provider started publishing — and where it did not, the
   * daemon's sentence already says not to press this again.
   */
  const warmUp = (workerId: string, label: string) =>
    guard(`warm:${workerId}`, async () => {
      const quota = await rpc('worker.warmUsage', { id: workerId })
      const worker = fleet.find((f) => f.worker.id === workerId)?.worker
      const gap = quotaGap(quota, probeKind(workerId), worker, Boolean(warmupOf(workerId)))
      setNotice(
        gap
          ? `${label}: a warm-up turn was sent. ${gap.label}. ${gap.hint}`
          : `${label}: warmed up — ${quota.windows.map((w) => `${w.label} ${percent(w.percent)}`).join(' · ')}`
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
          <p>No workers configured.</p>
          <p className="dim">
            Add a worker to connect an AI coding CLI account. Warmstart manages CLI sessions in isolated workspaces
            without storing user credentials directly.
          </p>
        </div>
      ) : (
        <table className="tbl tbl-workers">
          {/* ⛔ Eleven columns, eleven <col>s. A missing column makes a fixed-layout table
              hand the final cell no width at all, and Sign in / Probe / Retire then wrap one per
              line inside a cell the width of a button. Keep this count in lockstep with the
              headers and cells; the card layout below also labels by this same position.
              ⭐ The three actions are one 6% menu now rather than a 19% row of buttons, and the
              fourteen points that freed went where the content was actually being squeezed: Quota
              (which now sets one window per line), Account and Model. */}
          <colgroup>
            <col style={{ width: '3%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '35%' }} />
            <col style={{ width: '8%' }} />
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
              <th>
                <span className="th-with-info">
                  Models
                  <ColumnInfo text={MODEL_TABLE_HELP} />
                </span>
              </th>
              <th>
                <span className="th-with-info">
                  Unattended
                  <ColumnInfo text={UNATTENDED_AUTHORITY_HELP} />
                </span>
              </th>
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
              const warmup = warmupOf(worker.id)
              const gap = quotaGap(reading, probeKind(worker.id), worker, Boolean(warmup))
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
                fix?: { label: string; busyKey: string; run: () => void; title?: string }
              }> = []
              // ⛔ **Offered only where the provider has actually gone quiet**, which is the `gap`
              // above saying so — not on every worker whose adapter happens to declare a warm-up.
              // A button that spends a turn must not be sitting on an account that already has a
              // reading, where pressing it buys nothing at all.
              if (warmup && gap?.label === 'no usage data yet') {
                notes.push({
                  key: 'warmup',
                  tone: 'warn',
                  label: 'No usage published',
                  // ⚠️ The adapter's own sentence, which says what it costs. The renderer does not
                  // write the price of another vendor's turn.
                  text: warmup.note,
                  fix: {
                    label: 'Warm up',
                    busyKey: `warm:${worker.id}`,
                    run: () => void warmUp(worker.id, worker.label),
                    title:
                      'Sends one very small turn on this account — a question about the model, ' +
                      'touching no files — and then reads the usage panel again. It is a real turn ' +
                      'on your subscription.'
                  }
                })
              }
              if (needsFirstRun) {
                notes.push({
                  key: 'setup',
                  tone: 'warn',
                  label: 'Setup unfinished',
                  text:
                    'First-run onboarding has not completed for this CLI account. ' +
                    'Interactive terminal sessions may stall on initial setup prompts. Complete onboarding once to resolve.',
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
                      `${suspect.reason} — background usage polling paused while held out. ` +
                      'Renew subscription to restore access; use Recheck to verify after renewal.'
                  })
                } else {
                  notes.push({
                    key: 'suspect',
                    tone: 'danger',
                    label: suspect.needsReauth ? 'Authentication required' : 'Dispatch paused',
                    text:
                      `${suspect.reason} — background usage polling will clear this automatically ` +
                      'once valid quota windows or metered turns are confirmed. Use Recheck to poll immediately.'
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
                    {/* ⭐ The account's models as one table (t638): each (model, effort) line with its
                        class and a tick for Default, Auto-route, Grading and Judgment. It replaced three
                        pickers — default model, a routable-models menu behind a pen button, grading
                        model — that were one question asked three times.
                        ⛔ On the worker and nowhere higher: a model id belongs to one CLI, so the same
                        control on a project or the fleet would hold a value that is invalid for every
                        task routed to a different adapter. */}
                    <td className="worker-models-cell">
                      <ModelTable
                        worker={worker}
                        options={modelsFor(worker.adapterId, worker.id)}
                        busy={busy === `models:${worker.id}`}
                        onPatch={(patch) =>
                          void guard(`models:${worker.id}`, () => rpc('worker.update', { id: worker.id, ...patch }))
                        }
                      />
                    </td>
                    <td>
                      <SettingButtonSelect
                        className="worker-grading-select"
                        value={worker.unattendedAuthority}
                        options={[
                          { value: 'sandboxed-only', label: UNATTENDED_AUTHORITY_LABELS['sandboxed-only'] },
                          { value: 'full-user', label: UNATTENDED_AUTHORITY_LABELS['full-user'] }
                        ]}
                        ariaLabel={`Unattended authority for ${worker.label}`}
                        disabled={busy === `unattended:${worker.id}`}
                        title={UNATTENDED_AUTHORITY_HELP}
                        onChange={(value) =>
                          void guard(`unattended:${worker.id}`, () =>
                            rpc('worker.update', {
                              id: worker.id,
                              unattendedAuthority: value as UnattendedAuthority
                            })
                          )
                        }
                      />
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
                            {/* ⛔ **The cause, not just the effect.** This cell said *Vendor reports
                                credits off.* for all four reasons an account can not be spending,
                                and on 2026-09-13 the operator met the one that sentence describes
                                worst: they had turned credits on at the vendor, the month's $17.30
                                allowance had been spent ($20.57 used), and the vendor had cut them
                                off until the refill. Told the switch was off, there was nothing to
                                go and switch. `creditsMismatchNote` names which of the four it is
                                and what would change it; `purse-empty` reads as spent rather than
                                as broken, because nothing here is. */}
                            {globalCreditsOn && creditsMismatchKind(worker.credits) && (
                              <span
                                className={`worker-credits-warning${
                                  creditsMismatchKind(worker.credits) === 'purse-empty'
                                    ? ' worker-credits-warning--spent'
                                    : ''
                                }`}
                              >
                                {creditsMismatchNote(worker.credits, now)}
                              </span>
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
                       <td colSpan={11}>
                        {notes.map((n) => (
                          <div key={n.key} className="tbl-note">
                            <span className={`tbl-note-label ${n.tone}`}>{n.label}</span>
                            <span className="tbl-note-text">{n.text}</span>
                            {n.fix && (
                              <button
                                className="btn btn--primary"
                                disabled={busy === n.fix.busyKey}
                                onClick={n.fix.run}
                                // ⚠️ The note's own title where it has one. This string was written
                                // for Finish setup and read as a lie under any other fix — the
                                // warm-up opens no terminal and asks nothing.
                                title={n.fix.title ?? "Opens a terminal so you can answer the CLI's first-run screens once."}
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
              would — Warmstart is hosting the process, not reading what it writes.
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
          {/* ⛔ Below the header, not inside it. `.login-head` is a flex row whose paragraph takes
              the slack and whose buttons refuse to shrink; a third item in it squeezes the prose to
              its ellipsis. This warning gets the full width instead. */}
          <SignInLocationWarning />
          {loginEnded && (
            <p className="login-note">
              The login session has ended. Warmstart re-read the account by itself — the Account
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

  // ⛔ **Said at commissioning, not discovered later.** An operator who signs an account in and
  // watches its quota read "no usage data yet" for a day has no way to know the provider is waiting
  // to be spent in rather than the app being broken — and this is the moment before they wait. It is
  // a fact about *this adapter*, declared by it, so an adapter with no warm-up says nothing here.
  if (adapter.usageRefresh?.warmup) {
    facts.push({ ok: false, text: adapter.usageRefresh.warmup.note })
  }

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
              {detection?.error ?? 'not on PATH — install it, or point Warmstart at it (M6)'}
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

      {/* ⚠️ Above the button, not under it. This is the last moment the operator can decide to walk
          over to the other machine instead, and a warning read after the click is a report. ⛔ A
          `local-llm` worker has no interactive login at all — it is an endpoint URL — so warning
          about a browser that will never open would train the operator to skip this box. */}
      {adapterId !== 'local-llm' && <SignInLocationWarning />}

      <div className="form-actions">
        <button className="btn btn--primary" disabled={saving} onClick={() => void submit()}>
          {saving ? 'Creating…' : selected?.login.kind === 'external' ? 'Commission worker' : 'Create and sign in'}
        </button>
      </div>
    </div>
  )
}
