# agentyard — Implementation Plan (2026-08-24)

Status: **accepted 2026-08-24.** All asked decisions settled; D5 and D7 stand on their
recommendation. M0 (scaffold) executed on acceptance — see `HANDOFF.md` for where the build actually
is.

> This is a **transient doc**: the design of record as it stood on 2026-08-24. It will drift as the
> code lands and is kept for the reasoning, not as a status page. Durable facts extracted from it
> live in `docs/cost-model.md` and `docs/glossary.md`, which *are* maintained.

| | Decision | |
|---|---|---|
| **D1** Topology | Daemon + thin Electron client; `orchestratord` survives closing the window | ✔ |
| **D2** Controller | Deterministic core + LLM advisor on discrete events | ✔ |
| **D3** Accounts | Controller owns all accounts, commissioned from an in-app settings page (§6.4) | ✔ |
| **D4** Build order | M1 fleet → M2 tasks → M3 cost | ✔ |
| **D6** Name / licence | `agentyard`, Apache-2.0 | ✔ |
| **D8** Cross-account resume | Transcript moves, cache does not — shrink before moving (§8.8) | measured |
| **D9** Project | A directory; git optional | ✔ |
| **D10** Objectives | Cost / velocity / quality as a weight vector, modelled now, tuned later (§4) | ✔ new |
| **D11** Cost models | Versioned data files, never inline arithmetic (§3.4) | ✔ new |
| **D12** Resources | Shared external resources are first-class scheduler claims (§10) | ✔ new |
| **D18** Who creates work | Any principal — human, controller, or a worker agent mid-run. Bounded by inherited mandates and budgets (§7.2) | ✔ new |
| **D13** Workspaces | Pooled **git worktrees**; branch created in the claimed worktree, named after the *task*; trunk never used by agents (§10.1) | ✔ |
| **D14** Landing | A **strategy interface**. v1 ships `auto-land`; `leave-branch` and `pull-request` slot in later without scheduler changes (§10.2) | ✔ |
| **D15** Config | Policy committed at `.agentyard/project.json`; runtime state private in app data (§7.1a) | ✔ |
| **D17** Autonomy | Bounded — free within inherited mandate and budget; controller gate on commit/push/spend/depth>2; human gate on irreversible (§7.2) | ✔ |
| **D16** Notifications | Desktop notification + persistent My Queue badge; tray and push are v2 | ✔ |
| **D5, D7** | Permission default; wrap vs absorb — recommendations stand | open |

---

## 1. Thesis

Most open-source agent orchestrators solve: *spawn N agents in N worktrees, show a board*. That is
not the problem. The problem is **a scheduler with a budget**, and the budget has an unusual shape:

- **per account**, refilling on 5-hour and 7-day clocks, and **non-fungible** — account A's window
  cannot help account B;
- **destroyed by idleness** — a warm prompt cache expires and costs 2.0× to rebuild;
- **cheapest where context already lives** — 0.1× read vs 2.0× write is a 20× spread, larger than any
  model-choice saving;
- **structurally different per vendor** — Anthropic prices a TTL multiplier, Google prices cache
  *storage over time*. The arithmetic is not portable.

So the differentiator is **routing a task to the worker, session and moment where it is cheapest**,
under an objective the user chooses. Everything else on the requirement list is either an input to
that decision or a consequence of it.

Vocabulary: a **fleet** of **workers**; each worker hosts **sessions**; sessions run **tasks** inside
**workspaces**, contending for **resources**.

---

## 2. What is measured

Nothing load-bearing here is assumed. Sources are named so any claim can be re-checked.

### 2.1 Cache and cost — from the Claude docs, 2026-08-24

| Fact | Source |
|---|---|
| Cache write **1.25×** (5m TTL) / **2.0×** (1h TTL); cache read **0.1×** either way | prompt-caching |
| **A cache read refreshes the TTL at no cost.** "The cache is refreshed for no additional cost each time the cached content is used." | prompt-caching |
| TTL runs **from the start of the request** that writes or reads it — a 4-minute response eats 4 minutes of the hour | prompt-caching |
| Minimum cacheable prefix: **512** tok (Opus 5, Fable 5), **1,024** (Sonnet 5), **4,096** (Haiku 4.5). Below that, no caching and **no error** | prompt-caching |
| Max **4** cache breakpoints per request | prompt-caching |
| Invalidation cascades `tools → system → messages`. **Changing tool definitions invalidates everything.** Effort and thinking parameters are model-dependent | prompt-caching |
| Caches are **isolated per workspace within an organization** (org-level on Bedrock/Google Cloud) | prompt-caching |
| A cache entry is only available **after the first response begins** — parallel requests on one prefix both pay a write | prompt-caching |
| Context windows: **1M** on Opus 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6, Fable 5, Mythos 5 — default, no beta header, standard pricing. 200k elsewhere | context-windows |
| **"Context rot" is documented**: "As token count grows, accuracy and recall degrade." Not folklore | context-windows |
| **Context awareness is a per-model capability.** Sonnet 5 / 4.6 / 4.5 and Haiku 4.5 receive injected `<budget:token_budget>` and `<system_warning>Token usage: X/Y` tags. Opus 4.7+, Fable 5, Mythos 5 **do not** | context-windows |
| Claude 4.7+ / Fable 5 / Mythos 5 use a **new tokenizer: ~30% more tokens for the same text.** Counts are not comparable across generations | token-counting |
| Token counting endpoint is **free**, separate rate limits, does not use caching | token-counting |
| Any context reduction invalidates the prefix at the cut point and pays a write — hence `clear_at_least`, "clear enough to justify the invalidation" | context-editing |
| Server-side compaction bills a whole extra sampling iteration, reported in `usage.iterations[]`. **Top-level `input_tokens` excludes it** | compaction |

### 2.2 Harness surfaces — measured on this machine

| Fact | Where |
|---|---|
| The transcript already carries everything metering needs: `usage.iterations[]`, `cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens`, `cache_read_input_tokens`, `output_tokens_details.thinking_tokens`, plus per-record `effort`, `gitBranch`, `requestId`, `cwd`, `version` | `~/.claude/projects/*/*.jsonl`, sampled 2026-08-24 |
| **`/compact` takes ~2 minutes.** `compactMetadata.durationMs` = 139,207 and 116,245 on two real compactions (preTokens 549k and 329k) | same |
| Compaction economics over **118 real compactions**: summary S ≈ 5,631 output tok, post-compact P ≈ 12,243 tok | precompact `DESIGN.md` §5 |
| Idle must be measured from the **last assistant turn**, not file mtime | precompact `DESIGN.md` §6 |
| Post-compaction size lives in a later `compact_boundary` record, not the last turn | precompact §4b |
| `claude -p /usage` returns 5h / 7d percentages, answered by the CLI — no assistant turn, nothing billed, ~2s. Fallback `.claude.json` → `cachedUsageUtilization.utilization.limits[]` | precompact `usage.py` |
| `CLAUDE_CONFIG_DIR` per account isolates credentials — how N subscriptions become N workers | precompact `accounts.py` |
| `--session-id`, `--resume`, `--fork-session`, `--model`, `--effort`, `--permission-mode`, `--worktree`, `--autocompact`, `--max-budget-usd`, stream-json in/out, `--mcp-config` | `claude --help` 2.1.237 |
| Gemini CLI has `--session-id`, `--resume`, `-o stream-json`, `--worktree`, `--approval-mode`, `--acp` | `gemini --help` |
| A transplanted transcript **is** discovered by `--resume` in another config root (error moves from *no conversation found* to *not logged in*) | D8 spike, 2026-08-24 |
| Permanent worktree slots beat per-task worktrees on an 11.7 GB / 5,076-file repo | `magic_writer/scripts/worktree/README.md` |

### 2.3 Operational rules — from the owner's own experience

| Rule | Consequence |
|---|---|
| **`/compact` succeeds at any displayed utilisation below true 100%.** `/usage` rounds up, so a displayed 100% may be 99.99% and compaction still works. At *true* 100% it fails | There is a **point of no return** (§8.7). The scheduler must hold a compaction reserve. |
| Handing off through `HANDOFF.md` works but depends on remembering to ask for it | Automate it as a protocol, not a habit (§8.8) |
| Parallel agents in one checkout collide; git worktrees fixed it | Workspaces are claimed resources (§10) |
| Shared external tools (a browser-driven media generator) collide until something serialises them; locks were the first fix, an MCP queue the second | Generalise to **Resources** (§10) — make the lock unnecessary by owning the claim |

### 2.4 The limitation that goes away

precompact concluded: *"No way to trigger `/compact` in a running session from outside… only via
OS-level UI automation."* True of the **desktop app**. Not true of a session **we spawn in a PTY** —
we own stdin. `/compact`, `/usage`, ESC and any prompt are bytes written to the pty master. Actuation
becomes a function call. This is the main argument for the PTY-hosted design in §6.2.

---

## 3. The cost model

### 3.1 The four states of a session, priced

For a session holding context `C`, with output billed at 5× input (Opus 5: $25 vs $5 per MTok), in
input-token-equivalents:

| Move | Cost | Effect |
|---|---|---|
| **Keepalive** — send a trivial turn | `0.1·C` + ε | Cache read refreshes the TTL. **Buys another full hour.** Context unchanged |
| **Compact** — `/compact` over the pty | `0.1·C + 5·S` ≈ `0.1·C + 28k` | Context drops to `P ≈ 12k`. Takes ~2 min |
| **Let it expire, then resume** | `2.0·C` | Full cold rebuild |
| **Let it expire, never resume** | `0` | The context is gone |

The keepalive row is new, and it follows directly from *reads refresh the TTL for free* — a fact I did
not have in v0.3. Worked at `C = 300k`:

```
keepalive        30k per hour, indefinitely
compact          58k once, then 1.2k per hour (P is small)
expire + resume  600k
```

Compact overtakes keepalive at **≈ 2 hours of expected idleness**:
`58 + 1.2n = 30n → n ≈ 2.0`.

So the cache clock is a **three-way** decision driven by *expected time until this session is next
needed*, not a binary compact-or-not:

```
expected idle < ~1h   ->  do nothing, it will be resumed inside the TTL anyway
~1h .. ~2h            ->  keepalive at T+55m
> ~2h, and C > 60k    ->  compact  (precompact's measured break-even)
never                 ->  do nothing; both moves are pure waste
```

Two caveats that keep keepalive honest: it does **not** reduce context, so it does nothing for context
rot; and it **spends 5-hour quota**, so under a tight window a keepalive can cost more in scheduling
freedom than it saves in tokens. Both are priced by the objective in §4.

### 3.2 The compaction reserve

From §2.3: compaction works right up until true exhaustion, then stops. If a worker hits 100% while
holding a 300k session, that context is **stranded** — it cannot be compacted, cannot continue, and
its cache will expire long before the 5-hour window resets. The loss is `2.0·C` on the far side.

Therefore a hard gate:

```
worker.remaining_tokens  >=  Σ over live sessions on this worker of compact_cost(session)
                             ... at all times, not just at assignment
```

with `compact_cost = 0.1·C + 5·S`. When remaining budget approaches the reserve, the scheduler stops
dispatching to that worker and compacts its largest session **while it still can**. This is a
different gate from "will this task fit" (§8.3) and it is the more important of the two, because
running out of room to *finish* is recoverable and running out of room to *save* is not.

### 3.3 Metering correctness

Three traps, all avoidable because the transcript carries the data:

1. **Sum `usage.iterations[]`, not the top-level counts.** Compaction's own sampling iteration is
   excluded from the top level. A naive reader undercounts exactly the events we care most about.
2. **Read `cache_creation.ephemeral_1h_input_tokens` separately from `_5m`** — they price at 2.0× and
   1.25×. Claude Code writes 1h; do not assume it always will.
3. **Never compare token counts across tokenizer generations.** Claude 4.7+ / Fable / Mythos produce
   ~30% more tokens for the same text. The estimator keys on `(project, task_kind, model, effort,
   tokenizer_generation)`; a stored estimate whose tokenizer no longer matches is discarded, not
   scaled.

### 3.4 Cost models are data, not code (D11)

Anthropic prices a **multiplier on a TTL**. Google Vertex prices context caching partly as **storage
over time** and distinguishes implicit from explicit caching — a structurally different formula, not
a different constant. Antigravity's CLI will differ again. All of them move.

So no pricing arithmetic is written inline. A cost model is a **versioned data file**:

```
costmodels/
  anthropic.subscription.2026-08.json
  anthropic.api.2026-08.json
  google.vertex.2026-08.json
```

```jsonc
{
  "provider": "anthropic", "channel": "subscription",
  "schema_version": 1, "effective_from": "2026-08-01",
  "cache": {
    "kind": "ttl_multiplier",              // vs "storage_duration" for Vertex
    "read_multiplier": 0.1,
    "read_refreshes_ttl": true,
    "ttl_measured_from": "request_start",
    "ttls": [ {"id":"5m","seconds":300,"write_multiplier":1.25},
              {"id":"1h","seconds":3600,"write_multiplier":2.0} ],
    "min_cacheable_tokens": {"claude-opus-5":512,"claude-sonnet-5":1024,"claude-haiku-4-5":4096},
    "scope": "workspace",
    "invalidated_by": ["tools","system","images","tool_choice"]
  },
  "models": [ {"id":"claude-opus-5","context_window":1000000,
               "input":5.0,"output":25.0,"tokenizer":"v2"} ],
  "quota": {"kind":"rolling_windows","windows":[{"id":"5h"},{"id":"7d"},{"id":"7d_opus"}]}
}
```

The scheduler never multiplies anything itself. It asks the model object:
`costOfKeepalive(session)`, `costOfCompact(session)`, `costOfColdStart(tokens)`,
`cacheExpiryFor(session)`. A `storage_duration` implementation answers the same questions with
different internals, and Vertex's exact numbers get filled in **when the adapter is built and the
page can be read properly** — they are deliberately not guessed here.

`effective_from` is load-bearing: historical runs stay priced by the model in force at the time, so a
price change does not silently rewrite the estimator's training data.

---

## 4. Objectives — cost, velocity, quality (D10)

Different users want different things, and the same user wants different things on different days.
This is modelled now and tuned later; **nothing may branch on a mode name.**

```ts
Objective = { cost: number, velocity: number, quality: number }   // sums to 1
```

Presets, which are just named vectors:

| Preset | cost | velocity | quality |
|---|---|---|---|
| Economy | 0.70 | 0.15 | 0.15 |
| **Balanced** (default) | 0.34 | 0.33 | 0.33 |
| Velocity | 0.15 | 0.70 | 0.15 |
| Quality | 0.15 | 0.15 | 0.70 |

Resolution order: **global default → project override → task override.** The effective objective is
recorded on every Run, so "why did it pick that" is answerable months later.

What the vector actually drives — every one of these is a continuous function of the weights, not a
switch:

| Knob | cost ↑ | velocity ↑ | quality ↑ |
|---|---|---|---|
| Scheduler `W_cold`, `W_warm` | strongly prefer warm sessions | tolerate cold starts to start sooner | neutral |
| Concurrency per worker / across fleet | serialise onto warm sessions | fan out | neutral |
| Model + effort selection | cheapest capable model, low effort, prefer free local models | fastest model | strongest model, high effort |
| Cache clock (§8.6) | compact early and often | keepalive to stay hot | keepalive; avoid summary loss |
| Split vs whole (§8.4) | whole tasks — splitting manufactures cold contexts | split where the DAG is wide | whole tasks — less context loss at seams |
| `verification` default | `auto` | `not_required` | `required` |
| Preemption (§8.7) | preempt early, never risk overage | push through the boundary | preempt with a full handoff |
| Retry on failure | retry cheap, escalate late | retry immediately in parallel | escalate to a stronger model at once |

Implementation note so this stays honest: the objective is consumed in exactly two places — a
`weights(objective)` function feeding §8.4, and a `policy(objective)` object consulted by the cache
clock, model selector and preemption. Anything else reading the objective is a design smell.

---

## 5. Scope

**v1 non-goals:** hosted service; general CI; Kanban (tabular first — Kanban is a fine v2 addition,
just not the starting point); plugin marketplace; multi-machine fleets.

**Explicitly v2, agreed:** tray icon, launch-at-login, Kanban view, mobile/push notifications.

**Planned but not day 1:** the Antigravity CLI adapter is a **first-class target**, not an
afterthought — §9 is structured so adding it is a capability declaration plus a telemetry parser,
with no scheduler changes. Start with Claude Code.

---

## 6. Architecture

### 6.1 Process topology (D1)

```
  +-------------------------------------------------------------------------+
  | Electron app  (UI only - closing it stops nothing)                       |
  |  renderer: React + xterm.js + task table                                 |
  +---------------+---------------------------------------------------------+
                  |  localhost WS + HTTP, token-authed
  +---------------v---------------------------------------------------------+
  | orchestratord   - long-lived Node process                                |
  |                                                                          |
  |  scheduler -- objective -- quota ledger -- cache clock -- DAG            |
  |      |                                                                   |
  |  cost models (data)      resource broker (workspaces, external MCP)      |
  |      |                                                                   |
  |  worker pool --> adapters --> PTY / stream-json child processes          |
  |      |                                                                   |
  |  transcript tailer --> per-turn usage, ctx, idle, effort, branch         |
  |      |                                                                   |
  |  SQLite   +   MCP server (stdio + http) --> the controller agent         |
  +--------------------------------------------------------------------------+
```

The daemon survives UI close because the entire premise is unattended progress across quota windows.
It also gives the MCP server a stable endpoint and lets a future CLI share state.

### 6.2 Hosting a worker

| Mode | Visibility | Slash commands | Structured usage | Verdict |
|---|---|---|---|---|
| **PTY-hosted interactive CLI** | real TUI in xterm.js | yes — we own stdin | via transcript tail | **primary** |
| Headless `-p` stream-json in/out | events, no TUI | no | inline | secondary: batch workers, `--max-budget-usd` |
| Attach to a desktop app instance | already running | no | via transcript tail | avoid — quota accounting collides |

**The TUI is for humans; the transcript is for the machine.** No ANSI parsing ever determines state.
`--session-id` is minted by the controller, so the transcript path is known before the process starts.

**A cache rule that falls out of §2.1:** changing tool definitions invalidates the *entire* prefix.
So a session's MCP config is frozen for its lifetime, and workers on the same project get an
identical MCP config so their prefixes stay comparable. Changing `--effort` mid-session is
model-dependent invalidation — so effort is set at session start, and a task needing different effort
is a reason to prefer a different session, priced like any other cold start.

### 6.3 Stack

| Layer | Choice |
|---|---|
| Shell | Electron + electron-builder |
| Renderer | React + TypeScript + Vite |
| Terminal | `@xterm/xterm` + fit + serialize (backscroll survives UI reopen) |
| PTY | `@lydell/node-pty` (prebuilt; ConPTY on Windows) |
| Store | SQLite via `better-sqlite3`, numbered migrations |
| Daemon transport | HTTP + WS on 127.0.0.1, random port, token file |
| MCP | `@modelcontextprotocol/sdk`, stdio + http |

Native deps live in the daemon, never the renderer, so an Electron upgrade cannot break the fleet.
Cross-platform in code from day one; only Windows tested in v1.

### 6.4 Worker commissioning (D3)

Public open-source software: **nothing about one machine may be hard-coded** — not `C:\Dev`, not
`Claude`/`ClaudeSecond`/`ClaudeThird`, not a count of three, not that Claude is installed at all. A
stranger with one Gemini account and a local model must reach a working fleet from the UI. **This is
an M1 deliverable.**

**Settings → Workers** lists workers with adapter, label, live quota, enable toggle. *Add worker*:

1. **Pick an adapter** — auto-detected where possible (`claude`, `gemini` on PATH; a local
   OpenAI-compatible endpoint; a registered MCP service). Anything else pointed at by hand.
2. **Choose an isolation root** — `CLAUDE_CONFIG_DIR` for Claude. Default
   `<appdata>/agentyard/workers/<slug>`, created by the app. An existing root (including plain
   `~/.claude`) can be **adopted**, which is the path for someone who already has one account.
3. **Log in** — the wizard opens the vendor CLI in an **embedded PTY**, so their own OAuth flow runs
   in our terminal pane. agentyard never reads, stores, copies or proxies a credential.
4. **Verify and label** — run `probeQuota`, read back account identity, record `resets_at`.
5. **Policy** — enabled; **human-occupied** (quota tracked, never spent); max concurrent sessions
   (default **1**, because concurrent requests on one prefix each pay a write, §2.1); allowed
   projects; permission override; objective override.

Decommission closes sessions and marks the worker retired but **leaves the isolation root on disk**
unless deletion is explicitly requested. A credential store is not something a task manager removes
on a stray click.

A **Doctor** panel reports which CLIs were found and at what version, whether each worker answers
`probeQuota`, whether transcripts parse, whether the PTY backend loaded — so drift (§15) surfaces in
words rather than as a silently degraded scheduler.

**Transcript isolation.** Each worker's sessions live under its own root, so ownership is unambiguous
and precompact's Windows-only `projects` junction is unnecessary — good for portability. The cost is
that cross-account resume needs a transcript copy (§8.8).

---

## 7. Domain model

```
Project      a directory + policy.  vcs: git | none  (D9)
 +- Workspace  where a run executes. git: trunk or a pooled checkout. plain: the directory
Resource     anything contended for: workspaces, an exclusive browser profile, a credit-metered
             external service, a port range, a device                                  (§10)
Worker       an account/endpoint = a quota bucket + an adapter
 +- Session    one live agent process: model, effort, workspace, session_id, ctx_tokens,
               last_request_started_at, cache_expires_at, topic fingerprint, transcript path
Task         a thread of work with an assignee                                          (§7.1)
 +- Run        one attempt on one session; carries the actuals and the effective objective
```

`Worker ≠ Session` is the split that matters: **quota** lives on the worker, **context** lives on the
session, and routing must satisfy both.

A project declares capabilities the way an adapter does — `{vcs, workspacePoolSize, commitFlow,
testCommand}` — and the scheduler reads them rather than assuming. A plain directory is a workspace
pool of size 1, so two runs queue instead of colliding; identical mechanism, different capacity. A
task requiring `commitFlow` on a project without it is rejected at **admission** with a reason, not
halfway through a run.

### 7.1 Task — a thread, not a prompt

Confirming the human-in-the-loop model: `awaiting_human` exists, and it is backed by a real
conversation rather than a flag.

```ts
Task {
  id, project_id, title,
  thread: Message[],              // {role: human|agent|system, blocks, ts, run_id}
                                  // blocks are multimodal: text | image | file-ref
  created_by: 'human' | 'controller' | {worker_id, session_id, run_id},   // §7.2
  parent_task_id?, lineage_depth: int,
  mandate: Mandate,               // authority; inherited and narrowed, never widened
  budget: {granted_tokens, spent_tokens},
  assignee: worker_id | 'human' | null,
  assignee_hint?: 'human' | 'any' | worker_id,   // creators suggest; the controller decides
  priority: P0..P3, deadline?, objective?,          // objective overrides project default
  est_effort?: {tokens, minutes, confidence},
  depends_on: task_id[],
  not_before?,
  requires: [{resource_id, amount}],                // §10 — workspaces included
  constraints: { worker?, session?, adapter?, model?, effort?,
                 workspace_policy: trunk|pooled|direct|any,
                 needs: ('manualCompact'|'commitFlow'|'multimodal'|...)[]  },
  verification: required | not_required | auto,
  preemptible: bool,
  status: draft|ready|blocked|scheduled|assigned|running
        | awaiting_human|paused_quota|completed|failed|cancelled,
  handoff_note?, artifacts: {commit?, branch?, files[], hashes[]}
}
```

**The human round-trip**, which is the Asana-shaped part:

```
agent needs an answer
   -> assignee = 'human', status = awaiting_human, question appended to thread
   -> appears in My Queue
human answers
   -> reply appended to thread, assignee = worker, status = running
   -> reply is delivered INTO THE SAME SESSION if its cache is still warm
```

That last line is the whole reason to model it this way. A human reply into a warm session costs
`0.1·C`; the same reply into a dead session costs `2.0·C`. **`awaiting_human` is therefore the single
most valuable place to spend a keepalive** (§8.6) — human latency is routinely 10 minutes to 10
hours, which straddles the 1-hour TTL almost perfectly.

Detecting that human input is needed, in order of reliability:

1. **Explicit** — the agent calls the MCP tool `request_human(question, blocking?)`. Primary; the
   project's injected guidance tells agents it exists.
2. **Permission prompt** — the adapter reports the CLI is waiting on an approval. Structural, reliable.
3. **Heuristic** — the session went idle on a turn ending in a question. Flagged low-confidence,
   surfaced as "possibly waiting on you", never auto-blocking.

### 7.1a Project configuration (D15)

Policy is **committed in the repo**; runtime state stays private.

```
<project>/.agentyard/project.json      committed - policy, reviewable, travels with the repo
<appdata>/agentyard/state.db           private   - tasks, runs, usage, transcripts index
```

```jsonc
{
  "schema_version": 1,
  "name": "inklands",
  "vcs": "git",
  "objective": "balanced",                       // §4; per-task override still allowed
  "workspaces": { "poolSize": 3, "root": "../inklands_workspaces" },
  "prepare": ["npm ci"],                         // §10.1
  "check":   ["npm test", "npx tsc --noEmit"],   // gates landing
  "landing": { "strategy": "auto-land", "target": "main" },   // §10.2
  "permission": { "mode": "acceptEdits", "allow": ["Bash(git *)", "Edit"] },
  "env": { "portBase": 3000, "portsPerWorkspace": 2 },
  "resources": [ {"ref": "chrome-profile"}, {"ref": "flow-credits"} ],
  "mandate": { "allowed": ["read","write","commit","spawn_tasks"],
               "max_lineage_depth": 3, "max_children": 5 }        // §7.2
}
```

Committing this is what lets a second machine, a collaborator, or a fresh clone reproduce the same
fleet behaviour — and for an open-source tool, it means a project can ship a sensible agentyard config
the way it ships an `.editorconfig`. Nothing secret goes in it: no credentials, no account
identifiers, no paths outside the repo except the workspace root, which is relative.

### 7.2 Work begets work — agents create and assign tasks too

This is not a pipeline where humans file tickets and agents close them. **Any principal can create a
task**: a human, the controller, or a worker agent mid-run that discovers something out of scope.
A worker's discovery may need a human ("which tone should this take?"), another agent ("this needs a
test suite"), or itself later. The controller routes, and routing includes deciding whether the task
should exist at all.

That makes agentyard a system that **generates its own work**, and the failure mode is specific: task
explosion. Agent A files three follow-ups, each of which files three more, and a 5-hour window
evaporates into self-referential scaffolding. Heuristics will not contain this reliably. Structure
will.

**Mandate + budget: bounded by construction.**

```ts
Mandate {
  project_ids: string[]              // never wider than the parent's
  allowed: ('read'|'write'|'commit'|'push'|'spawn_tasks'|'external_resources')[]
  max_lineage_depth: int             // decrements each generation
  max_children: int                  // fan-out cap per task
  requires_approval_above: {tokens, blast_radius}
}
```

Every task inherits its creator's mandate **narrowed, never widened**, and a *share* of the creator's
remaining budget. A human-created task has the project's full mandate and a budget from the project's
allowance. A depth-3 agent-created task with `spawn_tasks` already dropped simply cannot create a
depth-4 one — not because a heuristic caught it, but because it has no such authority. Budget is
likewise inherited: children draw down the parent's grant, so a subtree cannot outspend its root no
matter how many nodes it grows.

**Risk assessment, which is the controller's judgment call (§11).** For each agent-created task:

| Dimension | Signal |
|---|---|
| Blast radius | read-only · writes files · commits · pushes · touches a shared Resource · irreversible |
| Cost | estimate vs the parent's remaining budget and the fleet's remaining quota |
| Provenance | lineage depth — how many agent generations from a human intent |
| Novelty | similarity to existing open tasks — dedup, or merge into one |
| Reversibility | is there a commit to revert, or is the effect outside git |

Outcome is one of three, and the objective (§4) moves the thresholds:

```
auto            -> admitted straight to the queue
controller-gate -> the LLM controller reviews, may merge/reject/rescope        (cheap, no human)
human-gate      -> assignee = 'human', status = awaiting_human                 (My Queue)
```

Defaults: read-only and small → auto. Anything that commits, pushes, spends an external Resource's
credits, exceeds its parent's remaining budget, or sits above `lineage_depth 2` → at least a
controller gate. Irreversible or outside-git effects → human gate regardless of objective. **Cycle
detection runs on every dependency edge added**, since agent-authored DAGs are where cycles actually
come from.

**Deduplication is a first-class step, not a nicety.** Parallel agents on related work reliably file
the same follow-up three times. Before admission, a new task is compared against open tasks in the
project (title/prompt similarity plus overlapping file paths); near-duplicates are merged and the
requesting run is told which task absorbed it.

**Everything is visible.** The task table carries an **origin** column (human / controller / which
agent), lineage is expandable in place, and `events` records the mandate and budget each task was
admitted under. An agent-generated subtree that has gone strange should be obvious at a glance and
cancellable at its root — cancelling a parent cancels its descendants.

*Governance defaults are* **D17**, *asked separately.*

---

## 8. The scheduler

Deterministic, zero tokens, every ~10s and on every event.

### 8.1 Admission

```
eligible(task) =
      status in {ready, scheduled}
  AND all depends_on completed
  AND now >= not_before
  AND project capabilities satisfy constraints.needs
  AND every required resource can be claimed          (§10)
```

### 8.2 Candidates

Every `(worker, session-or-new)` pair permitted by `constraints` and by adapter capability (§9). A
"new session" candidate exists per worker with a free workspace.

### 8.3 Hard gates — failing one discards the candidate

```
worker.remaining >= task.est_tokens * SAFETY(confidence, objective)
worker.remaining - task.est_tokens >= compaction_reserve(worker)        <- §3.2, the important one
worker.remaining_7d >= task.est_tokens
session.ctx + task.est_tokens < session.window * CTX_MAX
adapter provides every capability in constraints.needs
worker.live_sessions < worker.max_concurrent
```

### 8.4 Scoring

```
score = W_warm     · warm(session)          // 1.0 while cache alive, decaying to expiry
      + W_affinity · overlap(task, session) // shared files/dirs/topic
      - W_ctx      · rot(ctx_pct)           // ~0 below 50%, rising after — "context rot" is documented
      - W_switch   · (session.project != task.project)
      - W_qrisk    · quota_pressure(worker) // prefer the account that resets soonest
      - W_cold     · is_new_session
      + W_cap      · capability_fit(task, adapter, model, effort)
```

`W_*` come from `weights(objective)` (§4). Two requirements fall out rather than needing features:

- **"add X → test X → document X" land on one session** — `warm` and `affinity` both peak there,
  paying 0.1× reads instead of three 2.0× rebuilds.
- **Three big independent tasks go to three workers whole** — splitting manufactures cold sessions and
  `W_cold` prices them. Split-vs-parallel is an output of the cost model, not a mode.

### 8.5 Percent → tokens, learned

`/usage` reports percent; the gates need tokens, and no vendor publishes the conversion. Both signals
are available: exact per-turn tokens from the transcript, periodic percent from `/usage`. Fit a
rolling `tokens_per_percent` per `(worker, model, tokenizer_generation)`, sampled **only while exactly
one session was active on that worker** — which is also the answer to cross-contamination. Note that
token *attribution to a task* is always exact from that session's own transcript; only the calibration
needs isolation. Until enough samples exist, use a conservative constant and mark estimates
low-confidence, which widens `SAFETY` in §8.3.

### 8.6 The cache clock

Per session: `cache_expires_at = last_request_started_at + TTL`. Note **request start**, not response
end (§2.1) — a 4-minute response has already spent 4 minutes. precompact measured from the last
assistant turn, which errs ~1 response-length optimistic; we subtract the observed duration.

At **T+53m** (leaving margin for a ~2-minute compaction, §2.2):

```
1. An eligible task scores well against this session      ->  send it NOW
                                                              (an expiring asset becomes work at 0.1x)
2. awaiting_human, and expected reply < ~2h                ->  KEEPALIVE      (§3.1)
3. expected idle in ~1h..2h                                ->  KEEPALIVE
4. expected idle > ~2h AND ctx > 60k AND since_compact>25k  ->  COMPACT
5. quota tight, or compaction reserve at risk              ->  COMPACT NOW regardless (§3.2)
6. otherwise                                               ->  let it expire; if stale, HANDOFF + close
```

Move 1 did not exist for precompact — a watchdog has no queue to pull from. Moves 2 and 3 did not
exist in v0.3, because I did not know reads refresh the TTL for free. Between them they are the
largest saving this tool offers over running precompact beside manually driven windows.

`expected idle` is estimated from queue depth, dependency readiness, and — for `awaiting_human` — the
rolling median human response time, which the tool is uniquely positioned to measure.

### 8.7 Preemption at a window boundary

```
T-N        ->  inject "Wrap up. Commit what compiles, update HANDOFF.md with state and next
               steps. Do not start new work."   (N sized from the objective and the estimate)
then       ->  compact (keep warm past the reset) or close (successor is another worker)
task       ->  paused_quota, not_before = resets_at, handoff_note stored
```

`N` must cover the wrap-up turns **plus ~2 minutes of compaction plus the compaction reserve**. Under
a cost-weighted objective it is generous; under velocity-weighted it is tight and accepts the
occasional stranded context.

**Model-aware wrap-up.** Sonnet 5 / 4.6 / 4.5 and Haiku 4.5 receive injected remaining-budget tags and
can self-manage against them (§2.1). Opus 4.7+, Fable 5 and Mythos 5 do not — so for those, the
wrap-up injection must **state the remaining budget explicitly** rather than assume the model knows.
This is a per-model policy field, not a special case in the scheduler.

### 8.8 Cross-account continuation — shrink first, move second

D8 measured that a transplanted transcript *is* found and accepted. But cache scope is **per workspace
within an organization** (§2.1, documented — no longer an inference), so it does not travel. At
`C = 300k`:

| Route | Billed-equivalent |
|---|---|
| Raw transplant to account B | **~600k** |
| Compact on A while warm, transplant `P ≈ 12k` | **~82k** |
| HANDOFF.md, successor starts cold | **~40–80k** |

Raw transplant is a trap that looks like a free lunch and costs ~7×. Cross-account continuation always
compacts (where the adapter can) or writes HANDOFF (where it cannot — Gemini, Antigravity), then
moves. Both paths must exist regardless.

*Still unmeasured:* a second account actually completing a resumed turn. The M1 commissioning wizard
produces a second logged-in account as a side effect — verify it there.

### 8.9 Watchdogs

Stall (no turn for K minutes while running) · runaway (actual > 3× estimate) · loop (N turns, no file
writes, no tool diversity) · auto-resume (at `resets_at`, `paused_quota` → `ready`) · reserve breach
(§3.2 — compact the largest session immediately).

---

## 9. Adapters and per-agent policy

Capabilities alone are not enough: agents differ in *policy*, not just features.

```ts
interface AgentAdapter {
  id: string
  capabilities: {
    interactivePty, streamJson, resumeSession, forkSession,
    manualCompact,            // Claude yes; Gemini no; Antigravity no
    nativeWorktree, multimodalInput, mcp,
    quotaProbe: 'cli'|'api'|'none',
    models: ModelSpec[]       // {id, contextWindow, effortLevels, tokenizer,
  }                           //  contextAwareness: bool, strengths: TaskKind->score}
  policy: {
    contextManagement: { autoCompact?, keepaliveCost(ctx), compactCost(ctx), compactDurationMs }
    quota:      { windows[], reserveFor: 'compaction'|'none' }
    preemption: { wrapUpProtocol: 'handoff'|'compact'|'none', needsExplicitBudget: bool }
    costModel:  CostModelRef  // §3.4
  }
  spawn / send / interrupt / command / telemetry / probeQuota / close
}
```

The scheduler asks `capabilities` and `policy`. It never asks `if (adapter === 'claude')`. Concretely,
**Antigravity having no `/compact` is not a special case** — it makes moves 4 and 5 of the cache clock
unavailable, so the scheduler picks 1, 2, 3 or 6, and preemption falls back to `wrapUpProtocol:
'handoff'`. That is the whole change.

Routing between Claude and Antigravity is then just `capability_fit` plus hard needs:

| Task | Needs | Lands on |
|---|---|---|
| Long refactor, preemptible, high complexity | `manualCompact`, high reasoning | Claude Opus, high effort |
| Mechanical rename across 40 files | speed; no compact need | fast/cheap model, or a local LLM |
| Asset generation with monthly credits | a credit-metered Resource (§10) | the media worker |

Adapter roadmap: **claude-code** (M1) → **gemini-cli** (M5) → **antigravity-cli** (M5, first-class
target) → **openai-compatible/local** (M5, free so `W_qrisk = 0`; wins low-complexity work under a
cost-weighted objective).

---

## 10. Resources and external MCP services (D12)

The media generator is **an example, not a shipped component.** The generalisable problem it
demonstrates: an external tool with its own API, its own quota, and a hard concurrency limit, which
several agents will otherwise trample. The observed progression — a script, then collisions, then
hand-rolled locks, then an MCP queue — is the pattern to absorb.

**The insight: if the scheduler owns the claim, the lock is unnecessary.** Agents do not need to
coordinate, because nothing dispatches two claimants at once.

```ts
Resource {
  id, name,
  kind: 'exclusive' | 'counted' | 'rate_limited',
  capacity,                      // exclusive: 1 · counted: N
  quota?: { probe, unit, window, resets_at },   // e.g. credits per month
  provider: 'builtin' | 'mcp' | 'script',
  probe?: McpToolRef | Command,  // how availability is read
  queue_policy: 'fifo' | 'priority'
}
```

Tasks declare `requires: [{resource_id, amount}]`; the scheduler treats these exactly like workspaces
— a claim held for the duration of the run, released on completion or failure. **Workspaces are just
a Resource of kind `counted`**, which collapses two mechanisms into one.

This covers, with no new code per case: a pooled worktree checkout, a single Chrome profile, a
credit-metered generation API, a dev-server port range, a physical device, a flaky integration test
that must not run twice at once.

**Registering an external MCP service** (Settings → Resources): point at the MCP server, map one tool
to `probe` (returns availability/credits/reset), optionally map tools to claim/release, declare
capacity and queue policy. If the service already serialises internally, declare `capacity: 1` and
agentyard simply stops dispatching contenders — which is the outcome the hand-rolled lock was reaching
for. The repo ships this as a **documented worked example** plus a reference `Resource` definition;
it does not ship the generator.

---

### 10.1 Workspaces are git worktrees (D13)

Confirming the mechanics, because the failure mode you flagged is real: **the task branch is never
created in the trunk.**

```
<project>/                     TRUNK. Stays on main. Integration and landing only.
                               No agent ever runs here (unless a project explicitly opts in).
<project>_workspaces/
  ws1/  ws2/  ws3/             pool members: permanent `git worktree` checkouts,
                               created once, reused forever, sharing one .git object store
```

Lifecycle of one task:

```
claim ws2 (a counted Resource, §10)
  git -C ws2 fetch origin
  git -C ws2 switch -c agentyard/t123-fix-dialog origin/main     <- branch created IN ws2
  run project.prepare  (npm install, copy env, seed a DB - see below)
  ... agent works, commits on that branch, inside ws2 ...
land   (§10.2)
  git -C ws2 switch --detach origin/main                          <- park; branch is now free
release ws2
```

Three properties worth stating because they are the whole point:

- **Git enforces the isolation.** Two worktrees cannot check out the same branch — that is a hard
  guarantee, not a claim file. The claim file coordinates *scheduling*; git prevents *collision*.
- **The branch name carries the task, not the workspace.** `agentyard/t123-fix-dialog`, never
  `agent/ws2-fix-dialog`. That is the coupling you found confusing in the slot model, and it is gone:
  which workspace a task happened to land in is an implementation detail that never appears in
  history. Re-running task 123 later in ws1 produces the same branch name.
- **Pool size is per-project policy.** Size 1 serialises a project without any special case; a
  non-git project is a pool of one over the directory itself.

**The prepare hook, and the trap it exists for.** A fresh worktree has no `node_modules`, no `.env`,
no seeded database. magic_writer solved this by copying `node_modules` from the trunk on sync — and
that bit back, because a package installed inside a slot vanished on the next sync. So `prepare` is
declared per project and runs on claim, and the tool records what it did; a workspace whose lockfile
has drifted from the trunk's is re-prepared rather than patched. Per-workspace environment (port
offsets, database paths) is injected as `AGENTYARD_WORKSPACE_INDEX` plus project-declared derived
values, so nothing has to be hand-edited per checkout and no two workspaces can bind the same port.

### 10.2 Landing a finished task (D14)

You have not settled on one flow, and different projects genuinely want different ones — so landing is
a **strategy interface**, not a branch in the code:

```ts
interface LandingStrategy {
  id: 'auto-land' | 'leave-branch' | 'pull-request' | ...
  canLand(run, project): {ok: boolean, reason?: string}
  land(run, project): Promise<{commit?, pr_url?, branch?}>
}
```

**v1 ships `auto-land`**, matching how you work today: fetch, rebase the task branch onto
`origin/main`, run the project's check command, push to `main`, delete the branch. Linear history, no
surviving feature branches. It is gated — a task with `verification: required`, a failing check, or a
conflict falls back to `leave-branch` and raises a `awaiting_human` entry rather than forcing
anything.

**Landing is serialised.** Three workspaces finishing at once would each rebase onto an `origin/main`
that the other two are about to move, and the second and third rebases would race. So every project
has an implicit **exclusive Resource, `land:<project>`**, claimed for the duration of
rebase-check-push. This is not a special case — it is §10 doing exactly what it exists for, and it is
why landing is modelled as work the scheduler dispatches rather than something a run does on its way
out.

`leave-branch` and `pull-request` are implemented against the same interface later; `pull-request`
needs a remote and degrades to `leave-branch` without one. Selection is project policy with a
per-task override, so a repo can auto-land routine work and open PRs for anything touching a
sensitive path. Nothing about the scheduler, the workspace pool or the task model changes when a new
strategy is added — which is the point of writing it as an interface on day one rather than
retrofitting it.

---

## 11. The controller agent (D2)

Deterministic core; the LLM fires only on discrete events, so a scheduler running every 10 seconds for
weeks costs nothing and cannot hallucinate — and an LLM controller that exhausts its own window cannot
take the fleet down.

| Trigger | Question |
|---|---|
| New coarse goal | Decompose into a DAG. Prefer whole tasks; split only where genuinely wide. Estimate effort |
| Ambiguous routing (top two within ε) | Which worker/model/effort, and why |
| Task failed twice | Rewrite the prompt, escalate the model, or send to a human |
| **Agent filed a task at a controller gate** (§7.2) | Is this worth doing, is it a duplicate, is it correctly scoped, and who should do it — the risk assessment |
| Preemption imminent | Compact, hand off, or push through |
| Human types in chat | Converse; act via MCP tools |

The controller is a Worker in the fleet with its own quota, so **leadership delegation** is free: when
its window is nearly spent, the next judgment call routes elsewhere, or at the floor to the
deterministic default.

**MCP surface, in two tiers.** The controller gets the full set; **worker agents get a narrow one**,
because §7.2 means every running agent can now file work.

*Controller:* `fleet_status`, `task_list/get/create/update/split/assign/cancel/retry`,
`session_send/command/interrupt`, `estimate`, `schedule_at`, `resource_status`, `mandate_grant`.

*Worker agent (scoped to its own run, its own project, its own mandate and budget):*
`task_create(title, prompt, assignee_hint?, requires?, depends_on?)` · `task_link(dep)` ·
`request_human(question)` · `resource_status(id)` · `handoff(note)`.

Every worker-tier call is checked against the caller's `Mandate` before it takes effect, and rejected
calls return the reason so the agent can adapt rather than retry blindly. Deliberately absent from
both tiers: raw process spawn, raw SQL, filesystem outside project roots, and — from the worker tier —
any ability to widen its own mandate or assign directly to another worker.

---

## 12. UI and visual design

```
+------------+--------------------------------------------------------------+
| PROJECTS   |  Fleet:  [acct-1  5h ###--- 62% | 7d ##---- 41% | reset 1:47] |
|  v inkland |          [acct-2 ...] [gemini ...] [local qwen  inf]          |
|    trunk   |          cache: s-3ab 04:12(!)  s-9f1 41:06                   |
|    ws1  *  +--------------------------------------------------------------+
|    ws2  *  |  TASKS   > all / running / blocked / awaiting-me              |
|  > awardtr |  +----+---------------+---------+-------+------+------+----+ |
|            |  | #  | title         | status  | who   | from | est  | dep| |
|  RESOURCES |  | 12 | R8 questaudit | running | acct-1| you  | 40k  | -  | |
|   chrome * |  | 13 | fix dialog... | blocked |  -    | you  | 12k  |<-12| |
|   flow  3cr|  | 14 | render clips  | sched   | flow  | ctrl | 3cr  |3:00| |
|            |  | 15 | pick a tone   | YOU     | human | a-12 |  -   | -  | |
|  SETTINGS  |  | +- 16 add tests   | gated   |  -    | a-12 | 18k  |<-12| |
|            |  +----+---------------+---------+-------+------+------+----+ |
|            +--------------------------------------------------------------+
|            |  > TERMINAL (live TUI)  > CHAT  > THREAD  > DIFF  > LOG       |
+------------+--------------------------------------------------------------+
```

Sidebar: projects → workspaces, plus **Resources** with live availability. Task table is primary and
tabular, with an **origin** column (`you` / `ctrl` / the agent run that filed it) and agent-created
children nested under their parent — task 16 above was filed by the agent working task 12 and is
sitting at a controller gate (§7.2). Cancelling a parent cancels its subtree from that row. Fleet
strip shows what is currently held in the operator's head: quota bars, reset
countdowns, per-session cache countdowns (amber T+45m, red T+53m). Terminal tab shows the real TUI,
read-only until "take the keyboard" is toggled. Thread tab is the task conversation (§7.1). My Queue
is the human inbox.

**Visual direction — the brief was "sleek, not coarse".** Coarseness in tools like this comes from
three things, all avoidable: inconsistent spacing, saturated colour used decoratively, and type that
is too large and too varied. So:

- **Type.** UI: **Inter** (variable) — designed for dense product UI and legible at 12–13px; fallback
  `system-ui`. Terminal and all code: **JetBrains Mono** — unambiguous `0/O/l/1`, holds up at 12px,
  OFL-licensed so it ships with the app. Both are free and redistributable, which matters for an
  open-source binary.
- **Numbers.** `font-variant-numeric: tabular-nums` everywhere a number updates in place — quota
  percentages, countdowns, token counts. Without it every gauge jitters, which reads as cheap.
- **Scale.** Five sizes only: 11 (meta) / 12 (dense table) / 13 (body) / 15 (section) / 20 (title).
- **Density.** 28–32px rows. This is a control surface, not a landing page.
- **Colour.** Neutral greys carry structure; saturated colour is reserved for *state* — running,
  blocked, awaiting-human, over-budget, error. One accent, used sparingly.
- **Motion.** Only on state transitions, ≤150ms. No decorative animation.
- Dark-first with a real light theme, not an inverted afterthought.

---

## 13. Storage

```
projects, workspaces, resources, resource_claims, workers, sessions,
tasks, task_messages, task_deps, task_lineage, mandates, runs
turn_samples   (session_id, ts, request_started_at, in, out, thinking,
                cache_read, cache_write_1h, cache_write_5m, ctx_after, iteration_type)
quota_samples  (worker_id, ts, kind, percent, resets_at)
calibration    (worker_id, model, tokenizer_gen, tokens_per_percent, n, updated_at)
estimates      (project_id, task_kind, model, effort, tokenizer_gen, median_tokens, median_minutes, n)
cost_models    (id, provider, effective_from, json)
events         (append-only: every scheduling decision with its full candidate set, scores,
                and the effective objective)
```

`events` matters more than it looks: when the scheduler makes a bad call at 3am, the only fix is
being able to read why it chose what it chose.

---

## 14. Milestones

**M0 — Scaffold.** `git init`, `.gitignore` (`internal_docs/` excluded), `README.md`, `AGENTS.md`,
`HANDOFF.md`, `LICENSE` (Apache-2.0), `NOTICE`, `package.json` (`agentyard`), `docs/`,
`transient_docs/`. Electron + Vite + TS skeleton that opens a window.

**M1 — Fleet substrate + commissioning.** *"Anyone can add their accounts and drive them from one
window."* Daemon, SQLite, single-instance lock, localhost transport. Worker registry over isolation
roots. **Settings → Workers wizard, adapter detection, embedded-PTY login, Doctor (§6.4).** Quota
poller. PTY spawn/attach with minted `--session-id`. Transcript tailer producing per-turn usage
(summing `iterations`), context, idle-from-request-start, effort, branch. Shell: sidebar, fleet strip,
xterm.js pane. Cost-model loader (§3.4) with the Anthropic file. *Spike: a second account completing a
transplanted resume (§8.8).*

**M2 — Tasks, threads, resources, authorship.** Task/Run/thread schema, DAG, status machine,
`not_before`, `awaiting_human` + My Queue + `request_human`, task table with origin and lineage.
**Agent-authored work (§7.2)**: worker-tier MCP (`task_create`, `task_link`, `handoff`), mandate
inheritance, budget shares, fan-out and depth caps, cycle detection, dedup-at-admission, subtree
cancel. **Resource broker (§10)** with **pooled git worktrees** as its first implementation —
claim, fetch, task-named branch, `prepare` hook, per-workspace env, park and release (§10.1).
**Landing strategy interface with `auto-land`** (§10.2). `.agentyard/project.json` loader (§7.1a).
Scheduler v1: admission, dependencies, hard quota gates, manual pinning. *(Risk gating starts
rule-based here; the controller's judgment layer arrives in M4.)*

**M3 — Cost intelligence.** *The differentiator.* Cache clock with all six moves incl. **keepalive**
(§8.6). Compaction reserve (§3.2). Session-affinity scoring. Percent→token calibration. Estimator
from actuals. Preemption + HANDOFF protocol + auto-resume. Watchdogs. **Objective vector wired end to
end** (§4) with the four presets.

**M4 — Controller agent.** MCP server, controller as a fleet member, decomposition, routing
arbitration, failure triage, chat + thread panes, leadership delegation.

**M5 — Multi-provider.** `gemini-cli`, **`antigravity-cli`**, `openai-compatible`. Second and third
cost models. Capability-driven routing proven by the absence of `/compact`.

**M6 — Packaging.** electron-builder; macOS/Linux path + PTY verification; adapter loading from a
directory; additional landing strategies (`leave-branch`, `pull-request`); public README pass.
*(Tray, launch-at-login and Kanban are v2.)*

---

## 15. Risks

| Risk | Handling |
|---|---|
| Native modules in Electron | Prebuilt forks; pinned Electron; natives in the daemon only |
| **Pricing and cache models move** | §3.4 — versioned data files with `effective_from`; historical runs keep their original pricing; a stale model is a config update, not a release |
| Undocumented surfaces drift (transcript schema, `/usage` text) | Isolated readers with schema checks and hard fallbacks; degrade conservatively, never stall the scheduler; Doctor reports it in words |
| Unattended permissions | Per-project policy, default `acceptEdits` + allowlist, `bypassPermissions` opt-in behind a banner; agents in a pooled workspace, never the trunk; no push without approval or `verification: not_required` |
| Two agents in one checkout | Structurally prevented — no run without a claimed resource; git refuses two worktrees on one branch |
| **Stranded context at 100%** | The compaction reserve (§3.2) is a standing gate, not a check at assignment |
| **Task explosion** — agents filing work that files more work | Bounded by construction, not heuristics: mandates narrow each generation, budgets are inherited shares so a subtree cannot outspend its root, fan-out is capped, cycles are detected on every edge, near-duplicates are merged at admission, and cancelling a parent cancels its descendants (§7.2) |
| Estimator wrong early | Confidence shown; low confidence widens `SAFETY`; preemption exists because estimates are wrong |
| Controller as token sink | Deterministic core; every controller invocation is a Run with a recorded cost in the same table |
| Multiple subscriptions in public | Ordinary multi-account support, useful to anyone with a personal and a work account. README frames it as "multi-account, multi-provider fleet", not as multiplying one plan. Credentials are never read, stored or shared — §6.4 step 3 hands login to the vendor's CLI |
| Hard-coded local assumptions | Lint rule over absolute paths; CI run on a clean profile with **zero** workers — the app must open, say so, and offer the wizard |

---

## 16. Open decisions

Only two remain, both with a standing recommendation:

**D5** Permission default — recommend `acceptEdits` + allowlist, agents confined to a pooled
workspace, `bypassPermissions` opt-in per project behind a visible banner.

**D7** External resource services — recommend **wrapped**, never vendored: the media generator stays
where it lives and is referenced as a `Resource` (§10). The repo ships the pattern and a worked
example in `docs/`, not the component.

Everything else is settled; the table at the top of this document is the record.

---

## 17. What is still owed

1. Vertex/Antigravity **cache pricing numbers** — the pricing page truncated twice; deliberately not
   guessed. Fill when the adapter is built (M5); the schema in §3.4 already has a slot.
2. **Second-account resumed turn** (§8.8) — verify during M1 commissioning.
3. **`expected idle` estimator** (§8.6) — the keepalive/compact choice is only as good as this, and it
   cannot be designed further without real queue data. M3 ships a crude version (queue depth +
   dependency readiness + median human latency) and improves it from `events`.
