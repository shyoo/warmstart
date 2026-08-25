# agentyard — Agent Workspace Guide

Conventions, layout and pitfalls for AI agents working on this codebase. **This file is loaded into
every session's context, so its length is a real cost.** A fact belongs here only if it will still be
true and still be needed next month.

## Which doc to read, and when

| Before you… | Read |
|---|---|
| do anything at all | **`HANDOFF.md`** — current state, what to pick up next |
| reason about cost, caching, quota or compaction | **`docs/cost-model.md`** — the measured numbers and where each came from. ⛔ Do not re-derive these from memory; several are counter-intuitive |
| use a domain word (worker, session, workspace, resource, mandate, objective) | **`docs/glossary.md`** — these terms are load-bearing and mean specific things |
| understand *why* the design is shaped this way | **`transient_docs/implementation_plan_2026-08-24.md`** — the design of record, with every decision (D1–D18) and its reasoning |
| change pricing or add a provider | `costmodels/` — data, never code. See `docs/cost-model.md` § Cost models are data |

## Rules

- **No subagents.** Do the work yourself with direct tool calls. A subagent pays a fresh context cost
  to re-derive what this file and `HANDOFF.md` already give you.
- **Measure, don't assert.** This project is built on things that were checked. When you state a
  number, say where it came from and when. When you cannot measure something, label it *inferred* and
  say what the inference rests on. A confident unsourced sentence is worse than no sentence, because
  it gets trusted.
- **Prefer running the cheap experiment over hedging in prose.** Several design decisions here were
  settled in minutes by a two-command spike. If a question is empirical, answer it.

### Architecture invariants

These are not preferences; breaking one breaks the product.

- ⛔ **The TUI is for humans; the transcript is for the machine.** Never parse ANSI output to
  determine state. Usage, context size, idle time and effort all come from the agent's own transcript
  JSONL, which is exact. Terminal bytes go to xterm.js and nowhere else.
- ⛔ **The scheduler costs zero tokens.** Dependency resolution, quota gates, cache countdowns,
  retries and auto-resume are arithmetic. The LLM controller is consulted only on discrete judgment
  events. A loop running every 10 seconds for weeks must not bill anything.
- ⛔ **No pricing arithmetic inline.** Ask the cost-model object (`costOfKeepalive`, `costOfCompact`,
  `costOfColdStart`, `cacheExpiryFor`). Providers price caching in structurally different ways and
  all of them move.
- ⛔ **Never branch on an adapter or mode name.** No `if (adapter === 'claude')`, no
  `if (mode === 'economy')`. Adapters declare `capabilities` and `policy`; objectives are a weight
  vector consumed in exactly two places. Antigravity lacking `/compact` — or lacking a classifier-backed
  `auto` mode — must express itself as a missing capability, not a special case.
- ⛔ **Nothing about one machine may be hard-coded.** No `C:\Dev`, no account names, no assumption
  that any CLI is installed. Everything is discovered or configured. The app must open on a clean
  profile with zero workers, say so, and offer the wizard.
- ⛔ **Native modules live in the daemon, never the renderer.** An Electron upgrade must not be able
  to break a running fleet.
- ⛔ **The renderer never holds the daemon token.** It calls the main process over IPC, and main is
  orchestratord's only client. The renderer displays untrusted agent output; it does not get a
  credential to a service that can spawn processes.
- ⛔ **A quota reading is never shown without its age.** Stale is rendered as *unknown*, because a
  stale percentage makes the compaction reserve look satisfied when it is not.
- ⛔ **An approval is not a task.** A permission prompt blocks one live session, has a closed answer
  set and a deadline set by that session's cache expiry. It goes on the Approvals bar, is answered by
  policy or one keystroke, and becomes an `awaiting_human` task only if it goes unanswered past
  `escalate_after`. Approvals are captured through a structured channel — never by reading the screen.
- ⛔ **Cancel is not delete.** Cancel winds a run down through the preemption protocol into a resting
  state (`paused_user` / `draft` / `cancelled`) and destroys nothing. Delete is separate, human-only,
  soft by default, and **never removes runs** — they are the estimator's training data and the record
  of real spend.
- **Agents work in a pooled worktree, never the trunk.** The branch is named after the *task*
  (`agentyard/t123-…`), never after the workspace it happened to land in.

### Doc hygiene — these files shrink as often as they grow

- **`HANDOFF.md` = current state + what to do next.** Target **under 200 lines**. Adding a session's
  work means *replacing* the part it finished, not stacking a dated section on top. When something is
  done, delete its entry; if the reasoning is worth keeping, move it to
  `transient_docs/changes_history.md`.
- **`AGENTS.md` = durable rules, layout, pitfalls.** When a pitfall stops being possible, delete the
  entry. Keep the rule; the story of the bug belongs in `changes_history.md`.
- **`docs/` = permanent, maintained reference.** Kept current. If it is wrong, fix it.
- **`transient_docs/` = dated plans and design-of-record.** They go stale by design and are kept for
  the reasoning. Never read them for status — that is `HANDOFF.md`.
- **`internal_docs/` = the owner's private notes. Gitignored. Do not commit it, do not cite it.**
- ⚠️ **If you are about to append, ask what you can remove in the same edit.**

### Git

- Private repo, single developer, no PR review. Commit on `main` directly, and **only when asked**.
- Never commit `internal_docs/`, `node_modules/`, `out/`, or anything matching `.gitignore`.

## Layout

```
src/main, src/preload   Electron shell. A window host and nothing more.
src/renderer            React UI. Tokens in src/renderer/src/styles/tokens.css.
src/daemon              orchestratord: scheduler, PTYs, store, MCP server.   <- M1, not built
src/shared              types crossing a process boundary
costmodels/             versioned pricing data
```

## Things that will bite

- **Electron's postinstall is blocked by this machine's npm.** After `npm install`, if
  `node_modules/electron/dist/electron.exe` is missing, run `node node_modules/electron/install.js`.
  The failure looks like a broken build, not a missing download.
- **A sandboxed preload must be CommonJS.** `package.json` sets `"type": "module"`, so the preload is
  built to `index.cjs` via an explicit rollup output override in `electron.vite.config.ts`. If you
  see *"Cannot use import statement outside a module"* from the preload, that override was lost.
  ⛔ Do not "fix" it by dropping `sandbox: true`.
- **Idle time is measured from the request *start*, not the response record.** A four-minute response
  has already spent four minutes of the cache TTL. Measuring from the last assistant turn is
  optimistic by one response length.
- **Changing tool definitions invalidates the entire prompt cache prefix.** A session's MCP config is
  frozen for its lifetime. This is why workers on one project get identical MCP configs.
- **`claude -p /usage` spends a real turn.** The slash command is taken as a prompt. There is no free
  live quota probe on 2.1.223 — `docs/cost-model.md` §5 has the ladder that replaces it, and a stale
  reading must never be rendered as a current one.
- **`claude auth status --json` exits 1 when not logged in**, but still prints valid JSON. Read
  stdout, not the exit code, or every un-commissioned worker reports as "probe failed".
- **node-pty does not search PATH.** On Windows it goes straight to CreateProcess and fails with a
  bare *File not found* for a command that runs fine in a shell. Everything spawnable goes through
  `src/daemon/which.ts`, which also routes `.cmd`/`.bat` shims through the command processor.
- **`node:sqlite`, not better-sqlite3.** It ships inside the Node that Electron already carries, so
  there is no native module to rebuild against Electron's ABI. better-sqlite3 publishes no Electron 44
  prebuild and would need a toolchain on every contributor's machine.
- **`--permission-mode auto` must be passed explicitly.** `auto` is the built-in start mode only for
  a *terminal* session on Pro/Max/Team; `claude -p` and the Agent SDK start in `default`, and an
  `"auto"` value for `defaultMode` in a project settings file is ignored. Forget the flag and every
  scheduled run is silently Manual, stalling on its first shell command with nobody watching.
- **Auto mode discards broad allow rules** — blanket `Bash(*)`, wildcarded interpreters,
  package-manager run commands, `Agent` and `Monitor` rules. Narrow rules like `Bash(npm test)`
  survive, so generated allowlists must be written narrow or they vanish where they were needed.
- **`gemini-cli` is dead.** Google stopped serving individual accounts 2026-06-18; the Google adapter
  is **Antigravity CLI (`agy`)**. Do not write against `gemini`.
- **Compaction takes about two minutes.** Any deadline that ends in a compaction has to budget for
  it — see `docs/cost-model.md`.

## Design vocabulary

`docs/glossary.md` is the authority. The one distinction worth stating here because everything
depends on it: **a worker is not a session.** Quota lives on the worker (an account); context lives on
the session (a live process). Routing has to satisfy both, and conflating them makes the scheduler
incoherent.
