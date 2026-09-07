# Claude usage credits — measured facts and implementation plan (t271, 2026-09-07)

Measured against Claude Code **2.1.263** on this machine, on the two live workers `ClaudeFirst`
(`shyoo@sunghwanyoo.com`) and `ClaudeSecond` (`vision82@gmail.com`), both `claude_pro`.
Everything in "What was measured" was read off the running CLI, not off documentation.

---

## 1. What was measured

### ⭐ The whole feature is already structured JSON in `.claude.json` — no screen scraping

`<isolationRoot>/.claude.json` → `cachedUsageUtilization.utilization` carries, beside the `limits[]`
array `probeQuota` already reads:

```jsonc
"extra_usage": {
  "is_enabled": false,       "monthly_limit": null,   "used_credits": null,
  "utilization": null,       "currency": null,        "decimal_places": null,
  "disabled_reason": null,   "user_disabled": true,   "spend_limit_reached": false,
  "credits_ever_enabled": true, "daily": null, "weekly": null
},
"spend": {
  "used": { "amount_minor": 0, "currency": "USD", "exponent": 2 },
  "limit": null, "percent": 0, "severity": "normal",
  "enabled": false, "disabled_reason": null, "cap": null, "balance": null,
  "auto_reload": null, "can_purchase_credits": false, "can_toggle": false,
  "disclaimer": "Usage credits cover you when you hit your plan limits."
}
```

and at the top level of the same file:

```jsonc
"oauthAccount": { …, "hasExtraUsageEnabled": false, "organizationRole": "admin" },
"cachedExtraUsageDisabledReason": "org_level_disabled"
```

⭐ **This is refreshed by the `/usage` PTY drive the app already performs** (`usageRefresh`,
`readyMs: 12_000, settleMs: 16_000`). So requirements 2, 3, 4, 5 and 6 need **no new TUI
interaction** — the existing probe already brings the numbers to disk, and `probeQuota` is simply
throwing them away today.

### ⛔ Credits are currently **off and not toggleable from the CLI** on both accounts

| field | ClaudeFirst | ClaudeSecond |
|---|---|---|
| `extra_usage.is_enabled` | `false` | `false` |
| `extra_usage.user_disabled` | `true` | `true` |
| `extra_usage.credits_ever_enabled` | `true` | `true` |
| `extra_usage.used_credits` / `monthly_limit` / `currency` | `null` | `null` |
| `spend.enabled` / `balance` / `limit` / `cap` | `false` / `null` / `null` / `null` | same |
| `spend.can_toggle` | **`false`** | **`false`** |
| `spend.can_purchase_credits` | `false` | `false` |
| `cachedExtraUsageDisabledReason` | `org_level_disabled` | `org_level_disabled` |

⛔ **`/usage-credits` does not open a toggle — it starts a login.** Driven under a PTY on both
accounts (the second time with the app's own `spawnEnv()`, so an inherited host variable is ruled
out), the panel is:

```
Login
Starting new login following /usage-credits. Exit with Ctrl-C to use existing account.
Select login method:
 ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
   2. Anthropic Console account · API usage billing
   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI
```

The `/usage` panel's own footer agrees that the feature exists and is off:
`Usage credits — Usage credits are off · /usage-credits to turn them on`.

⚠️ So **the app cannot enable credits today**, and the balances the operator has described
($37.87 / $47.69, expiring 2026-09-19) appear **nowhere** in anything the CLI writes while credits
are off — `used_credits`, `balance`, `monthly_limit` and `currency` are all `null`. Whether those
credits sit on these subscription accounts or on a linked **Anthropic Console** account (option 2
above, and the kind of credit that carries an expiry date) is the one thing that cannot be settled
from this machine.

### What already exists in this codebase, and needs no rebuilding

| requirement | existing machinery |
|---|---|
| 1 · suppress preempt | `Settings.autoPreempt` / `autoOverrunPreempt` / `autoCompact`; per-task `quota_override_until` + `quotaOverridden()` |
| 3 · exact before/after | `spend_samples` table, `recordSpendSample()`, and `price.ts::attribute()`, which already walks a meter series, splits a movement across parallel runs and reports the unmeasured remainder |
| 5 · monthly reset | `SpendMeter.direction: 'spend_rises'`, whose documented meaning is *"a fall is a billing-period rollover"* — the exact case, already handled by `attribute()` |
| 6 · subscription vs credit price | `RunPrice.subscriptionUsd`, `.overageUsd`, `.listUsd`, `.onOverage` — all four fields exist and are rendered; `overageUsd` is simply never populated for Claude |
| overage marking | `markRunOverage()`, fed by `rate_limit_event.isUsingOverage` / `overageStatus`, writing `runs.on_overage` / `runs.overage_status` |

⭐ The architecture already anticipated this feature. The gap is that `claude-code` declares
`spendProbe: 'stream'` and has **no `probeSpend`**, so `spend_samples` is empty for Claude and
`overageUsd` is therefore always `null`.

---

## 2. Plan

### Phase A — read the state (no behaviour change, safe to land now)

1. **`claude-code.probeSpend`**, reading the same `.claude.json` `probeQuota` already opens.
   - `spend.used.amount_minor / 10^exponent` → a `SpendMeter` with `direction: 'spend_rises'`,
     `unit: 'usd'`, `usdPerUnit: 1`, dated by `cachedUsageUtilization.fetchedAtMs` (**the vendor's
     timestamp**, per the rule in `spend.ts`).
   - `spend.balance` → a second meter with `direction: 'balance_falls'` **only when non-null**.
   - ⛔ `null` stays `null`. A probe that ran and found nothing writes an error row, never a zero.
   - Switch `spendProbe` from `'stream'` to `'cli'`, keeping the stream's `isUsingOverage` marking.
2. **A `CreditStatus` on the worker**, derived from the same file: `enabled`, `userDisabled`,
   `disabledReason`, `canToggle`, `everEnabled`, `monthlyLimit`, `usedCredits`, `currency`.
   Surfaced through the existing worker/quota event so the UI can read it.
3. **Discrepancy detection** (requirement 2's second half): the operator's *intent* is stored on the
   worker; when a probe reports a state that contradicts it, raise it once through the existing
   `Question` machinery (`fileParkedQuestion`) rather than logging and carrying on.

### Phase B — the money on the strip and on the run

4. **Fleet strip**: when credits are enabled on that worker, render the meter beside the windows —
   `$12.34 used` (and `of $50` where `monthly_limit` is non-null).
5. **Run price**: `overageUsd` starts populating for Claude automatically once (1) lands, because
   `attribute()` already reads `spend_samples`. The run detail already renders
   subscription-vs-overage-vs-list separately, so requirement 6 needs display work only.

### Phase C — the behaviour change

6. **Do not preempt into credits.** When a worker's credits are enabled and the operator has opted
   in, the 5-hour-exhaustion and window-boundary preempt triggers stop firing for that worker —
   hitting the plan limit is the moment credits start doing their job, so wrapping the run up
   defeats the purchase. ⚠️ `autoCompact` is a separate switch and is *not* implied by this.

### Phase D — the toggle (blocked at the vendor, confirmed 2026-09-07)

7. Enabling credits from the app is **not implementable as measured** — `can_toggle: false` and
   `/usage-credits` opens a login chooser. What is implementable is *reading* the state, *reporting*
   it honestly, and telling the operator exactly where to change it.

---

## 2b. What the operator decided, 2026-09-07

Asked during implementation, and both answers are now in the code:

1. **Which credits these are.** The operator checked console.claude.com: the $37.87 / $47.69 expiring
   2026-09-19 are **subscription extra usage**, *not* Anthropic Console prepaid API credits. So the
   `extra_usage` / `spend` mechanism above is the right one, the API-key route is not needed, and the
   blocker in Phase D is the real remaining obstacle: somebody has to enable extra usage in the
   Anthropic account settings, because the CLI reports `can_toggle: false` and `org_level_disabled`.
   ⚠️ The reading half was landed regardless, so the moment it is enabled the app sees it.

2. **What credits stand down.** Not all compaction — only the **quota-motivated** kind. `mayCompact`
   now takes a `motive`, and credits suppress `'quota'` (move 4, move 5's reserve breach,
   `decideRevive`) while leaving `'context'` alone (`compactOnResume`, move 5b's *too full to lend*).
   ⛔ The first draft stood down both, which reads as the simpler rule and buys a real failure:
   nothing about buying credits makes a context window bigger, so a long conversation on a
   credit-spending account would lose the one intervention keeping it under its own ceiling and the
   next turn would fail outright rather than being wrapped up. ⚠️ `'quota'` is the default, so a
   caller that does not say gets the stand-down rather than silently opting out.

## 3. Risk to state plainly

Every credit-side field this plan reads (`used_credits`, `monthly_limit`, `balance`, `currency`,
`decimal_places`, `daily`, `weekly`) has only ever been observed as `null`, because credits have
never been on while anything measured them. Building the parser, the strip and the price attribution
against fields whose populated shape is unmeasured is exactly the kind of guess this project's
adapters do not make. **One account with credits actually enabled, probed once, removes the guess.**
