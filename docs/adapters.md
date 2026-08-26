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
| agentyard MCP tools | ✔ | ⛔ global registration only | ⛔ global registration only |
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
| `openai-compatible` | `--output-format json\|stream-json` | `exec` has **`--json`** and no `--output-format` |
| `openai-compatible` | identity from `auth.json` existing | **`codex doctor --json`** — free, local, redacted, and the vendor's own answer |
| `openai-compatible` | models `gpt-5.2-codex*` | `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini` — from `$CODEX_HOME/models_cache.json` |
| `antigravity-cli` | no auto-ish mode at all | **`--mode accept-edits\|plan` exists** — exactly what plan §9.1 predicted, and now the default |
| `antigravity-cli` | `--input-format` standalone | **requires `--output-format stream-json`**; one without the other is an argument error |
| `antigravity-cli` | conversations under `~/.gemini/antigravity/` | **`~/.gemini/antigravity-cli/conversations/<uuid>.db`** — and ⛔ **SQLite, not JSONL** |
| `antigravity-cli` | models `gemini-3-pro`, `gemini-3-flash` | `agy models` is free and lists the real set — including **Claude and GPT-OSS models** |
| *(shared)* | `cmd /d /s /c <shim>` | ⛔ **`/s` breaks any path containing a space** — and `C:\Users\First Last` is the Windows default |
| *(shared)* | one `stream-json` format | ⛔ **three dialects.** agy keys on `event`, not `type` — the shared parser read *nothing* from it, silently. Decoding now belongs to the adapter |
| `antigravity-cli` | `agy -p /usage` might be a free quota probe | ⛔ **it is not.** Measured: taken as a *prompt*, spent 14,603 input + 264 output tokens, and began listing directories trying to work out what "/usage" meant |
| `antigravity-cli` | unmeterable (SQLite conversations) | **meterable after all** — usage is in the stream. `metering: 'stream'` |

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
- **`classifierBackedAuto: false`** → agentyard writes a narrower allowlist into the worker's own
  configuration before each spawn, and expects a higher refusal rate.
- **`mintsSessionId: false`** → the transcript is discovered after the fact instead of predicted,
  and ⛔ **orphaned processes are never killed**, because identity cannot be proved. Leaving an orphan
  running costs quota; killing the wrong process costs somebody their work.
- **`metering`** → `transcript` is exact and survives a restart; `stream` bills from the wire and
  loses whatever a restarted daemon was not attached for; `none` would mean runs cost an **unknown**
  amount rather than zero. Doctor states which, and what it costs.
- **`maxAccounts: 1`** → commissioning refuses the second account, with a message that says why and
  what to do instead.

---

## Why there is still no free quota probe for Antigravity

Three routes were evaluated. ⛔ All three were rejected, and the reasoning is worth keeping because
this question will be asked again.

1. **`agy -p /usage`** — measured 2026-08-25 and it **does not work**. The slash command is taken as a
   prompt: the run spent 14,603 input and 264 output tokens and started listing directories trying to
   work out what "/usage" meant. `--disable-slash-commands` implies print mode expands them; it does
   not. The same trap Claude Code set, sprung a second time — which is why the adapter now says so in
   a comment rather than leaving the lead open.
2. **The local Antigravity Language Server** — what the community usage tools read. ⛔ It exists only
   while the **IDE is running**. Verified on this machine with the IDE closed: no such process is
   listening and no port file exists. agentyard's premise is unattended progress across hours-long
   windows with no GUI open, so a probe that needs a window open is not a probe for this product.
3. **A community package** (`antigravity-usage`, `antigravity-panel`, `opencode-antigravity-quota`).
   ⛔ Rejected on D7 — external services are wrapped, never vendored — and because an undocumented
   internal RPC surface behind a third-party wrapper is *two* things that can go stale rather than one.

**What agentyard does instead needs no probe.** The stream carries per-turn usage, so spend is accrued
from turns agentyard metered itself. ⚠️ That is a **floor**, not a percentage: it cannot see what the
vendor counted that never reached a stream. `reserve.ts` already treats accrued spend as a floor, and
runs on these adapters are marked `quotaUnverified`.

## Still unmeasured, and why

Everything below needs a **signed-in account and a real turn**, which is where free measurement stops.

| # | Question | Adapter |
|---|---|---|
| **R10** | Does the codex rollout JSONL carry per-turn usage in a shape `transcript.ts` can read? Metering works from the stream today, but a stream is lost if the daemon restarts mid-run and a file is not | `openai-compatible` |
| **R12** | Is headless compaction reachable on codex at all? Its session lifecycle has compaction, but no documented way to drive it from `exec`. If it is, `manualCompact` flips true and two cache-clock moves become available | `openai-compatible` |
| **R13** | Is agy's `result.usage` the *turn's* total or the *conversation's*? Measured on a single-turn run, where the two are identical. If it is cumulative, multi-turn sessions are over-billed | `antigravity-cli` |

**Answered by measurement on 2026-08-25:** R9 (no — `agy -p /usage` spends a turn and does not
answer) and R11 (three dialects, all three now decoded and regression-tested against verbatim records).

## Installing

- **`claude`** — `npm install -g @anthropic-ai/claude-code`
- **`codex`** — `npm install -g @openai/codex`, then `codex login`
- **`agy`** — `irm https://antigravity.google/cli/install.ps1 | iex` (Windows) or
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`. ⚠️ The installer drops
  `agy.exe` in `%LOCALAPPDATA%\agy\bin` and only adds it to PATH when you run `agy install`.
  agentyard looks there anyway, and Doctor tells you the difference.

Antigravity requires a Google AI Pro or Ultra subscription — the free tier ended on 2026-06-18, when
Gemini CLI stopped serving individual accounts. Codex is included with ChatGPT Plus/Pro/Business.
