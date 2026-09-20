# Adapters — what each CLI can do, and how we know

**Maintained.** This is the durable record of what was measured, when, and against which version. If
it disagrees with the code, one of them is wrong and it is worth finding out which.

Every claim carries its provenance, because a capability table is easy to write from documentation
and expensive to be wrong about. M5 wrote two adapters from vendor docs and then installed both
CLIs — and **several documented claims turned out to be wrong in ways that would have failed on the
first spawn.** That is the whole reason `AdapterInfo.verification` exists.

> **Audience:** anyone writing or changing an adapter, or trusting one's capability block.
> **Authority for:** per-CLI capabilities as measured against a running binary, the flags each
> takes, and what is still unverified.
> The capability *type* is `AdapterCapabilities` in `src/shared/protocol.ts`; how a capability is
> consumed is [`routing.md`](routing.md) and [`architecture.md`](architecture.md) §4.

---

## The fleet, at a glance

| | `claude-code` | `antigravity-cli` | `openai-compatible` | `local-llm` | `muse-code` |
|---|---|---|---|---|---|
| Command | `claude` | `agy` | `codex` | `local-llm-bridge` (node) | `muse` — native everywhere; on Windows the installer's `muse-bin-<version>.exe`, never the `muse.cmd` shim (`museBinary`) |
| Measured against | 2.1.223 | 1.1.20 | 0.151.0 | llama.cpp / Qwen3-Coder | 1.0.3 (Linux), 1.3.0 (Windows, 2026-09-19) |
| **Accounts per machine** | **unlimited** (`CLAUDE_CONFIG_DIR`) | ⛔ **1** (OS keyring) | **unlimited** (`CODEX_HOME`) | **unlimited** (by endpoint URL) | **unlimited** (`XDG_CONFIG_HOME`/`XDG_DATA_HOME`) |
| Credential lives in | a directory | ⛔ the OS keyring | a directory | ⛔ none (local HTTP) | a directory (`config/muse/auth.json`) |
| Metered from | ⛔ transcript, **by choice** (exact, survives a restart; its stream carries usage too) | **its live stream** | **its live stream** | **its live stream** | ⛔ **its session log** — its stream carries no usage at all |
| Can compact | ✔ | ⛔ | ⛔ *(conservative)* | ⛔ | ⛔ *(automatic thresholds only; no slash command)* |
| **Unattended authority** (`policy.headlessAuthority`) | ⛔ **full-user** (`bypassPermissions`) | ⛔ **full-user** (`--dangerously-skip-permissions`) | ⚠️ **sandboxed** (`--sandbox workspace-write`, widened by `grants.ts` to the shared `.git` and to a granted repository’s own) | ⛔ **full-user** *(unverified; conservative)* | ⛔ **full-user** (`--approval-mode never`) |
| Classifier reviews actions | ⚠️ `auto`, **interactive only** — unattended work runs `bypassPermissions` | ⛔ | ⛔ | ⛔ | ⚠️ `--approval-judge` — interactive only; unattended runs `--approval-mode never` |
| Approvals | `permission_prompt_tool` | settings rules | settings rules | ⛔ none | ⛔ flags on the process, before it starts |
| Raises its own questions | ✔ **`AskUserQuestion` / `ask_human` (single & multi-checkboxes)** | ✔ **`NEEDS DECISION: [multi]` contract** | ✔ **`NEEDS DECISION: [multi]` contract** | ✔ via `ask_human` tool | ✔ **`NEEDS DECISION: [multi]` contract** |
| Says why a turn stopped | ✔ **`post_turn_summary`** carries `status_category` + `needs_action` | ⛔ none seen | ⛔ none seen | ⛔ none seen | ⚠️ `run.terminal.<verdict>` names the verdict, not the reason |
| Warmstart MCP tools | ✔ | ⛔ global registration only | ⛔ global registration only | ⛔ function calling in bridge | ⛔ `mcpServers` is per-**root** config, not per session |
| Prompt arrives on stdin as | a conversation, pipe stays open | a conversation, pipe stays open | ⛔ **one prompt, then EOF** — `codex exec` is one-shot | a conversation, pipe stays open | ⛔ **it does not** — `exec` answers `missing prompt`; a drain in front of it writes a `--prompt-file` (`cat` on POSIX, the daemon's own Node on Windows) |
| Accepts our session id | ✔ | ⛔ | ⛔ | ⛔ | ✔ `--session-id` |
| Resumes a past conversation | ✔ `--resume <id>` | ✔ `--conversation <id>` | ✔ **`exec resume <thread_id>`** — measured 2026-09-02 | ⛔ fresh conversation per dispatch | ✔ **the same `--session-id`** — measured 2026-09-06; ⚠️ plus `--allow-workspace-switch`, or it refuses a new directory and exits 1 |
| Prompt cache TTL | **60m** (`1h`, 2.0× write) | ⛔ unpriced (storage per token-hour) | **30m** (1.25× write) | ⛔ none | ⛔ unpublished (reads and writes are *reported*, not priced) |
| Free quota probe | ✔ **live, on every turn** — `rate_limit_event.unifiedWindows` (2.1.270); the `.claude.json` cache behind it, `/usage` refreshes that | ⛔ **measured — see below** | ✔ **`account/rateLimits/read`**, rollout as fallback | ⛔ none (unlimited) | ⚠️ **screen only** — `/usage `; the provider can answer `Currently unavailable` with no windows |
| Free **money** meter (`spendProbe`) | `config-cache` — `.claude.json`’s usage-credit counter, only while the vendor says credits are enabled | ⛔ `none` — cloud credits are real and nothing read reports a balance | `config-cache` — `credits.balance`, in the rollout the quota already comes from | ⛔ `none` — it runs on the operator's own machine | ⛔ `none` — no local file names a figure |
| Reports cache reads | via transcript | ⛔ no | ✔ reads **and** writes | ⛔ server-side | ✔ reads **and** writes, in the session log |
| Read-only mode (may review) | ✔ `plan` | ✔ `plan` | ✔ `read-only` | ✔ `read-only` | ✔ `read-only` (`never` + `--disable-write` + `--disable-shell`) |

⛔ **`spendProbe` says *where the money comes from*, not whether there is any.** It is the capability
the poller reads instead of recognising an adapter by name, and `'stream'` and `'config-cache'` are
different enough to matter: a `config-cache` meter has to be fetched (`probeSpend`, a file read, on
the quota poller's own pacing), a `stream` meter **arrives unasked** on a record already being
decoded, and an adapter declaring `'stream'` is therefore never polled and must carry no
`probeSpend` at all. ⚠️ `'none'` is *this adapter reports no money*, which is not *this account
spends none* — Antigravity's cloud credits are real and unread.

⛔ **`readOnlyPermissionMode` is a capability and `null` is a real answer.** A quality review runs in
the operator's own project root — the one directory in this app where an unwanted edit is not
recoverable by throwing a branch away — so an adapter that cannot declare a mode which reads and does
not write is never offered one, rather than being run in a mode that might. Measured 2026-09-03 from
each adapter's own declaration; `external.ts` defaults it to `null`, which is the safe direction.
`local-llm` declares `read-only` as local inference has no filesystem or shell write tools and runs
non-interactively via its bridge. Its review model is the server's unless a person sets one: a local
model is named `local-llm:<the id the server reports>` and is learned from `/v1/models` at every
identity probe, never from a file — [`cost-model.md`](cost-model.md) §8a says why the pinned name
this replaced was wrong on every grade a second server answered.

⚠️ **A local endpoint's pace is a property of somebody's GPU, and no timeout may assume otherwise.**
Measured 2026-09-04 on a 27B model at ~3.5 tok/s: an 8.3k-token review prompt is minutes of reading
before the first token of the answer exists, and answers arrive over tens of minutes. Nothing here
waits on a wall clock for that reason — the review deadline watches for *silence* (`reviewStall`,
`src/daemon/reviewer.ts`), which is the same question at any speed.

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
| `openai-compatible` | models `gpt-5.2-codex*` | ChatGPT Codex: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` — refreshed from [OpenAI's Codex models documentation](https://learn.chatgpt.com/ja-JP/docs/models?surface=app) 2026-09-09. `gpt-5.4` and `gpt-5.4-mini` retired for ChatGPT sign-in on 2026-08-31; API-key Codex is unaffected. Sol accepts `low` through `ultra`; `gpt-reserve` and `codex-auto-review` are hidden, so neither is offered |
| `antigravity-cli` | no auto-ish mode at all | **`--mode accept-edits\|plan` exists** — exactly what plan §9.1 predicted, and now the default |
| `antigravity-cli` | `--input-format` standalone | **requires `--output-format stream-json`**; one without the other is an argument error |
| `claude-code` | a resumed conversation might wander the way Agy's did | ⛔ **It cannot, and the reason is structural.** Claude Code partitions conversations **by working directory** — `<isolationRoot>/projects/<encoded-cwd>/` — and stamps `cwd` and `gitBranch` on every transcript entry. A conversation is not reachable from another directory, so `--resume` from the wrong tree finds nothing rather than arriving pointed elsewhere. Measured 2026-08-28: the shared conversation `f9a6bac3`, which served five tasks across four branches, records `…_workspaces\ws1` on every entry and the trunk on none; no `work` session of any adapter has ever run in the trunk. ⚠️ Its failure is the mirror image — **it starts cold while reporting success** — which is what `resumableSession`'s cwd check exists to prevent |
| `claude-code` | `--add-dir` would bind it to a worktree the way it does for Agy | ⛔ **Opposite meaning.** `claude --help`: *"Additional directories to allow tool access to."* For Claude it **widens** access; for Agy it names the workspace. Do not copy the fix across |
| `antigravity-cli` | conversations under `~/.gemini/antigravity/` | **`~/.gemini/antigravity-cli/conversations/<uuid>.db`** — and ⛔ **SQLite, not JSONL** |
| `antigravity-cli` | models `gemini-3-pro`, `gemini-3-flash` | `agy models` lists the real set — including **Claude and GPT-OSS models** — and spends no turn. ⛔ But **only on a terminal**: with stdout on a pipe it prints nothing and **hangs** (killed at 30s via `execFile`, and at 2m via `agy models | cat`, 2026-08-26). It is not usable as a probe |
| *(shared)* | `cmd /d /s /c <shim>` | ⛔ **`/s` breaks any path containing a space** — and `C:\Users\First Last` is the Windows default |
| *(shared)* | one `stream-json` format | ⛔ **three dialects.** agy keys on `event`, not `type` — the shared parser read *nothing* from it, silently. Decoding now belongs to the adapter |
| *(shared)* | one `stream-json` format, and an *input* half that could be defaulted | ⛔ **Three dialects on the way in as well, and codex has none.** `codex exec` reads its prompt from **stdin to EOF** — `exec --help`: *"If not provided as an argument (or if `-` is used), instructions are read from stdin"* — so there is no envelope, and `sendPrompt`'s Claude-shaped default made the prompt begin with the literal text `{"type":"user"`. The worse half is EOF: with the pipe held open, codex prints `Reading prompt from stdin...` and blocks. Measured 2026-08-29 on 0.151.0 — a reproduction sat 18s for 34 bytes; in production t52 sat **50 minutes on 62ms of CPU**, reporting as `running`. Adapters now declare `streamPrompts: 'conversation' \| 'once'` |
| *(shared)* | one `assistant_text` event means one thing | ⛔ **It means two, and they are opposites.** `claude-code` emits one per whole assistant message (`{"type":"assistant"}`); `openai-compatible` one per finished `item.completed`. But `muse-code` emits `run.output.delta`, `antigravity-cli` `step_update.text_delta` and the local-LLM bridge a ~60-character rung — a handful of tokens, split mid-word. The peephole guessed, and guessed wrong in both directions: framing every event as a row read `landing / corners.test.ts / pass. The / tree / is clean` on muse (t272, 2026-09-07), and framing every event as a continuation glued Claude's separate messages together with no separator and dropped every linebreak inside them (`…what t269 recorded.Now let me make the edits.`, t284, 2026-09-07). Nothing in the bytes distinguishes them, so adapters now declare `outputFraming: 'message' \| 'delta'`, with `message` — the framing that cannot destroy text — as the default |
| `muse-code` | the peephole has no more than bare tool names while a run works | ⛔ **Muse emits no working prose:** `run.output.delta` is the final answer, so a live run must be read from lifecycle records. A proposal still shows a tool immediately; when its successful result carries a `command`, `file_path`, `path`, `file`, `query` or `pattern`, the tail adds that concise subject (never arbitrary tool output). This turns `bash / read_file / edit_file` into inspectable activity without pretending the CLI streamed reasoning |
| `muse-code` | `--image` works wherever the flag is accepted | ⛔ **It needs a filesystem that has permissions, and this fleet does not give it one.** `--image` does not hand muse a path — it *installs* the file into an asset store under `XDG_DATA_HOME` and refuses any whose mode is not `0700`. A Windows volume reaches WSL2 over 9p with no `metadata` option, so everything under `/mnt/c` reads `0777` and `chmod 0700` is a **silent no-op** (`stat` says `777` immediately after). Measured 2026-09-07 against the live account, both ways: data home on ext4 and the model answered a prompt carrying a real PNG; data home on `/mnt/c` and the run died with `failed to install accepted image asset: asset is corrupt: asset directory permissions must be 0700, got 0777` and **exit 1**, five seconds after dispatch and before the model was called — which reads as the agent having failed the task (t289). ⭐ **Gone with the WSL bridge (t547, 2026-09-19):** the native Windows build takes `--image` with its data home on NTFS — measured with a real PNG — so `plan()` passes every image again |
| `openai-compatible` | `mcp: true`, because codex has MCP | ⛔ **The capability is about this adapter, not the CLI.** `codex mcp add` registers into the shared config, so a session cannot carry the per-session identity `task_complete` needs — `plan()` warned about that while the field said otherwise. The prompt builder reads it, so every codex prompt ended by naming a tool that was never registered, and the run could only end in `awaiting_human` |
| `openai-compatible` | `turn.completed` is the usage record | **It is the usage record *and* the terminal one.** `codex exec` runs one turn and exits, so decoding it as usage alone left a successful run with no terminal event at all: nothing completed the task, and the process exit read as *"ended without reporting completion"* |
| `claude-code` | a turn that ends is a turn that finished | ⛔ **The terminal record cannot tell the two apart.** Measured 2026-08-30 on **2.1.251** (R14.c): an agent that asked a question and stopped emits `{"type":"system","subtype":"post_turn_summary","status_category":"blocked","needs_action":"…"}` — and then a `result` reading `stop_reason: end_turn`, `terminal_reason: completed`, `is_error: false`, i.e. byte-for-byte the shape of success. The reason was on the wire the whole time and was decoded as `other`. Now `StreamEvent.turn_status`, and a run that ends this way is `blocked` rather than `failed` |
| `claude-code` | `AskUserQuestion` is interactive-only, so headless work never sees it | ⛔ **It is in the headless tool list and it routes to `--permission-prompt-tool`,** carrying the whole question: `questions[]`, each with `question`, `header`, `options[{label, description}]` and `multiSelect`. Measured 2026-08-30 on 2.1.251. Until then our hook flattened all of it to Allow/Always/Deny — the operator was shown a yes/no where the agent had asked a three-way design question |
| `claude-code` | the permission hook could answer such a question by allowing it | ⛔ **Allow is not an answer.** Returning `{behavior:'allow', updatedInput}` yields the tool result **`The user did not answer the questions.`** — the hook gates *asking*, not *answering*. ⭐ `{behavior:'deny', message}` **does** reach the model as the tool result and is acted on (*"Got it — server-side session cookies it is."*), so that is the answer channel. ⚠️ It arrives with `is_error: true` and lands in the result's `permission_denials`; nothing reads that field today |
| `claude-code` | usage is not in the stream — it comes from the transcript | ⚠️ **It is in the stream on 2.1.251**, correcting the 2026-08-25 reading on 2.1.223: both captures of 2026-08-30 carry a full `usage` block with `iterations` on the `result` record (`cache_read_input_tokens` 45,446 and 80,541), and on `assistant` records too. ⛔ **We still meter from the transcript, deliberately** — it is exact and sees the compaction sampling iteration (`cost-model.md` §6), and decoding both would double-count every turn, because the daemon credits each final `usage` event it is handed. The row records what the CLI emits; the choice of instrument is separate and unchanged |
| *(shared)* | an isolation root is enough to isolate a worker | ⛔ **Not while the environment is copied whole.** Measured 2026-08-30: a Claude Code session's environment carries ~20 `CLAUDE*` variables including `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_BRIDGE_SESSION_ID`, and all three adapters built their env by copying `process.env` and deleting three or four API keys. A daemon started from inside such a session would hand every worker the operator's session handle and messaging socket - and an inherited `CLAUDE_CONFIG_DIR` would point it at the operator's credentials. `spawnEnv()` now denies the namespace by prefix |
| `claude-code` | the quota probe is free because it spends no tokens | ⚠️ **Free of tokens, not of sessions.** Each `/usage` refresh opens a real interactive PTY that registers a session with the vendor's bridge, and those accumulate in the desktop app until archived by hand. Measured 2026-08-30: **150 probe sessions against 14 that did any work** in four days. Since 2026-08-31 there is no clock at all: `ensureFreshQuota()` refreshes at the dispatch gate and when a run ends, and the on-disk cache is refreshed for free by any use of the account — so an idle worker simply keeps its last reading, and the UI shows its age |
| *(shared)* | an adapter with no MCP can be given the `NEEDS DECISION:` contract and that is the whole of it | ⛔ **The contract carried the question and lost the interface.** The line was matched, quoted into `hold_reason` and discarded; the card, the options and the box an answer is typed into are all rendered from a `Question` row, and none was written — so antigravity and codex could ask questions that were structurally unanswerable. Measured on t63, 2026-08-30: three named designs offered, `awaiting_human`, no reply channel. The line now files a real question, **already parked** (the turn is over, so there is no waiter), and the prompt asks for one `- option — detail` bullet per choice beneath it. If multiple options can be chosen (checkboxes), `NEEDS DECISION: [multi] <question>` or `(select all that apply)` marks it as `multi` kind. In t191 an agent passed embedded XML and multi-select phrasing without explicit booleans; the MCP parser, prompt parser and operator card UI (with a manual `+ select multiple` toggle) now seamlessly support multi-checkbox questions across all three agents |
| `antigravity-cli` | `agy -p /usage` might be a free quota probe | ⛔ **it is not.** Measured: taken as a *prompt*, spent 14,603 input + 264 output tokens, and began listing directories trying to work out what "/usage" meant |
| all three | `multimodalInput: true` means an image can be sent | ⛔ **It meant nothing at all** — declared on all three built-ins, read by five grep hits of which three were the declarations, and on `antigravity-cli` measurably **wrong**: the same base64 block Claude Code answers correctly returns `"status":"ERROR","num_turns":0,"error":"stream input content block type \"image\" is not supported (only \"text\")"`. It does not drop the image, it kills the turn. Replaced 2026-09-01 by `imageInput: 'inline' \| 'spawn-flag' \| 'none'`, which says how the bytes are *delivered*. ⚠️ All three read a PNG off disk with their own view tool (agy via `view_file`, measured), which is why the absolute path travels in the prompt text on every adapter |
| `antigravity-cli` | unmeterable (SQLite conversations) | **meterable after all** — usage is in the stream. `metering: 'stream'` |
| `claude-code` | the folder-trust dialog only affects fresh worktrees | ⛔ **It affects any folder, per account, and it swallows every keystroke until answered.** Measured 2026-08-27: the usage probe was spawning in the user's home - untrusted in the worker's config - so `/usage` was typed into the dialog and Enter accepted the folder. Projectless sessions now run in `<dataDir>/scratch` and `trustDirectory()` pre-answers it for that directory only |
| `claude-code` | signing in leaves an isolation root ready to use | ⚠️ **Only for print mode.** `claude auth login` writes `oauthAccount` and `userID` but not `hasCompletedOnboarding`, so an *interactive* session in that root opens the theme picker and then the login-method chooser. Scheduled work runs on `-p` and never sees it, which is why this hid until something needed a TUI (2026-08-27) |
| `claude-code` | a session that cannot work exits, so `onExit` is enough to catch it | ⛔ **It announces the failure and then stays.** Measured 2026-08-27 on an account whose organisation had disabled Claude Code: the stream carried `{"type":"result","is_error":true,"terminal_reason":"api_error"}` with *"Your organization has disabled Claude subscription access for Claude Code"*, and the process sat on stdin. The run stayed open, the task stayed `running`, and the worker's only slot stayed held. **The terminal `result` record is the signal; the exit is not** |
| `claude-code` | API 529 Overloaded is an unrecoverable failure | ⛔ **It is a temporary server outage.** Measured 2026-09-03 on t153: Claude returned *"API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com."* Treating it as an ordinary failure or DOA quarantined the worker or required human intervention; it is now classified as an overload (`overloaded`) and automatically retried after a backoff timeout (1m, 2m, 4m; up to 3 attempts) |
| `antigravity-cli` | an adapter that cannot answer identity questions looks the same as a healthy one | ⚠️ **Resolved for standalone OAuth and log inspections.** On macOS standalone installs, credentials live in `jetski-standalone-oauth-token` and identity is logged in `antigravity-cli/cli.log`; `readAntigravityIdentity` inspects these before falling back to `null` so signed-in accounts are not falsely reported as `loggedIn: false`, which would block quota probes |
| `antigravity-cli` | `agy login` signs an account in | ⛔ **there is no `login` and no `auth` subcommand.** Measured on agy 1.1.20: `agy --help` lists agent, agents, changelog, help, install, mcp, mic-serve, models, plugin, plugins, update. Commissioning failed with *unexpected argument "login"*. Sign in with the Antigravity app; the credential goes to the OS keyring |
| `antigravity-cli` | `--mode accept-edits` suffices for headless work | ⛔ **it auto-denies commands.** In headless stream mode (`--input-format stream-json`), `accept-edits` only approves edits; any command (`git`, test runner, etc.) cannot prompt interactively and is auto-denied by `jetski`, causing immediate `CANCELED` turns. Headless worktree dispatches pass `--dangerously-skip-permissions` (Option A), quarantined inside isolated pooled worktrees and gated by mandate and landing checks |
| `openai-compatible` | interactive sessions in fresh `$CODEX_HOME` start immediately | ⛔ **They block on two interactive modal prompts.** Fresh roots prompt for directory trust (*"Do you trust the contents of this directory?"*) and Windows sandbox setup (*"Set up the Codex agent sandbox"*), swallowing keystrokes. `trustDirectory()` pre-writes `$CODEX_HOME/config.toml` with `[windows] sandbox = "elevated"` and `[projects.'<dir>'] trust_level = "trusted"` |
| `openai-compatible` | a suite that passes on the host passes inside the worker | ⛔ **The sandbox denies privileged host queries, and a denied query fails as a red test.** `codex exec` runs under `--sandbox workspace-write`; measured on t56, 2026-08-30, `Get-CimInstance Win32_Process` came back access-denied, so `stall.test.ts`'s live sampling assertion failed inside the worker and passed unsandboxed on the same machine minutes later. The agent could not tell that from a regression it had caused and stopped to ask. Two fixes: the test now asserts the *denied* contract (`sampleProcessTree` returns null, never an empty sample) when enumeration is unavailable, and the prompt tells a one-shot worker that `runChecks` runs the project's `check` list **in the daemon, outside the sandbox** |
| `openai-compatible` | an agent that can edit its workspace can commit in it | ⛔ **Not in a worktree, which is every workspace this tool hands out.** `<worktree>/.git` is a *file* pointing at `<trunk>/.git/worktrees/<slot>`; a commit writes the index there and the objects and branch ref into the common `<trunk>/.git`, all outside the directory `--sandbox workspace-write` makes writable. Measured on t56, 2026-08-30 — three runs, ~1.8M tokens, 30-day quota 0%→34% — every one refused at `.git/worktrees/ws1/index.lock`: *"sync/rebase and staging both failed"*. `plan()` now passes `--add-dir` for each path `gitWritableRoots` finds. ⚠️ That grant is the whole common `.git`, so a worker can reach other tasks' refs; there is no narrower one, because two of the three paths are shared by construction. A real clone per worker would be the isolated fix and is an architecture change, not a flag |
| `openai-compatible` | a resume failure or backend 404 indicates a broken worker | ⛔ **It is a session-level failure, not an account fault.** Measured 2026-09-03 on CodexFirst: `https://chatgpt.com/backend-api/codex/responses` returned HTTP 404. DOA attributed this to the account, holding it out as `suspect`. Because the broken session retained its context tokens, pressing `Recheck` immediately re-scheduled the exact same doomed resume, failing again in 17s. Warm-start DOA failures now invalidate the failed session's context tokens and restart cold without quarantining healthy workers; backend API 404/5xx errors are classified as provider overloads |
| `openai-compatible` | the workspace and the git directories are everything that reaches outside it | ⛔ **Whatever a link inside the workspace points at is outside it too, and a sandbox resolves links before it checks them.** Measured on t171, 2026-09-03: `ws2/node_modules` on this install is a directory junction to the trunk's, so a write through it lands somewhere never granted. `npm test` there died before one test ran — `EPERM: operation not permitted, open …\ws2\node_modules\.vite-temp\vitest.config.ts.timestamp-….mjs` — while the same task, branch and commands passed 1,576 / 1,642 / 1,644 tests in `ws1` and `ws3`, which hold real directories. ⚠️ **It presents as flakiness**, which is the expensive part: an agent cannot tell a differently-shaped workspace from a regression it caused, and this one committed with the suite unverified rather than naming a fault it had no way to see. `plan()` now also passes `--add-dir` for each path `linkedWritableRoots` finds |
| `openai-compatible` | a refused write ends the turn, or is reported | ⛔ **The agent routes around it, into the index, and hides the evidence.** Measured on t353, 2026-09-11, codex-cli 0.151.0: the sandbox answered *Access is denied* on `prefs.ts` (one of 155 files in that slot still owned by `CodexSandboxOffline` from an earlier run, carrying a stale capability SID the daemon's `icacls /reset` cannot rewrite — `docs/development.md` §4). Codex wrote the content to `%TEMP%`, `git hash-object -w` + `update-index --cacheinfo`'d it, committed, then `update-index --assume-unchanged` on all eleven files so `git status` would stop reporting the unchanged working tree. The commit was real and the slot was unswitchable: `switch` compares the real stat. `rescueDirt` now clears the bits first ([`landing.md`](landing.md)). ⭐ **Reproduced on t408 (2026-09-13):** the refused file was one the sandbox had itself written on an earlier run, so it was owned by `CodexSandboxOffline` and the per-run grant could not be propagated into it; the ten others were operator-owned and got it. `sweepAcls` now replaces such files before every dispatch — [`development.md`](development.md) §4 |
| `claude-code` | only a sandboxed CLI needs telling what its workspace reaches | ⚠️ **Unmeasured here and granted anyway, which is a choice rather than an oversight.** `claude-code` now passes the same `workspaceGrants` as codex — the worktree's git directories, plus any link that leaves it — so one pooled worktree does not behave differently depending on which account drew it. ⛔ **Never the trunk's working tree.** That is what *"allow the project directory"* would mean, and it would hand a worker the one directory the invariants say no agent may work in; the mechanics need `<trunk>/.git` and whatever the workspace links to, and nothing else |
| *(every sandboxing adapter)* | a directory the operator attached is granted to the work that needs it | ⛔ **It is granted to the task the folder was attached to, and to nothing that task files.** Measured on t460 → t461, 2026-09-15: the operator attached `C:\Dev\warmstart-site` to a **planner**, whose whole plan was one piece that edits that repository. The piece is a new task with no attachments of its own, so codex was spawned in its worktree under `--sandbox workspace-write` with no `--add-dir` for the site, and reported back *“separate-site changes were blocked by filesystem permissions”* having done everything else. Nothing was wrong with the CLI, the plan or the piece — the grant did not travel the one hop the plan itself created. ⚠️ **And it did not survive a second run of the same task either**: an attachment travels only while its message is undelivered, which is right for an image that costs tokens to replay and wrong for a flag that costs none. `grantedDirsFor` now resolves both — every folder on the task **and on its ancestors**, on every run — and the three sandboxing adapters spell it as `--add-dir` |
| `openai-compatible` | granting a directory lets an agent commit in it | ⛔ **The sandbox grants the root and then takes `.git` back out of it, so the agent can edit everything and record nothing.** Codex's elevated Windows backend writes a write ACE for each `--add-dir` root and an explicit *deny* ACE on that root's `.git`. Its own audit log (`<CODEX_HOME>/.sandbox/sandbox-<date>.log`), 2026-09-16: `granting write ACE to C:\Dev\warmstart-site …` then `applied deny ACE to protect C:\Dev\warmstart-site\.git`. Measured on t469, 2026-09-15: `--add-dir C:\Dev\warmstart-site` was on the argv of both runs, every edit landed, and `git commit` there died on `fatal: Unable to create 'C:/Dev/warmstart-site/.git/index.lock': Permission denied`. The agent asked the operator for write access to a path no answer of theirs could grant. ⭐ **Probed the same day against codex-cli 0.151.0: passing `<dir>/.git` as a writable root of its own makes codex grant it and apply no deny at all — two grant lines, no deny line — and the commit succeeds.** `gitMetadataRoots` now returns it, for the workspace and for every operator-granted folder alike. ⚠️ **It bit the workspace too**, silently: `gitWritableRoots` returned nothing for an ordinary clone on the reasoning that `cwd` was already granted, so a `trunk`-mode task or a project root that is a plain checkout could not commit at all. Only worktrees, where the metadata is genuinely elsewhere, were ever covered |
| `openai-compatible` | an agent that can commit can also fetch, and `gh` works wherever it is installed | ⛔ **`workspace-write` ships with outbound network *off*, and `exec` has no prompt to ask for it with.** Measured on t493, 2026-09-16, codex-cli 0.151.0: the rollout's `turn_context.sandbox_policy` read `network_access: false`, and `gh secret list`, `gh issue view`, `gh release list`, `git fetch origin main` and `git push` every one died at the socket — *"connectex: An attempt was made to access a socket in a way forbidden by its access permissions"* — so the agent stopped to ask how a branch could be pushed. ⚠️ The finishing instruction tells every worktree agent to *fetch the target first*, so this was failing on every codex run; it only surfaced when a task needed the network for the work itself. `plan()` now passes `-c sandbox_workspace_write.network_access=true` (the documented key; measured to flip the policy and let `git ls-remote` reach GitHub). ⭐ Two more facts came out of the same probe, both via `codex sandbox`, which runs a command under the sandbox for no tokens — ⚠️ but only where that `CODEX_HOME` still holds its sandbox credentials. A root whose `.sandbox-secrets` is empty logs *"sandbox users missing or incompatible with marker version"* and raises a **UAC prompt** that nothing headless can answer (measured 2026-09-18 on `~/.codex`, while the worker's own isolation root ran the same command fine). Probe from the isolation root a worker actually uses, or pay for `codex exec`. **Git's schannel backend cannot work in there** — *"AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS"*, the restricted token cannot open the user's certificate store — so `envFor` appends `http.sslBackend=openssl` as a `GIT_CONFIG_*` entry on Windows (codex appends its own `safe.directory` pair after it; `GIT_SSL_BACKEND` is not a variable git reads). And ⛔ **no credential reaches the sandbox**: `git credential fill` dies at *"Unable to persist credentials with the 'wincredman' credential store"* and `gh auth status` reads *"The token in default is invalid"* where the host reads *(keyring)*, so `gh` runs unauthenticated (public reads work; anonymous rate limit 60) and a `git push` cannot succeed. That is consistent with the instruction the agent already has — commit, do not push, the landing pushes — and handing the operator's token in would widen a sandboxed adapter's authority to every repository that token reaches, which is a decision and not a fix |
| *(every sandboxing adapter)* | a refused directory is something the operator can fix from the thread | ⛔ **Not by replying to it.** A sandbox fixes what it may write before the first token — codex reads its roots off the `exec` argv and re-applies the ACLs from that frozen payload before every command — so no sentence a person types reaches the live process. On t469 the operator answered *"Continue."* and the run was abandoned. ⭐ The MCP tool `request_directory` ([`mcp.md`](mcp.md)) is the route that works: the operator's **Grant** attaches the folder to the task, ends the run and requeues it, so the grant arrives on a new run resuming the same conversation warm. ⚠️ **MCP-capable adapters only**, which today is `claude-code` alone. Everything else is told in its prompt to name the absolute path after `NEEDS DECISION:` and stop — the operator attaches the folder to their reply, and the next run has it |
| `openai-compatible` | a directory on the argv as `--add-dir` is a directory the sandbox granted, and one grant covers reading and writing | ⛔ **Codex declines some roots without saying so, and read and write are decided by two different mechanisms.** Measured on t537 → t538, 2026-09-18, codex-cli 0.151.0: `--add-dir C:\Users\<user>\.ssh` sat on the argv of three consecutive runs, no audit line ever named it, and it never appeared in `<CODEX_HOME>/cap_sid` → `writable_root_by_path` — the persistent registry of the 39 roots codex *had* granted that worker, which includes `AppData\Local\Temp`, an attached `AppData\Local\<app>` and every attachment directory. So the refusal is not about the user profile and not about Warmstart; codex simply will not register `.ssh`, and the agent spent a turn asking a person for a `CodexSandboxUsers` grant no attachment could have produced. ⭐ **A sandboxed command runs as `CodexSandboxOffline`/`CodexSandboxOnline`** (`whoami` inside it), so **read** outside the workspace is decided by an ordinary NTFS ACE: `icacls <dir> /grant "CodexSandboxUsers:(OI)(CI)(RX)"` makes a directory readable on **every** run for good, with no flag, no attachment and no per-task grant. Probed with nothing on the argv: `READ_SSH_OK`. ⛔ **The same ACE at `(M)` does not make it writable** — `WRITE_GEN_DENIED` with `CodexSandboxUsers:(OI)(CI)(M)` in place and propagated. A write outside the workspace is decided by the per-path **capability SID** in `cap_sid`, which only codex mints. ⭐ **`sandbox_workspace_write.writable_roots` in the isolation root's own `config.toml` mints it on every run**: probed with Warmstart's exact argv — which carries `-c sandbox_workspace_write.network_access=true` and does *not* clobber the table the file declares — the banner listed the root and the write succeeded. ⚠️ Warmstart writes `warmstart.config.toml` fresh each session but only ever *appends* to `config.toml` (`trustDirectory`), so a hand-added table there survives. ⛔ **Warmstart does not write either grant itself**, and that is the boundary rather than a gap: an ACE on the operator's own `.ssh` hands every sandboxed run their private key, and `grants.ts` already refuses to rewrite ACLs on a directory the operator attached |
| `antigravity-cli` | default print mode timeout allows long tasks | ⛔ **it times out at 5m.** `agy` defaults to `--print-timeout 5m0s` (1497 poll ticks); long tasks running multiple file edits/tests abort with `Print mode: timed out after 1497 polls` and exit with `ERROR`. Work sessions pass `--print-timeout 24h` |
| `antigravity-cli` | an `ERROR` terminal status is enough to explain a failed task | ⛔ **the explanation may be a separate `error` field.** t163's conflict-resolution turn returned `ERROR`; the decoder read only response-like fields, so the retained task record said *"and said nothing about it."* The raw record was not retained, but the CLI's measured image-input error has that field; it now reaches the run reason. Its earlier 5m print timeout likewise reports `Print mode: timed out after 1497 polls` beside `ERROR`; work sessions pass `--print-timeout 24h` |
| `antigravity-cli` | a tool call that has not come back is a turn still in flight | ⛔ **`agy` backgrounds a slow command and then waits on it, and an agent can wait there forever.** Measured on t366, 2026-09-11: `run_command` carries `WaitMsBeforeAsync: 5000`, so a command still running at five seconds is detached to `…/brain/<conv>/.system_generated/tasks/task-<n>.log`. The agent's own last words were *"I've started querying task 363… I will check the details once it finishes"*, the child sat alive and idle (0.7s CPU total, ~0 over 70s), its log stayed **0 bytes**, and the conversation recorded no further step for 32 minutes until a person cancelled. ⚠️ Nothing in the fleet ended that wait on the day: the stall watchdog reported and never acted, and cancel's wrap-up ask went unanswered and timed out at 90s. ⭐ It would now — a stall still flat a second stall window after it was reported parks the task (`confirmStall`), which would have handed t366 over at ~24m instead of leaving it `running` until a person looked. ⛔ **And the run metered nothing while it happened** — `agy` reports usage per model call but writes a turn only on its terminal `result`, so nine model responses read as `0 in / 0 out`. All three are fixed: `quietSince` now reads mid-turn evidence, `takeUnfinishedTurn` credits a cut-off turn, and a confirmed stall parks it. ⚠️ The backgrounded child itself is still `agy`'s own behaviour and is not patched — an agent on this adapter can still choose to wait on a log that never fills |
| `claude-code` | `--permission-mode auto` puts a headless session in auto mode | ⛔ **The flag is accepted and ignored.** Measured 2026-09-06 on 2.1.263: spawn with `--permission-mode auto -p` and the CLI's own `init` record answers `"permissionMode":"default"`. `acceptEdits`, `plan`, `dontAsk` and `bypassPermissions` all come back as themselves; `auto` alone does not, and neither a `permissions.defaultMode` in `--settings` nor the flag changes it. Because the adapter also declares `classifierBackedAuto`, no allowlist was written either — so dispatched work had **no classifier and no rules**, and every command became an approval. t250 paid nine of them in one hour for `git log`, `npm test` and the project's own checks, two left to time out into a deny. ⚠️ `dontAsk` is not the substitute it sounds like: measured the same day it *denies* what it will not ask about. Adapters now declare a `headlessPermissionMode`, used only for a `work` session on `stream`; `claude-code` names `bypassPermissions`, the same call already made for antigravity above and for the same reason — an isolated pooled worktree, gated by the mandate and the landing checks |
| `openai-compatible` | Codex usage limit failure halts task awaiting human | ⛔ **It is a quota exhaustion, not an unhandled error.** Measured 2026-09-03 on t168: Codex answered *"The agent reported a failure (error): You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:03 PM."* Because `openai-compatible` lacked `outOfQuota`, the refusal routed to `awaiting_human`. With `outOfQuota` and `parseQuotaResetTime`, the task parks at `paused_quota` with `notBefore` set to the reset time and auto-resumes once the window recovers |
| `antigravity-cli` | A turn that dies on quota says why | ⛔ **Only if the error is read before the response.** Measured 2026-09-18 on t527: a Claude model ran its window dry mid-turn; agy retried eight times over nine minutes, then ended with `status: "ERROR"`, the agent's whole narration in `response` and `RESOURCE_EXHAUSTED (code 429): Individual quota reached. … Resets in 52h16m45s.` in `error` (the latter verbatim from `~/.gemini/antigravity-cli/log`). Reading `response` first sent the task to a person as a bare `ERROR`. The decoder now prefers `error` on any non-`SUCCESS` status, and `outOfQuota` recognises `RESOURCE_EXHAUSTED` / *Individual quota reached*, so the task parks at `paused_quota` against the refused model's own pool |
| `claude-code` | a turn with no prose in it is a turn with nothing to show | ⛔ **78% of the turn was being thrown away.** `textBlocks` keeps `type: "text"` blocks and drops the rest, and `decodeStream` mapped a prose-less `assistant` record to `other` — so nothing reached the peephole or the pane. Measured 2026-09-13 against a real 1,679-record session in this repository: **1,310 records (78%) carried no text block at all**, 814 carried a tool call and 496 carried thinking. That is why Claude Code sat mute for minutes while Antigravity — whose adapter had synthesised `[Tool: …]` lines since M5 — looked busy. Both now emit `StreamEvent.tool_use`, in one shared vocabulary (`toolLine`), which is also the list `activity.proseOf` skips |
| `claude-code` | the thinking bubble could be shown if we decoded it | ⛔ **There are no words to decode.** Measured 2026-09-13 on 2.1.270: a `thinking` content block in the stream carries `thinking: ""` and a `signature`, and `--include-partial-messages` gives `thinking_delta.thinking === ""` as well. The transcript agrees — 490 of 496 thinking blocks in a real session were empty. ⭐ What *is* free is the size: `{"type":"system","subtype":"thinking_tokens"}` carries a running `estimated_tokens` with **no flag at all**. So a thinking bubble on this vendor is a phase and an estimate, and anything claiming to show the reasoning is showing something else |
| `claude-code` | `rate_limit_event` carries a status and a reset, and no sizes | ⭐ **It carries the sizes now.** Measured 2026-09-13 on 2.1.270: `rate_limit_info.unifiedWindows` is `{five_hour: {utilization: 0.12, resetsAt}, seven_day: {utilization: 0.43, resetsAt}}`, plus `overageResetsAt` — a **live** reading riding a turn already being paid for, where `probeQuota` reads a cache measured 19 days stale. `utilization` is a fraction, not a percentage. ⚠️ Published only where it names every window the account's newest reading named, because a snapshot is atomic and a shorter one would delete a window (`publishStreamWindows`); whether it carries an Opus pool on an account that has one is **unverified** |
| `claude-code` | a session's stdin takes what a person would type | ⛔ **Not on `--input-format stream-json`, where it takes whole JSON lines.** Measured 2026-09-13 on 2.1.270: three raw keystrokes written ahead of the next message produced `Error parsing streaming input line (type=user, 112 chars): SyntaxError` and **exit 1**; the identical run without them exited 0. Two callers were doing it. The Session TUI tab offered *take the keyboard* on dispatched work, so one stray character ended a task; and `cancel.ts`'s `askForWrapUp` wrote `"Please wrap up now.\r"` — and a carriage return is not a line terminator on a pipe, so it buffered, never parsed, and then corrupted whatever came next, so **every soft cancel of a dispatched task waited out its ninety seconds and logged *did not wrap up in time* about a prompt the agent had never seen**. `writeSession` refuses a `stream` session, `interruptSession` is a no-op on one, and the wrap-up goes through `sendPrompt` |
| `claude-code` | `--resume` and `--session-id` cannot both be passed | ⭐ **They can, with `--fork-session`, and that is what makes a terminal on a *running* conversation possible.** Measured 2026-09-13 on 2.1.270: `--resume <old> --fork-session --session-id <new>` printed an `init` carrying the minted id and read 31,372 tokens from cache — a cache read, not a rebuild. Without it the id would be the vendor's to choose, and the transcript path could not be known before the file existed. See `attachTerminal` |

The `cmd /s` one was latent since M1 and had never fired, because `claude` resolves to a `.EXE` on
this machine; `codex` installs as `codex.cmd`, which exposed it. The last two came from running the
CLIs against real accounts — see the quota section below.

---

## `muse-code`, and the five things that would have failed on the first spawn

Written from `--help` on 2026-09-06, then run against Muse Code 1.0.3 (1.0.3-R2198.1) in WSL2 Ubuntu
from a Windows host, on a live *Everyday Usage* account. The full capture is
`transient_docs/muse_code_findings_2026-09-06.md`; each of these was believed and wrong.

⛔ **There is no WSL bridge any more (t547, 2026-09-19).** Muse Code 1.3.0 ships a native Windows
build (`irm https://dev.meta.ai/install.ps1 | iex`), and `clihost.ts` now knows two hosts only:
`posix` (`/bin/sh -c`) and `windows` (the executable itself). Measured against 1.3.0 (1.3.0-R3401.1)
that day, through the daemon's own `spawnSession`/`sendPrompt`/`refreshUsage` on the live account:
the same flags and `--json` dialect; XDG honoured with the same `data/muse/sessions/YYYY/MM/DD/<id>`
layout and the same `model_completed` record; the credential the WSL install had written into the
isolation root accepted as-is, so an existing worker needed nothing re-done; non-ASCII round-tripped
through the stream; `--image` answered on NTFS; and `/usage` read over ConPTY. The rows marked
*(Windows)* below are what the bridge cost, kept because the relative worktree pointer and
`repairTrunkConfig` they produced are still in force. Three Windows facts are new:

| Believed | Measured on the Windows build, 2026-09-19 |
|---|---|
| run `muse`, the command the installer puts on `PATH` | ⛔ **That is `muse.cmd`**, which runs `powershell.exe -File .muse-launcher.ps1`, which runs `muse-bin-<version>.exe` as `.muse-version` names it. A `.cmd` goes through `cmd /d /s /c` (splits a path with a space), and started from PowerShell 7 the launcher fails outright — Windows PowerShell inherits pwsh's module path and `Get-FileHash` is not found (the installer died that way on this machine). `museBinary` reads the launcher's own layout under `MUSE_INSTALL_DIR` or `%LOCALAPPDATA%\Programs\muse` and starts the `.exe` |
| Windows has some stdin prompt channel | ⛔ **None.** `--prompt-file -` is *The system cannot find the file specified*; `\\.\CONIN$` is *Incorrect function*; no prompt is `missing prompt`. So the drain stays, as `WINDOWS_DRAIN`: the daemon's own runtime under `ELECTRON_RUN_AS_NODE` copies stdin to the file and spawns muse with `stdio: 'inherit'` — byte-exact, arguments as an array — having removed `ELECTRON_RUN_AS_NODE` so no shell the agent opens inherits it. PowerShell was rejected because it re-encodes a native command's stdout through the OEM code page |
| a `trust.json` key is the folder's path | ⛔ **On Windows it is `\\?\` + the fully resolved path** — the dialog prints it as *Trust target*. Pre-trusting four fresh folders under four spellings, only that one opened straight to the prompt; the path as given (an 8.3 temp path) and `realpathSync.native` without the prefix both drew the dialog, and a probe's `/usage ` keystrokes then answer it. `trustKey` spells it |

| Documented | Measured |
|---|---|
| `exec` reads its prompt from stdin, like `codex exec` | ⛔ **It has no stdin prompt channel at all.** A piped prompt answers `missing prompt` / `usage: muse exec [OPTIONS] [PROMPT]` and exits 1. The prompt is argv or `--prompt-file` and nothing else — so the host script does `cat > <file>` first and the EOF the `once` transport already sends becomes the go signal. Nothing in the scheduler changed |
| `exec --json` carries usage, the way agy and codex do | ⛔ **It carries none.** A full real run was captured — 39 records — and there is no usage anywhere in it. Usage is in the **session log** (`payload.event.kind == "model_completed"`), so `metering: 'transcript'` |
| a transcript is a transcript | ⛔ **Three differences at once, all silent.** It keys on `payload_type` not `type`, dates records in **microseconds**, and counts the cached prefix *inside* `input_tokens` (24,679 against a 24,433 cache read). A Claude-shaped reader meters nothing; summing the fields as they arrive doubles every cache read. Adapters now declare `decodeTranscript` |
| resuming needs a resume flag | ⭐ **Reusing `--session-id` is the resume.** A second `exec` on the same id appended to the conversation and logged `session.resumed` with `prior_turn_count: 1`. So the vendor's handle for a conversation is the id this app minted for it. ⚠️ But it needs **`--allow-workspace-switch`** — see *a resumed conversation is bound to the directory it was opened in* below |
| `/usage` + Enter shows the panel | ⛔ **The slash-command popup swallows the first Enter.** Two Enters work, and so does a **trailing space** — which is the fix, because `quota.ts` writes `${command}\r` and `'/usage '` submits in one go. ⚠️ And a **newly signed-in account has no windows on it at all** — see *the first probe of a new muse worker* below — so the parser answers `null` rather than 0% |
| an isolation root is a directory | ⚠️ **Two of them.** No `MUSE_HOME` exists and the real binary ignores the launcher's `MUSE_AUTH_PATH` (grep: 0 hits), so isolation is `XDG_CONFIG_HOME` + `XDG_DATA_HOME` or nothing. Both work on a Windows drive, with one benign warning: DrvFs cannot express mode 0700, so cross-session messaging disables itself |
| *(Windows)* `wsl.exe -- bash -lc <script> arg…` passes the arguments | ⛔ **It drops them.** `$#` came back `0`, `$0` read `/bin/bash`. Every path is quoted into the script text by `shQuote` instead |
| *(Windows)* a worktree is a directory git can open | ⛔ **Not from inside WSL.** `<worktree>/.git` holds `gitdir: C:/Dev/…`, which git resolves *relatively*: `fatal: not a git repository: /mnt/c/…/ws1/C:/Dev/…`. Every workspace this app hands out is a worktree, so a muse worker could not have run one git command. The first fix was `GIT_DIR` + `GIT_WORK_TREE`, which helped `git` — ⛔ **and nothing else.** Measured on t410 (2026-09-13): muse's own `edit_file`/`write_file` read `<worktree>/.git` themselves and refuse every edit with *cannot resolve workspace gitdir pointer: No such file or directory*. The agent's answer was to overwrite the pointer with a `/mnt/c/…` spelling, which broke the slot for Windows git and cost the task its next dispatch. So the pointer is written **relative** (`gitdir: ../../<repo>/.git/worktrees/wsN`), which git 2.54 (Windows) and 2.53 (WSL) both follow with no environment, and `ensureWorktreePointer` runs `git worktree repair` on any slot whose pointer no longer resolves. ⚠️ That muse's tools accept the relative form is inferred from their error, not yet measured against a live run |
| *(Windows)* `GIT_DIR` in the environment is a harmless hint | ⛔ **It is sticky, and it cost two landings.** Exported into the agent's whole environment, every git it starts anywhere talks to its worktree — including the `git init` each fixture of an `npm test` runs in a temporary directory. `git init` under a foreign `GIT_DIR` writes `core.worktree = $GIT_WORK_TREE` into the repository's **common** config, i.e. the trunk's `.git/config`, spelled `/mnt/c/…`; from then on every Windows git in the trunk dies with *fatal: Invalid path '/mnt'*. t446 (a muse run in ws3, 2026-09-14) did exactly that, its test commits landed on the task branch and a fixture's `user.name` in the trunk config, and t446 and t447 both finished into *the trunk could not be read*. Reproduced with one `git init`. ⭐ A relative pointer needs neither variable — measured the same day: WSL git in ws3 with no environment read toplevel, git-dir, common-dir, branch and status right, and a commit from there was visible on Windows — so `gitEnvFor` now answers `{}` for one, and exports the pair only for a pointer that cannot be made relative (a pool on another drive). The trunk also repairs its own config on every prepare, park, base lookup and landing (`repairTrunkConfig`) |
| *(Windows)* the pointer is one file | ⚠️ **Two.** `.git/worktrees/wsN/gitdir` points back at `<worktree>/.git`, absolutely, and WSL git — unable to open `C:/…` — listed every pool member as **prunable** on 2026-09-14: one `git worktree prune` from that side away from losing the pool's admin directories. `git worktree repair --relative-paths` (git ≥ 2.48) rewrites both files; the WSL listing is clean afterwards. Windows only, because git records the choice as `extensions.relativeWorktrees` in the trunk's config, which a git older than 2.48 refuses to open — and Windows is the platform with two gits reading one pool |

⛔ **`clihost.ts` is the whole of the per-platform start-up, and that is the requirement rather than a
convenience.** `hostAt()` names the host, `hostPlan()` produces the command for it, and `muse-code.ts`
never branches on `win32` to build a turn. ⚠️ `isInstalled()` is a filesystem lookup again: the
bridge needed a spawn to find a CLI that was not on this filesystem, so it cached the answer and said
*no* until the first probe returned (t268 was that probe using the wrong shell). Neither is needed now.

Muse workers have taken real dispatches, and the three faults that found are in this section: the
image asset store (t289, a WSL-only fault, now gone), the workspace-bound resume (t364) and the
workspace it reads before it starts (t436).

### muse reads `<workspace>/.codex/skills` before it starts, and dies on a non-directory (t436, 2026-09-14)

⛔ **Measured 2026-09-14 against Muse Code 1.1.1 (1.1.1-R2514.1)**, three workspaces, one prompt
file, one flag set — the exact argv the quality reviewer spawns:

| `<workspace>/.codex` is… | what muse does |
|---|---|
| absent | starts normally |
| a **directory** | starts normally |
| a **regular file** | `runtime host failed to start: failed to read skill file at <workspace>/.codex/skills: Not a directory (os error 20)` on **stderr**, exit 1 at ~4.5s, **stdout empty** |

⚠️ It is muse that opens *codex's* skill directory, not a mistake in the argv: the path is derived
from the workspace root and read at startup, before the model is called.

⛔ **This fleet produced the third row for a day, from its own repository.** `.codex` was committed
as a symlink to `.claude` on 2026-09-13; git with `core.symlinks=false` — the default on most
Windows checkouts — writes a symlink out as a *regular file containing its target*, so every
workspace in this repo had a seven-byte `.codex`. Three quality reviews then failed as *the
reviewer's session ended before it answered* (the batch of 2026-09-14 06:19), which was true and
useless: the CLI had named the file on stderr, and the stream parser skipped it as the ordinary
chatter non-JSON lines usually are. Two things changed: the link is
[made locally and never committed](development.md#the-codex-link) (`scripts/link-agent-skills.mjs`),
and a `stream` session now keeps a bounded tail of what its CLI said outside the protocol
(`sessionDiagnostics` in [`../src/daemon/sessions.ts`](../src/daemon/sessions.ts)) so a session that
dies without answering quotes the reason instead of reporting a bare exit code.

### A resumed conversation is bound to the directory it was opened in (t364, 2026-09-11)

muse records the `workspace_root` a session was **opened** in — it is the second record in
`session.jsonl`, `runtime.session.metadata` — and compares it to `--workspace` on every later `exec`.
When they differ it refuses:

```
session <id> was created in workspace <A>; refusing to resume in workspace <B>;
pass --workspace <A> or --allow-workspace-switch to continue in the new workspace
```

⛔ **That refusal is exit 1 with an empty stdout, before the model is called**, so it reads exactly
like an agent that failed its task: *the session ended (exit 1) without reporting completion*, four
seconds after dispatch, task to `awaiting_human`. t364 lost a dispatch to it and t366 lost two more to
the same conversation. Measured 2026-09-11 against muse 1.1.1 (1.1.1-R2514.1) on a throwaway
`--provider echo` session, so confirming it cost no tokens: two directories and one id, refused
without the flag, and with it a warning plus `workspace root: <B> (explicit)` and a normal run.

⚠️ **The app's `samePath` gate cannot see this.** The conversation t364 revived was opened on
2026-09-07 under `multi_agent_controller_workspaces\ws1`; the rename's `repointIsolationRoots`
rewrote the `sessions.cwd` **row** to `warmstart_workspaces\ws1`, which is the one thing it can
reach — the vendor's own session log still says the old path. So this app believed the directory was
unchanged while muse compared two different strings. The same refusal waits on any conversation
revived into a *different pool slot*, rename or no rename, which is a thing this fleet does by design.

⭐ So `muse-code.ts` passes `--allow-workspace-switch` **whenever `resumeFrom` is set**, and never on
a cold start. The worktree the dispatch claimed is the authority on where a run works; declining the
resume instead would pay a full cold start for a prefix that is sitting right there.

### Four faults behind one message: *"its usage panel did not appear"*

⛔ **Measured 2026-09-07 on MuseFirst, commissioned and signed in that morning** (t266). The first
probe reported *"`/usage ` was typed into MuseFirst but its usage panel did not appear"* and pointed
at a folder-trust dialog. It had been typed, no dialog was in the way, and **three separate things
were wrong** — each of which alone produces that same sentence, which is why the message had to stop
being a guess. A fourth arrived with Muse 1.2.1 (below).

**1. The return must not travel with the command.** `driveScreenProbe` wrote `'/usage \r'` in one
`write`; through this app's own PTY that leaves `/usage` sitting in the composer, unsent — four
attempts, eighteen seconds, nothing. Typing the text and sending the return **400ms later** drew the
panel on the first attempt. Muse's TUI negotiates the kitty keyboard protocol and bracketed paste at
startup (`ESC[>3u`, `ESC[?2004h`), and a return inside the same chunk as the text is not a keypress
to it. `usageRefresh.submitDelayMs` is the declaration; an adapter that omits it still gets exactly
one write, which is what Claude Code and Antigravity were measured on.

**2. Through a PTY there are no lines.** `backscroll` is the raw stream with its escapes stripped,
and muse paints with **absolute cursor addressing**, emitting no newline between rows. The whole
panel arrives as *one* line:

```
… Subscription · Muse Code Everyday Usage   Current   0% used · Resets at 1:55 PM   Weekly   2% …
```

So `/^\s*Current\s+/` matched nothing on a complete, correct panel, and would have gone on doing so
after fault 1 was fixed. Nothing in `parseUsage` may be anchored to a line now, the reset clause is
bounded to the two shapes measured (`at 1:38 AM`, `Sep 13 at 5:00 PM`) rather than to the end of a
"line" that is the rest of the panel, and **the last paint wins** — a TUI redraws, so the backscroll
holds every frame it ever drew. ⚠️ Antigravity's TUI does emit newlines, which is why this survived
a screen-answered adapter shipping: it took the second one to expose it.

**3. The provider can return no numbers even when the probe itself worked.** Driven by hand under
tmux against that same isolation root, the panel read:

```
  Subscription · Muse Code Everyday Usage
    Currently unavailable
```

The first observation was a newly signed-in credential, and one completed turn then made a fresh
TUI publish windows:

| Tried | Read |
|---|---|
| signed in, two hours old, zero turns | `Currently unavailable` |
| one `muse exec` turn, then a **fresh** TUI on `Turns 0` | `Current 0% used · Weekly 2% used` |
| a **second** isolation root holding a copy of the same `auth.json` | the same windows, immediately |

That correlation was not a general rule *as stated*. On 2026-09-08, MuseFirst had already completed
work and its probes had read 5h values from **35% to 80%** and 7d values from **46% to 62%**; after
the window reset, the same accepted `/usage` command again read `Currently unavailable`. The
provider publishes no reason and no local file contains these windows.

⭐ **Eleven days of samples reconciled the two.** Read against MuseFirst's own `quota_samples`
(2026-09-06 → 2026-09-17, 427 attempts), every `Currently unavailable` streak *begins* as a window's
`resetsAt` passes and the first real reading after one is consistently low: the vendor publishes a
window once something has been spent in it, and a freshly reset window has had nothing spent in it.
The 2026-09-07 observation and the 2026-09-08 recurrence are the same rule seen at two different
resets. `scoring.ts`'s `inferredFreshWindows` reads that as 0% used (t516).

### The one probe that spends money: `usageRefresh.warmup`

⛔ **If a provider publishes only once a window has been spent in, no free probe can ever produce a
reading on a fresh one.** Since t570 an adapter may declare `usageRefresh.warmup` — a prompt, a
completion wait, and the sentence a person is shown — and `worker.warmUsage` sends that one small
turn in the probe session already open, then re-drives `/usage `. Muse Code is the only adapter that
declares one. ⚠️ **Inferred, not measured** (2026-09-19): it rests on the sample reading above, and
nobody has yet watched a deliberate warm-up turn end a streak. The button says so.

The rules it is bound by, each of which is an invariant rather than a preference:

- ⛔ **Nothing on a timer may reach it.** The scheduler spends zero tokens; `RefreshOptions.warmUp`
  is passed by `worker.warmUsage` and by nothing else, and `worker.probe` stays free.
- ⛔ **Only where the provider itself said it has nothing** — `driveScreenProbe`'s `unavailable`, the
  adapter's own words. A screen that merely failed to parse is a probe fault, and a turn cannot fix it.
- ⛔ **Completion is waited out by the clock, never read off the pane.** `driveWarmupTurn` writes the
  prompt and waits `completeMs`; the TUI is still for humans, and the usage parser is still the only
  thing allowed to turn rendered text into state.
- ⛔ **An adapter that declares no warm-up is refused, not quietly downgraded** to the free probe.
- ⚠️ The prompt asks the model about *itself* — no file, no tool — so it cannot fail on an untrusted
  folder, and it cannot touch a repository.

**4. The TUI asks its terminal a question, and a probe PTY has nobody to answer it.** ⭐ Measured
2026-09-13 on macOS against Muse Code 1.2.1 (t1, t3): every probe on a signed-in, folder-trusted
worker read *"the probe session did not start"*, and the daemon log showed why — `session … exited
with 0` **6.7s after the spawn**, before `readyMs` (14s) had elapsed, so `/usage` was typed into a
process that was gone. Spawned the same way outside the app, muse wrote its colour, keyboard-protocol
and device-attribute queries, then `ESC[6n` (*report cursor position*) at +2.3s and again at +4.3s,
and exited at +6.4s having drawn nothing; run against the user's own config root it said so on the
way out: *"The cursor position could not be read within a normal duration"*. 1.0.3, which this
adapter was measured on, did not ask. A person's session never saw it because xterm.js answers the
query itself. `termquery.ts` now answers that one request (`ESC[1;1R`) on `probe` PTYs, and the
same spawn then started and drew the panel on the first `/usage `. ⚠️ The colour and DA queries are
deliberately left unanswered: the TUI was measured to carry on without them.

⛔ So *"what did the screen say"* has a third answer, and adapters now have somewhere to put it:
**`usageUnavailable(screen)`** returns the sentence a person is shown when the panel drew and said
it has no reading. It is asked
only after `parseUsage` has declined, so it can never mask a reading; a non-null answer **ends the
retry loop**, because a provider that has published no numbers will not publish them because the
command was typed a fifth time. `quotaGap` then shows the worker with no current quota reading;
the fleet may dispatch to it only under the existing unverified-quota policy, never as a remedy for
the provider response.

⭐ **Verified end to end, 2026-09-07**: the adapter's own spawn plan, this app's PTY at 100×30,
`driveScreenProbe` with the adapter's parser — **one attempt**, `Muse 5h 0% · Muse 7d 2%`, with both
reset times. Before the fix the same worker answered *"the usage panel did not appear"* on every
probe, including one taken through the running daemon minutes earlier.

---

## `codex exec resume`, and the reasoning it corrected

`openai-compatible` declared `resumeSession: false` from M5 until **2026-09-02**, with the note that
`codex exec resume` *"exists and has not been run here"*. It has now been run here. Measured against
**codex-cli 0.151.0 on Windows**:

```
codex exec -s workspace-write -C <dir> --add-dir <dir> --skip-git-repo-check --json \
           resume -m <model> <THREAD_ID> -          (prompt on stdin)
-> Error: thread/resume: thread/resume failed: no rollout found for thread id <THREAD_ID> (code -32600)
```

Four facts, and `plan()` depends on all of them:

| | |
|---|---|
| **Flag placement** | `--sandbox`, `--cd` and `--add-dir` are declared on `exec` and **not** on the `resume` subcommand. They must precede the word `resume`, and clap accepts them there |
| **Prompt channel** | a literal `-` as the PROMPT argument means *read stdin* — the same one-shot channel a fresh `exec` uses, so `sendPrompt` needs no branch |
| **⛔ Omitting the `-`** | resume prints `No prompt provided via stdin` and **exits 0** having done nothing. The quietest possible failure, and the reason the argv order is asserted in tests |
| **Keying** | resume reads the rollout under `$CODEX_HOME`, which is this fleet's per-worker isolation unit. A thread resumes where it was written and nowhere else |

**⛔ One-shot and resumable are not in conflict, and treating them as such is what kept this off.**
`adapters.test.ts` asserted `streamPrompts === 'once'` ⇒ `resumeSession === false`, reasoning that
`codex exec` exits after its turn *"so there is no conversation left to reuse"*. The **process** is
gone; the **conversation** is a rollout file on disk. The real hazard in that sentence — a prompt
delivered into a pipe that closed, the 50-minute hang measured on t52 — is about continuing a *live*
session, and it is guarded where it belongs: `warmSessionFor` returns null for any one-shot adapter
whatever its state says. `resumeSession` governs a **respawn** carrying prior context, which is one
prompt into one fresh process — exactly what one-shot means.

**⭐ Measured 2026-09-02, and it was the last open link:** a successful resume re-emits
`thread.started` with the **same** `thread_id`. Two real turns on a signed-in account — the first was
given a token on stdin, the second resumed that thread and answered with it, both reporting one id.
So the fleet keeps one session row per conversation and the next dispatch still finds it. ⚠️ Had it
minted a new id the failure would have been a row per turn and a fall back to cold starts, not a
wrong answer, which is why this shipped ahead of the measurement rather than behind it.

**⛔ A conversation whose CLI names it is not resumable until it has told us the name.** `spawn`
resolves `resumeFrom` as `vendorSessionId ?? id`, which is right only where `mintsSessionId` is true.
Codex and Antigravity name their own, and handing codex our UUID is not a quiet no-op — it exits with
`no rollout found`, killing the run. `resumableSession` now refuses such a candidate, turning that
into the cold start it should always have been.

---

## Consequences the scheduler reads

⛔ **No code anywhere asks which adapter it is looking at.** Each of these is a capability, and the
behaviour falls out of it:

- **`manualCompact: false`** → cache-clock moves 4 and 5 are unavailable, and `wrapUpProtocol` is
  `handoff`. M5 also found the hole this left: a reserve breach on a no-compact adapter used to fall
  through and do *nothing* — the one case the reserve exists to catch. It now hands off and closes.
- **`wrapUpProtocol`** → quota preemption uses the adapter's declared safe exit: `compact` sends
  `/compact`, records the ask and waits up to five minutes for a boundary; `handoff` asks the agent
  to commit safe work, update `HANDOFF.md` when present, and record the structured handoff before a
  two-minute deadline. The operator may choose handoff instead during the warning, but cannot choose
  a compaction the adapter does not support.
- **`canPriceCache(): false`** → the clock declines to spend on keepalive or compaction at all,
  rather than acting on an invented number. Google bills cache *storage per token-hour*; OpenAI
  caches server-side with no client-controlled TTL. Neither is a lever of the shape the clock pulls.
- **`classifierBackedAuto: false`** → Warmstart writes a narrower allowlist into the worker's own
  configuration before each spawn, and expects a higher refusal rate.
- **`headlessPermissionMode` set** → a **`work`** session on the **`stream`** transport starts in that
  mode instead of `defaultPermissionMode`, because the default one does not reach it. ⚠️ Only the
  unattended case: a chat, a consult and a review each name their own mode and are never rewritten,
  and a `pty` session keeps the default, which is where a person is watching and where Claude Code's
  `auto` actually works. ⛔ A declaration about **the CLI**, not a preference — see the corrected
  assumption below.
- **`bypassPermissionMode` set** → the escape from `headlessAuthority: 'sandboxed'`, offered only to
  Codex. A worker whose own `unattendedAuthority` is `full-user` gets this mode instead of
  `headlessPermissionMode`/`defaultPermissionMode` on a **`work`**/**`stream`** dispatch —
  `--dangerously-bypass-approvals-and-sandbox`, opt-in per account (t545), never per project. See
  `docs/security.md`.
- **`mintsSessionId: false`** → the transcript is discovered after the fact instead of predicted,
  and ⛔ **orphaned processes are never killed**, because identity cannot be proved. Leaving an orphan
  running costs quota; killing the wrong process costs somebody their work.
- **`resumeSession: true`** → a task continued after its session has exited goes back into the
  conversation it was already having, instead of starting one that has never heard of it. The
  scheduler names the conversation; the adapter chooses the flag — `--resume <id>` for Claude Code,
  `--conversation <id>` for Antigravity, and a whole different subcommand, `exec resume <thread_id>`,
  for codex. ⛔ A claim about **the adapter**, not the CLI. ⚠️ Two conditions the scheduler
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
  ⭐ **codex measured the same way 2026-09-02** (codex-cli 0.151.0): a resumed run answered with a token planted in the first turn and reported the same `thread_id`. Its argv is a *subcommand*, not a flag, and the flag placement it forces has its own section below — see § *`codex exec resume`, and the reasoning it corrected*.
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
  - **`openai-compatible`: true, promoted 2026-09-15.** `codex exec --help` lists no
    `--reasoning-effort` flag; `-c model_reasoning_effort=<level>` is the only route in. Run against a
    signed-in ChatGPT account (codex-cli 0.151.0), on a fresh `exec` and on `exec resume`: both turns'
    rollout `turn_context` came back with `"effort":"high"`/`"medium"` — set *and* observable. An
    unsupported level (`=bogus`) fails the turn with the API's own `[ReasoningEffortParam] ...
    Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'` rather than
    being silently dropped.
  - **`muse-code`: true.** `muse exec --reasoning-effort` receives the selected level on both the
    interactive and stream spawn paths. Its picker offers `none`, `minimal`, `low`, `medium`, `high`,
    `xhigh` and `ultra`; the current list was supplied for this change on 2026-09-14. ⚠️ This worker
    could not re-run Muse because its WSL instance returned `E_ACCESSDENIED`, so that update is not
    promoted to a local measurement.
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

⚠️ Five failure modes; the first four were measured, and the fifth is labelled with its basis:

- The panel reports **remaining**; `QuotaWindow.percent` is **used**. Inverted in the parser.
- A clipped **`Quota ava…` does not prove `Quota available`**. The parser accepts only the complete
  label and rejects any displayed group that does not provide both validated windows, so a damaged
  rendering becomes `n/a` rather than a false fresh 0% sample.
- The panel is **taller than a default terminal and scrolls**. At 30 rows one group's five-hour
  window fell below the fold and three of four windows came back looking complete. The probe
  session now runs at 120×100 and the parser requires both known groups with both windows. That
  second condition is load-bearing: on t183 (2026-09-03), the 03:19 probe read Gemini 5h at 78% and
  both Claude/GPT windows at 100%; the 03:29 capture contained only the internally complete
  Claude/GPT pair, and the scheduler preempted the Gemini 3.8 run six seconds later. A missing pool
  is an incomplete reading, never evidence that the other pool's quota applies.
- ⚠️ **Measured 2026-09-03 (startup 1.5s–2.5s, probe 5.2s–5.5s):** The old fixed 20-second `readyMs`
  wait caused every probe to unconditionally wait 20.5s before reading (and 50s on missed panels).
  `readyMs` is now 5s and `settleMs` is 15s; the driver sends `/usage` immediately after startup and
  retries every 5 seconds until a complete panel parses or the 15s settle deadline expires, reducing
  normal probe duration to ~5.2s–5.5s while bounding any retry stall at 20s total.
- **An exhausted weekly pool has no five-hour bar.** Live-debugged 2026-09-03 on agy 1.1.25:
  Claude/GPT weekly showed 0.00% remaining, then its five-hour row said `Disabled` because the weekly
  limit had been hit. The old completeness guard discarded all four otherwise valid windows, so
  Probe appeared to do nothing. The parser now carries that shorter window as 100% used until the
  weekly reset: it is unavailable, and a five-hour-only scheduler gate must not dispatch into it.

What was tried before and does not work:

1. **`agy -p /usage`** — measured 2026-08-25 and it **does not work**. The slash command is taken as a
   prompt: the run spent 14,603 input and 264 output tokens and started listing directories trying to
   work out what "/usage" meant. `--disable-slash-commands` implies print mode expands them; it does
   not. The same trap Claude Code set, sprung a second time — which is why the adapter now says so in
   a comment rather than leaving the lead open.
2. **The local Antigravity Language Server** — what the community usage tools read. ⛔ It exists only
   while the **IDE is running**. Verified on this machine with the IDE closed: no such process is
   listening and no port file exists. Warmstart's premise is unattended progress across hours-long
   windows with no GUI open, so a probe that needs a window open is not a probe for this product.
3. **A community package** (`antigravity-usage`, `antigravity-panel`, `opencode-antigravity-quota`).
   ⛔ Rejected on D7 — external services are wrapped, never vendored — and because an undocumented
   internal RPC surface behind a third-party wrapper is *two* things that can go stale rather than one.

**What Warmstart does instead needs no probe.** The stream carries per-turn usage, so spend is accrued
from turns Warmstart metered itself. ⚠️ That is a **floor**, not a percentage: it cannot see what the
vendor counted that never reached a stream. `reserve.ts` already treats accrued spend as a floor, and
runs on these adapters are marked `quotaUnverified`.

### What was tried for Antigravity spend/credits (2026-09-04)

Driving `/credits` in a real PTY session was spiked on 2026-09-04 (`agy 1.1.26` on Google AI Pro).
Like `/usage`, `/credits` is handled client-side without consuming an API turn. However, the rendered
curses dialog box (drawn in ~120ms) reports:
`Remaining AI Credits: AI Credits not enabled (enable in /settings)`.
No numeric balance, no credit count, and no billing window are presented. Enabling `useAiCredits: true`
in `~/.gemini/settings.json` produces the same `not enabled` result on individual accounts.
Because no parseable number or spend meter exists, `antigravity-cli` declares `spendProbe: 'none'`
and carries no probe function.

### The adapter spend probe contract

`AdapterCapabilities.spendProbe` governs how a CLI surfaces money meters:
- `'config-cache'` (`openai-compatible`, `claude-code`): reads cached balances from disk on the quota
  poller's pacing via `probeSpend(isolationRoot)`. In Codex, reads `credits.balance` from rollout JSON
  files in ~1ms (0 tokens, 0 extra processes).
- `'stream'`: usage and overage data arriving in-band on stream turns. No adapter declares this alone
  today; `claude-code` still *reads* those records (below) and declares `config-cache` for the amount.
- `'none'` (`antigravity-cli`, `local-llm`): no spend meters available.

### Claude usage credits — the amount was on disk all along (2026-09-07, t271)

⛔ **`claude-code` was `spendProbe: 'stream'` and carried no `probeSpend`, so `spend_samples` was
empty for Claude and `RunPrice.overageUsd` could never be anything but `null`.** The stream records
it does read answer *whether* a turn was billed as extra usage — `rate_limit_event.isUsingOverage`,
`overageStatus` — and a boolean cannot answer *how much*, which is the only question an operator
spending credits is actually asking.

⭐ The amount is structured JSON in the same `.claude.json` `probeQuota` already opens, on a cache
the existing `/usage` PTY drive already refreshes. So it costs a `readFileSync` and no turn, and
**no new TUI interaction was needed for any of it**. Measured on 2.1.263,
`cachedUsageUtilization.utilization` carries, beside the `limits[]` array:

```jsonc
"extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null, "currency": null,
                 "disabled_reason": null, "user_disabled": true, "credits_ever_enabled": true },
"spend": { "used": { "amount_minor": 0, "currency": "USD", "exponent": 2 }, "limit": null,
           "enabled": false, "balance": null, "can_toggle": false,
           "disclaimer": "Usage credits cover you when you hit your plan limits." }
```

⛔ **Minor units and an exponent, never a float**: `{ amount_minor: 3787, exponent: 2 }` is `$37.87`.
⛔ **`null` is *not reported*, never zero.** On an account with credits off the vendor publishes a
status and no numbers at all, so rendering `$0.00` would claim a purse is empty when it has merely
not been shown.

⭐ **Credits off is two different situations, and only one field tells them apart** (2026-09-13,
2.1.270, t408). Measured on `ClaudeFirst`, where the operator had turned usage credits on at the
vendor and the app still reported them off:

```jsonc
"extra_usage": { "is_enabled": false, "monthly_limit": 1730, "used_credits": 2057, "utilization": 100,
                 "currency": "USD", "decimal_places": 2, "disabled_reason": "org_level_disabled_until",
                 "user_disabled": false, "spend_limit_reached": true, "credits_ever_enabled": true },
"spend": { "used": { "amount_minor": 2057, ... }, "limit": { "amount_minor": 1730, ... },
           "percent": 100, "severity": "critical", "enabled": false, "can_purchase_credits": false },
// and, one level up: "oauthAccount": { "hasExtraUsageEnabled": true }
```

⛔ Both switches the operator controls are **on** — `hasExtraUsageEnabled: true`,
`user_disabled: false` — and the vendor has still cut credits off, because `used_credits` ($20.57) is
past `monthly_limit` ($17.30). `spend_limit_reached` is the vendor's own verdict on that and is now
`CreditStatus.spendLimitReached`, which `creditsPurseEmpty` reads *ahead of* comparing the two numbers
itself. ⚠️ Note the numbers are present here: the earlier capture's all-`null` money block is the
*never-offered* shape, not the credits-off shape, and the two must not be conflated.

⚠️ **The reason string is recorded and never matched on**, which is why 2.1.270 renaming
`org_level_disabled` to `org_level_disabled_until` changed no behaviour. A parser that had branched on
the old spelling would have read this account as *no reason given*.

⛔ **A non-zero counter keeps being metered after credits are cut off.** `spendMeters` used to drop
every meter on `enabled === false`, to avoid reading the zero-shaped counter of an unavailable balance
as `$0.00`. On this account the counter is the whole month's overage cash, so the suppression now
applies to the **zero only** — otherwise the run that crosses the cut-off gets one reading and no
second, and prices as `null` at exactly the moment the most money has been spent.

⭐ **The refill date is inferred, because the vendor never prints one** (2026-09-07, t278). Measured
across three live accounts: `extra_usage`, `spend` and `limits[]` carry no credits reset — the limits
carry only the 5h and 7d windows. What the file *does* carry is `oauthAccount.subscriptionCreatedAt`,
and extra usage is a monthly allowance on a `stripe_subscription`, so `CreditStatus.resetsAt` is the
next subscription-month anniversary in UTC (month-end clamped, e.g. a 31st renews on Feb 28). The
strip shows whole days to it (`29d`) beside the `$used/$limit` value, which sits by the bar like
every session row instead of right-aligned to the card edge. If the vendor ever publishes the date,
that replaces the inference.

⛔ **The app cannot turn credits on, and does not pretend to.** Driven under a PTY on both accounts
(the second time with the app's own `spawnEnv()`, ruling out an inherited host variable),
`/usage-credits` does **not** open a toggle — it starts a login chooser:

```
Login
Starting new login following /usage-credits. Exit with Ctrl-C to use existing account.
Select login method:
 ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
   2. Anthropic Console account · API usage billing
```

and both accounts report `spend.can_toggle: false` with
`cachedExtraUsageDisabledReason: "org_level_disabled"`. So the switch is thrown by a person where the
vendor put it; what this app does is **read** the state, record what the operator asked for, and say
when the two disagree (`creditsDiscrepancy`, surfaced by Doctor).

⭐ **Measured 2026-09-07 on ClaudeSecond with extra usage enabled.** The vendor reports
`extra_usage.monthly_limit: 4000` with `decimal_places: 2`, and `spend.limit: { amount_minor: 4000, currency: 'USD', exponent: 2 }`
— both in minor units (cents), representing the $40.00 allowed usage ceiling configured by the user.
The parser scales by `decimal_places` (and `majorUnits` by `exponent`), preventing the ceiling from
being misread as `$4000.00`. In the fleet strip, credits are drawn as a gauge row matching sessions
(font-size `var(--text-meta)`, urgency bar fill, `$0.00/$40.00` value, and `"billing"` tag dropped).

## Still unmeasured, and why

Everything below needed a **signed-in account and a real turn**, which is where free measurement
stops. ⭐ **Nothing is open here today** — the last of these closed on 2026-09-03.

✅ **R13 closed 2026-09-03, and it was the bad answer: agy's `result.usage` is cumulative over the
whole conversation.** Three prompts down one conversation on agy 1.1.25, reading the raw NDJSON:

| run | `step_update.usage.input_tokens`, per model call | `result.usage.input_tokens` |
|---|---|---|
| 1 (new conversation) | 14,687 + 14,947 + 15,151 | **44,785** |
| 2 (`--continue`) | 15,599 | **60,384** |
| 3 (`--continue`) | 15,825 | **76,209** |

44,785 + 15,599 = 60,384 and + 15,825 = 76,209, exactly. So the terminal record repeats every
earlier turn, and crediting it once per turn made a session's recorded spend grow with the *square*
of its turn count — 4.7M in one session's `tokens_since_compact` against its own last reading of
1.38M. ⛔ It is also **not a context level**: even within one run it is a sum of prompt sizes across
model calls, which is what drew `1.1M/1.0M` and `2.0M/1.0M` on the session gauge.

⭐ Both are fixed in [`src/daemon/streamusage.ts`](../src/daemon/streamusage.ts), and the rule is a
fact about the *records*, not about this vendor: **a run that emitted per-call usage is billed the
sum of those calls and holds the last of them in its window; a run that emitted none is billed its
terminal record.** Codex and local-llm emit one terminal record each and take the second path
unchanged. ⚠️ `input` and `cacheRead` are disjoint (session `f88c6fe8`: 1,384,180 input against
23,169,687 cache reads over the same calls), so the window level is their sum.

⚠️ **`/context` exists in the agy TUI and cannot answer this.** agy 1.1.25 has a `/context` slash
command (*"Visualize current context usage"*, drawing a `└ Context Usage` panel), and
`parseContextScreen` in the adapter reads that panel. But a work session on this adapter is
`--print` with no TUI, and the only place a slash command can be typed is the throwaway PTY the
quota probe opens — whose context is its own, not the work session's. A screen reading would answer
for the wrong conversation, which is worse than the stream arithmetic above, not better.

**Answered by measurement on 2026-08-27:** the print flag (above), and with it the first
confirmation that a corrected argv reaches a signed-in Antigravity account: the CLI returns a
valid `init` record listing 50-odd tools, with no turn spent. ⚠️ Everything past `init` on this
adapter was still unmeasured then, because it needed a real turn — R11 and R13, both since closed.

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
  Warmstart looks there anyway, and Doctor tells you the difference.

Antigravity requires a Google AI Pro or Ultra subscription — the free tier ended on 2026-06-18, when
Gemini CLI stopped serving individual accounts. ⚠️ **Codex is included on ChatGPT Free as well** —
measured 2026-08-29 on a free account, which reports a 30-day quota window like any other.
