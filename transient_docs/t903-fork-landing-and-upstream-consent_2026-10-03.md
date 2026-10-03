# t903 — Fork landing, and consent before a pull request to someone else's repo

Dated plan, 2026-10-03. Stale by design once it lands; `docs/landing.md` is the authority after.

## What t902 actually did (measured 2026-10-03, read-only)

Sources: `gh repo view`, `gh api …/issues/116/events`, the live `warmstart.db` (read-only), and
`git` in `C:\Dev\Optiscaler-Client`.

| UTC | What happened | Source |
|---|---|---|
| 21:08:46 | `shyoo/Optiscaler-Client` created, `isFork: true`, parent `Optiscaler-Client/Optiscaler-Client`, **PUBLIC** | `gh repo view` |
| ~21:12 | Project row created, `landing.pushRemote: "fork"`; the wizard also set `finish: "pull-request"` (t897's `clonedDraft`) | `projects.created_at`, `newproject.ts:162` |
| 21:44:31 | t902's first run finished; **the daemon** pushed `warmstart/t902` to `fork` and opened **PR #116 on upstream** with no question asked | thread row 10497, `task_deliveries` |
| 22:09:48 | You closed #116; 4 s later the fork's `warmstart/t902` was deleted | issue events |
| 22:11:19 | `.warmstart/project.json` rewritten to `finish: "commit-and-verify"` | file mtime |
| 22:18:58 | Third run: thread reads *"Landed as \`undefined\` onto \`general\`"* — but `verify-only` moved nothing | thread row 10525 |

### Finding 1 — the fork did happen

It exists, it is a real fork, and the wizard added it as the `fork` remote. Two things make it look
like it did not:

1. **It cannot be private.** GitHub does not allow a fork of a public repository to be private; the
   fork reads `PUBLIC`. *Inferred* that "my private repository" meant a private copy — this needs
   your answer (D1).
2. **Your latest work is on no remote.** The fork's only branch from Warmstart was deleted along
   with the PR. The local branch has since been amended twice (`c8b92ae` → `4b45db8` → `efd50a5`),
   and `efd50a5` exists only on this machine.

### Finding 2 — a pull request to upstream was opened unattended, by design

t897 made *fork ⇒ finish = pull-request* in the wizard, and `pullRequest.land` opens the PR on
`origin` with no gate other than the `push` mandate. There is no notion of *whose* repository
`origin` is. Nothing in the code is a fork-only landing: every policy that reaches a remote either
pushes the **trunk to origin** (`commit-and-push`) or opens a PR **on origin** (`pull-request`).

### Finding 3 (a bug, fixed regardless) — `verify-only` says "Landed as `undefined`"

`landTask` sends every successful result through `landedMessage`, which writes *Landed as `<sha>`
onto `<target>`*. `verify-only` returns no `commit` and moves nothing. That breaks the invariant *a
landing that landed nothing must not say it landed*, and the line has the shape that
`salvageLandedCommits` reads. Fix: `verify-only` gets its own headline (*Verified \`<sha>\` on
\`<branch>\`; nothing moved*), never one that begins *Landed as*. One L1 test on `landedMessage`.

## Decisions (asked 2026-10-03, operator's answers)

- **D1 Privacy** — a public fork is fine; no private-mirror option.
- **D2 Layout** — the fork is home: `origin` = fork, `upstream` = original; default finish
  `commit-and-push`. (Rejected: a new `push-branch` policy; a configurable landing remote.)
- **D3 Consent** — per pull request, with a preview, never unattended.
- **D4 Own** — ADMIN or MAINTAIN only; WRITE counts as external.
- **D5 Existing project** — ship **Make my fork home** and run it on Optiscaler-Client (done by
  hand with the same git commands, since the live app is the old build; `efd50a5` pushed to the fork).
- **D6 Contents** — only the task's commits, replayed onto `upstream/<target>`.

As built: §B's Decide card became a ledger action (**Propose upstream…**), because D3 removed the
`pull-request` finish from the path entirely; §C's `push-branch` was not needed under D2.

## The plan as first proposed

### A. Know whose repository it is — `upstreamTrust`

- New daemon helper (in `projectsetup.ts` or a new `github.ts`): `gh repo view <slug> --json
  viewerPermission`, cached per project with its age. **ADMIN / MAINTAIN** (and WRITE, per D4) →
  `own`; **READ / TRIAGE / none** → `external`; **gh missing / not GitHub / error** → `unknown`.
- ⛔ `unknown` is treated as `external`. Conservative is the cheap direction (`docs/adapters.md`).
- Measured here: upstream `READ`, `shyoo/Optiscaler-Client` `ADMIN`, `shyoo/warmstart` `ADMIN`.

### B. A pull request onto an external repository needs a person's explicit yes

- `pullRequest.land`: push the branch (to the fork) exactly as now; then, if the PR's base repo is
  not `own`, **stop before `gh pr create`** and rest the task with a Decide card: *Open a pull
  request on Optiscaler-Client/Optiscaler-Client from shyoo:warmstart/t902 into general?* —
  showing the title, body and commit list that would be sent. **Open it** / **Not now**.
- The yes is recorded (who, when, which head sha). A new push after the yes asks again (per D3).
- ⛔ This is an authority, not a preference: no finish policy, no MCP call (`land_work`,
  `task_complete`), no controller judgement may open that PR without the recorded yes. Lives beside
  `mandateAllows` so every path reads one gate.
- Prompt: on a project whose upstream is external, the agent is told not to run `gh pr create` or
  push to `origin` itself (the tool cannot stop a shell call; it can stop its own).

### C. A fork project lands into the fork (D2 decides the shape)

- New finish policy **`push-branch`** — *commit, verify, push the branch* — pushes the task branch
  to the push remote and opens nothing. Or the fork becomes the home remote (D2 option 1), in which
  case existing `commit-and-push` already means "merge and push to my fork".
- Wizard: *Fork* sets the chosen default instead of `pull-request`, and its sentence stops promising
  a pull request on the original.
- Project settings: the *Push remote* row says whose repository each remote is.

### D. The existing Optiscaler-Client project

- Push `efd50a5` to the fork so the work is off this machine, and rewrite its `project.json` to the
  new default. ⛔ Outside this workspace — needs `request_directory`, and your yes (D5).

### E. Docs and tests

- `docs/landing.md` § *Configuring a project* and a new § on upstream consent; `docs/glossary.md`
  (*own / external upstream*); `AGENTS.md` invariant on landing gains the consent rule; `HANDOFF.md`.
- L1: the gate (own / external / unknown, yes recorded, re-ask on new sha), `push-branch`, the
  `verify-only` headline, the wizard's default. L3: the wizard's fork sentence.
