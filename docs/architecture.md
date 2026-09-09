# Architecture

How Multi Agent Controller is put together: four processes, three loops, and the invariants that are
not preferences. Read this before touching any code.

> **Audience:** anyone changing the daemon, the shell or the protocol.
> **Authority for:** process topology, loop cadences, the RPC/IPC surface, the data directory, the
> architecture invariants.
> Domain words are defined in [`glossary.md`](glossary.md); scoring lives in
> [`routing.md`](routing.md); the schema in [`data-model.md`](data-model.md).

---

## 1. Four processes

```
┌──────────────────────────────┐
│ Electron main  src/main      │  window host + tray + the ONLY client that holds the daemon token
│  └ preload  src/preload      │  contextBridge → window.agentyard (sandbox: true, CommonJS)
│      └ renderer src/renderer │  React 19 UI. No port, no token, displays untrusted agent output
└──────────────┬───────────────┘
               │ Electron IPC (src/shared/ipc.ts)
┌──────────────▼───────────────┐
│ orchestratord  src/daemon    │  detached; Electron binary with ELECTRON_RUN_AS_NODE=1
│   HTTP + WS on 127.0.0.1:<random>, bearer token in <dataDir>/orchestratord.json (0600)
│   scheduler · cache clock · controller · quota poller · PTYs · node:sqlite store
└──────────────┬───────────────┘
               │ spawns agent CLIs (pty or stream), and writes each one an MCP config
┌──────────────▼───────────────┐
│ MCP server  src/mcp          │  spawned BY the agent CLI, not by us. Two tiers. Talks back over RPC
└──────────────────────────────┘
```

**Why a daemon and not all-in-Electron.** The premise is unattended progress across quota windows
that are hours long. If closing the window killed the fleet, this would be a nicer way to arrange
terminal tabs. `main/daemon.ts` spawns `process.execPath` with `ELECTRON_RUN_AS_NODE: '1'`,
`detached: true`, and unrefs it — so a packaged app needs no system Node and native modules already
match Electron's ABI.

**Startup order matters** (`daemon/index.ts` `main()`): acquire the lock → open the DB (runs
migrations) → load cost models → load declarative adapters → log cost factors → reconcile orphans,
claims, tasks and consults → prune unbound attachments → start the server, poller, scheduler,
controller and transcript tailers → publish the endpoint file.

⛔ **Adapters load before the scheduler starts.** An adapter appearing under a running scheduler
means capabilities changed between the gate that admitted a task and the dispatch that acted on it.

### Talking to the daemon

| Caller | Path |
|---|---|
| Renderer | `window.agentyard.rpc(method, params)` → `ipcRenderer.invoke('daemon:rpc')` → main → HTTP `POST /rpc` |
| MCP server | reads `<dataDir>/orchestratord.json`, `POST /rpc` with `Authorization: Bearer <token>` |
| Tests | the same HTTP + WS surface (`test/lib/harness.mjs`) |
| Paired phone | a **second listener** on a second credential — see [`remote.md`](remote.md) |

⛔ **Remote access is a separate listener with a separate credential, and that is the point.** The
loopback endpoint above authorises spawning processes, so its token never leaves the machine.
`daemon/remote/server.ts` binds its own port only while the operator has switched remote access on,
authenticates a per-device token stored hashed, and reaches only the subset of methods
`daemon/remote/policy.ts` allows — which is a total map over `RpcMethod`, so a new method is denied
until someone decides otherwise. It is off by default and gated a second time per project.

Events flow the other way over a WebSocket: `DaemonEvent` (`protocol.ts`) → main → `daemon:event-push`
→ renderer. `session.data` carries raw terminal bytes; everything else is typed state.

The RPC method table is **129 methods across six domain files** — `daemon/api/workers.ts`,
`projects.ts`, `tasks.ts`, `quality.ts`, `agent.ts` and `remote.ts` — that `daemon/api.ts` spreads
into one object. `RpcMethod`/`RpcParams`/`RpcResult` in `shared/protocol.ts` are derived from it, so adding a
method is one edit plus its types.

⛔ **A method belongs to exactly one domain, and the mapped type is what enforces it.** `Api` is
`{ [M in RpcMethod]: Handler<M> }`, each domain returns `Pick<Api, ItsMethodUnion>`, and `buildApi`
closes with `satisfies Api` — so a method no domain claims fails the build *by name*. That check is
the only reason splitting the table was safe, and nothing may replace it with a cast.
`daemon/api/support.ts` holds what the domains share: the RPC types, `ApiContext`, and the
`checkConstraints` / `checkWorkerDefaults` validators that refuse a bad request at the door.

## 2. Three loops

| Loop | Cadence | Where | Spends |
|---|---|---|---|
| **Scheduler tick** | `TICK_MS` = 10s | `scheduler.ts` `tick()` | ⛔ **nothing** |
| **Controller drain** | `CONTROLLER_LOOP_MS` = 30s | `controller.ts` | tokens, on judgment events only |
| **Quota poller** | self-paced, `probeDemand()` | `quota.ts` | no tokens; opens a PTY per refresh. ⚠️ Reads **money** on the same pass — see below |

### The scheduler tick, in order

```
admitScheduled()        scheduled → ready when not_before passes
resumeQuotaPaused()     the ONLY thing that ends a paused_quota hold (clock or a measured reading)
escalateStale()         approvals past their deadline
askForTitle()           at most one title consult; free, changes nothing this tick
runWatchdogs()          preemption, stall, runaway, finish-overdue — BEFORE new work
  for each ready task, in schedulingOrder:
    kind === 'plan'  → askForPlan(), never dispatch
    poolPressure()   → hold (before chooseTarget, so contention never costs a consult)
    chooseTarget()   → deferred/none → hold with a reason and a hold_until
    needsBaseline()  → hold one tick while the window is read
    dispatch()       → Contended ⇒ back to ready; anything else ⇒ failed
runCacheClock()         after dispatch, so a session just chosen counts as move 1
```

⚠️ The tick logs only when its conclusion *changes*. A loop running every ten seconds forever would
otherwise push a day of real events out of the buffer inside six hours.

### The controller loop

`controller.ts` drains a queue of `consults`. Five judgment events (`judgment.ts`): routing,
decomposition, failure triage, agent-filed work, and title summary. Each has a **closed answer set**
and a **deterministic fallback that fires on a timer** (`ANSWER_TIMEOUT_MS` = 4 min) whether or not a
controller ever replies. With no controller account configured, the fleet behaves exactly as it would
without one.

### The quota poller

No fixed refresh clock. `probeDemand()` asks what the fleet is doing and the poller computes its own
delay, refreshing only where something is about to act on the number: a run in flight, a parked task
past its reset, or a live rate-limit warning (`requestUrgentProbe`). `ensureFreshQuota()` at the
dispatch gate and at run end shares the same ledger, so two terminals never open on one account.
Details and the staleness ladder: [`cost-model.md`](cost-model.md) §5.

⛔ **It reads money on the same pass, and deliberately owns no second timer.** `probeSpendFor`
(`spend.ts`) asks whatever the adapter's `spendProbe` capability says can be asked — never which
adapter it is — and writes `spend_samples`. The two readings answer halves of one question, and the
account worth asking about is the same account in both. ⚠️ It never throws and never fails the quota
probe beside it: an adapter that breaks its own best-effort contract must not cost that account the
window reading every gate and reserve is computed from.

## 3. The data directory

`<dataDir>` is `MULTI_AGENT_CONTROLLER_DATA_DIR` if set, otherwise the platform app-data directory
for `multi_agent_controller` (`paths.ts`). Computed there rather than from Electron's `app.getPath`,
because orchestratord runs as plain Node where the `electron` module is unusable — main reads the
same function so both agree.

```
<dataDir>/
  multi_agent_controller.db        node:sqlite, WAL
  orchestratord.json               { port, token } — 0600, the endpoint file
  orchestratord.lock               single-instance lock
  logs/                            one file per day, pruned after a fortnight
  workers/<worker>/                per-account isolation roots; the vendor CLI owns the contents
  costmodels/                      user-supplied pricing, takes precedence over bundled
  adapters/*.json                  declarative adapters
  attachments/                     image bytes; metadata is a row
  scratch/                         where a session with no project runs
```

⛔ **`scratch/` is not the user's home and not a credential root.** A CLI asks whether it may trust
the folder it opened in, per account, and until somebody answers it **swallows every keystroke sent
to the session**. `trustDirectory()` pre-answers that question for `scratch/` only — never for a
project, a worktree, or anybody's home.

⚠️ **A pre-rename install is carried across by two halves, and both are required.**
`adoptLegacyDataDir()` in `paths.ts` moves the `agentyard` directory; `repointIsolationRoots()` in
`db.ts` rewrites the absolute `isolation_root` of every worker inside it. `paths.test.ts` fails if
either is removed.

### Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `MULTI_AGENT_CONTROLLER_DATA_DIR` | everything | override the data directory. What tests use |
| `MULTI_AGENT_CONTROLLER_TIER` | `src/mcp` | `worker` (default) or `controller`. ⛔ Written **only** by the daemon into the session's MCP config; an agent cannot promote itself |
| `MULTI_AGENT_CONTROLLER_SESSION_ID` | `src/mcp` | which session a tool call belongs to |
| `MULTI_AGENT_CONTROLLER_HEADLESS` | `main/showwindow.ts` | suites set it; `createWindow` skips both `show()` paths |
| `MULTI_AGENT_CONTROLLER_LOG_LEVEL` / `_LOG_STDOUT` | `log.ts` | daemon log verbosity and destination |
| `MULTI_AGENT_CONTROLLER_E2E` | `test/e2e.test.mjs` | the only gate on the only suite that spends tokens |
| `MULTI_AGENT_CONTROLLER_AUTO_TRUST` | `sessions.ts` | on unless set to `0`; pre-answers the trust dialog for `scratch/` only |
| `ELECTRON_RUN_AS_NODE` | `main/daemon.ts` | turns the Electron binary into plain Node for the daemon |

⛔ **Two tiers means two prompt-cache prefixes on an install.** Adding a third tier adds a third; do
not add one casually.

## 4. Architecture invariants

These are not preferences. Breaking one breaks the product. Each links to the page carrying its
evidence.

### The machine reads the transcript; the human reads the screen

⛔ **Never parse ANSI output to determine state.** Usage, context size, idle time and effort come from
the agent's own transcript JSONL, which is exact. Terminal bytes go to xterm.js and nowhere else.

⚠️ **One exception exists, it is narrow, and it is declared rather than assumed.** An adapter may set
`usageRefresh.answer: 'screen'` and implement `parseUsage`, producing **a quota reading and nothing
else** — never a session's state. It exists because Antigravity keeps its quota in memory and writes
it nowhere (measured 2026-08-27; see [`adapters.md`](adapters.md)). ⛔ Such a parser must fail the way
a rendering fails — return null rather than a partial reading. The first live run proved why: at 30
rows the panel scrolled, a window fell below the fold, and three of four came back looking complete.

### The scheduler costs zero tokens

⛔ Dependency resolution, quota gates, cache countdowns, retries and auto-resume are arithmetic. The
LLM controller is consulted only on discrete judgment events, is **never in the critical path**, and
every question has a deterministic fallback on a timer. When you add a judgment event, **write the
fallback first** — it is the normal path, not the error path.

### A decision that triggers an action, re-evaluated before the action lands, is a loop

⛔ Three components learned this separately: the cache clock re-issued `/compact` thirteen times
(2026-08-26), the runaway watchdog re-preempted one run thirteen times (2026-08-28), and the finish
path would have re-asked an agent to commit on every completion. In each case the decision is a pure
function of state the action has not changed yet.

**Record the ask, with the evidence that would prove it landed** — `clock_move`, the `preempting` set,
`quota_preempt_json`, `finish_asked_at` — and owe a re-read before acting on the far side of the wait. ⚠️ "A turn happened"
is not that evidence: an agent replying *"I don't understand /compact"* is a turn. Compaction is
proved by `tokensSinceCompact` falling; a keepalive by the TTL moving. And the clock **stops asking**
after `MAX_MOVE_ATTEMPTS`. See [`cost-model.md`](cost-model.md) §4.

### Capabilities and objectives are data, never branches

⛔ **Never branch on an adapter or mode name.** No `if (adapter === 'claude')`, no
`if (mode === 'economy')`. Adapters declare `capabilities` and `policy`; objectives are a weight
vector consumed in **exactly two places** — `weights()` for scheduler scoring and `policy()` for the
cache clock, model selector and preemption. A third consumer means one of those two is missing a
field. Antigravity lacking `/compact` must express itself as a missing capability.

⛔ **No pricing arithmetic inline.** Ask the cost-model object (`costOfKeepalive`, `costOfCompact`,
`costOfColdStart`, `cacheExpiryFor`). Providers price caching in structurally different ways and all
of them move. A cost model may also say it does not know: `cache.kind: "unpriced"` makes
`canPriceCache()` false and the clock declines to spend rather than acting on an invented number.

### Spending real money needs two independent yeses

⛔ **An operator's intent and a vendor's reading are different facts, and the fleet acts only where
they agree.** `settings.spendCreditsPastLimit` says what the operator wants of the fleet;
`Worker.credits.enabled` says what the vendor reports about one account. `spendingCreditsOn()` is the
**only** reader of the pair, for the same reason `mayCompact` is the only reader of `autoCompact`: two
call sites that combine them themselves are two chances to disagree, and here the disagreement is
billed. Acting on the intent alone pushes runs into exhausted windows on accounts with nothing behind
them — a hard vendor refusal in place of a clean wrap-up, losing the commit and the handoff. Acting on
the vendor's word alone starts a bill nobody asked for.

⚠️ **Not knowing is not permission.** A worker no spend probe has read is `null` here and is therefore
not spending, which is the same rule `unknown is a verdict` states one heading below.

⛔ **An intervention that does not happen must still leave a trace.** A run carrying on at 100% of its
window looks exactly like a run the scheduler forgot about, so the stand-down says so on the task
thread — once per run per kind, and only at the moment a guard would actually have fired. Announcing
it unconditionally at dispatch would put a paragraph about the plan limit on every run that never
goes near one; `noteCreditsDispatch` is the dispatch-time case and it re-reads the window first, so
it speaks only where the gate would in fact have held the task.

⛔ **The pair gates *starting* work as well as continuing it** (t282). `chooseTarget` and
`quotaReleaseFor` read `spendingCreditsOn` too, or the one account allowed to spend past its limit is
the one account that can never be handed a task queued behind that limit. See `cost-model.md` §4.

### Every belief carries its basis

⛔ `remainingTokens` returns a number *and* how it was arrived at; the reserve returns a verdict *and*
its reason; the cache clock records every decision including the ones that did nothing; every routing
score prints the weight beside the formula that produced it. `cost.test.ts` evaluates every published
formula against `weights()`, so a derivation cannot drift from the code it claims to explain.

⛔ **`unknown` is a verdict, not a synonym for `ok`, and not "half as bad" either.** Scoring it 0.5
made a routing term stop measuring risk and start measuring *does this worker have a session*;
measured 2026-08-27, a never-signed-in account won a dispatch over two working ones on exactly that.
⛔ **But a term stuck at zero for the whole fleet is a missing input, not a safe default** — the fix
left `quotaRisk` with no reachable trigger and quota vanished from routing for three days
(2026-08-30). Honest-zero is where a term *rests*, never where it *lives*.

### Security boundaries

- ⛔ **The renderer never holds the daemon token.** It calls main over IPC; main is orchestratord's
  only client. The renderer displays untrusted agent output and does not get a credential to a
  service that can spawn processes.
- ⛔ **A phone gets its own credential, never the daemon's.** Pairing mints a 32-byte token stored
  as a SHA-256 hash and revocable from the desktop; it reaches an allowlist that denies
  `session.write`, `daemon.shutdown`, every `worker.*`, project mutation, `task.delete` and
  `settings.set`. Two switches gate it — global, then per project — and the per-project one lives in
  the daemon database rather than the committed `project.json`, because a network-exposure decision
  must not travel to another machine with a clone.
- ⛔ **Native modules live in the daemon, never the renderer.** An Electron upgrade must not be able
  to break a running fleet.
- ⛔ **Code is never loaded from the data directory.** Declarative adapters are JSON driven by a
  generic driver. The daemon holds the RPC token, spawns agents and knows every credential root;
  executing a file anything on the machine can write would put all of that behind a file permission.
  A declaration also cannot grant itself MCP tools, a mintable session id, metering or a quota probe —
  each is refused with a test.
- ⛔ **A spawned CLI gets `spawnEnv()`, never a copy of `process.env`.** It denies the whole
  `CLAUDE*` / `ANTHROPIC_*` namespace **by prefix**, because a Claude Code session's environment
  carries ~20 such variables and a daemon started inside one would hand every worker the operator's
  own session handle. Deny by prefix, not a whitelist of what to keep: a whitelist must enumerate what
  a CLI needs on three platforms, and one omission is a spawn that fails untraceably. Each adapter
  still deletes its own provider's API keys afterwards.
- ⛔ **Nothing about one machine may be hard-coded.** No absolute path from your own disk, no account
  directory names, no assumption that any CLI is installed. The app must open on a clean profile with
  zero workers, say so, and offer the wizard.
- ⛔ **Preference never widens authority.** `finishPolicy` (fleet → project → task) says what *should*
  happen; `mandate.allowed ⊇ 'land'` says what *may*. The mandate is inherited down a lineage so an
  agent-spawned subtask cannot grant itself more than its parent had — so nothing settable in a UI may
  touch it. A dropdown that could would be a privilege escalation with a nice label.
- ⛔ **Unattended judgment gets no tools.** A consult is asked a question and replies with JSON
  validated against a **closed set**: a worker id must be a candidate that was offered, a model one
  the cost model can price, a dependency index must point backwards. If a real reply keeps failing
  validation, the *prompt* is wrong — never widen a closed set to make a reply fit.

### Process lifecycle

- ⛔ **The daemon is *asked* to stop, never killed.** `daemon.shutdown` makes orchestratord run its
  own wind-down — loops, tailers, sessions, lock, endpoint file, database — and the app's quit path
  uses it when the tray is switched off. Reading `orchestratord.json` for a pid and killing it would
  strand a lock file and a half-written database even if the pid were trustworthy, which it is not.
  ⚠️ Shutting it down ends every live session, so anything that asks must ask a person first when work
  is in flight. The tray switch lives in main's own `ui-settings.json`, not the daemon's settings
  table: main must be able to read it when the daemon is *not answering*, which is when it matters.
- ⛔ **Never kill a process by image name.** Not in code, not in a shell, not "just this once" in a
  test. `taskkill /IM electron.exe` and `pkill -f node` take out the user's editor and their other
  agent windows. This app kills **only PIDs it recorded itself**, and stops when the pid it stored no
  longer matches the process it started.
- ⛔ **Never kill a bare pid either.** Pids are recycled: a process you spawned can exit, the OS can
  hand its number to something else, and a `finally` block firing seconds later kills a stranger. Read
  the command line and check it is yours — both `ownsProcess()` and the harness's `killTree()` do. If
  the command line cannot be read, the answer is **no**.

### Work, holds and evidence

- ⛔ **A contended resource is a hold, never a failure.** `claim()` returning null means *not yet*.
  Contention is a `Contended` error the tick returns to `ready`; `poolPressure` holds the task before
  `chooseTarget` can spend a consult on it. ⚠️ A hold, **not a dependency edge** — an edge outlives the
  contention that created it, so a P0 filed a minute later would queue behind it; a hold is re-decided
  from `schedulingOrder` every tick, which is what makes priority mean anything. ⚠️ Keep the retry
  narrow: only contention meets a different world on the next attempt.
- ⛔ **Every held status needs something that ends the hold.** `admit()` in `tasks.ts` is the only
  thing that re-admits a `blocked` task; `admitScheduled()` looks at `scheduled` and nothing else;
  `resumeQuotaPaused()` is the clock for `paused_quota`. A second copy of `admitDependents` in
  `scheduler.ts` re-set each dependent to the status it already had, so for months **no completed task
  ever unblocked anything**. Never reimplement it. A new held status owes a releaser too.
- ⛔ **A task that settles admits its dependents inside `setStatus`, on the transition into
  `completed`, `failed` or `cancelled`.** It was the caller's job until 2026-09-04, and most of the
  seven paths that settle a task never did it: `relandTask` — a failed landing driven home by hand —
  and `decomposeTask` skipped it outright, and on the failure and cancellation paths a `settled`
  edge (the one `task_split` writes, so a planner is woken by the pieces that *failed*) was released
  by nothing outside `cancelTask`. Measured: t192 was landed by hand at 14:40, and t193 was still
  `blocked` behind it when a person looked. A `blocked` task holds no clock, no worker and no
  session, so **nothing about it ever expires** and one missed event strands it permanently.
  ⚠️ `admit()` still decides per edge, so an ordinary `completed` edge is unmoved by a failure.
  ⚠️ The backstop is `admitBlocked()` on the tick, which re-reads every blocked row against the world
  and logs at warn when it releases one — a release there means a bug above it. ⚠️ Admission now
  lands a moment *before* the settling task's workspace is released, so a dependent can reach `ready`
  and find the pool full: that is a hold, and the next tick runs it.
- ⛔ **Every gate on whether an *account* may be handed a turn lives in `eligibility.ts`, in one
  list.** Work and judgment both read it; they kept their own copies until 2026-08-27 and the copies
  drifted. A gate that needs to know *what is being asked* belongs at the call site; anything true of
  the account itself goes in the shared list.
- ⛔ **A reply to a task that has stopped is a new run on the same thread, never a note that waits.**
  Work needs a **run** to be visible, gated and billed. `continueTask()` re-queues and the scheduler
  routes it; the same worker, workspace and session win because `warmSessionFor` scores them highest,
  not because anything hard-codes them.
- ⛔ **`task_complete` is the only MCP completion signal; an adapter without MCP gets an equally exact
  `TASK COMPLETE:` prompt contract.** A terminal status alone never proves success: t163 (2026-09-03)
  returned `ERROR` after its completion prose. The scheduler accepts that error only beside the exact
  contract line, never by reading intent from a paragraph. A run is one attempt — whether the *task*
  is done is a separate question. `completed` on a run beside `awaiting_human` on its task is not a
  contradiction, and the UI has to say so.
- ⛔ **A clock-issued compaction ends the run it interrupted when its boundary lands.** `/compact`
  takes over the active turn; after the boundary the CLI is waiting for input and the displaced turn
  can no longer report `task_complete`. The session is closed, the run is recorded as `blocked`, and
  the compacted conversation and workspace are preserved for a person to resume. Agent-initiated and
  automatic CLI compactions do not end a run; a pre-prompt resume compaction has a boundary waiter
  that continues its run, and `revive_compact` has no open run to end.
- ⛔ **An agent has two ways to end a run, and calling neither leaves the task reading `running` for
  ever.** `task_complete` reports success; `await_human` reports that the agent has gone as far as it
  can and the rest is a person's. An ordinary run stays open until one of them arrives — that is the
  whole of its contract — so a turn that merely ends holds the run, the workspace and the worker slot
  until the daemon dies. Measured on t226, 2026-09-05, where an agent told *"I will close this out
  myself"* obeyed, stopped, and had nothing it could call to say so. ⚠️ `await_human` ends the run
  `blocked` and claims nothing about the work; it is not a quieter completion and the prompt names it
  appended to the one asking for completion, never beside it.
- ⛔ **An agent that calls neither is no longer left there, because "the agent will remember" is not a
  mechanism.** The same defect was reported twice in one day — t249, then t254, which was filed to fix
  it and did it to itself. Measured on t254, 2026-09-06: closing summary written at 21:08:16, no
  `task_complete`, and the run still open and the task still `running` **forty-five minutes later**,
  when an unrelated daemon restart reconciled it. So the `result` record now writes down *that the
  turn ended without a terminal signal* (`idleTurns`), and `runWatchdogs` acts on the note once
  `quietSince` proves nothing has happened for `IDLE_TURN_AFTER_MS` (3m) — the grace exists because
  everything the daemon does to an idle session (wrap-up, `/compact`, a reply) starts a request and
  clears the note. ⚠️ The action is `parkForHuman`, i.e. the `await_human` verdict the agent should
  have reached itself: run `blocked`, task at `awaiting_human` carrying the agent's own last words,
  session kept warm, **nothing landed, committed, graded or discarded**. It reads no completion out of
  prose — not even a literal `TASK COMPLETE:` line, which is a contract given to adapters that cannot
  call the tool. Pinned by `idleturn.test.ts`.
- ⛔ **`awaiting_human` must say what it wants and offer somewhere to answer.** Every hand-off to a
  person writes its reason onto the task, and `resolveTask()` records the answer.
- ⛔ **Cancel is not delete.** Cancel winds a run down through the preemption protocol into a resting
  state and destroys no work. Delete is separate, human-only, soft by default, and **never removes
  runs** — they are the estimator's training data and the record of real spend.

### Three objects, and the differences are load-bearing

A **Task** is schedulable, durable, and outlives every session. An **Approval** blocks one live
session, has a **closed** answer set, a deadline set by that session's cache expiry, and an answer
that can become a project rule. A **Question** blocks a session too, but its answer set is written by
whoever asked and its answer is *content*, so it can never be a rule.

⚠️ An unanswered approval **denies**; an unanswered question **parks** and stays open. ⛔ However it
arrived, a question is a `Question` row — a channel that detects a question and does not file one
produces a question nobody can reply to.

### Workspaces and branches

- **Agents work in a pooled worktree, never the trunk.** The branch is named after the *task*
  (`multi-agent-controller/t123-…`), never after the workspace it landed in.
- **A new task starts from the ref its finish policy will rebase onto**: the local target for
  `merge-local`, otherwise `origin/<target>` when it exists. A subtask starts from its parent's
  branch while that branch still carries work the trunk lacks; after the parent lands it uses the
  trunk. An existing clean branch with no commits of its own is fast-forwarded to the same base.
- ⛔ **A slot does not arrive clean.** `switch --detach` carries uncommitted changes with it, so
  parking frees a member's *branch* and leaves its *edits* for whoever claims it next. **Committed if
  there is a branch, stashed if there is not, `reset --hard` never.**
- ⭐ **The branch, not the stash, is the carrier**: a stash belongs to a *repository*, so it does not
  reach the workspace the next run claims. A rescue commit carries a `Multi-Agent-Controller-Rescue`
  trailer and ⛔ may not land while it is still the tip.
- ⛔ **A task branch at rest is invisible to anything that reads a workspace.** A finished task's
  branch is checked out nowhere. Enumerate `refs/heads/` when the question is about branches; read a
  workspace only for what is *in* one.
- ⛔ **The tool never writes a commit, and never destroys work.** Committing is the agent's job. Work
  the tool declines to land is preserved where it is and surfaced under **Loose ends** — preserving it
  silently is only half a fix. Full spec: [`landing.md`](landing.md).

## 5. Layout

```
src/main, src/preload   Electron shell. A window host and nothing more
src/renderer            React UI. Tokens in src/renderer/src/styles/tokens.css  → ui.md
src/daemon              orchestratord: scheduler, PTYs, store, adapters
src/mcp                 the MCP server the agent CLI spawns                     → mcp.md
src/shared              types crossing a process boundary (protocol, ipc, tasks)
costmodels/             versioned pricing data                                  → cost-model.md
test/                   the .mjs suites that drive a built app                  → testing.md
scripts/                ensure-electron, icons, build-win.ps1                   → development.md
.claude/skills/         /commit commits locally, /push publishes                → development.md
```

### The daemon's modules

| File | Owns |
|---|---|
| `index.ts` | entry: lock, db, server, poller, scheduler, tailer wiring, shutdown |
| `server.ts` `api.ts` `api/` | HTTP + WS on 127.0.0.1, bearer token; `api.ts` spreads the five domain files in `api/` into one table (§1), and `api/support.ts` holds the types and validators they share |
| `db.ts` | `node:sqlite` + numbered migrations → [`data-model.md`](data-model.md) |
| `paths.ts` | the data directory, and the legacy-install adoption |
| `scheduler.ts` | `tick`, dispatch, the watchdogs, `continueTask` → [`routing.md`](routing.md). Scoring, session residency, turn-end handling and the resolution RPCs are split into the five files below it |
| `prompt.ts` | `promptFor` and its helpers — what an agent is actually told, and what a resumed turn withholds |
| `scoring.ts` | `chooseTarget`, the score arithmetic and its explanation (`formatScore`, `briefScore`, `scoreLegend`), `poolPressure` |
| `residency.ts` | session residency and worker capacity — `atCapacity`, the reservation counters, `leastValuableResident`, `sessionLeaseId`, `evictableResidents` |
| `turnend.ts` | what happens when a turn ends — `onSessionExit`, `onStreamResult`, the two MCP-less prompt contracts (`needsDecisionIn`, `taskCompletionIn`), the idle-turn note, `overloadFailureRetry`, `deadOnArrival` |
| `resolutions.ts` | RPC-driven actions, not scheduling: every Resolve & retry cause (`resolveConflictOnTask`, `resolveChecksOnTask`, `resolveCommitOnTask`, `resolveTrunkMovedOnTask`, `resolveRetryOnTask`), `pendingWorkFor`, `commitConversation`, `landConversation`, `relandTask` |
| `eligibility.ts` | ⛔ the account gates, in ONE list |
| `tasks.ts` | the DAG, admission, mandates, budgets, runs |
| `sessions.ts` | pty and stream transports, reaping, resuming a closed conversation |
| `transcript.ts` | metering: iterations, TTL split, the cache clock's inputs |
| `cacheclock.ts` `compaction.ts` | moves 1–6 plus `revive_compact`, and the ledger that records the ask |
| `reserve.ts` `objective.ts` `costmodel.ts` `estimator.ts` | the cost intelligence |
| `quota.ts` `stream.ts` | the staleness ladder, the self-pacing poller, live rate-limit signals |
| `controller.ts` `judgment.ts` `chat.ts` | the consult queue, the five events, the one tooled session |
| `finish.ts` `landing.ts` `worktrees.ts` `conflict` paths | → [`landing.md`](landing.md) |
| `conversations.ts` `sharing.ts` | → [`sessions.md`](sessions.md) |
| `approvals.ts` `questions.ts` | the two interrupt objects |
| `resources.ts` | the broker: `exclusive`, `counted`, `rate_limited` |
| `adapters/` | per-CLI integrations, capabilities as data → [`adapters.md`](adapters.md) |
| `which.ts` `git.ts` `spawn.ts` | PATH resolution — node-pty does not do it; and the shared git / promise-based `execFile` runners |
| `stats.ts` | shared medians: `null` is no series, never a measured zero |
| `activetime.ts` `activity.ts` `log.ts` | agent time, the live peephole, the daily log |
| `testkit.ts` | ⛔ test-only shared L1 fixtures — never bundled, never imported outside `*.test.ts` |
| `../shared/policy.ts` | cross-process preference resolvers; task/project/fleet choices never widen a mandate |
