# Warmstart

**A scheduler with a budget.** Warmstart runs a fleet of coding agents across the
accounts you own — Claude Code, Antigravity, local models — and routes each task to the worker,
session and moment where it is cheapest to run.

> **On the name.** The project was called **agentyard** before it had a public one, and that name
> survives internally: source comments, the `window.agentyard` preload bridge, test fixtures, and
> `paths.ts`'s `LEGACY_APP_DIR`, which exists so an install predating the rename keeps its fleet.
> Everything a user reads or types is *Warmstart*.

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
> controller account at all, Warmstart behaves exactly as it did before.
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

So Warmstart is not primarily an orchestrator. It is a scheduler that knows what your context is
worth and refuses to let it evaporate.

## What it does

- **Multi-account, multi-provider fleet.** Each account is a worker with its own quota, commissioned
  through the app. Warmstart never reads, stores or proxies a credential — login runs the vendor's
  own CLI in an embedded terminal.
- **Cache-aware routing.** A task lands on the session that already holds its context, when that
  session's cache is still warm. Follow-up work ("add X" → "test X" → "document X") converges on one
  session instead of paying three cold rebuilds.
- **A cache clock.** Every live session has an expiry. Before it lapses, Warmstart either sends it
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
- **Debate mode.** Ask one question and put two to five agents on it — each on the account, model and
  effort you name, each answering **blind** in its own session. An *organizer* then reads every
  position, may send each seat a brief for another round, and reports an agreement **with its
  dissent**, after which you choose what happens: execute it, split it into pieces, keep asking
  questions, mark it done, or stop. Every file path a seat cites is checked against the repository and
  the ones that do not resolve are listed beside its name — a report, never a penalty. ⚠️ The composer
  says what it will cost as a multiple of asking the question once, whether your roster spans more
  than one model family, and — honestly — that several published results find debate does **not** beat
  one strong agent at the same token budget.
- **Isolated workspaces.** Each task gets its own git worktree from a pooled set, on a branch named
  after the task. Agents never work in the trunk. ⛔ This is *organisation*, not a security boundary
  — read **[Security model](#security-model)** before you run this on a machine that has anything on
  it.
- **A live view.** The real agent TUI, not a reconstruction.
- **Answer it from your phone.** Turn on remote access and pair a phone by scanning a QR code: it
  shows quota and everything waiting on you, answers questions and approvals, overrides a quota gate,
  stops or reassigns work, and files new tasks. It gets its own revocable credential and a much
  smaller API than the desktop has — it cannot stop the daemon, administer accounts or type into a
  live agent — and it reaches only the projects you switch on, one at a time. Over Tailscale it
  installs to the home screen and notifies you with the app closed. See
  [`docs/remote.md`](docs/remote.md).

## Requirements

- Node.js 22+ (to build; the app runs on the Node inside Electron)
- Git 2.40+
- At least one agent CLI on `PATH`:

| CLI | Install | Needs |
|---|---|---|
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` | a Claude Pro/Max/Team subscription |
| **Codex** | `npm install -g @openai/codex` | any ChatGPT plan — **Free included** — or an API key |
| **Antigravity** | `irm https://antigravity.google/cli/install.ps1 \| iex` | Google AI Pro or Ultra |

You need **one**. Having several is the point — see *Multiple accounts* below.

- Windows is tested. ⚠️ macOS and Linux are written for and **have never been run**; the packaging
  targets exist and the platform branches are there, but nobody has started the app on either.
  macOS is the next platform to be brought up and is a release gate. **Linux is unsupported** — not
  "broken", simply never started, with nobody committed to fixing it if it is not.

## What works today

- **Add an account** in Settings → Workers. Warmstart creates an isolation directory, runs the
  vendor's own `login` in a terminal you type into, and verifies who signed in. It never reads,
  stores, copies or proxies a credential — each account must be separately and legitimately
  subscribed. A switch on each row holds an account out of dispatch without decommissioning it,
  and an account a run has proved unusable says so and stops being offered work, judgment, or a
  background usage probe until you fix it.
- **Add a project in one dialog.** The `+` beside **Projects** in the sidebar opens a three-step
  setup: pick the directory with your OS file picker, and Warmstart tells you what it
  found there — a repository or not, what it is built with, which of `README.md`, `AGENTS.md` and
  `HANDOFF.md` are missing, and whether the workspace directory it recommends is free. Then set the
  workspace directory, the finish policy, the landing branch, session sharing, the completion mode
  and the workspace pool size, and accept or edit the check commands it proposes from the project's
  own manifests. For an empty or undocumented project it offers to write starter `README.md`,
  `AGENTS.md` and `HANDOFF.md` files — editable before they land, and ⛔ it never overwrites one that
  already exists. The last step lists every write before it happens; nothing touches your disk until
  you press Create.
- **File a task and walk away.** It gets a worktree from the project's pool, a branch named after the
  task, and an agent on an account that can take it. When the agent reports done, what happens next is
  your **finish policy** — land it unattended, wait for you, open a pull request, or run the project's
  own finishing instructions — set fleet-wide, per project, or per task, and changeable at any time.
  ⛔ Warmstart never writes a commit for an agent, and never discards work it declines to
  land: it goes on the **Loose ends** list instead. See [docs/landing.md](docs/landing.md).
- **Approvals, not interruptions.** When an agent needs permission, the request arrives as a
  structured event, is answered by your project's rules where possible, and otherwise appears as a
  one-keystroke strip above your work. *Always* turns it into a rule so the next one answers itself.
  ⛔ **This describes an agent that asks.** Unattended work on Claude Code and Antigravity runs with
  permission checks *bypassed* and raises no approvals at all — see
  **[Security model](#security-model)**, which is the honest version of this bullet.
- **Cancel without losing anything.** Cancelling stops the work, asks the agent to commit what
  compiles and write a handoff, releases the workspace, and rests the task — it never deletes.
  Deleting is separate, and never removes the record of what a run cost.
- **Spend less on the same work.** A warm prompt cache is an asset with an expiry date: a read costs
  0.1× and *refreshes the TTL for free*, while rebuilding a lapsed one costs 2.0×. Warmstart watches
  that clock on every session and picks between sending it queued work, keeping it warm, compacting
  it, and letting it go — and the **Cost** view shows you which it chose and why.
- **Don't rebuild what the agent already knows.** A task replied to continues in its own session, and
  one whose session has since exited **resumes the same conversation** rather than starting over —
  measured on this machine, a cold turn built 41,542 tokens of prompt prefix that a resumed one read
  back for 65. Tasks can also *share* a conversation across a project, which is ⛔ **off by default**,
  because an agent that joins one sees everything said in it. See [docs/sessions.md](docs/sessions.md).
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
  configured at all, Warmstart behaves exactly as it would without one.
- **Settings → Global** tells you which CLIs were found, who is signed in, how old each quota reading
  is, which cost model is in force, and — per adapter — what Warmstart can and cannot verify about it.

### Providers are not interchangeable, and Warmstart says so

The three CLIs differ in ways that matter to a scheduler and are invisible in a feature comparison.
Each difference is a capability Warmstart reads, never a branch in its code:

| | Claude Code | Antigravity | Codex |
|---|---|---|---|
| **Accounts per machine** | unlimited | ⛔ **one** | unlimited |
| Can compact a long session | ✔ | ⛔ | ⛔ |
| Something reviews each action | ✔ | ⛔ | ⛔ |
| Warmstart can meter its cost | exactly | from the live stream | from the live stream |

Antigravity keeps its credential in the OS keyring with no way to point it elsewhere, so **one machine
holds exactly one Antigravity account** — Warmstart refuses to commission a second rather than let two
workers quietly share one window. A CLI that cannot compact hands off and closes instead. A CLI with
no reviewer gets a narrower allowlist written into its own configuration before every run.

⚠️ Everything in that table was established by **running the CLIs**, not by reading their
documentation — which mattered, because several documented claims turned out to be wrong in ways that
would have failed on the first spawn. [`docs/adapters.md`](docs/adapters.md) records what was measured,
when, against which version, and what is still unverified.

> **On quota numbers.** All three CLIs can be asked for a live reading without spending a token:
> `/usage` typed into an interactive session is handled by the client on Claude Code and Antigravity,
> and Codex answers `account/rateLimits/read` over its app-server. Probe drives them for you. ⚠️ A reading is always shown with
> its age, and an old one is reported as *unknown* rather than as a number.
>
> One consequence is still worth stating plainly: the compaction reserve, which stops an account
> running out of room to *save* a large session, reports `unknown` rather than `ok`. A percentage
> is not a size, and no vendor publishes what one percent of a window is worth.
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
npm run test:e2e     # WARMSTART_E2E=1 required. SPENDS REAL TOKENS
```

**Packaging.**

```bash
npm run pack         # unpacked app in release/win-unpacked, for testing. ⛔ Nothing may be
                     # running out of it: install the app if you want one you can keep open.
npm run dist         # installers for the current platform
```

⚠️ Builds are **unsigned**. Windows SmartScreen will warn; macOS Gatekeeper will refuse until you
clear it by hand. That is the honest state of a pre-alpha rather than something worked around —
signing is a certificate and a release process, not a config line.

## Security model

⛔ **Read this before pointing Warmstart at a repository on a machine that has anything else on it.**
What follows is not a warning about a theoretical risk; it is what the code does today.

**Unattended work on Claude Code and Antigravity runs with permission checks turned off, as your OS
user.** When the scheduler dispatches a task, `permissionModeFor`
([`src/daemon/sessions.ts`](src/daemon/sessions.ts)) substitutes the adapter's headless permission
mode for whatever the CLI would otherwise do:

| Adapter | Unattended mode | What bounds it |
|---|---|---|
| **Claude Code** | `bypassPermissions` | ⛔ Nothing at the OS level. Your user's full authority. |
| **Antigravity** | `--dangerously-skip-permissions` | ⛔ Nothing at the OS level. Your user's full authority. |
| **Codex** | `--sandbox workspace-write` | A real sandbox, widened to reach the shared `.git` |

This is not an oversight, and turning it off is not the fix: measured on t250, a headless Claude
session with permissions left on produced nine approval prompts in one hour for `git log` and `npm
test`, two of which timed out into a denial with nobody watching. A CLI that cannot ask cannot be
made to ask. The choice is between an agent that can finish and an agent that is contained, and
Warmstart currently chooses *finish* for two of its three adapters.

**So a dispatched Claude or Antigravity task can read and write anything your user can** — other
workers' isolation roots, `~/.ssh`, your whole home directory — and reach the network. The worktree
is where it is *pointed*, not a wall around it.

**What does bound it:**

- **The mandate** (`mandate.allowed`) — what a task may do to the *fleet*: file work, land, push.
  ⛔ It is not an OS permission and does not restrain a shell command.
- **The landing gate** — the project's check commands plus, on `await-human`, your own decision with
  the diff in front of you. Warmstart never writes a commit for an agent.
- **Credential separation** — each account gets its own isolation root; the tool never reads, copies
  or proxies a credential, and a spawned CLI gets `spawnEnv()`, which prefix-denies `CLAUDE*` and
  `ANTHROPIC_*` rather than a copy of your environment.
- ⚠️ **Codex's sandbox is widened on purpose.** A pooled worktree keeps its git metadata in the
  trunk, so committing needs the *common* `.git` — which holds every branch's refs and every task's
  objects. A Codex worker could therefore rewrite refs belonging to another task. There is no
  narrower grant; the real fix is a clone per worker, which is an architecture change and is not
  done. See [`src/daemon/adapters/grants.ts`](src/daemon/adapters/grants.ts).

**Treat any text that reaches a task as code you are about to run.** A prompt injection in a pasted
issue, a phone-filed task, or a repository an agent has read can turn into arbitrary commands with
no reviewer in front of them. Today Warmstart ingests nothing automatically — there is no GitHub,
Linear or Slack intake — so every task starts with something you or your agent typed. That is a
smaller attack surface, not an absent one.

**The per-project setting.** The add-project wizard asks how much authority unattended work may have
in that project, and it is changeable later in **Project → Settings**:

- **Sandboxed only** — dispatch only to adapters whose unattended mode is a real sandbox (today:
  Codex). A task that can only be run by a bypassing adapter **holds** rather than running: a hold
  you can see is the honest outcome, and silently running it sandboxed would reproduce the t250
  stall.
- **Full user authority** — today's behaviour, on every adapter. Appropriate for a repository you
  would hand to a contractor on a machine you would hand them too.

⚠️ Projects created before this setting existed keep **full user authority**, because changing what
a running fleet is allowed to do underneath it is worse than the disclosure.

**Reporting something.** This is a single-developer pre-alpha with no security contact and no
advisory process. Open a public issue; do not expect a coordinated disclosure.

[`docs/development.md`](docs/development.md) has the full script list, the `scripts/build-win.ps1`
pipeline and the platform failures that look like something else;
[`docs/testing.md`](docs/testing.md) explains what each test tier can and cannot prove.

## Documentation

[`docs/README.md`](docs/README.md) is the index, and it opens with a table mapping what you are about
to do to the page that governs it. The ones most people want first:

| Page | What it is the authority on |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | The four processes, the three loops, and the invariants |
| [`docs/glossary.md`](docs/glossary.md) | The domain words — worker vs session vs workspace |
| [`docs/cost-model.md`](docs/cost-model.md) | Caching, context, compaction, quota — each number with its source and date |
| [`docs/routing.md`](docs/routing.md) | How a task is scored and where it is sent |
| [`docs/adapters.md`](docs/adapters.md) | What each CLI can actually do, measured against a running binary |
| [`docs/development.md`](docs/development.md) | Setup, build, packaging, and the commit workflow |
| [`docs/remote.md`](docs/remote.md) | Phone access: the boundary, Tailscale setup, pairing and notifications |

Reference under `docs/` is kept current: a test in `npm test` fails the build on a page nobody
indexed, a link that resolves to nothing, or a source path a doc cites that has since moved.

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
| `docs/` | Current, maintained reference. Twelve pages; [`docs/README.md`](docs/README.md) is the index. |
| `transient_docs/` | Design and implementation plans, dated. Kept for reasoning, not status. |
| `AGENTS.md` | Conventions for AI agents working on this repo. |
| `HANDOFF.md` | Current state and what to do next. |

## Multiple accounts

Warmstart supports more than one account per provider, which is useful to anyone with, say, a
personal and a work subscription. Each account must be separately and legitimately subscribed, and
each is kept in its own isolation root; the tool never shares credentials between them and never
reads them at all.

⛔ **With one exception, and it is not a limitation Warmstart can engineer around.** Antigravity keeps
its credential in the operating system's keyring and offers no environment variable to point it at a
different one, so a machine holds exactly **one** Antigravity identity. Commissioning a second is
refused, with a message saying why — because two workers on one keyring are not two accounts, they are
two schedulers' worth of belief about a single window. Claude Code and Codex both have a
config-directory variable and are unlimited.

## Adding a CLI it does not know about

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
wrote a decoder for, so Warmstart **cannot meter it** — its runs cost an *unknown* amount rather than
nothing — it gets no Warmstart MCP tools, and its orphaned processes are never killed because their
identity cannot be proved. Doctor states all three. A CLI worth more than that is worth a real adapter
in `src/daemon/adapters/`, where its quirks can be measured and written down.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
