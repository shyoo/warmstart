# Is there a probe/dispatch deadlock on Muse Code? — findings, and the plan (t309, 2026-09-08)

**The question (operator, t309).** *"The probe is stale until you send a prompt such that Muse Code
starts to work. However, the controller cannot dispatch to Muse until it has a successful probe."*

**The short answer: no such deadlock exists.** The quota gate does not require a reading, and a
worker with no readable quota is dispatched to blind. The operator's second premise is false, and it
was false before t307. ⚠️ But the *symptom* is real and has two other causes, one of which is a
genuine two-way lock. Both are below with what was measured.

## 1. What was measured

Scratch suite over a temp database and a declared adapter (`node`, no CLI, no tokens), 2026-09-08 —
seeding exactly the row a failed `/usage` probe writes (`store()` in `quota.ts`: one row, no
windows, `error` set, `sampled_at` = now):

| # | Question | Measured |
|---|---|---|
| 1 | What does a failed probe leave behind? | `{ windows: [], stale: true, error: 'Currently unavailable' }` |
| 2 | Is that worker still chosen for a task pinned to it? | **Yes** — `choice.worker` = the worker, `reason` empty, `quotaUnverified: true` |
| 3 | And a worker never probed at all, with no run ever? | **Yes** — chosen, empty refusal |
| 4 | Does `needsBaseline` hold it? | `null` (this adapter declares no `usageRefresh`) |

⛔ The scratch suite was **deleted rather than kept**: its adapter cannot declare `usageRefresh`
(`external.ts` hard-codes `usageRefresh: null`), so it proves rows 1–3 and cannot reach the Muse
probe path at all. Rows 1–3 are the load-bearing ones and are re-derivable in a minute.

## 1b. What the live fleet says (measured 2026-09-08, read-only query against the app database)

The three faults in §3 are read off the code. Against **MuseFirst** (`ec6db958`, adapter `muse-code`)
none of them is the state that account is actually in, and the fleet's own history settles the
question the operator asked:

| Row | Value | Rules out |
|---|---|---|
| `health_json` | **`null`** — never struck, not `suspect` | 3a is latent here, not active |
| `identity_json` | `loggedIn: true`, `setupComplete: true`, cliVersion `1.0.3` | 3c — no dialog is in the way |
| turns / runs | **532 turns across 13 runs**, most recent `completed` | 3b — `everWorked` is long since true |
| every muse run | `quota_unverified = 1` | ⛔ **the decisive one, below** |

⛔ **All 13 Muse runs dispatched with `quota_unverified = 1`, and they completed.** The fleet has
already done, thirteen times, the exact thing the operator believed it could not do: dispatch to Muse
with no usable quota reading. That is the deadlock question answered on live data rather than from
the source.

⚠️ **What the probe history does show** is a narrower, real vendor behaviour. Sample `18059`
(`sampled_at` 1788853885023) is a *successful* read — `5h` window, **80%**, `source: 'cli'`,
`resets_at` 1788867480000 — taken **16 seconds after a run ended**. Every sample after that window's
reset reads `Currently unavailable` again. So Meta publishes windows only while a window is live, and
a window goes live only from a completed turn. The operator's first premise is therefore *correct*
and their second is not: the reading does depend on work happening, but nothing depends on the
reading. This is a display and expectations problem, not a scheduling one — and t307 already
corrected the sentence the operator reads.

## 2. Why there is no deadlock, in the code

- **`poolVerdict([])` refuses nothing.** `blocking` stays `null` when a pool has no windows
  (`shared/tasks.ts`); `quotastaleness.test.ts` already asserts this in as many words.
- **The dispatch gate's `else` branch is not a refusal.** In `scoring.ts` (~line 405), when
  `!quota || quota.windows.length === 0` the code sets `quotaUnverified = true` and **falls through
  to `rawCandidates.push`**. There is no `continue`.
- **`quotaUnverified` is a note, never a filter.** All 30 references are display, logging or the
  `runs` row. Nothing branches on it to exclude a candidate.
- **`needsBaseline` gives up on purpose.** Its own docblock: *"it gives up … After one attempt the
  run goes ahead and is marked `quotaUnverified`."* `ensureFreshQuota` returns `true` only while a
  refresh is claimable or in flight; once `endRefresh` stamps the attempt, `REFRESH_BACKOFF_MS`
  (10m) makes the next tick answer `'too-soon'` → `false` → the task dispatches. Worst case the task
  is held for **one probe's duration** (~32s for muse: `readyMs` 14s + `settleMs` 18s), not forever.
- **`ensureFreshQuota`'s own contract says so.** *"`false` is not a failure and must not bench the
  task — a fleet that refuses to dispatch without a fresh percentage is a fleet stopped by its own
  instrument."*
- **`eligibility.ts` has no quota gate at all.** It asks about retirement, `enabled`,
  `humanOccupied`, install, sign-in, subscription and health. Never a reading.

⚠️ t307 changed only the *sentence* shown to a person. It touched no gate.

## 3. What is actually wrong — three real faults, in the order they bite

### 3a. ⛔ `suspect` is a genuine two-way lock (the real one)

`STRIKES_TO_QUARANTINE = 1` (`workers.ts`): **one** dispatch that ends with no metered turn sets
`health.state = 'suspect'`. Then:

- `accountRefusal` refuses every dispatch — `"<label> is held out: <reason>"`.
- `mayRefreshUsage` **also returns `false`** for a suspect worker, so no automatic probe either.

So a suspect Muse worker is neither dispatched to nor probed, and the only two exits are a metered
turn (which needs a dispatch) or the operator pressing **Probe** (`refreshIdentity(lift = true)`).
That is deadlock-shaped and it is *by design* — the docblock argues for it — but it is the state the
operator's description actually fits, and the UI does not say *"press Probe to clear this"*.

⚠️ Muse is unusually exposed here: `headlessPermissionMode: 'never'` with
`defaultPermissionMode: 'on-request'` means an unattended run that hits a shell command **stalls**,
which is exactly a run that ends with no metered turn.

### 3b. ⚠️ `unproven` starves a new worker out of auto-routing

`scoring.ts`: doubt is `0.5` (never worked) `+ 0.6` (`setupComplete === false`) `+ 0.4` (not signed
in), times `UNPROVEN_PENALTY = 0.35` → up to **−0.525** against `ROUTE_EPSILON = 0.10`. Only a
metered turn clears `everWorked`. The docblock records this exact loop having already happened:
*"antigravity-cli had 0 turns ever, against 122 on claude-code."* A fresh Muse worker sits −0.175 to
−0.385 behind any proven Claude worker and loses every unpinned contest. ⛔ Not a gate — pinning the
task to Muse bypasses it entirely — but it is why the operator sees "it never goes there".

### 3c. ⚠️ One unanswered dialog produces both symptoms at once

Muse's `firstRun` (folder-trust, `completedKey: 'projects'`) *"swallows anything typed at it until it
is answered"* — so it blanks the `/usage` probe **and** sets `setupComplete === false`, which is the
`+0.6` in 3b. The operator sees "stale probe" and "never routed" together and reads them as one
mechanism. They are two, and one dialog is upstream of both.

## 4. The plan

⛔ **Nothing here removes a quota gate, because there is no quota gate to remove.**

| # | Change | Where | Why |
|---|---|---|---|
| 1 | Say how a `suspect` hold ends, on the row and in the refusal sentence | `eligibility.ts`, `Workers.tsx` | 3a is operator-clearable and nothing says so |
| 2 | Let a **pinned** task clear `suspect` itself — an explicit human pin is the operator saying *try it anyway* | `eligibility.ts` call site in `scoring.ts` | ⛔ Design decision, see below |
| 3 | Let a *successful* identity or quota probe clear `suspect`, not only the Probe button | `quota.ts` / `workers.ts` | A probe that reads the panel is evidence the account answers |
| 4 | Cap `unproven` doubt where the worker is the operator's explicit pin | `scoring.ts` | 3b; pinning already bypasses it, so this is only for the auto path |
| 5 | Surface the muse `firstRun` dialog as one actionable item, not two symptoms | `Workers.tsx` | 3c |
| 6 | Regression suite: a worker with a failed probe row is still a candidate | new `probedeadlock.test.ts` | rows 1–3 above, kept this time |

### ⛔ Design decisions the operator has to make (not guessed here)

1. **Should one dead run still quarantine an account?** `STRIKES_TO_QUARANTINE = 1` was chosen
   against an expired subscription, where retrying is pure waste. Against Muse, where a stalled
   permission prompt produces the same signature, it quarantines a healthy account. Options: keep 1;
   raise to 2; or make it **per adapter** (`policy.strikesToQuarantine`), so an adapter whose runs
   can stall for a recoverable reason gets a second attempt.
2. **May an explicit human pin overrule `suspect`?** Today it cannot. A pin is the operator saying
   *use this one*, and the alternative is a task that sits at `awaiting_human` until Probe is
   pressed. Against that: it re-spends a workspace claim and a process on an account that has
   already proved a run dies there.
3. **Should `mayRefreshUsage` still refuse a suspect worker?** Refusing the probe is what makes 3a
   two-way. A probe is cheap relative to a dispatch and a successful one is real evidence; allowing
   it would let the fleet clear its own quarantine without a person.

⚠️ **Now measured — see §1b.** MuseFirst is in *none* of the three states: `health_json` is
`null`, `setupComplete` is `true`, and it has 532 turns behind it. 3a, 3b and 3c are all real in the
code and all latent on this fleet. That demotes rows 2, 4 and 5 to hardening, and leaves rows 1, 3
and 6 as the ones that pay for themselves regardless of which state an account is in. ⛔ It also
means the operator's actual complaint is answered by §1b and not by any row here: the `/usage`
panel goes blank once the 5h window resets with no activity, and that is a vendor behaviour the
scheduler already tolerates thirteen runs over.
