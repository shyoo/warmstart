import type { AdapterCapabilities, SpendMeter, SpendSnapshot } from '@shared/protocol.js'
import { adapter } from './adapters/index.js'
import { db, rows } from './db.js'
import { log } from './log.js'
import { bumpPricingEpoch } from './price.js'
import { requireWorker } from './workers.js'

/**
 * The money store: what each account's meters read, and when.
 *
 * ⛔ **The money analogue of `quota.ts`'s store, and shaped like it on purpose.** A quota window is
 * a share of a flat fee already paid; a meter is a purse or a counter a vendor charges against on
 * top of it — Codex credits, Claude extra-usage overage, Antigravity cloud credits. `price.ts`
 * attributes movements in this table to the runs open across them exactly the way it attributes a
 * window's percent, which is why this file's job ends at *writing readings down honestly*.
 *
 * The rules it inherits from `quota.ts`, and why each one is load-bearing:
 *
 *  - ⛔ **A probe that ran and found nothing is a fact, not a failure.** It writes a row carrying an
 *    `error` and no balance. A gap in the series is otherwise indistinguishable from a healthy quiet
 *    period, and "we asked and the vendor publishes nothing" is a different sentence from silence.
 *  - ⛔ **A reading is dated by the *vendor's* timestamp wherever there is one.** Codex's balance is
 *    only ever as fresh as that worker's last turn, and stamping it with our clock would present a
 *    reading from Tuesday as one taken now. The staleness ladder depends on the difference.
 *  - ⛔ **Every write bumps the pricing epoch**, because a new reading moves a segment boundary and
 *    that changes what *every* run open across it is answerable for — not only the newest one.
 *  - ⚠️ **Re-reading the same reading is not a new sample.** A `config-cache` meter on an idle
 *    account returns the identical (meter, timestamp) pair on every poll, and inserting it again
 *    would grow the series without adding information — the failure that made the fleet strip sprout
 *    duplicate quota windows every five minutes.
 */

/** One meter's reading, as `price.ts` walks the series. */
export interface SpendReading {
  balance: number
  at: number
}

interface SpendRow {
  meter_id: string
  label: string
  unit: string
  balance: number | null
  direction: string
  usd_per_unit: number | null
  source: string
  error: string | null
  sampled_at: number
}

/** ⚠️ The empty-meter row's id, and the value `price.ts` filters on. Mirrors `quota_samples`' `''`. */
const NO_METER = ''

function toMeter(r: SpendRow): SpendMeter {
  return {
    id: r.meter_id,
    label: r.label,
    unit: r.unit === 'credits' ? 'credits' : 'usd',
    balance: r.balance,
    direction: r.direction === 'spend_rises' ? 'spend_rises' : 'balance_falls',
    usdPerUnit: r.usd_per_unit
  }
}

/**
 * Write one probe's answer: a row per meter, or a single row saying nothing was found.
 *
 * ⚠️ Returns how many rows actually landed, which is `0` for a re-read of a reading already stored.
 * The count is what the pricing epoch is bumped on: invalidating the whole memo every five minutes
 * because an idle account answered the same thing again is a real cost for no new information.
 */
export function recordSpendSample(
  workerId: string,
  snapshot: Omit<SpendSnapshot, 'workerId'>
): number {
  // ⛔ `where not exists`, not `insert or replace`: the table's primary key is a synthetic id, so
  // there is no natural key for SQLite to replace on. The identity of a reading is (worker, meter,
  // the vendor's timestamp), and this is that rule written out.
  const stmt = db().prepare(
    `insert into spend_samples
       (worker_id, meter_id, label, unit, balance, direction, usd_per_unit, source, error, sampled_at)
     select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      where not exists (
        select 1 from spend_samples
         where worker_id = ? and meter_id = ? and sampled_at = ?
      )`
  )

  const write = (m: {
    id: string
    label: string
    unit: string
    balance: number | null
    direction: string
    usdPerUnit: number | null
  }): number =>
    Number(
      stmt.run(
        workerId,
        m.id,
        m.label,
        m.unit,
        m.balance,
        m.direction,
        m.usdPerUnit,
        snapshot.source,
        snapshot.error ?? null,
        snapshot.sampledAt,
        workerId,
        m.id,
        snapshot.sampledAt
      ).changes
    )

  let written = 0
  if (snapshot.meters.length === 0) {
    // ⛔ Recorded, not dropped. `price.ts` skips these rows by `meter_id != ''`, so they cost the
    // arithmetic nothing and they are the only evidence that this account was ever asked.
    written += write({
      id: NO_METER,
      label: '',
      unit: 'usd',
      balance: null,
      direction: 'balance_falls',
      usdPerUnit: null
    })
  }
  for (const m of snapshot.meters) {
    written += write({ ...m, unit: m.unit, direction: m.direction })
  }

  // ⛔ Only on a row that landed. See the header.
  if (written > 0) bumpPricingEpoch()
  return written
}

/** Every meter this worker reported at its newest sample, with that sample's age and error. */
export interface DatedSpend extends SpendSnapshot {
  ageMs: number
}

/**
 * The most recent probe of this worker, whatever it found.
 *
 * ⚠️ **Whatever it found**, including nothing: a failed or empty probe is newer than the last good
 * reading and answering with the good one would present a stale balance as current. The caller is
 * given the age and the error and decides — the same contract `lastQuota` has, and for the same
 * reason.
 */
export function lastSpend(workerId: string): DatedSpend | null {
  const newest = rows<{ sampled_at: number }>(
    db()
      .prepare('select sampled_at from spend_samples where worker_id = ? order by sampled_at desc limit 1')
      .all(workerId)
  )[0]
  if (!newest) return null

  const at = newest.sampled_at
  const sampled = rows<SpendRow>(
    db()
      .prepare(
        `select meter_id, label, unit, balance, direction, usd_per_unit, source, error, sampled_at
           from spend_samples
          where worker_id = ? and sampled_at = ?
          order by meter_id asc`
      )
      .all(workerId, at)
  )
  const first = sampled[0]
  if (!first) return null
  const source = first.source
  return {
    workerId,
    meters: sampled.filter((r) => r.meter_id !== NO_METER).map(toMeter),
    sampledAt: at,
    source:
      source === 'cli' || source === 'config-cache' || source === 'stream' ? source : 'unknown',
    ...(first.error ? { error: first.error } : {}),
    ageMs: Math.max(0, Date.now() - at)
  }
}

/**
 * One meter's readings, oldest first — the series a movement is attributed from.
 *
 * ⛔ Rows with no balance are left out. A probe that found nothing marks the *account*, not the
 * meter, and treating its absent balance as a reading of zero would publish a purse emptying itself
 * every time a probe failed.
 */
export function spendSeries(workerId: string, meterId: string): SpendReading[] {
  return rows<{ balance: number; sampled_at: number }>(
    db()
      .prepare(
        `select balance, sampled_at from spend_samples
          where worker_id = ? and meter_id = ? and balance is not null
          order by sampled_at asc`
      )
      .all(workerId, meterId)
  ).map((r) => ({ balance: r.balance, at: r.sampled_at }))
}

/**
 * The `spendProbe` values that mean *somebody has to go and ask*.
 *
 * ⚠️ `none` has nothing to read and `stream` needs no reading — see `AdapterCapabilities.spendProbe`.
 */
const POLLABLE: Array<AdapterCapabilities['spendProbe']> = ['cli', 'config-cache']

/** What `probeSpendFor` needs of an adapter. ⚠️ Every `AgentAdapter` satisfies it structurally. */
export interface SpendProbeSource {
  info: { capabilities: Pick<AdapterCapabilities, 'spendProbe'> }
  probeSpend?: (isolationRoot: string) => Promise<Omit<SpendSnapshot, 'workerId'>>
}

/**
 * Ask an adapter what its meters read, and write the answer down.
 *
 * ⛔ **Never throws, and never fails the quota probe it rides beside.** An adapter that breaks its
 * own best-effort contract is a bug in that adapter; losing this account's *quota* reading over it
 * would be a bug in the fleet. The throw is caught, recorded as a failed probe — which is what it is
 * — and the caller carries on.
 *
 * ⚠️ Skipped entirely for `spendProbe: 'none'`, and for `'stream'`: a stream meter arrives unasked
 * on a turn already being paid for, so there is nothing here to ask. The gate is the *capability*,
 * never the adapter's name.
 *
 * ⚠️ `using` is an injection point for the tests, which need an adapter that misbehaves on purpose
 * and cannot get one from the registry — the same trick `driveScreenProbe` uses for its clock.
 * Production passes nothing.
 */
export async function probeSpendFor(workerId: string, using?: SpendProbeSource): Promise<number> {
  const w = requireWorker(workerId)
  const a = using ?? adapter(w.adapterId)
  // ⛔ A positive list, not `!== 'none'`. `'stream'` is a declaration that the number **arrives**,
  // and polling one would be a second and costlier route to a fact already in hand — so an adapter
  // that declares `'stream'` is not asked even if it carries a `probeSpend`.
  if (!POLLABLE.includes(a.info.capabilities.spendProbe) || !a.probeSpend) return 0

  try {
    const snapshot = await a.probeSpend(w.isolationRoot)
    const written = recordSpendSample(workerId, snapshot)
    if (snapshot.meters.length) {
      log.info(
        `spend on ${w.label}: ` +
          snapshot.meters
            .map((m) => `${m.label} ${m.balance === null ? 'not reported' : m.balance} ${m.unit}`)
            .join(' · ')
      )
    }
    return written
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    log.warn(`spend probe failed for ${w.label}: ${why}`)
    return recordSpendSample(workerId, {
      meters: [],
      sampledAt: Date.now(),
      source: 'unknown',
      error: `the spend probe threw: ${why}`
    })
  }
}
