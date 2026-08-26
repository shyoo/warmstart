# agentyard

**A scheduler with a budget.** agentyard runs a fleet of coding agents across the accounts you own —
Claude Code, Antigravity, local models — and routes each task to the worker, session and moment where
it is cheapest to run.

> **Status: pre-alpha, M6.** It runs work end to end — file a task, it runs in a pooled git worktree
> on its own branch and lands on your trunk when the checks pass — and it reasons about **cost**: it
> keeps a warm prompt cache alive when that is cheaper than rebuilding it, compacts when it is not,
> preempts before a quota window closes and resumes itself after the reset. Every belief it acts on is
> shown with its basis, including the ones that are still *unknown*.
>
> M4 adds a **controller**: it can break a coarse goal into draft tasks, work out why something keeps
> failing, and decide whether work an agent filed for itself should exist at all. ⛔ It is never in the
> critical path — the scheduler queues a question and carries on, and **every question has a
> deterministic answer that fires on a timer** whether or not the controller replies. With no
> controller account at all, agentyard behaves exactly as it did before.
>
> M5 adds **Antigravity** and **Codex** alongside Claude Code, each measured against the real CLI
> rather than its documentation — see [docs/adapters.md](docs/adapters.md) for what that corrected.
> Their differences are capabilities the scheduler reads, never branches in its code: one of them
> cannot compact, none of them has a classifier, and one of them can only ever hold a single account
> on a machine because it keeps its credential in the OS keyring.
>
> M6 packages it. `npm run dist` produces an installer, and a test suite drives the *packaged* app to
> prove the things only packaging can break — that the native terminal module survived the archive,
> and that the app can still start its own background daemon with no system Node installed.
> See [HANDOFF.md](HANDOFF.md) for exactly where the build is, and
> [`transient_docs/implementation_plan_2026-08-24.md`](transient_docs/implementation_plan_2026-08-24.md)
> for the design of record.

## Why this exists

There are already good open-source agent orchestrators. Most of them solve *spawn N agents in N
worktrees and show me a board*. That is not the hard part when you are running agents seriously over
weeks. The hard part is that agent capacity is a **budget with an unusual shape**:

- It is **per account**, refilling on rolling windows, and **non-fungible** — one account's remaining
  quota cannot help another.
- It is **destroyed by idleness.** A warm prompt cache expires on a timer and costs **2.0×** base
  input to rebuild, against **0.1×** to read. That 20× spread dwarfs any saving from picking a
  cheaper model.
- It is **structurally different per vendor.** Anthropic prices a multiplier on a TTL; Google prices
  cache storage over time. The arithmetic is not portable, and all of it moves.

So agentyard is not primarily an orchestrator. It is a scheduler that knows what your context is
worth and refuses to let it evaporate.

## What it does

- **Multi-account, multi-provider fleet.** Each account is a worker with its own quota, commissioned
  through the app. agentyard never reads, stores or proxies a credential — login runs the vendor's
  own CLI in an embedded terminal.
- **Cache-aware routing.** A task lands on the session that already holds its context, when that
  session's cache is still warm. Follow-up work ("add X" → "test X" → "document X") converges on one
  session instead of paying three cold rebuilds.
- **A cache clock.** Every live session has an expiry. Before it lapses, agentyard either sends it
  queued work, spends a cheap keepalive turn to refresh the TTL, or compacts it — whichever the
  arithmetic favours given how long the session is expected to stay idle.
- **Quota-aware scheduling.** Tasks are admitted only if the target account can afford them *and*
  still afford to compact everything it is holding. Running out of room to finish is recoverable;
  running out of room to save is not.
- **Preemption and resume.** When a window is about to close, work is wrapped up, handed off, and
  re-queued to restart when the window resets.
- **A task DAG with humans in it.** Tasks carry dependencies, schedules, priorities and threads. Any
  participant — you, the controller, or an agent mid-run — can file work. When something needs a
  human decision it is assigned to you and the session holding the context is kept warm for your
  reply.
- **Isolated workspaces.** Each task gets its own git worktree from a pooled set, on a branch named
  after the task. Agents never work in the trunk.
- **A live view.** The real agent TUI, not a reconstruction.

## Requirements

- Node.js 22+ (to build; the app runs on the Node inside Electron)
- Git 2.40+
- At least one agent CLI on `PATH`:

| CLI | Install | Needs |
|---|---|---|
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` | a Claude Pro/Max/Team subscription |
| **Codex** | `npm install -g @openai/codex` | a ChatGPT Plus/Pro/Business plan, or an API key |
| **Antigravity** | `irm https://antigravity.google/cli/install.ps1 \| iex` | Google AI Pro or Ultra |

You need **one**. Having several is the point — see *Multiple accounts* below.

- Windows is tested. ⚠️ macOS and Linux are written for and **have never been run**; the packaging
  targets exist and the platform branches are there, but nobody has started the app on either.

## What works today

- **Add an account** in Settings → Workers. agentyard creates an isolation directory, runs the
  vendor's own `login` in a terminal you type into, and verifies who signed in. It never reads,
  stores, copies or proxies a credential — each account must be separately and legitimately
  subscribed.
- **File a task and walk away.** It gets a worktree from the project's pool, a branch named after the
  task, and an agent on an account that can take it. When the agent reports done, agentyard rebases,
  runs the project's checks and pushes — or keeps the branch and asks you, which is what it does
  whenever it is not certain.
- **Approvals, not interruptions.** When an agent needs permission, the request arrives as a
  structured event, is answered by your project's rules where possible, and otherwise appears as a
  one-keystroke strip above your work. *Always* turns it into a rule so the next one answers itself.
- **Cancel without losing anything.** Cancelling stops the work, asks the agent to commit what
  compiles and write a handoff, releases the workspace, and rests the task — it never deletes.
  Deleting is separate, and never removes the record of what a run cost.
- **Spend less on the same work.** A warm prompt cache is an asset with an expiry date: a read costs
  0.1× and *refreshes the TTL for free*, while rebuilding a lapsed one costs 2.0×. agentyard watches
  that clock on every session and picks between sending it queued work, keeping it warm, compacting
  it, and letting it go — and the **Cost** view shows you which it chose and why.
- **Survive a window closing.** Work in flight when an account's window is about to reset is wrapped
  up, committed, handed off and re-queued to resume itself after the reset.
- **See the fleet**: per-account quota with its **age**, reset countdowns, live sessions with their
  prompt-cache countdown and context size.
- **Ask it to break down a goal.** File something too big for one task and the controller turns it
  into a handful of drafts with dependencies between them. Drafts dispatch nothing — you promote them
  one at a time, and each prompt is written *then*, from what the work before it actually learned.
- **A controller that is never in the way.** It can also work out why a task keeps failing and
  whether work an agent filed for itself should exist at all. ⛔ Every question it is asked has a
  deterministic answer that fires on a timer if it does not reply — so with no controller account
  configured at all, agentyard behaves exactly as it would without one.
- **Doctor** tells you which CLIs were found, who is signed in, how old each quota reading is, which
  cost model is in force, and — per adapter — what agentyard can and cannot verify about it.

### Providers are not interchangeable, and agentyard says so

The three CLIs differ in ways that matter to a scheduler and are invisible in a feature comparison.
Each difference is a capability agentyard reads, never a branch in its code:

| | Claude Code | Antigravity | Codex |
|---|---|---|---|
| **Accounts per machine** | unlimited | ⛔ **one** | unlimited |
| Can compact a long session | ✔ | ⛔ | ⛔ |
| Something reviews each action | ✔ | ⛔ | ⛔ |
| agentyard can meter its cost | exactly | from the live stream | from the live stream |

Antigravity keeps its credential in the OS keyring with no way to point it elsewhere, so **one machine
holds exactly one Antigravity account** — agentyard refuses to commission a second rather than let two
workers quietly share one window. A CLI that cannot compact hands off and closes instead. A CLI with
no reviewer gets a narrower allowlist written into its own configuration before every run.

⚠️ Everything in that table was established by **running the CLIs**, not by reading their
documentation — which mattered, because several documented claims turned out to be wrong in ways that
would have failed on the first spawn. [`docs/adapters.md`](docs/adapters.md) records what was measured,
when, against which version, and what is still unverified.

> **On quota numbers.** Claude Code has no free live usage probe — the slash command spends a real
> turn — so agentyard reads the CLI's own cache and always shows you how old it is. An old reading is
> reported as *unknown*, never as a number. One consequence is worth stating plainly: the compaction
> reserve, which stops an account running out of room to *save* a large session, currently reports
> `unknown` rather than `ok`, because it needs a size and nothing free gives it one.
> See [`docs/cost-model.md`](docs/cost-model.md) §5 and §10.

## Development

```bash
npm install
npm run dev
```

Electron 44 has no postinstall, so `npm install` does not fetch the ~110MB runtime. If the window
fails to start with a missing-binary error, run `node scripts/ensure-electron.mjs` once and try
again — it is idempotent, so it is also safe to run when you are not sure.

```bash
npm run typecheck    # tsc over main/preload/daemon and renderer
npm run build        # typecheck + production bundle into out/
npm start            # preview a production build
```

**Tests.** Organised by what a failure would *cost*, not by the usual pyramid:

```bash
npm run test:all     # unit + daemon + UI. Free, and required before every commit
npm run test:pack    # builds a real package and drives it. Free, slow
npm run test:e2e     # AGENTYARD_E2E=1 required. SPENDS REAL TOKENS
```

**Packaging.**

```bash
npm run pack         # unpacked app in release/, for testing
npm run dist         # installers for the current platform
```

⚠️ Builds are **unsigned**. Windows SmartScreen will warn; macOS Gatekeeper will refuse until you
clear it by hand. That is the honest state of a pre-alpha rather than something worked around —
signing is a certificate and a release process, not a config line.

## Repository layout

| Path | What it holds |
|---|---|
| `src/main`, `src/preload` | Electron shell. A window host and nothing more. |
| `src/renderer` | React UI. |
| `src/daemon` | `orchestratord` — the scheduler, cache clock, controller, PTYs and store. |
| `src/mcp` | The MCP server agent CLIs spawn. Two tiers; neither can delete anything. |
| `src/shared` | Types crossing a process boundary. |
| `costmodels/` | Versioned pricing data. Never inline arithmetic. |
| `electron-builder.yml` | Packaging. Two lines in it are load-bearing and say why. |
| `docs/` | Current, maintained reference. |
| `transient_docs/` | Design and implementation plans, dated. Kept for reasoning, not status. |
| `AGENTS.md` | Conventions for AI agents working on this repo. |
| `HANDOFF.md` | Current state and what to do next. |

## Multiple accounts

agentyard supports more than one account per provider, which is useful to anyone with, say, a
personal and a work subscription. Each account must be separately and legitimately subscribed, and
each is kept in its own isolation root; the tool never shares credentials between them and never
reads them at all.

⛔ **With one exception, and it is not a limitation agentyard can engineer around.** Antigravity keeps
its credential in the operating system's keyring and offers no environment variable to point it at a
different one, so a machine holds exactly **one** Antigravity identity. Commissioning a second is
refused, with a message saying why — because two workers on one keyring are not two accounts, they are
two schedulers' worth of belief about a single window. Claude Code and Codex both have a
config-directory variable and are unlimited.

## Adding a CLI agentyard does not know about

Drop a JSON file in `<data dir>/adapters/`:

```json
{
  "schema_version": 1,
  "id": "my-cli",
  "label": "My CLI",
  "command": "mycli",
  "isolation_env_var": "MYCLI_HOME",
  "print_args": ["--print", "--cwd", "{{cwd}}"],
  "cost_model_id": "anthropic.subscription.2026-08"
}
```

⛔ **Declarative only — never JavaScript.** The daemon holds the RPC token, spawns agents and knows
where every credential root lives; loading code from a directory anything can write to would put all
of that behind a file permission. So a declaration describes what its CLI is *like*, and a generic
driver does the work.

⚠️ The ceiling is real and deliberate. A declared adapter cannot decode a stream dialect nobody
wrote a decoder for, so agentyard **cannot meter it** — its runs cost an *unknown* amount rather than
nothing — it gets no agentyard MCP tools, and its orphaned processes are never killed because their
identity cannot be proved. Doctor states all three. A CLI worth more than that is worth a real adapter
in `src/daemon/adapters/`, where its quirks can be measured and written down.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
