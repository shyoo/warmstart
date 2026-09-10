# Documentation index

Reference for **Warmstart** — a scheduler that routes coding-agent tasks to the worker,
session and moment where they are cheapest to run.

Everything under `docs/` is **permanent and maintained**. If a page is wrong, fix it; do not append a
correction below the wrong sentence. `AGENTS.md` is the short entry point that points here.

## Read this before you…

| Before you… | Read |
|---|---|
| do anything at all | [`../HANDOFF.md`](../HANDOFF.md) — current state and what to pick up next. ⛔ The **only** file that carries status |
| touch any code | [`architecture.md`](architecture.md) — the four processes, the loops, and the invariants that break the product if broken |
| use a domain word (worker, session, workspace, resource, mandate, objective) | [`glossary.md`](glossary.md) — these terms are load-bearing and mean specific things |
| reason about cost, caching, quota or compaction | [`cost-model.md`](cost-model.md) — the measured numbers and where each came from. ⛔ Do not re-derive from memory; several are counter-intuitive |
| change how a task is routed or scored | [`routing.md`](routing.md) — the three decision phases, every weight, and worked examples |
| add or change an **adapter** | [`adapters.md`](adapters.md) — what each CLI can actually do, measured, with the date and version. ⛔ Read it before writing a capability from a vendor doc |
| touch conversation reuse, resume or sharing | [`sessions.md`](sessions.md) |
| touch finishing, landing, rescue or loose ends | [`landing.md`](landing.md) |
| add a column, a status or a migration | [`data-model.md`](data-model.md) |
| add or change an MCP tool | [`mcp.md`](mcp.md) |
| write or change a test | [`testing.md`](testing.md) — the four tiers, and the ways a suite here has reported a confident false pass |
| build, package, or hit a platform-specific failure | [`development.md`](development.md) |
| change the renderer | [`ui.md`](ui.md) |
| configure phone access or notifications | [`remote.md`](remote.md) |
| change pricing or add a provider | `../costmodels/` — data, never code. See [`cost-model.md`](cost-model.md) § *Cost models are data* |
| check or update a model's agentic-coding prior | `../benchmarks/` — versioned data, never code, mirroring `costmodels/`. See [`routing.md`](routing.md) § *Fitness* |
| understand *why* the design is shaped this way | `../transient_docs/implementation_plan_2026-08-24.md` — the design of record, decisions D1–D18. ⚠️ Dated, and never read for status |

## The pages

| Page | What it is the authority on |
|---|---|
| [`architecture.md`](architecture.md) | Process topology, the loops and their cadences, the RPC/IPC surface, the data directory, and the architecture invariants |
| [`glossary.md`](glossary.md) | Every domain word. Worker vs session vs workspace; task vs approval vs question; run vs task |
| [`cost-model.md`](cost-model.md) | Prompt caching, context, compaction, quota, metering — each number with its source and date |
| [`routing.md`](routing.md) | Eligibility gates, candidate scoring, tie-breaking and the controller consult |
| [`adapters.md`](adapters.md) | Per-CLI capabilities as measured against a running binary, and what is still unverified |
| [`sessions.md`](sessions.md) | Continuation, resume and cross-task sharing; the lease and what a borrower is told |
| [`landing.md`](landing.md) | Finish policies, the landing bar, rescue commits and loose ends |
| [`data-model.md`](data-model.md) | The SQLite schema, the migration contract, and every load-bearing enum |
| [`mcp.md`](mcp.md) | The two MCP tiers, every tool in each, and how a session is given one |
| [`testing.md`](testing.md) | The four test tiers, what each can and cannot prove, and the suite pitfalls |
| [`development.md`](development.md) | Setup, build, packaging, platform pitfalls, and the commit workflow |
| [`ui.md`](ui.md) | Renderer structure, routes, styling tokens and the UI's own conventions |
| [`remote.md`](remote.md) | Remote device access, pairing, Tailscale setup and notifications |

## Where a fact belongs

⚠️ Four files, and putting a fact in the wrong one is how it goes stale.

| File | Holds | Lifetime |
|---|---|---|
| `HANDOFF.md` | Current state, what is unproven, what to do next. **Under 200 lines** | Replaced as work lands |
| `AGENTS.md` | The rules an agent must not break, and where to read the detail. **Under 200 lines** | Durable; an entry is deleted when the pitfall becomes impossible |
| `docs/` | Reference that is true regardless of what anyone is working on | Permanent, maintained |
| `transient_docs/` | Dated plans, design of record, and `changes_history.md` — the archive of *why* | Goes stale by design |

⛔ `internal_docs/` is the owner's private notes. Gitignored. Do not commit it, do not cite it.

⚠️ **If you are about to append, ask what you can remove in the same edit.** Every doc edit should be
net-neutral or net-shorter unless it documents something genuinely new.

## The guard

`src/daemon/docs.test.ts` runs in `npm test` and fails the build when documentation drifts: a page
missing from this index, a relative link that resolves to nothing, a `src/…` path cited by a doc that
no longer exists, or `AGENTS.md` / `HANDOFF.md` over their line budgets. It is not a substitute for
reading — it catches the mechanical half only.
