# Why ClaudeSecond read stale for hours with a 5-minute probe

Measured 2026-08-31 from `%APPDATA%\multi_agent_controller\logs\orchestratord-2026-08-3*.log`.
**Nothing hung and nothing crashed.** The poller ran on time throughout; the reading it produced
was old by construction.

## The two rungs are not the same operation

- `probeWorker` (`src/daemon/quota.ts:69`) reads the CLI's on-disk `cachedUsageUtilization` and
  stores the reading with **the vendor's** `fetchedAtMs` as `sampledAt`
  (`src/daemon/adapters/claude-code.ts:474`). Re-reading an unchanged cache therefore produces a
  row identical to the one already there — `store()` is `insert or replace` for exactly that
  reason — and **the age keeps climbing**. This is what the 5-minute sweep does.
- `refreshUsage` (`quota.ts:104`) is the only thing that makes that cache current on an idle
  account, and it is gated by `REFRESH_AFTER_MS`.

So the 5m setting buys *frequency of looking*, not *freshness*. The comment at `quota.ts:44`
already says the vendor cache is kept current by "any use of that account" — true, and ClaudeSecond
was idle (`Claude 5h 0%` all day), so nothing used it.

## The arithmetic that produced ">2 hours"

`STALE_AFTER_MS` = 15m (`quota.ts:32`) · `REFRESH_AFTER_MS` = **2h** (`quota.ts:54`, raised from
30m on 2026-08-30 to stop 150 probe PTYs against 14 work sessions).

`shouldBackgroundRefresh` returns true only at `ageMs > REFRESH_AFTER_MS`, so an idle worker's
reading cycles 0 → 2h05 and is `stale` for **1h50 of every 2h05** — 88% of the time. Measured
ClaudeSecond refreshes: `07:46:17 → 09:51:18 → 11:56:18` (2h05 apart, the 2h gate plus the sweep it
lands on). On 2026-08-30, before the constant changed, the same lines are 35m apart.

That is the whole answer to the question asked. The 5m sweep was working the entire time — the log
shows `probed ClaudeSecond: Claude 5h 0% · Claude 7d 92%` every 5 minutes without a gap.

## Latent, not what happened here

1. **One refresh per sweep, first eligible wins.** `sweep()` sets `refreshed = true` after the first
   worker (`quota.ts:492-508`), and iterates in `listWorkers()` order. On the failure path
   (`quota.ts:214-236`) a refresh that produced no fresher reading stores the snapshot with the
   **old** `after.sampledAt`, so that worker stays eligible forever and re-claims the single slot
   every 5 minutes, starving every worker behind it in the list indefinitely. No
   `no fresher reading appeared` warning appears in these logs, so this did not fire — but a
   commissioned-but-unonboarded worker is precisely the case that triggers it.
2. **ClaudeThird was refreshed every 15m21s** (11:07:49, 11:23:10, 11:38:31, 11:53:51) — off the
   sweep boundary, so from `scheduler.ts:352/385`, not the poller. Worth confirming that path is
   meant to run that often now that the poller's own clock is 2h.

## What was done about it (the operator chose all three)

1. **The strip stops saying `stale` and says the age.** `quotaGap` returns `read 2h ago`, the fleet
   card is faint rather than amber, and the amber is kept for the case that really is a fault —
   every check since has failed. Old on an idle account is ordinary: the window is not moving.
   ⛔ Unchanged underneath: `stale` is still a gate, and nothing the scheduler gates on will use a
   reading past `STALE_AFTER_MS`.
2. **The refresh clock is gone.** `QuotaPoller.sweep()` now starts no process at all — identity,
   then the free file read. `ensureFreshQuota()` refreshes where the number is about to be used:
   the dispatch gate (`needsBaseline`, which also serves the tied-candidate consult gate), the end
   of a run, and the Probe button. `REFRESH_AFTER_MS` is deleted; `mayRefreshUsage()` carries the
   account gates that were buried inside `shouldBackgroundRefresh`.
3. **The starvation is fixed at its root.** `REFRESH_BACKOFF_MS` (10m — the dispatch gate's own
   retry, now the only such number) is keyed on the **attempt**, recorded in `refreshAttempts`, so
   a refresh that cannot move the reading no longer re-qualifies itself forever. The single
   per-sweep slot it used to monopolise no longer exists either.

⚠️ **None of it has run in flight.** The next idle worker on this fleet is the trial: its card
should read `read Nm ago` and grow, and the refresh should appear in the log only when a task is
about to be dispatched to it.
