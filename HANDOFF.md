# Warmstart — Session Handoff

## Current state — 2026-09-12

Warmstart M0–M6 is implemented. The current branch contains debate mode, quota-aware scheduling,
pooled worktrees, model-aware routing, quality review, remote access, packaging, and the completed
Warmstart rename. The maintained reference in [`docs/`](docs/README.md) is the authority on each
subsystem; dated design and incident history belongs in `transient_docs/`, not here.

Last full local validation on this branch (2026-09-12): `npm run typecheck`, `npm run lint`,
`npm test` (**3,171 passed, 2 skipped**) and `npm run build` all passed. The expected test warnings
exercise refusal and recovery paths; they are not failures.

## Closed in this cleanup

- **Debate seats now see current code and stay in their role.** t383–t385 were all initially cut
  from `origin/main` at `316aa33`; t385 therefore correctly found no debate implementation, since
  `debate.ts` arrived at `467c90e`. `report-only` work now starts from the local landing target, and
  seat prompts treat the submitted text as a question rather than instructions to edit, commit,
  rebase or finish. See [`transient_docs/debate_mode_2026-09-12.md`](transient_docs/debate_mode_2026-09-12.md)
  §12.
- **The reported Luna `task_complete` defect is closed.** Codex deliberately has no per-session MCP
  registration (`mcp: false`), so the old universal seat wording was wrong. Seats now follow the
  completion contract actually present in their generated prompt. Model exploration did not choose
  Luna: debate seats are roster-pinned and exploration rejects pinned tasks.
- **The t382 organizer capacity leak is closed.** A debate organizer now winds down its run and
  session after sending round briefs or splitting work, just like a Plan & Split planner.

## Remaining work — ordered by payoff

These are deliberately not marked complete: each needs either a real signed-in account, a macOS
machine, release credentials, or a human product judgement. Do not replace the missing evidence with
a unit test.

1. **Run one more live Plan & Split.** Exercise a `merge-branch` landing while a sibling is genuinely
   mid-run, and an organizer resolution turn where some pieces fail. This is the highest-value
   scheduler integration check.
2. **Run a real debate and record its measurements.** Compare total tokens/cost against a strong
   single-agent answer; record cache reads, resolved/unresolved citations, and whether the organizer
   changed the operator's decision. The evidence format is in
   [`transient_docs/debate_mode_2026-09-12.md`](transient_docs/debate_mode_2026-09-12.md) §7.
3. **Run human-in-the-loop, `commit-and-merge`, and cross-task reuse with a real agent.** The code
   and L1–L3 checks exist, but this has not been demonstrated in flight.
4. **Run on macOS with a real CLI; this is the launch gate.** Verify detached daemon startup without
   system Node, `node-pty` under hardened runtime, Application Support isolation, Antigravity's
   Keychain interaction, and Gatekeeper. The signed arm64 release cannot be called ready before it.
5. **Execute the signing/release pipeline.** macOS signing and notarisation are decided; required
   secrets are not configured and `.github/workflows/release.yml` has never run. Windows is
   intentionally unsigned initially. Release notes must tell upgraders to uninstall the old app,
   because the `appId` changed.
6. **Give Antigravity a real per-worker isolation root.** It currently shares `~/.gemini`; changing
   `HOME` must first be proven not to disturb the OS-keyring credential. See [`docs/adapters.md`](docs/adapters.md).
7. **Finish the metering and calibration measurements.** Meter PTY-hosted Codex from rollout data;
   compare small and large quality-review models on the same five tasks; verify the Claude credits
   gauge against one real invoice; and decide whether preempted runs should contribute to estimates.
8. **Increase thread UI coverage where behaviour changes.** The add-project wizard, project settings,
   conversations, session TUI, routing pages and selected thread rows are exercised; most thread
   interactions remain hand-tested. Extract pure decisions into `src/renderer/src/lib/` first.
9. **Continue the scheduler split only when touching it.** `scheduler.ts` remains about 3,780 lines
   against a ~1,500 target. Existing seams import back from it, so no extracted module may read a
   scheduler binding at module evaluation time.

## Open questions and quiet-worker measurements

| Item | Evidence needed | Consequence |
|---|---|---|
| R1: Claude auto-mode classifier cost | Run the same shell-heavy task on a quiet subscription worker in `auto` and `default`; compare quota delta with transcript tokens. | If billed, `auto` cannot remain a free default. |
| R2: tokens per quota percent | Sample `/usage` around known transcript work for each worker/model/tokenizer. | Lets quota gates work in tokens rather than percentages. |
| R4: end-to-end compaction cost | Record a known-size compaction's transcript delta and duration. Six samples exist; `post_tokens` is still null. | Tunes the T+53-minute deadline. |
| R8: controller reply shape | Designate a controller, file a `plan`, drain once, then record whether the validator accepted an answer or used its fallback. | Proves the one M4 path L1 cannot reach. |
| Vertex/Antigravity cache price | Find a published vendor price; do not infer it experimentally. | Keeps `cache.kind: "unpriced"` honest. |
| Expected-idle estimator | Gather real queue data first. | No honest design exists without it. |

Record measurement results, CLI versions and dates in [`docs/cost-model.md`](docs/cost-model.md), then
remove the corresponding row here. R5 is intentionally dropped: resume is measured and shipped
within one account; cross-account transplant needs a second subscription.

## Durable constraints

- A worker is an account; a session is a live process. Quota belongs to the worker, context to the
  session. [`docs/glossary.md`](docs/glossary.md) is authoritative.
- The scheduler spends zero tokens; model judgment is asynchronous and has a deterministic fallback.
- Agents use pooled worktrees, never the trunk. Nothing kills a process by image name or bare PID.
- The renderer treats agent output as untrusted text. No raw HTML.
- Do not trust an agent-session view of `%APPDATA%`: packaged hosts can redirect it. See
  [`docs/development.md`](docs/development.md) §4.
