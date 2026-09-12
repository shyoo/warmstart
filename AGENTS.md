# Warmstart — Agent Workspace Guide

How to work in this codebase: the rules you must not break, and where the detail lives.

⚠️ **This file is loaded into every session's context, so its length is a real and recurring cost.**
It is a map, not a manual. A fact belongs here only if an agent needs it *before* knowing which page
to open. Everything else belongs in [`docs/`](docs/README.md), and
[`src/daemon/docs.test.ts`](src/daemon/docs.test.ts) fails the build if this file passes 200 lines.

## Start here

1. **[`HANDOFF.md`](HANDOFF.md)** — current state and what to pick up next. ⛔ The only file that
   carries status. Read it before anything else.
2. **[`docs/README.md`](docs/README.md)** — the documentation index. It has a *"Read this before
   you…"* table that maps what you are about to do to the page that governs it. Use it rather than
   guessing which page is authoritative.

The three pages most work touches: [`docs/architecture.md`](docs/architecture.md) (processes, loops,
invariants), [`docs/glossary.md`](docs/glossary.md) (the domain words, which are load-bearing), and
[`docs/testing.md`](docs/testing.md) (the four tiers and the ways a suite here has lied).

## How to work here

- **No subagents.** Do the work yourself with direct tool calls. A subagent pays a fresh context cost
  to re-derive what this file and `HANDOFF.md` already give you.
- **Measure, don't assert.** This project is built on things that were checked. State a number with
  where it came from and when. What you cannot measure, label *inferred* and say what the inference
  rests on. A confident unsourced sentence is worse than none, because it gets trusted.
- **Prefer running the cheap experiment over hedging in prose.** Several decisions here were settled
  in minutes by a two-command spike. If a question is empirical, answer it.
- **Two names, and which one goes where.** **Warmstart** is public: UI copy, docs, PR
  bodies, prompt text, `productName`, the MCP server name. **`agentyard`** is internal and stays
  that way: source comments, `window.agentyard`, test fixtures, `LEGACY_APP_DIR`. ⛔ On-disk
  identifiers were *migrated*, not left alone — `.warmstart/project.json`, the data
  directory, `WARMSTART_*`, `warmstart/t<seq>` branches. `adoptLegacyDataDir`
  in [`src/daemon/paths.ts`](src/daemon/paths.ts) and `repointIsolationRoots` in `db.ts` are both
  required halves; `paths.test.ts` fails if either goes.

### Docs, and why they shrink as often as they grow

`HANDOFF.md` = state + next step, under 200 lines, *replaced* as work lands, never stacked.
`AGENTS.md` = durable rules and the map, under 200 lines; when a pitfall becomes impossible, delete
the entry. `docs/` = permanent maintained reference — if it is wrong, fix it in place.
`transient_docs/` = dated plans and the design of record; stale by design, never read for status.
⛔ `internal_docs/` is private and gitignored: do not commit it, do not cite it.

⚠️ **If you are about to append, ask what you can remove in the same edit.**

⛔ **A commit owes the docs an edit.** [`docs/development.md`](docs/development.md) §7 has the table
mapping each kind of change to the page it invalidates, and `HANDOFF.md` is owed by *every* commit.

### Git

- Private repo, single developer, no PR review. Commit on `main` directly, and **only when asked**.
- Never commit `internal_docs/`, `node_modules/`, `out/`, `release/`, or anything gitignored.
- **`/commit` commits locally; `/push` publishes.** Same steps, and `/commit` writes nothing to
  origin. ⛔ Both integrate `origin/main` first. ⛔ **Both are Claude Code slash commands, not a
  general instruction** — a codex or `agy` worker cannot invoke either and must not improvise its own
  version from memory (t102, 2026-09-01: one did, and edited unrelated lint failures to make a check
  it was never asked to run pass). Follow the finishing instruction the task actually gives you.

## Layout

```
src/main, src/preload   Electron shell. A window host and nothing more.
src/renderer            React UI. Tokens in src/renderer/src/styles/tokens.css.
src/daemon              orchestratord: scheduler, PTYs, store, MCP server
src/shared              types crossing a process boundary
costmodels/             versioned pricing data
docs/                   the maintained reference — start at docs/README.md
.claude/skills/         project skills. /commit commits locally, /push publishes
```

## The invariants

⛔ These are not preferences; breaking one breaks the product. Each is stated in full, with the
measurement behind it, in [`docs/architecture.md`](docs/architecture.md) §4. The short forms:

- **The TUI is for humans; the transcript is for the machine.** Never parse ANSI to determine state.
  One narrow declared exception exists (`usageRefresh.answer: 'screen'`) and it may produce a quota
  reading and nothing else.
- **The scheduler costs zero tokens.** A loop running every 10s for weeks must bill nothing. The LLM
  controller is consulted only on discrete judgment events, and is **never in the critical path** —
  every judgment event needs a deterministic fallback on a timer, written first.
- **A decision re-evaluated before its action lands is a loop.** Record the ask *with the evidence
  that would prove it landed*, and re-read before acting on the far side of the wait. Three
  components learned this separately; one sent `/compact` thirteen times in two minutes.
- **Never branch on an adapter or mode name.** Adapters declare `capabilities` and `policy`;
  objectives are a weight vector consumed in exactly two places
  ([`src/daemon/objective.ts`](src/daemon/objective.ts)). A missing feature is a missing capability,
  never an `if`.
- **Nothing about one machine may be hard-coded** — no absolute path from your disk, no assumption
  any CLI is installed. The app must open on a clean profile and say so.
- **Every belief carries its basis.** A cost returns a number *and* how it was reached; a score
  publishes its own arithmetic. `unknown` is a verdict, not a synonym for `ok` or for "half as bad".
  A term stuck at zero fleet-wide is a missing input, not a safe default. A quota reading is never
  shown without its age.
- **Security boundaries.** The renderer never holds the daemon token. Code is never loaded from the
  data directory. A spawned CLI gets `spawnEnv()`, which prefix-denies `CLAUDE*` / `ANTHROPIC_*` —
  never a copy of `process.env`. Unattended judgment gets no tools; its reply is validated against a
  closed set, and a reply that keeps failing means the *prompt* is wrong — ⛔ but only once a `result`
  with `isError` has been ruled out, because an errored turn carries the *vendor's* JSON where the
  answer goes and it validates as badly as a bad answer. Preference never widens
  authority: `finishPolicy` says what should happen, `mandate.allowed` says what may.
- **Process lifecycle.** The daemon is *asked* to stop, never killed. ⛔ Never kill a process by
  image name — not in code, not in a shell, not once in a test. ⛔ Never kill a bare pid; read the
  command line and confirm it is yours, and if you cannot read it the answer is no.
- **A contended resource is a hold, never a failure**, and every held status needs something that
  ends the hold. `admit()` in [`src/daemon/tasks.ts`](src/daemon/tasks.ts) is the only thing that
  re-admits a `blocked` task — never reimplement it. ⛔ **A task that settles admits its dependents
  from inside `setStatus`, not from the call site**: seven paths settle a task and remembering was
  not a mechanism (t192 → t193, 2026-09-04). `admitBlocked()` on the tick is the backstop.
- **Work is visible, gated and billed only as a *run*.** A reply to a stopped task is a new run on
  the same thread, never a note pushed into a warm session. `task_complete` is the only signal an
  agent finished; a clean exit says nothing.
- **Every gate on whether an account may be handed a turn lives in
  [`src/daemon/eligibility.ts`](src/daemon/eligibility.ts), in one list**, read by work and judgment
  alike. Two copies drifted once and cost tokens in the one loop that spends them.
- **Landing is measured against `origin/<target>`** by `landedRef()` in
  [`src/daemon/worktrees.ts`](src/daemon/worktrees.ts), and a landing that landed nothing must not
  say it landed. A clean workspace is not evidence the work was done. The tool never writes a commit
  and never destroys work; what it declines to land surfaces under **Loose ends**.
- **A quality review never grades its own author, and no path writes a score that could not name its
  reviewer.** Excluded by *adapter*, not by account — one Claude grading another Claude is Claude
  grading Claude. No eligible peer means no review; there is no self-graded variant. ⛔ The score
  feeds one preference term among eleven (`fitness`, `objective.ts`) and can never exclude a candidate.
- **Cancel is not delete.** Cancel winds down into a resting state and destroys nothing. Delete is
  human-only, soft by default, and never removes runs.
- **Agents work in a pooled worktree, never the trunk**, on a branch named for the *task*. ⛔ A slot
  does not arrive clean: committed if there is a branch, stashed if there is not, `reset --hard`
  never. ⭐ The branch, not the stash, is the carrier — a stash belongs to a repository and does not
  reach the workspace the next run claims.

## Things that will bite

Grouped by the page that explains each in full. Read that page before working in the area.

**Tests** — [`docs/testing.md`](docs/testing.md) §§3-4. `npm run coverage` reports L1 only (50% of
statements, 2026-09-07); a file at 0% there may still be proven at L2 or L3. Every suite below L1
drives a build product and none of them builds one. A suite that cannot run twice at once is a bug in the suite (hard-coded
port, 2026-08-29). Bound the wait nearest the resource. The UI worker has no credentials, so any
check against runs, sessions or tokens **passes against an empty list** — assert non-empty as half
the claim. [`test/ui.test.mjs`](test/ui.test.mjs) never opens a project, so project-tab changes run
green untested: mutate the code and watch it go red first. A test may not assert a host capability.
Anything calling `plan()` needs the CLI on PATH and CI has none. A Windows path through a shell
heredoc silently loses a backslash — write those literals with the Edit tool.

**Build and platform** — [`docs/development.md`](docs/development.md) §§1–4. Electron 44 has no
postinstall and does not download itself: run
[`scripts/ensure-electron.mjs`](scripts/ensure-electron.mjs) or every suite fails as if the build
broke. ⛔ Never compare two paths with `===`; use `samePath` from
[`src/daemon/fspath.ts`](src/daemon/fspath.ts). node-pty does not search PATH — everything spawnable
goes through [`src/daemon/which.ts`](src/daemon/which.ts); every `git` call through
[`src/daemon/git.ts`](src/daemon/git.ts); every promise-based `execFile` through
[`src/daemon/spawn.ts`](src/daemon/spawn.ts); and every median through
[`src/daemon/stats.ts`](src/daemon/stats.ts). Private copies do not come back — `git status --porcelain`
uses leading whitespace as data. `cmd /d /s /c` splits any path with a space;
`node --experimental-strip-types` resolves no `@shared` alias, so `adapters/local-llm-bridge.ts`
shares nothing and copies instead. The preload must be CommonJS, and native modules cannot load from inside an asar.
`ready-to-show` may never fire, so no window may be shown only from it. `node:sqlite`, not
better-sqlite3. ⛔ An agent inside the Claude desktop app has `%APPDATA%` redirected to that package's
own copy — what it reads or writes under `AppData\Roaming` is not what the user's app sees (§4 Paths).

**Adapters and CLIs** — [`docs/adapters.md`](docs/adapters.md). ⛔ Read it before writing a
capability from a vendor doc; several documented claims would have failed on the first spawn. A
capability is a fact about *this adapter*, not the vendor's CLI, and carries `verification`.
Conservative is the cheap direction. Never carry a flag's shape across adapters — `-p` is `--print`
on `claude`, `--profile` on `codex` and a *string-valued* `--print` on `agy`. `--permission-mode
auto` must be passed explicitly. `--print` will not start under a PTY. The workspace-trust dialog
swallows every keystroke until answered. `gemini-cli` is dead; the Google adapter is `agy`.

**Cost and quota** — [`docs/cost-model.md`](docs/cost-model.md). ⛔ Do not re-derive these from
memory; several are counter-intuitive. No pricing arithmetic inline — ask the cost-model object, and
let it say `unpriced` rather than inventing a number. Runs are priced in layered money (subscription
allocation + overage cash; list price excluded). `/usage` costs a real turn in **print mode
only**; interactive it is free. A cost is a difference, so a run gets two quota readings or none. A
falling spend series draws down a purse, where a rise is a top-up (baseline reset). A vendor's
rate-limit signal names a *window*, and a caution is not a refusal. Changing tool
definitions invalidates the whole prompt cache prefix.

**Schema** — [`docs/data-model.md`](docs/data-model.md). Migrations are numbered, append-only and
must be replay-safe; `versionBefore` matches on text, not number. **MCP** —
[`docs/mcp.md`](docs/mcp.md): two tiers, and only the daemon writes `WARMSTART_TIER`.
**Renderer** — [`docs/ui.md`](docs/ui.md): agent output is untrusted **text**. A thread message is
parsed as a closed markdown subset by [`src/renderer/src/lib/markdown.ts`](src/renderer/src/lib/markdown.ts)
and drawn as elements this codebase writes; ⛔ no raw HTML, no `dangerouslySetInnerHTML`, and a
link's `href` is whitelisted at the parse. A person's own typed message is never reinterpreted.

## The one distinction to hold in your head

[`docs/glossary.md`](docs/glossary.md) is the authority, but everything depends on this one: **a
worker is not a session.** Quota lives on the worker (an account); context lives on the session (a
live process). Routing has to satisfy both, and conflating them makes the scheduler incoherent.
