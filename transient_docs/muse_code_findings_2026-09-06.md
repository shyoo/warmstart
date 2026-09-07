# Muse Code CLI — measured findings (2026-09-06)

Measured on: Windows 11 host, WSL2 `Ubuntu` distro, `muse` 1.0.3 (1.0.3-R2198.1),
plan "Everyday Usage". Invoked from Windows as `C:\WINDOWS\system32\wsl.exe`.

Everything below was run against the live CLI on this machine unless a line says otherwise.

## Install shape
- `~/.local/bin/muse` is a **bash launcher** that self-updates and `exec`s
  `~/.local/bin/muse-bin-<version>` (263 MB). `MUSE_NO_AUTO_UPDATE=1` stops the update check.
- `muse --version` -> `Muse Code 1.0.3 (1.0.3-R2198.1)`.

## Config / data locations (XDG)
- Config: `$XDG_CONFIG_HOME/muse` else `~/.config/muse` — `auth.json` (creds, 0600),
  `settings.json`, `trust.json` (+ `.lock` files).
- Data: `$XDG_DATA_HOME/muse` else `~/.local/share/muse` — `sessions/`, `session-index.db`,
  `tui-history.jsonl`, `plugins/`, `skills/`, `model-catalog/`, `runtime/`.
- No `MUSE_HOME` / `MUSE_CONFIG_DIR` exists; the launcher honours `MUSE_AUTH_PATH` but the real
  binary does not (grep: 0 hits) — **isolation must be by XDG dirs**. `META_API_KEY` overrides login.
- ⭐ **Both XDG dirs work when they live on a Windows drive** (`/mnt/c/...`) — measured: a full
  `muse exec` run with `XDG_CONFIG_HOME=/mnt/c/Dev/…/config` and `XDG_DATA_HOME=…/data` completed
  and wrote its session log there, readable from the Windows side. ⚠️ One warning is printed and is
  benign: *"local session messaging unavailable: unsafe_registry_root … directory must be same-user
  mode 0700"* — DrvFs cannot express 0700, so cross-session messaging (a feature this app does not
  use) turns itself off.

## `auth.json` — the free identity probe
```
{"schema_version":1,"providers":{"meta":{"access_token":"dca:…","api_base_url":"https://api.meta.ai/v1",
 "api_key":"LLM|…","mechanism":"oauth","obtained_via":"device_code",
 "user_email":"…","user_full_name":"…"}}}
```
A file read answers *who is signed in*. No command, no turn.

## `trust.json` — the folder-trust dialog, pre-answerable
```
{"schema_version":1,"projects":{"/home/shyoo/musetest":{"decision":"trusted"}}}
```
⛔ Measured on a fresh config root: the very first screen is **"Do you trust this workspace?"**
(1 Trust and continue / 2 Quit), and the second is the **login chooser** (*Log in with browser* /
*Set an API key*). Those are the "few yes" clicks. Writing `trust.json` answers the first.

## CLI surface (from `--help`, both root and `exec`)
- `muse [OPTIONS] [PROMPT]` = interactive TUI. Subcommands: resume, exec, config, export, trace,
  skills, sandbox, schema, serve, session-message, auth, login, logout, init.
- `muse exec [OPTIONS] [PROMPT]` — headless. `--json`, `--prompt-file <PATH>`, `--session-id <UUID>`,
  `--model <ID>`, `--reasoning-effort none|minimal|low|medium|high|xhigh|max|ultra`,
  `--approval-mode untrusted|on-request|never`, `--workspace <PATH>`, `--image <PATH>` (repeatable),
  `--trust-workspace`, `--disable-approval`, `--disable-sandbox`, `--disable-write`,
  `--disable-shell`, `--sandbox-network`, `--yolo`, `--max-model-steps`, `--no-session-log`.
- `muse login` — a **plain, non-TUI** device-code flow. Measured output:
  `Open this page to sign in: https://auth.meta.com/oauth/device/?code=XXXX-XXXX` … `Press Enter to
  open it in your browser:`. Exits on its own. Perfect for a commissioning terminal.

## ⛔ `muse exec` has **no stdin prompt channel**
Measured: `echo "…" | muse exec --json --provider echo --session-id …` answers
`missing prompt` / `usage: muse exec [OPTIONS] [PROMPT]` and exits 1. Codex reads stdin to EOF;
muse does not. The prompt must arrive as **argv** or **`--prompt-file`**.

⭐ **The bridge that fixes this without touching the scheduler**: launch under a shell that copies
stdin into a file and then `exec`s muse against it —
`bash -lc 'cat > <f>; exec muse exec --json --prompt-file <f> …'`. The daemon's existing
`streamPrompts: 'once'` path already writes one prompt and closes stdin, and the EOF is exactly the
go signal `cat` needs. Measured end to end from Windows `child_process.spawn`.

## `--session-id` is ours to choose, and reusing one **resumes**
Measured: a second `muse exec --session-id <same uuid>` appended to the same session and wrote
`session.resumed` with `prior_turn_count: 1`, `resumed_from_sequence: 80`. So `mintsSessionId: true`
and `resumeSession: true`, and the vendor handle is our own id.

## Session log = the transcript, and the only place usage appears
`$XDG_DATA_HOME/muse/sessions/<YYYY>/<MM>/<DD>/<session-uuid>/session.jsonl` — the date directory is
**local** (WSL and Windows agreed to the minute on this machine).

⛔ **Usage is in the session log and *not* on the `--json` stdout stream.** A full real run was
captured (39 records) and carries no usage anywhere. The log carries:
```
"payload_type":"runtime.session","payload":{"event":{"duration_ms":2155,"kind":"model_completed",
 "model":"muse-spark-1.3-contributor","usage":{"cache_read_tokens":0,"cache_write_tokens":0,
 "cached_tokens":0,"input_tokens":24532,"output_tokens":24,"reasoning_tokens":12}}, …}
```
So `metering: 'transcript'`, and the record shape is muse's, not Claude Code's — the tailer has to
be told which dialect it is reading.

Other log records worth knowing: `runtime.session.metadata` (build semver/sha, model_id,
workspace_root), `run.model.configured`, `session.resumed`, `session.end` (exit_reason,
resource_usage, uptime_ms).

## `exec --json` stdout dialect (the stream transport)
Every line is an envelope: `{schema_version, id, stream:{kind:"session",id}, sequence, recorded_at,
record_type, durability, causation_id, payload_type, payload}` — `recorded_at` is **microseconds**.
The records that matter:
- `run.model.configured` → the model and the session id (our `init`).
- `run.output.delta` → `payload.text`, the assistant's prose.
- `run.terminal.completed` → `{kind:"run_terminal","terminal":"completed","reason":null,"text":"PONG"}`
  — **the terminal record**, and the process exits after it.
- `task.lifecycle.failed` → `{"kind":"failed","reason":"…"}`.
- `task.lifecycle.status` → provider retry facets (`opening meta model stream attempt 1/10`).

### ⛔ `run.output.delta` is the **final answer only** (measured 2026-09-07, t269)

The transport itself is healthy — re-measured from a plain `child_process.spawn` of the exact command
the daemon logs: line-buffered, **no NUL bytes**, every line valid JSON, `run.terminal.completed`
then exit 0. The bytes flow and the parser reads them.

What is *not* there is progress. On a two-tool turn the three `run.output.delta` records arrived at
**sequences 47–49 of 67**, after every tool had already finished; muse streams no prose between tool
calls the way Claude Code does. The t267 dispatch ran 24 minutes over 42 tool batches and put **one**
line in the peephole (a `task.lifecycle.failed`), which is why a working run read as a hung one.

Everything a run is *doing* arrives on these instead, and the adapter now decodes all three:

| record | field | meaning |
|---|---|---|
| `task.lifecycle.proposed` | `event.task_kind` | `tool.<name>` — a tool is about to run. ⚠️ Also carries `model.meta.response` and `reminder.agent.plugin:…`, which are muse's own bookkeeping (7 of 67 records) and must be filtered out. No arguments on this record. |
| `tool.result` | `correlation_facts.{tool_name,outcome}` | The verdict. `text` holds the tool's own JSON blob. |
| `task.lifecycle.status` | `event.message`, `event.details.facets[].error_kind` | `retrying meta model stream in 5000ms (attempt 2/10)` on a 429. ⚠️ `stream_succeeded` rides the same `error_kind` field and means *fine*. ⛔ Not a quota signal — muse retries up to 10 times itself, and decoding it as `rate_limit` would bench a healthy account. |

⭐ Re-measured end to end 2026-09-07 through `StreamParser` + the real adapter: a three-step prompt
produced `INIT` at +3.9s, three `· bash` lines at +6.7/6.9/7.8s, prose from +10.8s, and
`RESULT completed` at +21.6s. Send (stdin → `cat` → `--prompt-file`) and receive both work.

### ⛔ `task.lifecycle.failed` is a **step's** verdict, never the run's (measured 2026-09-07, t270)

A shell command whose *last* member exits non-zero makes muse emit
`task.lifecycle.failed` with `reason: "process exited with status exit status: 1"` — and then the
agent reads the output, carries on, and the run ends `run.terminal.completed` with the process
**exiting 0**. Reproduced verbatim against the live CLI with
`echo hello; git config --global does.not.exist`, and again with the t267 original,
`git log -1 --format='%an <%ae>'; git config --global user.email` — a machine with no global git
config, where the answer had already been printed by the time the chain returned 1.

This is what was reported as *"we had an error of `process exited with status exit status: 1`"*.
Nothing had failed. The adapter decoded that record as `error: <reason>`, it was the only line the
t267 run ever put in the peephole, and a healthy 24-minute run was killed over it.

- ⛔ **What ends a muse run is `run.terminal.*`** and nothing else. That record is decoded as a
  `result`, and `onStreamResult` turns an error one into a failed run and a closed session — so the
  task *was* correctly still `running`, and there was nothing wrong with it to fix.
- ⚠️ `task.lifecycle.failed` is the **contextless twin** of `tool.result`: measured, the two arrive
  back to back for the same `task_id` (sequences 29 and 30), and only `tool.result` names the tool
  and the command. The adapter is silent on the first and reports the second as
  `· bash failure: <command>`.
- ⭐ `tool.result.text` is a **string holding JSON**, whose `command`, `exit_code`, `terminal_status`
  and `output` describe the call. Measured for `bash`; read defensively, since another tool may
  spell its result differently.

## `/usage` — the quota panel, free, screen-only
Driven under tmux at 100x30 against the live account:
```
  Subscription · Muse Code Everyday Usage
    Current        5% used · Resets at 1:38 AM
    Weekly         1% used · Resets Sep 13 at 5:00 PM
    as of 9:17 PM
```
- Two windows: **Current** (the 5h window) and **Weekly** (7d). `Session usage` above it is
  per-session tokens, not quota.
- ⛔ **Costs no tokens** — the same panel reported `Turns 0` on the session that displayed it.
- ⛔ **A credential that has not spent a turn has no windows here.** Recorded 2026-09-06 as *the
  block is absent*; **measured again 2026-09-07** on a worker commissioned that morning, where the
  block is present and reads `Currently unavailable`. Either way a parser must return `null`
  (unknown), never zeroes. ⭐ **One turn on that credential ends it** — measured: a single
  `muse exec`, after which a *fresh* TUI on `Turns 0` read `Current 0% used · Weekly 2% used`, and
  so did a second isolation root holding a copy of the same `auth.json`. ⚠️ Time alone does not: the
  same root still read `Currently unavailable` two hours after `muse login`. The account already had
  usage from another credential throughout, so the gate is per-credential and server-side — nothing
  local caches it (`grep subscription` over the data dir hits only `feature-config`).
- ⛔ **Through a PTY, the panel arrives on ONE line** (measured 2026-09-07 with `@lydell/node-pty`,
  the app's own terminal). Muse paints with absolute cursor addressing and emits no newline between
  rows, so after `stripAnsi` the backscroll reads
  `… Subscription · Muse Code Everyday Usage   Current   0% used · Resets at 1:55 PM   Weekly   2% …`.
  ⚠️ tmux `capture-pane` renders a grid and hides this completely — which is how the line-anchored
  parser was written and believed. A parser for this CLI must be line-agnostic.
- ⛔ **The command and the return must be two writes** (measured 2026-09-07 through the same PTY).
  `write('/usage \r')` leaves the text in the composer unsent; `write('/usage ')` then `write('\r')`
  400ms later draws the panel first time. Muse enables the kitty keyboard protocol (`ESC[>3u`) and
  bracketed paste (`ESC[?2004h`) at startup, and a return inside the same chunk as the text is not a
  keypress. ⚠️ `\n` in place of `\r` does not submit either.
- ⛔ **Typing `/usage` + Enter is not enough**: the slash-command popup swallows the first Enter.
  ⭐ **A trailing space closes the popup**, so `"/usage "` + Enter submits in one go — which is
  exactly the shape `quota.ts` already writes (`write(`${command}\r`)`).

## Models (from `$XDG_DATA_HOME/muse/model-catalog/*.json`, a free file read)
| model | default | context | efforts |
|---|---|---|---|
| `muse-spark-1.3-contributor` | ✔ | 1,007,997 | minimal low medium high xhigh |
| `muse-spark-1.3` | | 1,007,997 | minimal low medium high xhigh max |
| `muse-spark-1.2-contributor` | | 1,007,997 | minimal low medium high xhigh |
| `muse-spark-1.2` | | 1,007,997 | minimal low medium high xhigh |
⚠️ `-contributor` variants carry *"Your content, including inter-session messages, may be used for
product improvement."*

## Plans (vendor pricing, read 2026-09-06; **not** measured here)
Everyday Usage **$5/mo** · High Usage **$15/mo** (3×) · Power Usage **$50/mo** (10×).
The panel names the plan verbatim: `Muse Code Everyday Usage`.

## ⛔ WSL: what actually blocks, and what fixes it
1. **`wsl.exe -- bash -lc <script> arg…` drops the trailing positional arguments.** Measured:
   `$#` came back `0` and `$0` was `/bin/bash`. So paths must be **quoted into the script text**,
   never passed as `$1`/`$2`.
2. **A Windows-made git worktree is unreadable by WSL git.** `<worktree>/.git` holds
   `gitdir: C:/Dev/…/.git/worktrees/ws1`, which WSL git resolves *relatively*:
   `fatal: not a git repository: /mnt/c/Dev/…/ws1/C:/Dev/…/worktrees/ws1`. Every workspace this app
   hands out is such a worktree, so without a fix a muse worker could not run one git command.
   ⭐ **Fixed by environment alone, touching no file**: `GIT_DIR=<translated gitdir>` and
   `GIT_WORK_TREE=<translated worktree>`. Measured — `rev-parse --abbrev-ref HEAD`, `status
   --short` and `log` all correct, and **no `safe.directory` was needed**.
3. `wsl.exe --cd <path>` accepts a `/mnt/c/…` path and works.
4. WSL does not inherit the Windows environment, so `XDG_*` must be exported inside the script.
