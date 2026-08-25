# agentyard

**A scheduler with a budget.** agentyard runs a fleet of coding agents across the accounts you own —
Claude Code, Gemini, local models — and routes each task to the worker, session and moment where it
is cheapest to run.

> **Status: pre-alpha, M0.** The scaffold exists and the app opens. Nothing schedules anything yet.
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

- Node.js 22+
- Git 2.40+
- At least one agent CLI on `PATH` (`claude`, `gemini`, or an OpenAI-compatible local endpoint)
- Windows today; macOS and Linux are written for and not yet tested

## Development

```bash
npm install
npm run dev
```

If the window fails to start with a missing-binary error, your npm blocked Electron's postinstall.
Run `node node_modules/electron/install.js` once and try again.

```bash
npm run typecheck    # tsc over main/preload/daemon and renderer
npm run build        # typecheck + production bundle into out/
npm start            # preview a production build
```

## Repository layout

| Path | What it holds |
|---|---|
| `src/main`, `src/preload` | Electron shell. A window host and nothing more. |
| `src/renderer` | React UI. |
| `src/daemon` | `orchestratord` — the scheduler, PTYs, store and MCP server. **M1.** |
| `src/shared` | Types crossing a process boundary. |
| `costmodels/` | Versioned pricing data. Never inline arithmetic. |
| `docs/` | Current, maintained reference. |
| `transient_docs/` | Design and implementation plans, dated. Kept for reasoning, not status. |
| `AGENTS.md` | Conventions for AI agents working on this repo. |
| `HANDOFF.md` | Current state and what to do next. |

## Multiple accounts

agentyard supports more than one account per provider, which is useful to anyone with, say, a
personal and a work subscription. Each account must be separately and legitimately subscribed, and
each is kept in its own isolation root; the tool never shares credentials between them and never
reads them at all.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
