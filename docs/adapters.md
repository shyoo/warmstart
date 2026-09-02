# Adapters — what each CLI can do, and how we know

**Maintained.** This is the durable record of what was measured, when, and against which version. If
it disagrees with the code, one of them is wrong and it is worth finding out which.

Every claim carries its provenance, because a capability table is easy to write from documentation
and expensive to be wrong about. M5 wrote two adapters from vendor docs and then installed both
CLIs — and **several documented claims turned out to be wrong in ways that would have failed on the
first spawn.** That is the whole reason `AdapterInfo.verification` exists.

---

## The fleet, at a glance

| | `claude-code` | `antigravity-cli` | `openai-compatible` | `local-llm` |
|---|---|---|---|---|
| Command | `claude` | `agy` | `codex` | `local-llm-bridge` (node) |
| Measured against | 2.1.223 | 1.1.20 | 0.151.0 | llama.cpp / Qwen3-Coder |
| **Accounts per machine** | **unlimited** (`CLAUDE_CONFIG_DIR`) | ⛔ **1** (OS keyring) | **unlimited** (`CODEX_HOME`) | **unlimited** (by endpoint URL) |
| Credential lives in | a directory | ⛔ the OS keyring | a directory | ⛔ none (local HTTP) |
| Metered from | ⛔ transcript, **by choice** (exact, survives a restart; its stream carries usage too) | **its live stream** | **its live stream** | **its live stream** |
| Can compact | ✔ | ⛔ | ⛔ *(conservative)* | ⛔ |
| Classifier reviews actions | ✔ `auto` | ⛔ | ⛔ | ⛔ |
| Approvals | `permission_prompt_tool` | settings rules | settings rules | ⛔ none |
| Raises its own questions | ✔ **`AskUserQuestion`, and it reaches our hook** — see below | not measured | not measured | ✔ via `ask_human` tool |
| Says why a turn stopped | ✔ **`post_turn_summary`** carries `status_category` + `needs_action` | ⛔ none seen | ⛔ none seen | ⛔ none seen |
| Multi Agent Controller MCP tools | ✔ | ⛔ global registration only | ⛔ global registration only | ⛔ function calling in bridge |
| Prompt arrives on stdin as | a conversation, pipe stays open | a conversation, pipe stays open | ⛔ **one prompt, then EOF** — `codex exec` is one-shot | a conversation, pipe stays open |
| Accepts our session id | ✔ | ⛔ | ⛔ | ⛔ |
| Free quota probe | ✔ the `.claude.json` cache; `/usage` refreshes it | ⛔ **measured — see below** | ✔ **`account/rateLimits/read`**, rollout as fallback | ⛔ none (unlimited) |
| Reports cache reads | via transcript | ⛔ no | ✔ reads **and** writes | ⛔ server-side |

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
| `claude-code` | one rate-limit window per account | ⛔ **Two, and they disagree.** `rate_limit_event` carries `rateLimitType`, and `five_hour` and `seven_day` records arrive on the same stream minutes apart - `allowed` on one while the other warns. A reader keyed on "the newest sample" silently mixes them (measured 2026-08-31, 2.1.251; `docs/cost-model.md` §5) |
| `openai-compatible` | no usage *command* exists (openai/codex#10233), therefore `quotaProbe: 'none'` | ⛔ **A missing command is not a missing reading.** `codex app-server` answers **`account/rateLimits/read`** over JSON-RPC in ~700ms — no params, no turn, and *live* rather than cached (`resetsAt` moved 1311s between two calls). Every rollout records `rate_limits` besides, so a reading was on disk the whole time. Measured 2026-08-29, 0.151.0 |
| `openai-compatible` | Codex needs a paid ChatGPT plan to report quota | ⛔ **Free reports it too** — `planType: "free"`, one **30-day** window, `secondary: null`. A paid plan puts a five-hour window in `primary` instead, so a window's id must come from its *length*, never its slot |
| `openai-compatible` | models `gpt-5.2-codex*` | `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini` — from `$CODEX_HOME/models_cache.json` |
| `antigravity-cli` | no auto-ish mode at all | **`--mode accept-edits\|plan` exists** — exactly what plan §9.1 predicted, and now the default |
| `antigravity-cli` | `--input-format` standalone | **requires `--output-format stream-json`**; one without the other is an argument error |
| `claude-code` | a resumed conversation might wander the way Agy's did | ⛔ **It cannot, and the reason is structural.** Claude Code partitions conversations **by working directory** — `<isolationRoot>/projects/<encoded-cwd>/` — and stamps `cwd` and `gitBranch` on every transcript entry. A conversation is not reachable from another directory, so `--resume` from the wrong tree finds nothing rather than arriving pointed elsewhere. Measured 2026-08-28: the shared conversation `f9a6bac3`, which served five tasks across four branches, records `…_workspaces\ws1` on every entry and the trunk on none; no `work` session of any adapter has ever run in the trunk. ⚠️ Its failure is the mirror image — **it starts cold while reporting success** — which is what `resumableSession`'s cwd check exists to prevent |
| `claude-code` | `--add-dir` would bind it to a worktree the way it does for Agy | ⛔ **Opposite meaning.** `claude --help`: *"Additional directories to allow tool access to."* For Claude it **widens** access; for Agy it names the workspace. Do not copy the fix across |
| `antigravity-cli` | conversations under `~/.gemini/antigravity/` | **`~/.gemini/antigravity-cli/conversations/<uuid>.db`** — and ⛔ **SQLite, not JSONL** |
| `antigravity-cli` | models `gemini-3-pro`, `gemini-3-flash` | `agy models` lists the real set — including **Claude and GPT-OSS models** — and spends no turn. ⛔ But **only on a terminal**: with stdout on a pipe it prints nothing and **hangs** (killed at 30s via `execFile`, and at 2m via `agy models | cat`, 2026-08-26). It is not usable as a probe |
| *(shared)* | `cmd /d /s /c <shim>` | ⛔ **`/s` breaks any path containing a space** — and `C:\Users\First Last` is the Windows default |
| *(shared)* | one `stream-json` format | ⛔ **three dialects.** agy keys on `event`, not `type` — the shared parser read *nothing* from it, silently. Decoding now belongs to the adapter |
| *(shared)* | one `stream-json` format, and an *input* half that could be defaulted | ⛔ **Three dialects on the way in as well, and codex has none.** `codex exec` reads its prompt from **stdin to EOF** — `exec --help`: *"If not provided as an argument (or if `-` is used), instructions are read from stdin"* — so there is no envelope, and `sendPrompt`'s Claude-shaped default made the prompt begin with the literal text `{"type":"user"`. The worse half is EOF: with the pipe held open, codex prints `Reading prompt from stdin...` and blocks. Measured 2026-08-29 on 0.151.0 — a reproduction sat 18s for 34 bytes; in production t52 sat **50 minutes on 62ms of CPU**, reporting as `running`. Adapters now declare `streamPrompts: 'conversation' \| 'once'` |
| `openai-compatible` | `mcp: true`, because codex has MCP | ⛔ **The capability is about this adapter, not the CLI.** `codex mcp add` registers into the shared config, so a session cannot carry the per-session identity `task_complete` needs — `plan()` warned about that while the field said otherwise. The prompt builder reads it, so every codex prompt ended by naming a tool that was never registered, and the run could only end in `awaiting_human` |
| `openai-compatible` | `turn.completed` is the usage record | **It is the usage record *and* the terminal one.** `codex exec` runs one turn and exits, so decoding it as usage alone left a successful run with no terminal event at all: nothing completed the task, and the process exit read as *"ended without reporting completion"* |
| `claude-code` | a turn that ends is a turn that finished | ⛔ **The terminal record cannot tell the two apart.** Measured 2026-08-30 on **2.1.251** (R14.c): an agent that asked a question and stopped emits `{"type":"system","subtype":"post_turn_summary","status_category":"blocked","needs_action":"…"}` — and then a `result` reading `stop_reason: end_turn`, `terminal_reason: completed`, `is_error: false`, i.e. byte-for-byte the shape of success. The reason was on the wire the whole time and was decoded as `other`. Now `StreamEvent.turn_status`, and a run that ends this way is `blocked` rather than `failed` |
| `claude-code` | `AskUserQuestion` is interactive-only, so headless work never sees it | ⛔ **It is in the headless tool list and it routes to `--permission-prompt-tool`,** carrying the whole question: `questions[]`, each with `question`, `header`, `options[{label, description}]` and `multiSelect`. Measured 2026-08-30 on 2.1.251. Until then our hook flattened all of it to Allow/Always/Deny — the operator was shown a yes/no where the agent had asked a three-way design question |
| `claude-code` | the permission hook could answer such a question by allowing it | ⛔ **Allow is not an answer.** Returning `{behavior:'allow', updatedInput}` yields the tool result **`The user did not answer the questions.`** — the hook gates *asking*, not *answering*. ⭐ `{behavior:'deny', message}` **does** reach the model as the tool result and is acted on (*"Got it — server-side session cookies it is."*), so that is the answer channel. ⚠️ It arrives with `is_error: true` and lands in the result's `permission_denials`; nothing reads that field today |
| `claude-code` | usage is not in the stream — it comes from the transcript | ⚠️ **It is in the stream on 2.1.251**, correcting the 2026-08-25 reading on 2.1.223: both captures of 2026-08-30 carry a full `usage` block with `iterations` on the `result` record (`cache_read_input_tokens` 45,446 and 80,541), and on `assistant` records too. ⛔ **We still meter from the transcript, deliberately** — it is exact and sees the compaction sampling iteration (`cost-model.md` §6), and decoding both would double-count every turn, because the daemon credits each final `usage` event it is handed. The row records what the CLI emits; the choice of instrument is separate and unchanged |
| *(shared)* | an isolation root is enough to isolate a worker | ⛔ **Not while the environment is copied whole.** Measured 2026-08-30: a Claude Code session's environment carries ~20 `CLAUDE*` variables including `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_BRIDGE_SESSION_ID`, and all three adapters built their env by copying `process.env` and deleting three or four API keys. A daemon started from inside such a session would hand every worker the operator's session handle and messaging socket - and an inherited `CLAUDE_CONFIG_DIR` would point it at the operator's credentials. `spawnEnv()` now denies the namespace by prefix |
| `claude-code` | the quota probe is free because it spends no tokens | ⚠️ **Free of tokens, not of sessions.** Each `/usage` refresh opens a real interactive PTY that registers a session with the vendor's bridge, and those accumulate in the desktop app until archived by hand. Measured 2026-08-30: **150 probe sessions against 14 that did any work** in four days. Since 2026-08-31 there is no clock at all: `ensureFreshQuota()` refreshes at the dispatch gate and when a run ends, and the on-disk cache is refreshed for free by any use of the account — so an idle worker simply keeps its last reading, and the UI shows its age |
| *(shared)* | an adapter with no MCP can be given the `NEEDS DECISION:` contract and that is the whole of it | ⛔ **The contract carried the question and lost the interface.** The line was matched, quoted into `hold_reason` and discarded; the card, the options and the box an answer is typed into are all rendered from a `Question` row, and none was written — so antigravity and codex could ask questions that were structurally unanswerable. Measured on t63, 2026-08-30: three named designs offered, `awaiting_human`, no reply channel. The line now files a real question, **already parked** (the turn is over, so there is no waiter), and the prompt asks for one `- option — detail` bullet per choice beneath it. ⚠️ Options are read only from those bullets — t63 wrote its three inline as *"(Option A) … (Option B)"*, and nothing here will guess choices back out of a sentence |
| `antigravity-cli` | `agy -p /usage` might be a free quota probe | ⛔ **it is not.** Measured: taken as a *prompt*, spent 14,603 input + 264 output tokens, and began listing directories trying to work out what "/usage" meant |
| all three | `multimodalInput: true` means an image can be sent | ⛔ **It meant nothing at all** — declared on all three built-ins, read by five grep hits of which three were the declarations, and on `antigravity-cli` measurably **wrong**: the same base64 block Claude Code answers correctly returns `"status":"ERROR","num_turns":0,"error":"stream input content block type \"image\" is not supported (only \"text\")"`. It does not drop the image, it kills the turn. Replaced 2026-09-01 by `imageInput: 'inline' \| 'spawn-flag' \| 'none'`, which says how the bytes are *delivered*. ⚠️ All three read a PNG off disk with their own view tool (agy via `view_file`, measured), which is why the absolute path travels in the prompt text on every adapter |
| `antigravity-cli` | unmeterable (SQLite conversations) | **meterable after all** — usage is in the stream. `metering: 'stream'` |
| `claude-code` | the folder-trust dialog only affects fresh worktrees | ⛔ **It affects any folder, per account, and it swallows every keystroke until answered.** Measured 2026-08-27: the usage probe was spawning in the user's home - untrusted in the worker's config - so `/usage` was typed into the dialog and Enter accepted the folder. Projectless sessions now run in `<dataDir>/scratch` and `trustDirectory()` pre-answers it for that directory only |
| `claude-code` | signing in leaves an isolation root ready to use | ⚠️ **Only for print mode.** `claude auth login` writes `oauthAccount` and `userID` but not `hasCompletedOnboarding`, so an *interactive* session in that root opens the theme picker and then the login-method chooser. Scheduled work runs on `-p` and never sees it, which is why this hid until something needed a TUI (2026-08-27) |
| `claude-code` | a session that cannot work exits, so `onExit` is enough to catch it | ⛔ **It announces the failure and then stays.** Measured 2026-08-27 on an account whose organisation had disabled Claude Code: the stream carried `{"type":"result","is_error":true,"terminal_reason":"api_error"}` with *"Your organization has disabled Claude subscription access for Claude Code"*, and the process sat on stdin. The run stayed open, the task stayed `running`, and the worker's only slot stayed held. **The terminal `result` record is the signal; the exit is not** |
| `claude-code` | `auth status --json` says whether an account can work | ⚠️ **It says who is signed in, which is a different question.** A lapsed or org-disabled subscription answers exactly as a live one does — `loggedIn: true`, an email, an org — so nothing free separates them and only a run can. `subscriptionType` is now recorded and shown, and ⛔ gated on nowhere: what an expired plan puts there has not been measured here |
| `antigravity-cli` | an adapter that cannot answer identity questions looks the same as a healthy one | ⚠️ **It does, and that is the problem.** Antigravity's credential is in the OS keyring, so `loggedIn` and `setupComplete` are permanently `null` — the honest answer, and indistinguishable from an account in perfect health. Measured 2026-08-27: a never-signed-in Antigravity worker won a dispatch over two working Claude workers and failed in 0s. What separates them is whether a turn has **ever** come out of the account, which is in `turns` and now scores |
| `antigravity-cli` | `agy login` signs an account in | ⛔ **there is no `login` and no `auth` subcommand.** Measured on agy 1.1.20: `agy --help` lists agent, agents, changelog, help, install, mcp, mic-serve, models, plugin, plugins, update. Commissioning failed with *unexpected argument "login"*. Sign in with the Antigravity app; the credential goes to the OS keyring |
| `antigravity-cli` | `--mode accept-edits` suffices for headless work | ⛔ **it auto-denies commands.** In headless stream mode (`--input-format stream-json`), `accept-edits` only approves edits; any command (`git`, test runner, etc.) cannot prompt interactively and is auto-denied by `jetski`, causing immediate `CANCELED` turns. Headless worktree dispatches pass `--dangerously-skip-permissions` (Option A), quarantined inside isolated pooled worktrees and gated by mandate and landing checks |
| `openai-compatible` | interactive sessions in fresh `$CODEX_HOME` start immediately | ⛔ **They block on two interactive modal prompts.** Fresh roots prompt for directory trust (*"Do you trust the contents of this directory?"*) and Windows sandbox setup (*"Set up the Codex agent sandbox"*), swallowing keystrokes. `trustDirectory()` pre-writes `$CODEX_HOME/config.toml` with `[windows] sandbox = "elevated"` and `[projects.'<dir>'] trust_level = "trusted"` |
| `openai-compatible` | a suite that passes on the host passes inside the worker | ⛔ **The sandbox denies privileged host queries, and a denied query fails as a red test.** `codex exec` runs under `--sandbox workspace-write`; measured on t56, 2026-08-30, `Get-CimInstance Win32_Process` came back access-denied, so `stall.test.ts`'s live sampling assertion failed inside the worker and passed unsandboxed on the same machine minutes later. The agent could not tell that from a regression it had caused and stopped to ask. Two fixes: the test now asserts the *denied* contract (`sampleProcessTree` returns null, never an empty sample) when enumeration is unavailable, and the prompt tells a one-shot worker that `runChecks` runs the project's `check` list **in the daemon, outside the sandbox** |
| `openai-compatible` | an agent that can edit its workspace can commit in it | ⛔ **Not in a worktree, which is every workspace this tool hands out.** `<worktree>/.git` is a *file* pointing at `<trunk>/.git/worktrees/<slot>`; a commit writes the index there and the objects and branch ref into the common `<trunk>/.git`, all outside the directory `--sandbox workspace-write` makes writable. Measured on t56, 2026-08-30 — three runs, ~1.8M tokens, 30-day quota 0%→34% — every one refused at `.git/worktrees/ws1/index.lock`: *"sync/rebase and staging both failed"*. `plan()` now passes `--add-dir` for each path `gitWritableRoots` finds. ⚠️ That grant is the whole common `.git`, so a worker can reach other tasks' refs; there is no narrower one, because two of the three paths are shared by construction. A real clone per worker would be the isolated fix and is an architecture change, not a flag |
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
- **`selectableEffort`** → where false, the UI draws **no effort control at all** for that account,
  rather than a disabled one. ⛔ The scheduler drops `constraints.effort` for any adapter that says
  false, so an adapter reading `SpawnRequest.effort` can trust it said it could act on one.
  **Re-measured 2026-08-29, and it moved:**
  - **`claude-code`: true.** claude 2.1.250 takes `--effort low|medium|high|xhigh|max` — the same
    five its cost model lists for `claude-opus-5` and `claude-sonnet-5`, and none for
    `claude-haiku-4-5`, which takes no effort at all. ⭐ Promoted on a run, not on `--help`: a
    headless call with `--effort low` came back with `effort: "low"` on its transcript's assistant
    record, the field `transcript.ts` already parses. Set *and* observable.
  - **`antigravity-cli`: false — and now because the CLI refuses, not because we argued it should.**
    agy 1.1.22 has the flag and rejects every combination this fleet dispatches:
    `--model gemini-3.1-pro-high --effort low` → *"conflicts with --effort=low"*;
    `--model claude-sonnet-4-6 --effort low` → *"--effort is not supported for model"*;
    `--model gpt-oss-120b-medium --effort low` → conflicts. Only a **bare family** takes it:
    `--model gemini-3.1-pro --effort low` runs. So the vendor has two spellings for one choice, and
    `agy models` reports the pre-combined one, which is what this cost model prices. ⛔ Declaring
    true would offer a second control for a choice already made, and anyone touching both would get
    a hard dispatch failure rather than a politely ignored flag.
  - **`openai-compatible`: false, still unrun.** `model_reasoning_effort` is a documented `-c`
    override and that adapter's verification says `measured`, so documentation alone is not enough.
- **`needsReauth(reason)`** → the *presentation* of a held-out account: `re-sign-in required` and a
  Sign in button, rather than a reason to go and read. ⛔ Optional, and the adapter answers because
  the sentence is its CLI's — an expired subscription, a revoked key and a crash all arrive as the
  same `api_error` and differ only in the words after it. ⚠️ It changes nothing about gating: a
  suspect worker is held out either way, and an adapter that does not implement it says `false`,
  which is the safe answer. Never keyed on `api_error` alone — that code also covers an outage, and
  sending somebody to re-authenticate through one is how a working account gets signed out.

### Antigravity Tool Permissions & Future Improvement Options

- **Option A (Current / Shipped):** Antigravity CLI runs with `--dangerously-skip-permissions` for scheduled stream-json work.

  ⛔ **The safety argument this was shipped on has been measured false.** It read: *"work runs
  strictly in isolated pooled worktrees (never trunk) and is validated by mandate constraints and
  automated landing check commands before anything merges."* The first clause is the load-bearing
  one, and on 2026-08-28 it did not hold. t17 was spawned with `cwd` = `…_workspaces\ws1` on its own
  branch; its conversation store records **45 distinct absolute paths under `C:\Dev\multi_agent_controller`
  and zero under any workspace**. It edited and committed in the **trunk**, three times, with
  permissions disabled. The branch never moved, so landing correctly logged `nothing-to-land` and
  none of the "validated before anything merges" machinery ever ran — there was nothing on the branch
  to validate. The commits were simply on `main`.

  ⚠️ **Why: this adapter has no isolation root in practice.** `envFor()` copies `process.env` and
  deletes three API-key variables; it sets no `HOME`, no Gemini directory, nothing. `trustDirectory`
  and `writePermissions` take `_isolationRoot` and ignore it. Measured the same day,
  `<dataDir>/workers/antigravity/` is **empty**, while `~/.gemini/antigravity/brain/<id>/` holds a
  persistent cross-session memory naming `C:/Dev/multi_agent_controller` **349 times** against 5
  mentions of the workspaces root — written on 2026-08-27, before the run, from earlier work done in
  the trunk. The agent did not navigate out of its worktree; it was never anchored to it, because its
  memory outlives the session and is keyed to the operator's home rather than to the worker.

  ⭐ **Fixed by binding the workspace explicitly: `--add-dir <cwd>`, on every spawn including a
  resume.** The process cwd is a starting position; `--add-dir` is what tells this CLI what its
  workspace *is*. The resume is the case that needed it — a fresh launch has no prior opinion, while
  a conversation reopened with `--conversation` arrives pointed at wherever it was born.

  **Measured on agy 1.1.22, 2026-08-28**, same repository, same pooled worktree, one cold run and one
  resumed run in the same conversation:

  | | t17, before | t18, after |
  |---|---|---|
  | distinct trunk paths in the conversation store | **45** | **0** |
  | distinct workspace paths | **0** | **5**, first at step 2 |
  | trunk reflog entries added | **3 commits** | **0** |
  | landed through the branch and its gates | no — `nothing-to-land` ×3 | yes — both runs |

  The resumed run reported its own toplevel as the worktree and committed there, which is the
  behaviour the flag exists to produce.

  ⚠️ **This narrows, it does not contain.** `--add-dir` is a request to a CLI; nothing stops an agent
  that decides to write elsewhere, and this adapter still has no real isolation root (below). The
  check that does not depend on the CLI cooperating is a trunk tripwire, which is not built.

  ⛔ So `--dangerously-skip-permissions` on this adapter is **bounded by the CLI's cooperation, not
  by the filesystem**. Treat it accordingly until an isolation root is enforced.
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
| **R13** | Is agy's `result.usage` the *turn's* total or the *conversation's*? Measured on a single-turn run, where the two are identical. If it is cumulative, multi-turn sessions are over-billed | `antigravity-cli` |

**Answered by measurement on 2026-08-27:** the print flag (above), and with it the first
confirmation that a corrected argv reaches a signed-in Antigravity account: the CLI returns a
valid `init` record listing 50-odd tools, with no turn spent. ⚠️ Everything past `init` on this
adapter is still unmeasured, because it needs a real turn — R11 and R13 below.

✅ **R12 closed 2026-08-30, negatively** (`docs/cost-model.md` §5): headless compaction is unreachable on `codex exec` — not because of compaction, but because a `streamPrompts: 'once'` CLI has no second input to drive it with.

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
Gemini CLI stopped serving individual accounts. ⚠️ **Codex is included on ChatGPT Free as well** —
measured 2026-08-29 on a free account, which reports a 30-day quota window like any other.
