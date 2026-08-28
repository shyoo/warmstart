# Adapters — what each CLI can do, and how we know

**Maintained.** This is the durable record of what was measured, when, and against which version. If
it disagrees with the code, one of them is wrong and it is worth finding out which.

Every claim carries its provenance, because a capability table is easy to write from documentation
and expensive to be wrong about. M5 wrote two adapters from vendor docs and then installed both
CLIs — and **several documented claims turned out to be wrong in ways that would have failed on the
first spawn.** That is the whole reason `AdapterInfo.verification` exists.

---

## The fleet, at a glance

| | `claude-code` | `antigravity-cli` | `openai-compatible` |
|---|---|---|---|
| Command | `claude` | `agy` | `codex` |
| Measured against | 2.1.223 | 1.1.20 | 0.149.1 |
| **Accounts per machine** | **unlimited** (`CLAUDE_CONFIG_DIR`) | ⛔ **1** (OS keyring) | **unlimited** (`CODEX_HOME`) |
| Credential lives in | a directory | ⛔ the OS keyring | a directory |
| Metered from | transcript (exact, survives a restart) | **its live stream** | **its live stream** |
| Can compact | ✔ | ⛔ | ⛔ *(conservative)* |
| Classifier reviews actions | ✔ `auto` | ⛔ | ⛔ |
| Approvals | `permission_prompt_tool` | settings rules | settings rules |
| Multi Agent Controller MCP tools | ✔ | ⛔ global registration only | ⛔ global registration only |
| Accepts our session id | ✔ | ⛔ | ⛔ |
| Free quota probe | ⛔ | ⛔ **measured — see below** | ⛔ |
| Reports cache reads | via transcript | ⛔ no | ✔ reads **and** writes |

**Read the ⛔ column-by-column, not row-by-row.** Two of these three CLIs have no classifier and no
approval callback, and yet only one of them can hold a fleet. That difference is invisible in a
feature comparison and decisive in a scheduler.

---

## What measuring corrected

Written from documentation, then run. Each of these was wrong:

| Adapter | Documented | Measured |
|---|---|---|
| `openai-compatible` | `codex exec --ask-for-approval on-request` | ⛔ **`--ask-for-approval` does not exist on `exec`.** It is interactive-only. Every scheduled spawn would have died on an argument error |
| `openai-compatible` | `-p` is print mode | ⛔ **`-p` is `--profile`.** On `agy` the same letter *is* print mode |
| `antigravity-cli` | `-p` is a boolean, like `claude -p` | ⛔ **it takes the prompt as its value.** `-p` / `--print` / `--prompt` are one *string* flag; `agy -p` alone answers *flag needs an argument: -p*. A bare `-p` before `--input-format` makes the CLI take `--input-format` as the prompt and exit 2 — and this adapter did exactly that, so **every Antigravity dispatch failed in 0s from M5 until 2026-08-27**. Print mode is switched on with `--print=` and the prompt arrives as NDJSON on stdin |
| `openai-compatible` | `--output-format json\|stream-json` | `exec` has **`--json`** and no `--output-format` |
| `openai-compatible` | identity from `auth.json` existing | **`codex doctor --json`** — free, local, redacted, and the vendor's own answer |
| `openai-compatible` | models `gpt-5.2-codex*` | `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini` — from `$CODEX_HOME/models_cache.json` |
| `antigravity-cli` | no auto-ish mode at all | **`--mode accept-edits\|plan` exists** — exactly what plan §9.1 predicted, and now the default |
| `antigravity-cli` | `--input-format` standalone | **requires `--output-format stream-json`**; one without the other is an argument error |
| `antigravity-cli` | conversations under `~/.gemini/antigravity/` | **`~/.gemini/antigravity-cli/conversations/<uuid>.db`** — and ⛔ **SQLite, not JSONL** |
| `antigravity-cli` | models `gemini-3-pro`, `gemini-3-flash` | `agy models` lists the real set — including **Claude and GPT-OSS models** — and spends no turn. ⛔ But **only on a terminal**: with stdout on a pipe it prints nothing and **hangs** (killed at 30s via `execFile`, and at 2m via `agy models | cat`, 2026-08-26). It is not usable as a probe |
| *(shared)* | `cmd /d /s /c <shim>` | ⛔ **`/s` breaks any path containing a space** — and `C:\Users\First Last` is the Windows default |
| *(shared)* | one `stream-json` format | ⛔ **three dialects.** agy keys on `event`, not `type` — the shared parser read *nothing* from it, silently. Decoding now belongs to the adapter |
| `antigravity-cli` | `agy -p /usage` might be a free quota probe | ⛔ **it is not.** Measured: taken as a *prompt*, spent 14,603 input + 264 output tokens, and began listing directories trying to work out what "/usage" meant |
| `antigravity-cli` | unmeterable (SQLite conversations) | **meterable after all** — usage is in the stream. `metering: 'stream'` |
| `claude-code` | the folder-trust dialog only affects fresh worktrees | ⛔ **It affects any folder, per account, and it swallows every keystroke until answered.** Measured 2026-08-27: the usage probe was spawning in the user's home - untrusted in the worker's config - so `/usage` was typed into the dialog and Enter accepted the folder. Projectless sessions now run in `<dataDir>/scratch` and `trustDirectory()` pre-answers it for that directory only |
| `claude-code` | signing in leaves an isolation root ready to use | ⚠️ **Only for print mode.** `claude auth login` writes `oauthAccount` and `userID` but not `hasCompletedOnboarding`, so an *interactive* session in that root opens the theme picker and then the login-method chooser. Scheduled work runs on `-p` and never sees it, which is why this hid until something needed a TUI (2026-08-27) |
| `claude-code` | a session that cannot work exits, so `onExit` is enough to catch it | ⛔ **It announces the failure and then stays.** Measured 2026-08-27 on an account whose organisation had disabled Claude Code: the stream carried `{"type":"result","is_error":true,"terminal_reason":"api_error"}` with *"Your organization has disabled Claude subscription access for Claude Code"*, and the process sat on stdin. The run stayed open, the task stayed `running`, and the worker's only slot stayed held. **The terminal `result` record is the signal; the exit is not** |
| `claude-code` | `auth status --json` says whether an account can work | ⚠️ **It says who is signed in, which is a different question.** A lapsed or org-disabled subscription answers exactly as a live one does — `loggedIn: true`, an email, an org — so nothing free separates them and only a run can. `subscriptionType` is now recorded and shown, and ⛔ gated on nowhere: what an expired plan puts there has not been measured here |
| `antigravity-cli` | an adapter that cannot answer identity questions looks the same as a healthy one | ⚠️ **It does, and that is the problem.** Antigravity's credential is in the OS keyring, so `loggedIn` and `setupComplete` are permanently `null` — the honest answer, and indistinguishable from an account in perfect health. Measured 2026-08-27: a never-signed-in Antigravity worker won a dispatch over two working Claude workers and failed in 0s. What separates them is whether a turn has **ever** come out of the account, which is in `turns` and now scores |
| `antigravity-cli` | `agy login` signs an account in | ⛔ **there is no `login` and no `auth` subcommand.** Measured on agy 1.1.20: `agy --help` lists agent, agents, changelog, help, install, mcp, mic-serve, models, plugin, plugins, update. Commissioning failed with *unexpected argument "login"*. Sign in with the Antigravity app; the credential goes to the OS keyring |
| `antigravity-cli` | `--mode accept-edits` suffices for headless work | ⛔ **it auto-denies commands.** In headless stream mode (`--input-format stream-json`), `accept-edits` only approves edits; any command (`git`, test runner, etc.) cannot prompt interactively and is auto-denied by `jetski`, causing immediate `CANCELED` turns. Headless worktree dispatches pass `--dangerously-skip-permissions` (Option A), quarantined inside isolated pooled worktrees and gated by mandate and landing checks |
| `antigravity-cli` | default print mode timeout allows long tasks | ⛔ **it times out at 5m.** `agy` defaults to `--print-timeout 5m0s` (1497 poll ticks); long tasks running multiple file edits/tests abort with `Print mode: timed out after 1497 polls` and exit with `ERROR`. Work sessions pass `--print-timeout 24h` |

The `cmd /s` one was latent since M1 and had never fired, because `claude` resolves to a `.EXE` on
this machine; `codex` installs as `codex.cmd`, which exposed it. The last two came from running the
CLIs against real accounts — see the quota section below.

---

## Consequences the scheduler reads

⛔ **No code anywhere asks which adapter it is looking at.** Each of these is a capability, and the
behaviour falls out of it:

- **`manualCompact: false`** → cache-clock moves 4 and 5 are unavailable, and `wrapUpProtocol` is
  `handoff`. M5 also found the hole this left: a reserve breach on a no-compact adapter used to fall
  through and do *nothing* — the one case the reserve exists to catch. It now hands off and closes.
- **`canPriceCache(): false`** → the clock declines to spend on keepalive or compaction at all,
  rather than acting on an invented number. Google bills cache *storage per token-hour*; OpenAI
  caches server-side with no client-controlled TTL. Neither is a lever of the shape the clock pulls.
- **`classifierBackedAuto: false`** → Multi Agent Controller writes a narrower allowlist into the worker's own
  configuration before each spawn, and expects a higher refusal rate.
- **`mintsSessionId: false`** → the transcript is discovered after the fact instead of predicted,
  and ⛔ **orphaned processes are never killed**, because identity cannot be proved. Leaving an orphan
  running costs quota; killing the wrong process costs somebody their work.
- **`resumeSession: true`** → a task continued after its session has exited goes back into the
  conversation it was already having, instead of starting one that has never heard of it. The
  scheduler names the conversation; the adapter chooses the flag — `--resume <id>` for Claude Code,
  `--conversation <id>` for Antigravity. ⛔ A claim about **the adapter**, not the CLI: `codex exec
  resume` exists and is unwired, so `openai-compatible` says false. ⚠️ Two conditions the scheduler
  checks before it will resume, both learned from real failures — the **same account** (a
  conversation lives in one isolation root) and the **same worktree** (Claude Code files transcripts
  under an encoding of the cwd, so resuming from elsewhere finds nothing and starts cold *quietly*).
  A session with no recorded turn is never resumed: `claude --resume` on an unknown id fails the
  process outright.
  ⭐ **Measured end to end 2026-08-28**, one fact planted and asked back on each CLI:
  claude 2.1.250 `--resume` returned the *same* `session_id` and answered from the earlier turn, at
  **cache_read 41,542 / cache_creation 65** against the cold turn's **0 / 41,542** — the whole prefix
  read instead of rebuilt. agy 1.1.22 `--conversation` returned the same `conversation_id`, answered
  from the earlier turn, and reported `num_turns: 2`. ⚠️ But **agy reported `cache_read_tokens: 0`
  on both turns** while `input_tokens` went 14,637 → 29,556: it restores the conversation and appears
  to re-send it at full input price. Resuming is still right there — the context is what the agent
  needs — but on this vendor it is not a *cache* saving, and nothing should claim one.
- **`metering`** → `transcript` is exact and survives a restart; `stream` bills from the wire and
  loses whatever a restarted daemon was not attached for; `none` would mean runs cost an **unknown**
  amount rather than zero. Doctor states which, and what it costs.
- **`maxAccounts: 1`** → commissioning refuses the second account, with a message that says why and
  what to do instead.
- **`selectableEffort: false`** → the New Task form draws **no effort control at all** for that
  account, rather than a disabled one. ⚠️ False on all three built-ins as of 2026-08-27, and that is
  a measurement: effort is something this codebase *reads back* from a transcript, and no built-in
  CLI has a start-up flag for one that anybody here has run. Claude Code sets it inside the session
  (`/effort`); Antigravity encodes it in the model id, which is why its cost model lists
  `gemini-3.1-pro-high` and `gemini-3.1-pro-low` as two models with one level each; codex documents
  `model_reasoning_effort` as a `-c` override, unrun, and that adapter's verification says
  `measured`. ⛔ The scheduler drops `constraints.effort` for any adapter that says false, so an
  adapter reading `SpawnRequest.effort` can trust it said it could act on one.
- **`needsReauth(reason)`** → the *presentation* of a held-out account: `re-sign-in required` and a
  Sign in button, rather than a reason to go and read. ⛔ Optional, and the adapter answers because
  the sentence is its CLI's — an expired subscription, a revoked key and a crash all arrive as the
  same `api_error` and differ only in the words after it. ⚠️ It changes nothing about gating: a
  suspect worker is held out either way, and an adapter that does not implement it says `false`,
  which is the safe answer. Never keyed on `api_error` alone — that code also covers an outage, and
  sending somebody to re-authenticate through one is how a working account gets signed out.

### Antigravity Tool Permissions & Future Improvement Options

- **Option A (Current / Shipped):** Antigravity CLI runs with `--dangerously-skip-permissions` for scheduled stream-json work. Because work runs strictly in isolated pooled worktrees (never trunk) and is validated by mandate constraints and automated landing check commands before anything merges, this provides zero-friction autonomous execution without stalls.
- **Option B (Future Improvement — Auto-Seeded Granular Settings Rules):** Instead of global permission skipping, the daemon's `writePermissions` could automatically seed fine-grained tool rules (`command(git)`, `command(npm)`, `read_file(*)`, `write_file(*)`, etc.) into `~/.gemini/antigravity-cli/settings.json` derived dynamically from the task's `mandate` and project configuration before spawn. This would provide granular tool sandboxing without requiring manual operator intervention or global permission skipping.

---

## The free quota probe for Antigravity, and the three routes that were not it

⭐ **There IS a free probe, and it is `/usage` typed into the TUI** - found 2026-08-27, after three
other routes had been evaluated and rejected. Those are kept below because the question gets asked
again, and because the first of them is a trap this project has now fallen into twice. Same
shape as Claude Code's, and free for the same reason — a slash command is handled by the client.
⛔ The difference, and why this took so long to find: Claude Code writes the answer to disk and
`agy` does not. Driving `/usage` in a PTY and diffing every file under `~/.gemini` showed only
`cli.log` (which logs `doRefreshQuota: starting reload` and no numbers) and `history.jsonl`
(which logs the command text) changing; the quota lives in `quota_manager.go` in memory. So the
adapter declares `usageRefresh.answer: 'screen'` and parses the panel — the one place in this
codebase where rendered text becomes state, permitted for a quota reading and nothing else.

Live reading, 2026-08-27, agy 1.1.22, Google AI Pro: Gemini weekly 5.48% used · Gemini 5-hour
32.80% · Claude-and-GPT weekly 42.80% · Claude-and-GPT 5-hour 0%.

⚠️ Two traps, both measured rather than reasoned:

- The panel reports **remaining**; `QuotaWindow.percent` is **used**. Inverted in the parser.
- The panel is **taller than a default terminal and scrolls**. At 30 rows one group's five-hour
  window fell below the fold and three of four windows came back looking complete. The probe
  session now runs at 110x60 and the parser refuses any group showing one of its two windows.

What was tried before and does not work:

1. **`agy -p /usage`** — measured 2026-08-25 and it **does not work**. The slash command is taken as a
   prompt: the run spent 14,603 input and 264 output tokens and started listing directories trying to
   work out what "/usage" meant. `--disable-slash-commands` implies print mode expands them; it does
   not. The same trap Claude Code set, sprung a second time — which is why the adapter now says so in
   a comment rather than leaving the lead open.
2. **The local Antigravity Language Server** — what the community usage tools read. ⛔ It exists only
   while the **IDE is running**. Verified on this machine with the IDE closed: no such process is
   listening and no port file exists. Multi Agent Controller's premise is unattended progress across hours-long
   windows with no GUI open, so a probe that needs a window open is not a probe for this product.
3. **A community package** (`antigravity-usage`, `antigravity-panel`, `opencode-antigravity-quota`).
   ⛔ Rejected on D7 — external services are wrapped, never vendored — and because an undocumented
   internal RPC surface behind a third-party wrapper is *two* things that can go stale rather than one.

**What Multi Agent Controller does instead needs no probe.** The stream carries per-turn usage, so spend is accrued
from turns Multi Agent Controller metered itself. ⚠️ That is a **floor**, not a percentage: it cannot see what the
vendor counted that never reached a stream. `reserve.ts` already treats accrued spend as a floor, and
runs on these adapters are marked `quotaUnverified`.

## Still unmeasured, and why

Everything below needs a **signed-in account and a real turn**, which is where free measurement stops.

| # | Question | Adapter |
|---|---|---|
| **R10** | Does the codex rollout JSONL carry per-turn usage in a shape `transcript.ts` can read? Metering works from the stream today, but a stream is lost if the daemon restarts mid-run and a file is not | `openai-compatible` |
| **R12** | Is headless compaction reachable on codex at all? Its session lifecycle has compaction, but no documented way to drive it from `exec`. If it is, `manualCompact` flips true and two cache-clock moves become available | `openai-compatible` |
| **R13** | Is agy's `result.usage` the *turn's* total or the *conversation's*? Measured on a single-turn run, where the two are identical. If it is cumulative, multi-turn sessions are over-billed | `antigravity-cli` |

**Answered by measurement on 2026-08-27:** the print flag (above), and with it the first
confirmation that a corrected argv reaches a signed-in Antigravity account: the CLI returns a
valid `init` record listing 50-odd tools, with no turn spent. ⚠️ Everything past `init` on this
adapter is still unmeasured, because it needs a real turn — R11 and R13 below.

**Answered by measurement on 2026-08-25:** R9 in *print* mode (no — `agy -p /usage` spends a turn
and does not answer) and R11 (three dialects, all decoded and regression-tested against verbatim
records). ⭐ **R9 was then reopened and closed the other way on 2026-08-27**: the same command in
the *interactive* TUI is free, and is now the adapter's quota probe. Print mode and the TUI are
different products — that is twice this project has been caught by the distinction.

## Running the tests without any of them

⛔ Every suite except `test:e2e` runs on a machine with **no agent CLI installed** — that is what CI
does. Checks that genuinely need a binary are skipped *visibly*, with a reason, and counted apart from
passes, so a green run on a bare runner cannot be mistaken for a green run on a developer's machine.

Two things that survived being run that way, and would not have been found otherwise:

- ⛔ **The not-signed-in gate did not fire when the CLI was missing.** It string-matched the probe
  output for `"loggedIn": false`; a probe that failed because there was no binary returned an error
  string instead, the gate passed, and the scheduler dispatched to a worker that could not possibly
  work — claiming a workspace to discover it. `WorkerIdentity.loggedIn` is now a stored field and the
  gate reads it.
- ⛔ **Nothing checked whether the CLI existed at all.** `isInstalled()` is now a hard gate on every
  candidate, in the scheduler and in controller selection. It is a filesystem lookup, so it costs
  nothing to ask on every tick — unlike `detect()`, which runs the binary.

## Installing

- **`claude`** — `npm install -g @anthropic-ai/claude-code`
- **`codex`** — `npm install -g @openai/codex`, then `codex login`
- **`agy`** — `irm https://antigravity.google/cli/install.ps1 | iex` (Windows) or
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`. ⚠️ The installer drops
  `agy.exe` in `%LOCALAPPDATA%\agy\bin` and only adds it to PATH when you run `agy install`.
  Multi Agent Controller looks there anyway, and Doctor tells you the difference.

Antigravity requires a Google AI Pro or Ultra subscription — the free tier ended on 2026-06-18, when
Gemini CLI stopped serving individual accounts. Codex is included with ChatGPT Plus/Pro/Business.
