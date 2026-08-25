# agentyard — Implementation Plan (2026-08-24)

Status: **accepted 2026-08-24, amended 2026-08-25 (A1, A2).** M0-M2 executed — see `HANDOFF.md` for
where the build actually is.

> **Amendment A1 — 2026-08-25.** Three changes from owner review, each verified before being written:
>
> 1. **Gemini CLI is retired.** Google stopped serving individual accounts on **2026-06-18** and
>    replaced it with **Antigravity CLI (`agy`)**. `gemini-cli` leaves the adapter roadmap;
>    `antigravity-cli` is *the* Google adapter (§2.2, §9).
> 2. **D5 closes, and it closes per adapter.** Claude Code runs in **`auto`**; adapters with no
>    classifier — Antigravity, local models — run **ask + allowlist**. This is a capability, not a
>    table of names (§9.1).
> 3. **Two new objects.** An approval is an **interrupt on a session**, not a task (§7.3). **Cancel
>    is not delete**, and cancel lands in a chosen resting state (§7.4).
>
> **Amendment A2 — 2026-08-25.** Two sections the design was missing, both asked for after M2:
>
> 4. **§18 Worked scenarios.** What the pieces *do*, on real work — starting with the question this
>    repository is the answer to: a six-milestone plan is a **roadmap, not a task DAG**. Also surveys
>    how Agent Orchestrator, Vibe Kanban, Agent Kanban and Conductor answer the same question.
> 5. **§19 Testing plan.** Five levels organised by what a failure would *cost*, the fixture rules
>    that stop a test damaging the developer's own machine, and what is deliberately not tested.

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
| **D5** Permissions | Per adapter, from a capability: Claude Code `auto`; no-classifier adapters get ask + allowlist (§9.1) | ✔ A1 |
| **D19** Approvals | An approval is an interrupt on a session, not a task. Own queue, one-click, policy-answered, priced against the cache clock (§7.3) | ✔ A1 |
| **D20** Cancel / delete | Cancel winds a run down into a resting state and destroys nothing; delete is separate, soft by default, and never removes runs (§7.4) | ✔ A1 |
| **D21** Decomposition | A milestone plan is a **roadmap**: children created as `draft` with dependency edges up front, prompts written at promotion. Decomposition is itself a task (§18.1) | ✔ A2 |
| **D7** | Wrap vs absorb — recommendation stands | open |

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
| `--session-id`, `--resume`, `--fork-session`, `--model`, `--effort`, `--permission-mode`, `--worktree`, `--autocompact`, `--max-budget-usd`, stream-json in/out, `--mcp-config` | `claude --help` 2.1.223 |
| `claude --permission-mode` accepts **`auto`**, `acceptEdits`, `bypassPermissions`, `manual`/`default`, `dontAsk`, `plan`. `auto` is the built-in start mode on Pro/Max/Team **in a terminal only** — `-p` and the Agent SDK start in `default` | `claude --help` 2.1.223 + *Choose a permission mode*, 2026-08-25 |
| **`--permission-prompt-tool <tool>` exists**: an MCP tool agentyard serves that answers permission prompts, non-interactive mode only. Undocumented in `--help`, but the parser accepts it | `claude --permission-prompt-tool` → *option argument missing*, 2.1.223, 2026-08-25 |
| **Gemini CLI stopped serving individual accounts on 2026-06-18** and is superseded by **Antigravity CLI (`agy`)**. Gemini Code Assist Standard/Enterprise licences keep the old CLI | Google Developers Blog, *Transitioning Gemini CLI to Antigravity CLI*, read 2026-08-25 |
| `agy` has `-p/--print`, `--output-format text\|json\|stream-json`, `-c/--continue`, `--conversation <id>`, `--model`, `--effort`, `--agent`, `--json-schema`, `--dangerously-skip-permissions`. **No auto/classifier mode.** Permissions are `allow`/`ask`/`deny` rules shaped `action(target)` in `~/.gemini/antigravity-cli/settings.json` | antigravity.google/docs/cli, read 2026-08-25 |
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
        | awaiting_human|paused_quota|paused_user|cancelling|cancelled
        | completed|failed,                            // §7.4 adds the last three
  cancel?: {requested_by, requested_at, reason?, resting_state},   // §7.4
  deleted_at?,                                          // soft delete; §7.4
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
2. **Permission prompt** — the adapter reports the CLI is waiting on an approval. Structural and
   reliable, and it is **not** a task: see §7.3, where it becomes one only if it goes unanswered.
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

### 7.3 Approvals are not tasks (D19, A1)

An agent asking *"may I run `npm publish`?"* and an agent asking *"should this be REST or gRPC?"*
look alike in a UI and are nothing alike in the scheduler. Filing the first as a Task is wrong on
every axis a Task exists for:

| A Task | An approval |
|---|---|
| can be scheduled for later | **blocks a live session right now** |
| can be reassigned to another worker | only *that* session can consume the answer |
| carries dependencies, effort, a budget | carries none — the answer set is fixed and finite |
| is worth a row someone will re-read | would bury the table in rows nobody re-reads |
| outlives the session | is void the moment the session dies |

So there is a second, lighter object, deliberately not a Task:

```ts
Approval {
  id, session_id, run_id, task_id?,        // task_id is context, not ownership
  origin: 'permission_prompt' | 'tool_gate' | 'resource_gate',
  action: {tool, target, command?, diff_summary?},
  options: Answer[],                       // supplied by the adapter, never invented here
  policy_result: 'auto_allow' | 'auto_deny' | 'escalate',
  matched_rule?, asked_at,
  deadline_at,                             // = the blocked session's cache expiry
  answered_at?, answer?, answered_by
}
```

**Three resolutions, in order of preference:**

1. **It never happens.** The best approval is the one the agent's own mode absorbs — Claude Code's
   `auto` classifier, or an Antigravity `allow` rule. That is D5 (§9.1), and it does most of the work.
2. **Policy answers it.** agentyard evaluates the project's own rules and answers without a human.
3. **A human answers it in one click**, from an **Approvals bar** — not by opening a task.

**Why one click is achievable here and not for tasks:** the answer set is closed and supplied by the
adapter. A persistent bar above the task table showing *session · action · countdown* takes one
keystroke to clear — `a` allow, `d` deny, `↵` allow-and-remember. The remember offer ("always allow
`Bash(npm test)` in inkland?") is the important half: it converts a recurring interruption into a
rule, so the queue empties itself over time instead of growing. An approval never becomes a table row,
never gets an estimate, and never appears in My Queue.

**The countdown is real money, which is why this is not a notification.** A blocked session is idle,
and idle burns the cache clock (§8.6). So waiting is priced like everything else:

```
expected answer < ~1h         -> do nothing; the TTL covers it
expected answer ~1h .. ~2h    -> KEEPALIVE the blocked session (0.1*C buys the hour)
expected answer > ~2h         -> the answer will not arrive in time:
                                 auto-deny-and-continue where the policy permits,
                                 else preempt — handoff, compact, release the workspace
unanswered past escalate_after (default 30m)
                              -> NOW it becomes task work: task -> awaiting_human,
                                 the question is appended to the thread, the session
                                 is released on the cache clock (§7.1)
```

That last rule is the only place the two objects meet, and it is placed where it is for a reason: an
approval becomes a task exactly when it stops being an interrupt and starts being a decision someone
has to schedule — which is also the moment holding a session open for it stops paying for itself.

**Capture mechanism, per adapter — and ⛔ never by scraping the TUI.** The standing rule that no ANSI
parsing determines state binds hardest here, because a mis-read approval card is an unattended *yes*.

| Adapter | Where the approval comes from | Status |
|---|---|---|
| `claude-code`, `stream` transport | **`--permission-prompt-tool <mcp tool>`** — the CLI calls a tool agentyard serves and blocks on the reply | flag accepted by 2.1.223, 2026-08-25 |
| `claude-code`, `pty` transport | none — the session's own `auto` classifier absorbs it (§9.1). Anything it escalates is a human sitting at the terminal, by definition | by design |
| `antigravity-cli` | `allow`/`ask`/`deny` rules written into the worker's isolation root before spawn; `ask` hits arrive over `stream-json` | to verify at M5 |

⚠️ **`--permission-prompt-tool` is non-interactive only.** A session hosting the vendor's real TUI has
no such channel. §9.2 resolves that with two transports rather than with a parser.

### 7.4 Cancel is not delete (D20, A1)

Stopping work and forgetting an intent are different operations, and a single `×` button conflates
them. They are separated.

**Cancel** stops execution and returns the task to a **resting state**. It destroys nothing — not the
thread, not the runs, not the artifacts, not the branch.

```
running | assigned | scheduled | awaiting_human | blocked | ready
     -- cancel(reason, resting_state) -->
                    cancelling                       (asynchronous — a run is winding down)
     -->            paused_user | draft | cancelled
```

`cancelling` is a real state, not a formality, because a running session has to be stopped *well*. The
wind-down is the preemption protocol of §8.7 run at low urgency:

1. **`interrupt`** through the adapter — the ESC equivalent. Never a process kill.
2. **Ask for a wrap-up**: commit whatever compiles on the task branch, write `handoff_note`.
3. **Release every claim** — workspace, resources, and the `land:<project>` lock if held. ⛔ A cancel
   that leaks an exclusive resource deadlocks the fleet, so release is not conditional on the wrap-up
   succeeding.
4. **Decide the session's fate on the cache clock (§8.6), not reflexively.** A `paused_user` task
   whose context is warm and which may resume in ten minutes is worth a keepalive; one going to
   `cancelled` is worth closing immediately.
5. **Cancel the subtree** — agent-created descendants (§7.2) cancel with the *same* resting state, so
   an operator who paused a parent does not find its children destroyed.

A hard **kill** exists behind a confirmation, for a session that will not wind down. It skips steps
1–2 and marks the run `terminated`, so the estimator does not train on a truncated run as if it were
a normal one (§8.5).

**The three resting states, and when each is right:**

| Resting state | Means | Re-entry |
|---|---|---|
| `paused_user` | *not now* — the intent is intact and correct | resume → `ready`, keeping thread, handoff, branch and estimates |
| `draft` | *not like this* — the intent needs rewriting first | edit → `ready`, and it **re-enters admission** (§8.1): dependencies re-checked, duplicates re-merged |
| `cancelled` | *not at all* — terminal, but still on the record | reopen → `draft` |

Defaults, because the operator should not have to answer a dialog to stop something: **`paused_user`**
when a human cancels a running task, since that is what *stop* means to a person watching something go
wrong; `draft` when the cancel reason names the prompt; `cancelled` when the controller cancels work it
has judged redundant.

⛔ **Quota preemption keeps `paused_quota` and never becomes a cancel.** They resume differently:
`paused_quota` carries `not_before = resets_at` and auto-resumes; `paused_user` waits for a person,
indefinitely. Collapsing them would have the fleet cheerfully restart work an operator deliberately
stopped.

**Delete** is separate, explicit and destructive:

- **Only from a resting state** (`paused_user`, `draft`, `cancelled`, `completed`, `failed`). A
  running task must be cancelled first — delete has no way to wind a session down.
- **Soft by default.** `deleted_at` is set, the row leaves the table, and it is recoverable. Hard
  delete purges thread and messages after a retention window.
- ⛔ **Runs are never deleted with the task.** They are the estimator's training data and they record
  real spend; they detach to the project's cost history. A tool that lets an operator erase the record
  of what a month cost is lying to them about the next month.
- **Blocked while it still matters**: descendants that are not themselves deleted, or a live task
  depending on it. The blocker is shown as a list, not as a refusal.

Both operations are available to the controller and to agents through the worker-tier MCP surface —
`task_cancel(id, resting_state, reason)` — under the same mandate that governs creation (§7.2), and
`task_delete` is **human-only**. An agent that can delete the record of its own failed work is an
agent that can hide it.

**In the UI**: cancel is a row action and a keystroke on the task table, with subtree count shown
before it fires; delete sits behind the row menu, and hard delete asks for a typed confirmation.
Neither appears on the Approvals bar — an approval is *answered*, never cancelled (§7.3).

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
    manualCompact,            // Claude yes; Antigravity no
    transports: ('pty'|'stream')[],          // §9.2
    permissionModes: string[]                // §9.1
    classifierBackedAuto: boolean,           // Claude yes; Antigravity no
    approvalChannel: 'permission_prompt_tool'|'settings_rules'|'none',
    nativeWorktree, multimodalInput, mcp,
    quotaProbe: 'cli'|'api'|'none',
    models: ModelSpec[]       // {id, contextWindow, effortLevels, tokenizer,
  }                           //  contextAwareness: bool, strengths: TaskKind->score}
  policy: {
    defaultPermissionMode: string,           // §9.1 - Claude 'auto'; others ask+allowlist
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

Adapter roadmap (A1): **claude-code** (M1) → **antigravity-cli** (M5, the Google adapter) →
**openai-compatible/local** (M5, free so `W_qrisk = 0`; wins low-complexity work under a cost-weighted
objective).

⛔ **`gemini-cli` is not on the roadmap.** Google stopped serving individual accounts on 2026-06-18 and
`agy` replaces it (§2.2). It survives only under a Gemini Code Assist Standard/Enterprise licence,
which is not this tool's audience; if someone with one asks, it is a community adapter, not a
milestone. Writing it would have meant building an adapter against a dead CLI for two months' work.

### 9.1 Permission policy, per adapter (D5 — closed by A1)

D5 asked for *one* default. There isn't one, because the underlying capability differs:

| Adapter | Mode | Why |
|---|---|---|
| `claude-code` | **`auto`** | A classifier reviews each action in place of the operator. It is also the built-in start mode on Pro/Max/Team in a terminal, so it is what the owner already experiences by hand. |
| `antigravity-cli` | **ask + allowlist** | No classifier-backed auto mode exists. Permissions are `allow`/`ask`/`deny` rules shaped `action(target)` — `command(git)`, `read_file(src/)`, `mcp(linter/*)`, with wildcards and regex — in the worker's settings. agentyard writes the project's allowlist into the isolation root before spawn. |
| `openai-compatible` / local | ask + allowlist | Same reason: nothing is reviewing but the operator. |

⛔ In code this is **not** a table of adapter names. It is one capability and one policy field:

```ts
capabilities.permissionModes: string[]        // what this CLI actually accepts
capabilities.classifierBackedAuto: boolean    // is there a reviewer that is not the human?
policy.defaultPermissionMode: string
policy.approvalChannel: 'permission_prompt_tool' | 'settings_rules' | 'none'
```

The scheduler asks `classifierBackedAuto`. When it is false, agentyard compensates by writing a
**narrower** allowlist and expecting a higher approval rate (§7.3) — a policy consequence, not a
branch. `bypassPermissions` / `--dangerously-skip-permissions` stays opt-in per project behind a
visible banner, unchanged from the original D5 recommendation.

**Three consequences worth writing down, because each one bites silently:**

1. **`auto` is not the default under `-p`.** The built-in `auto` applies to a *terminal* session on
   Pro/Max/Team. `claude -p` and the Agent SDK start in `default`, and an `"auto"` value for
   `defaultMode` in a project settings file is ignored outright. **agentyard must pass
   `--permission-mode auto` explicitly on every spawn** — left implicit, every scheduled run is
   silently Manual and stalls on its first shell command with nobody watching.
   *(Source: Claude docs, "Which mode a session starts in", 2026-08-25.)*
2. **Auto mode drops broad allow rules.** On entering auto, blanket `Bash(*)` / `PowerShell(*)`,
   wildcarded interpreters like `Bash(python*)`, package-manager run commands, `Agent` rules and
   `Monitor` rules are discarded; narrow rules such as `Bash(npm test)` survive. So the allowlist
   agentyard generates per project must be **written narrow**, or it is dropped exactly where it was
   meant to help.
3. **The classifier's token cost on a subscription is unmeasured.** The docs state that classifier
   calls count toward usage on Enterprise plans and on API / Bedrock / Vertex / Foundry accounts, and
   say nothing about Pro/Max/Team. ⛔ Do not read that silence as *free*. Measure it in M3 — the same
   task, metered with auto on and off — before any scheduling decision leans on it. Recorded in §17.

### 9.2 Session transport (A1)

§7.3 leaves a real tension: the structured approval channel exists only in non-interactive mode, and a
live vendor TUI exists only in a PTY. Resolve it with **two transports selected by capability**, never
by parsing a screen:

| Transport | How it runs | Approvals | Human can type |
|---|---|---|---|
| **`stream`** | `-p --input-format stream-json --output-format stream-json --permission-prompt-tool …`; agentyard renders the live view from structured events | structured, blocking, policy-answerable | no |
| **`pty`** | the vendor CLI in a real PTY, its own TUI on screen | absorbed by the agent's own mode; whatever escalates faces a human who is already there | yes — "take the keyboard" |

Default: **`stream` for unattended scheduled work**, because that is the only transport where an
approval can be answered by policy at 3am; **`pty` when a human opens or takes over a session**.

They are not a fork in the road. Session ids are minted before spawn (§6.2), so a session can be
**closed on one transport and resumed on the other** — `--resume <id>` — which is precisely what "take
the keyboard" does. One session, two views of it.

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

*Controller:* `fleet_status`, `task_list/get/create/update/split/assign/retry`,
`task_cancel(id, resting_state, reason)` (§7.4 — **no `task_delete`; delete is human-only**),
`approval_list/answer` (§7.3), `session_send/command/interrupt`, `estimate`, `schedule_at`,
`resource_status`, `mandate_grant`.

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
|    ws2  *  |  ! acct-1/s-3ab  Bash(npm publish)   [a]llow [d]eny  38:12  |
|            +--------------------------------------------------------------+
|            |  TASKS   > all / running / blocked / awaiting-me              |
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
sitting at a controller gate (§7.2). Cancelling a parent cancels its subtree from that row, into a
resting state shown before the action fires (§7.4).

**The Approvals bar** is the strip between the fleet and the tasks, and it is empty almost always —
that is the design goal, not a shortfall (§7.3). When something does land there it shows session,
action and the live countdown to that session's cache expiry, and clears in one keystroke without
opening anything. It is deliberately *not* a task row, *not* My Queue, and *not* a modal: a modal
would block the operator from looking at the very terminal that would tell them whether to say yes.

Fleet strip shows what is currently held in the operator's head: quota bars, reset
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
**Cancel / delete (§7.4)**: `cancelling` wind-down reusing the preemption protocol, the three resting
states, subtree cancel, soft delete with runs detached to cost history. **Approvals (§7.3)**: the
`Approval` object, the agentyard MCP server behind `--permission-prompt-tool`, project rules,
the Approvals bar, remember-as-rule, and the 30-minute escalation into `awaiting_human`.
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

**M5 — Multi-provider.** **`antigravity-cli`** (the Google adapter — `gemini-cli` is retired, §9) and
`openai-compatible`. Second and third cost models. Capability-driven routing proven twice over: by the
absence of `/compact`, and by the absence of `classifierBackedAuto` (§9.1).

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
| Unattended permissions | Per-adapter default from a capability (§9.1): `auto` where a classifier exists, ask + **narrow** allowlist where it does not, `bypassPermissions` opt-in behind a banner. Residual prompts are structured `Approval`s answered by policy or one keystroke, never by screen-scraping a card (§7.3); agents in a pooled workspace, never the trunk; no push without approval or `verification: not_required` |
| Two agents in one checkout | Structurally prevented — no run without a claimed resource; git refuses two worktrees on one branch |
| **Stranded context at 100%** | The compaction reserve (§3.2) is a standing gate, not a check at assignment |
| **Task explosion** — agents filing work that files more work | Bounded by construction, not heuristics: mandates narrow each generation, budgets are inherited shares so a subtree cannot outspend its root, fan-out is capped, cycles are detected on every edge, near-duplicates are merged at admission, and cancelling a parent cancels its descendants (§7.2) |
| Estimator wrong early | Confidence shown; low confidence widens `SAFETY`; preemption exists because estimates are wrong |
| Controller as token sink | Deterministic core; every controller invocation is a Run with a recorded cost in the same table |
| Multiple subscriptions in public | Ordinary multi-account support, useful to anyone with a personal and a work account. README frames it as "multi-account, multi-provider fleet", not as multiplying one plan. Credentials are never read, stored or shared — §6.4 step 3 hands login to the vendor's CLI |
| Hard-coded local assumptions | Lint rule over absolute paths; CI run on a clean profile with **zero** workers — the app must open, say so, and offer the wizard |

---

## 16. Open decisions

One remains.

**D5 is closed by A1** (§9.1): permissions come from a capability, not a global default — `auto` for
Claude Code, ask + narrow allowlist for adapters with no classifier, `bypassPermissions` opt-in per
project behind a visible banner, agents confined to a pooled workspace throughout.

**D7** External resource services — recommend **wrapped**, never vendored: the media generator stays
where it lives and is referenced as a `Resource` (§10). The repo ships the pattern and a worked
example in `docs/`, not the component.

Everything else is settled; the table at the top of this document is the record.

---

## 17. What is still owed

1. Vertex/Antigravity **cache pricing numbers** — the pricing page truncated twice; deliberately not
   guessed. Fill when the adapter is built (M5); the schema in §3.4 already has a slot.
2. **Second-account resumed turn** (§8.8) — verify during M1 commissioning.
3. **Auto-mode classifier cost on a subscription** (§9.1) — documented as billable on Enterprise and
   API-billed accounts, unstated for Pro/Max/Team. Measure at M3 with the same task metered under
   `auto` and under `default`; until then no scheduling decision may assume it is free.
4. **Antigravity `ask`-hit shape** (§7.3) — that `agy` surfaces an approval over `stream-json` in a
   form agentyard can answer is inferred from its documented three-tier model, **not measured**.
   Verify when the adapter is built (M5); if it turns out to be TUI-only, the adapter loses
   `approvalChannel` and gains a narrower allowlist, which the design already accommodates.
5. **`expected idle` estimator** (§8.6) — the keepalive/compact choice is only as good as this, and it
   cannot be designed further without real queue data. M3 ships a crude version (queue depth +
   dependency readiness + median human latency) and improves it from `events`.

---

## 18. Worked scenarios (A2)

Everything above says what the pieces *are*. This section says what they **do**, on real work, because
that is where a design either holds together or quietly does not. Each scenario states what agentyard
does step by step, what it must **not** do, and which part of the design it exercises.

### 18.0 How other tools answer this

Worth knowing before deciding, because the shape of the answer is not obvious and several good tools
have picked different points on it. Read 2026-08-25:

| Tool | Decomposition model | What it does with dependencies |
|---|---|---|
| **Agent Orchestrator** (Untrivial) | Hybrid. A project orchestrator develops the larger outcome first, and *"when a plan becomes actionable, the orchestrator can break it into focused tasks, spawn or redirect workers, pass each worker the relevant context, follow their progress, and coordinate follow-up work."* | Not an explicit graph. The orchestrator holds the context and coordinates follow-up; the board surfaces state. Deliberately **human-in-the-loop over autonomous task-graph execution** |
| **Vibe Kanban** | A **planning ticket** is itself a task: an agent is told to decompose the work and generate the downstream cards. Issues and sub-issues; `PLAN → PROMPT → REVIEW` | Ordering is a board, not a DAG. Status moves when an agent starts and when a PR opens or merges |
| **Agent Kanban** | A **leader agent** plans and assigns; worker agents claim | Assignment, not dependency resolution |
| **Conductor** | None — it is an agent *manager*: parallel worktrees, one agent per task, a human reads every diff | None |

Two things stand out. **Nobody executes a full task graph autonomously**, and the one tool that comes
closest makes decomposition *a task in its own right* rather than a planning phase. Both of those
survive into what follows.

What agentyard adds is the axis none of them model: **cost**. A board can afford to be indifferent to
when a task runs. A scheduler with a budget cannot.

### 18.1 A six-milestone roadmap — the case this repository is

> *"The plan had M1 through M6. Does the tool create six tasks that depend on each other and work
> through them, or does the agent file M2 once M1 is done?"*

**Neither, and the difference matters.** A milestone plan is a **roadmap**, not a task DAG.

Create all six **up front, as `draft`**, each with a title, an acceptance criterion, and a
`depends_on` edge to its predecessor. Drafts carry the shape of the work and cost nothing: admission
skips `draft`, so nothing dispatches, nothing is assigned, and no worker is held.

Then promote **one at a time**, and — this is the load-bearing part — **write the prompt at promotion,
not at creation.**

```
M1..M6 created as draft, chained by depends_on        <- the horizon, visible from day one
M1 promoted: draft -> ready, prompt written now       <- promoteDraft() re-enters admission
M1 runs (many sessions, one task)
M1 completes -> admitDependents() -> M2 leaves blocked
M2 is still DRAFT. A human or the controller writes its prompt from the current handoff,
   then promotes it.
```

**The evidence for writing prompts late is this repository.** An M2 ticket written on 2026-08-24
would have said *"host sessions in a PTY."* M1 then measured that `--print` will not start under a
pseudo-terminal and that the workspace-trust dialog blocks a fresh worktree — and M2 shipped on real
pipes instead. An M3 ticket written on the same day would have said *"poll `claude -p /usage`."* That
turned out to spend a real assistant turn per poll. **Five of six prompts would have been rewritten,
and a stale prompt is worse than no prompt, because somebody follows it.**

So the split is:

| Written up front | Written just in time |
|---|---|
| Title, acceptance criterion, dependency edges, rough effort | The prompt, the constraints, the model and effort choice, the resource requirements |

**What the agent working M1 files with `task_create` is *discovered* work** — never the next
milestone. `which.ts` (node-pty does not search PATH) and *measure the auto-mode classifier cost* are
both real examples from this build: nobody could have written them at t=0, and both are exactly what
agent-authored tasks are for. Bounded by construction — the mandate narrows, the budget is a share,
fan-out is capped — so a milestone cannot quietly become forty tickets.

⛔ **Do not create six `ready` tasks and let the scheduler run them.** It looks tidier and it is wrong
twice over: five of the prompts are fiction, and the scheduler would happily dispatch M2 the moment M1
completes, with nobody having read what M1 learned.

⚠️ **A milestone is one task across many sessions, not one session.** M1 here took a dozen. `task`,
`session` and `run` are three different things, and preemption (§8.7) plus the handoff is what carries
one task across a quota boundary — see 18.3.

**Where the controller (M4) fits:** decomposition is a judgment call, so it is a *controller* job, and
following Vibe Kanban's better idea, **it is a task itself** — a `plan` task whose output is a set of
draft children. That keeps it visible, cancellable, billable to a budget, and re-runnable when the
plan turns out wrong. It is not a hidden phase.

### 18.2 Fan-out with a merge — "port 40 components to the new tokens"

The case orchestrators are built for, and the one where agentyard's answer is a **calculation** rather
than a preference.

```
1 task, 1 session      context grows across all 40; late components are cheap to read
                       (0.1·C per turn) but degrade with context rot, and one failure
                       stalls the lot
40 tasks, N sessions   each pays its own cold prefix (2.0·C_prefix); truly parallel, but
                       bounded by workspace pool size and per-worker maxConcurrent -
                       and concurrent requests on ONE worker's prefix each pay a write
```

So the split decision is: *does the shared prefix cost, times the number of splits, beat the context
degradation and the serialisation?* The scheduler has both numbers — `costOfColdStart` from the cost
model, context size from the transcript — so this is arithmetic, not a vibe. M3 makes it a scored
decision; until then it is a human choice expressed as one task or several.

What holds either way:

- Each split task gets its **own worktree from the pool and its own task-named branch**. Git enforces
  the isolation; two worktrees cannot hold the same branch.
- Landing is **serialised** by the exclusive `land:<project>` claim — forty tasks finishing near each
  other would otherwise each rebase onto a trunk the others are about to move.
- A merge task `depends_on` all forty. It stays `blocked` until every one completes, which is a query,
  not a poll.

⛔ **Splitting is not free and must never be the default.** Forty cold prefixes on a 35k-token
project is 1.4M input-token-equivalents that a single session would not have paid.

### 18.3 Overnight, across a window reset — the case that motivated the tool

Three accounts, five-hour windows, a queue, and nobody watching.

```
23:10  acct-1 at 60%.  t12 dispatched. t13, t14 ready and waiting.
00:40  acct-1 approaches its window end while t12 is mid-run
       -> PREEMPT: wrap up, commit what compiles, `handoff` recorded on the task,
          compact or close on the cache clock
       -> t12 -> paused_quota, not_before = resets_at.   ⛔ NOT cancelled: it resumes itself.
00:41  scheduler picks t13, sees acct-1 gated, routes to acct-2
04:00  acct-1's window resets -> admitScheduled() flips t12 paused_quota -> ready
       -> t12 redispatched, handoff prepended, SAME task, SAME branch, new run
08:30  you open the window to a landed t12 and two runs on its record
```

Exercised: the quota gate, preemption, `not_before` as a real scheduling primitive, the handoff, and
the distinction between `paused_quota` (auto-resumes) and `paused_user` (waits for a person,
indefinitely). Collapsing those two would have the fleet restart work you deliberately stopped.

⚠️ **This scenario is the one M3 is for.** Today the quota gate has no trustworthy reading, so every
dispatch is marked `quotaUnverified` and the 00:40 preempt does not fire.

### 18.4 A question arrives mid-flight

An agent hits something it should not guess about.

```
agent calls request_human("REST or gRPC for the sync endpoint?")
  -> Approval, escalate (no rule can answer a design question)
  -> Approvals bar, one keystroke, WITH the blocked session's cache countdown

you answer in 4 minutes   -> reply lands in the SAME warm session: 0.1·C
you answer in 3 hours     -> at 30 minutes it escalated: task -> awaiting_human,
                             session released on the cache clock, and your answer
                             starts a fresh run with the handoff prepended
```

The 30-minute escalation is not a timeout for tidiness. It is the point where holding a session open
stops paying for itself — and it is the *only* place an approval becomes a task.

Contrast a permission prompt: `Bash(npm test)` is answered by a rule in 30ms and never reaches you.
⛔ Neither ever becomes a task table row while the session is still live.

## 19. Testing plan (A2)

This tool spawns processes, spends money, writes to git repositories and pushes to trunks. The cost
of a bug is not a red build — it is somebody's quota, or their branch. So the test strategy is
organised by **what a failure would cost**, not by the usual pyramid.

### 19.1 Five levels

| Level | Runs | Costs | Proves |
|---|---|---|---|
| **L0 unit** | `npm test`, every change | nothing | Pure logic that is a *safety boundary*: mandate narrowing, rule matching, usage summing, branch naming |
| **L1 daemon integration** | `npm run test:daemon` | nothing | The daemon's real behaviour against a live orchestratord over its own RPC: commissioning, quota staleness, task DAG, cancel, delete refusal, resource claims |
| **L2 approvals** | `npm run test:daemon` | nothing | A real MCP client speaking the real protocol to the real server: policy, escalation, human answer, remember-as-rule, deny precedence |
| **L3 UI** | `npm run test:ui` | nothing | The built app, driven over DevTools: what actually rendered, and zero console errors |
| **L4 agent-in-the-loop** | `npm run test:e2e`, **opt-in** | **real tokens** | The only thing the others cannot: an agent doing work, reporting completion, and the branch landing |

L0–L3 must pass before every commit (`npm run test:all`). **L4 is gated behind `AGENTYARD_E2E=1`**
and never runs in a watch loop, because each run spends a real assistant turn on a real account.

⛔ **L1 must be provably unable to spend.** It adopts a real signed-in credential root to prove
identity detection, which means a scheduler tick *could* dispatch real work to a real account. So the
adopted worker is disabled the moment it has been probed, and the suite asserts that a tick dispatches
nothing. "It probably will not dispatch" is not a property; "it dispatched nothing" is.

### 19.2 What L0 covers, and why those things

Not "cover the code" — cover the places where **being wrong is silent**:

- `narrowMandate` — a widened mandate is an authority escalation that no test failure would announce.
- `matchesPattern` / `parseRule` — an over-broad rule auto-approves something it should have asked
  about. Regex metacharacters must stay literal; a mistyped rule that matches everything is the exact
  failure this must not have.
- `sumUsage` / `contextOf` — the three metering traps (§3.3). Undercounting is invisible until a quota
  gate opens when it should have closed.
- `branchNameFor` — a branch named after the workspace couples a task to where it happened to run.

### 19.3 Fixtures: the rules that keep tests from costing something

⛔ **Every level obeys all four.** They are not conventions; the first two exist because breaking them
damages the developer's own machine.

1. **`AGENTYARD_DATA_DIR` always points at a temp directory.** No test ever touches the real fleet
   database, the real endpoint file, or the user's workers.
2. **Never kill by image name.** No `taskkill /IM`, no `pkill -f`. Stop the pid the test started, after
   checking its command line. `taskkill /IM electron.exe` also kills the developer's editor and any
   agent window they had open — this happened during M2.
3. **Git tests use a throwaway repo with a local bare `origin`**, created and destroyed by the test.
   ⛔ Never the agentyard repository, and never a remote that exists.
4. **Adopting a real credential root is read-only.** L1 may point a worker at `~/.claude` to prove
   identity detection, and must not log in, log out, or write settings.

### 19.4 What L4 does, exactly

One task, one small repository, one turn:

```
create a bare origin + a working clone with .agentyard/project.json
add the project, commission a worker against an existing signed-in root
build a task graph and exercise it WITHOUT an agent:
    dependency blocks admission · not_before schedules · cancel rests
    without loss · delete refuses while a dependent lives · resume requeues
then ONE real task: "create HELLO.md, commit it"
assert: completed · run metered from the transcript · branch named after the task
        · landed on origin/main · every claim released · trunk still on main
```

That last block is the whole product in one assertion list, and it is why L4 exists despite the cost.

### 19.5 What is deliberately not tested, and why

Saying this out loud stops someone "fixing" the gap with a test that lies:

- **Agent output quality.** Whether the agent writes good code is not agentyard's contract. L4 asserts
  that *the machinery* carried the work, not that the work was good.
- **Vendor CLI behaviour.** We do not test that `claude auth status` prints JSON. We *measure* it, once,
  and record it in `docs/cost-model.md` with a date and a version. A test would pin somebody else's
  contract and fail on their release schedule, teaching everyone to ignore it.
- **Timing of the scheduler loop.** Asserting "dispatched within 10s" makes a flaky test out of a
  tick interval. L1 calls `scheduler.tick` directly instead.
- **Cost arithmetic against hard-coded prices.** Prices are data with an `effective_from`; a test that
  asserts a dollar figure is a test of the JSON file, not the code.

### 19.6 Regression cases earned the hard way

Each of these is a real bug from M1 or M2. They stay as tests because each one looked correct:

| Case | Level | Was |
|---|---|---|
| `auth status` exits 1 while printing valid JSON | L1 | Every un-commissioned worker reported "probe failed" instead of "not signed in" |
| A stale quota reading is reported as *unknown*, with its age | L1 | A 19-day-old percentage rendered as current |
| node-pty does not search PATH | L1 | Detection succeeded (`shell: true`) while spawning failed with *File not found* |
| A run is dispatched blind and **marked** | L1 | Silently pretending the quota gate had passed |
| Deny rules win over allow rules | L2 | — |
| A timeout denies rather than allows | L2 | — |
| Every claim is released on **both** holders | L4 | A workspace claimed by the task and released only by the run leaked, draining the pool to zero with no error |
| The trunk is still on its branch after landing | L4 | — |
| A retry is not blocked by the branch its last run left | L4 | Git refuses one branch to two worktrees — correctly. A re-dispatch failed with *already used by worktree* until `prepareWorkspace` learned to park the stale holder first |
| The scheduler refuses an account nobody signed into | L1 | A `stream` session that cannot authenticate **does not exit** — it waits on stdin forever, holding the worker's only slot. Every task routed there stalled silently |
| L1 cannot spend money | L1 | The suite adopts a real signed-in root to prove identity detection; the scheduler could have dispatched a real task to it. It is disabled the moment it has been probed, and the tick is asserted to dispatch nothing |
| A test kills the process **tree**, by pid | harness | `child.kill()` leaves Electron's renderer and GPU children alive, and one keeps the debugging port — so the *next* L3 run failed with "no debugging target", which looks like a product bug and is not one |
| Every cost belief carries its basis | L1, L3 | A reserve that renders a reassuring verdict on a guess is worse than one that says `unknown` |

### 19.7 The measurement runs are not tests

R1–R5 in `HANDOFF.md` answer questions about the *world* — does the classifier bill, what refreshes
the usage cache — and their results go into `docs/cost-model.md` with a date and a CLI version. They
are run deliberately, by a person, on a quiet worker. ⛔ Never wire one into CI: it would spend quota
on every push and produce a number nobody reads.
