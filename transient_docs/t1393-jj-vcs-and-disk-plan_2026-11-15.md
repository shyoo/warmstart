# t1393 — jj as an alternative VCS, a VCS migration tool, and pool disk use

**Status: AGREED, 2026-11-15.** The operator chose *jj + disk fixes* and accepted every
recommendation in §8, so items marked **(rec.)** below are decisions. The spike ran (§9) and changed
three things: trunk HEAD goes detached (§9 row 2d), long repo roots are refused (3b), and fetch can
abandon commits (5c). Implementation is delegated in waves (§7).

## 1. Why: what was measured

Measured in pool slot `ws1` on Windows 11, 2026-11-15 (`Get-ChildItem -Recurse | Measure-Object Length`):

| Item | Size | Share of the slot |
|---|---:|---:|
| `ws1` total | 1,973 MB | 100% |
| `release/` (untracked build output) | 1,289 MB | 65% |
| `node_modules/` | 590 MB | 30% |
| `out/` | 53 MB | 3% |
| Tracked checkout (790 files; what remains) | ≈41 MB | ≈2% |
| Shared `.git` object store (`c:\Dev\warmstart\.git`, stored once) | 35 MB | — |

**Finding:** a git worktree already shares the object store. `jj workspace add` does the same thing:
one shared store and a full working copy per workspace, with no shallow or copy-on-write copies
(*inferred* from jj's documentation; jj is not installed here). **Switching to jj alone does not
reduce disk use on this repository.** Disk is therefore its own track (§5).

**What jj does offer this product** (*inferred*, to be checked by the spike in §3):
- Automatic working-copy snapshots. These could replace the stash/rescue machinery
  (`rescueAtTip`, `parkWorkspace`, the "committed if there is a branch, stashed if there is not"
  rule in AGENTS.md).
- Conflicts are stored in commits instead of blocking. This bears on `resolveConflictOnTask` and the
  rebase self-conflicts in t1338 §(c).
- The operation log (`jj op log` / `jj undo`) gives a recorded basis for every workspace mutation.

Volumes on this machine: C: NTFS, D: NTFS, K: exFAT. Dev Drive support is enabled, but no ReFS
Dev Drive exists. Plain NTFS has no block cloning.

## 2. How git is wired in today (measured with `Select-String`, 2026-11-15)

- `Vcs = 'git' | 'none'` (`src/daemon/tasks.ts:25`). The `projects.vcs` column already exists (`db.ts:259`).
- About 15 sites check `project.vcs !== 'git'`, in `landing.ts` (×7), `cancel.ts`, `conversationland.ts`,
  `deliveries.ts`, `disown.ts`, `finish.ts`, `flow.ts`, `branchsweep.ts`, `projectbrief.ts` and `tasks.ts`.
- 158 `git(` call sites. 16 daemon modules import `git.ts` directly, and `worktrees.ts` (2,000+ lines)
  holds the pool, park/rescue and landed-ref logic.
- The renderer has git-shaped surfaces: diff, branches, Loose ends, Propose upstream.
- The agent prompt contract tells agents to *commit on their branch*. That is git vocabulary.

## 3. Phase 0 — spike (2–3 h, before any code)

Install jj (`winget install jj-vcs.jj`) **(rec., pending Q6)** and measure on a throwaway clone:

1. Disk used by `jj workspace add` compared with `git worktree add`, at the same revision.
2. In a colocated repository, whether a *secondary* workspace has a `.git`. If not, does `git status`
   fail there, and does an agent that runs git still work?
3. Paths containing spaces (`C:\Users\Sunghwan Yoo\…`) through `cmd /d /s /c` and node-pty.
4. Snapshot timing: when does the working copy get snapshotted (on every `jj` command), and what does
   that cost on a 790-file tree and a 50k-file tree?
5. `jj git push --bookmark` and `jj git fetch` against `origin`, and whether `landedRef()`
   (`origin/<target>`) reads the same commit afterwards.
6. Concurrency: two workspaces running `jj` at once (does the op log diverge, and how is it resolved?).

Write the results into this file's §9 before Phase 1 starts. A result that contradicts this plan
changes the plan.

## 4. jj backend — design

### 4.1 A driver, not a name check
Per AGENTS.md (*never branch on an adapter or mode name*), add a `VcsDriver` with declared
`capabilities`, chosen by `project.vcs`:

```ts
interface VcsCapabilities {
  sharedStore: true            // both git and jj
  autoSnapshot: boolean        // jj: true, git: false
  storedConflicts: boolean     // jj: true
  opLog: boolean               // jj: true
  gitInterop: 'native' | 'colocated' | 'none'
  verification: string         // where each claim was measured
}
interface VcsDriver {
  capabilities: VcsCapabilities
  addWorkspace / removeWorkspace / listWorkspaces
  currentChange / branchFor / createBranch / deleteBranch
  commitsOnlyOn / landedRef / refreshTarget
  park(path) / rescue(path) / workspaceState(path)
  diff(path, base) / fileAt(rev, path)
  push / fetch
}
```

`Vcs` becomes `'git' | 'jj' | 'none'` (a migration adds `jj` to the accepted values, replay-safe).
The ~15 `vcs !== 'git'` checks become capability checks (`driver.capabilities…` or `hasVcs(project)`).

### 4.2 Recommended choices (pending §8)
- **Colocated mode (rec., Q2):** `.jj` next to `.git`. Landing stays measured against
  `origin/<target>` (`landedRef()` is unchanged), and GitHub, Propose upstream and `originRefusal`
  keep working.
- **Agents use jj inside a jj workspace (rec., Q3):** the prompt contract names the workspace's VCS,
  and a short jj command card replaces "commit on your branch". The completion evidence becomes
  "a change described on bookmark `warmstart/t<seq>`". Git is the fallback if the spike's question 2
  fails.
- **Task branch = jj bookmark `warmstart/t<seq>`**, the same name, so Loose ends, `taskBranches` and
  the landing code read it through the driver.

### 4.3 Phases
| Phase | Content | Exit check |
|---|---|---|
| 1 | Extract `GitDriver`: move `worktrees.ts`/`git.ts` behaviour behind `VcsDriver`, **no behaviour change** | Full L1/L2 green; no daemon module imports `git.ts` except the git driver and `which`/`spawn` |
| 2 | `JjDriver` for the pool: claim, prepare, park, release, `workspaceState` | L1 against a temp jj repo (skipped with a stated reason when jj is absent; never a host-capability assertion) |
| 3 | Landing and finish through the driver: `commitsOnlyOn`, `landedRef`, merge-local, commit-and-push | `landing*.test.ts` parameterised over both drivers |
| 4 | Renderer: diff, branches, Loose ends read through the driver; project settings show the VCS | L3 check on a jj project |
| 5 | Prompt contract and agent tooling for jj | One live task on a jj project, measured |

Invariants that must survive: never `reset --hard` (in jj, `abandon` is the equivalent, and is also
banned without a recorded basis); a contended workspace is a hold; the tool never destroys work on its
own; nothing about one machine is hard-coded (jj is optional, and a jj project on a machine without
jj says so and holds).

## 5. Disk track

Ordered from cheapest to most involved **(rec., Q7)**:

1. **Prune untracked build output in idle slots.** A per-project, declared list (e.g. `release/`,
   `out/`) is cleared when a slot is released or parked. Never anything tracked, and never
   `node_modules` unless declared. Estimated saving here: 1,289 MB per slot (`release/`). Settings
   show bytes per slot, with how old the reading is.
2. **Shared dependency store.** Use the package manager's own hardlinked store (pnpm, or
   `npm` + a project hook) rather than junctions, because a shared, mutable `node_modules` would
   let one task's install break another's. Declared per project; never assumed.
3. **Copy-on-write slot cloning** where the volume supports it: ReFS Dev Drive block cloning on
   Windows, APFS `clonefile` on macOS, reflink on btrfs/XFS. A pool on a volume that cannot clone
   says *"this volume cannot clone; slots are full copies"*. It never falls back silently. On this
   machine, that needs a Dev Drive to be created first.

The disk track is independent of the VCS choice and works for git projects too.

## 6. VCS migration tool — design

A project action, **Change version control…**, in project settings, plus a daemon RPC
`project.migrateVcs`.

**Direction (rec., Q5):** git → jj and jj → git. In colocated mode, git → jj is
`jj git init --colocate` and jj → git removes `.jj` once bookmarks are exported. Both are reversible
because `.git` is never removed.

**Preconditions (refuse with a named reason, never force):**
- No task holds a pool workspace or the trunk lease. Running tasks would otherwise lose their slot
  mid-run. The tool lists the holders.
- jj is on PATH (through `which.ts`), with its version recorded.
- The trunk has no uncommitted changes, or the person confirms them first. The tool never stashes or
  resets on their behalf.

**Steps (each step is recorded, with the evidence that proves it landed; see the loop invariant):**
1. Snapshot the current state: every `warmstart/t*` branch → tip SHA, written to the migration record.
2. `jj git init --colocate` at the trunk; `jj git import`; set `revset-aliases.trunk()` to
   `<landing target>@origin` (§9 5d). Refuse first if the root is longer than ≈106 chars (§9 3b) or
   jj is older than the pinned minimum (§9 5b). Never repoint a remote (§9 5c).
3. Check: every recorded branch exists as a bookmark at the same commit. **Any mismatch aborts and
   rolls back** (remove `.jj`; git was untouched).
4. Rebuild the pool **(rec.)**: retire the old worktree slots (after confirming each is clean or its
   branch carries its work), then create jj workspaces at the same paths.
5. Flip `projects.vcs` to `jj` only after step 3 passes. One transaction, one audit row.

**Reverse (jj → git):** `jj git export`, check that every bookmark is a git branch at the same commit,
retire jj workspaces, recreate git worktrees, flip `vcs`, then remove `.jj` last (optional, and kept
by default).

**Data model:** a new `vcs_migrations` table (id, project, from, to, started/finished, branch
snapshot JSON, outcome, error). Numbered, append-only, replay-safe migration.

**Tests:** L1 using temp repos for each step, including an abort at step 3 that leaves git
byte-identical; the jj steps are skipped (with a reason) when jj is absent.

## 7. Delegation (`tier:low` workers)

Each piece is cut from this branch and merged here only after review. Wave 1 = pieces 1 (interface
and git wrapper only, no callers moved), 2, and the type/gate half of 3, filed together because none
depends on another. Later waves are filed after wave 1 is merged, because a piece is cut from this
branch as it stands when it is filed and cannot see a sibling's unmerged work. Order:

1. Phase 1 `GitDriver` extraction (no behaviour change). The largest piece; it may be split by module.
2. Disk track step 1 (prune declared build output on release, plus bytes-per-slot reading).
3. `Vcs` type and migration adding `jj`; capability checks replacing the `vcs !== 'git'` sites.
4. `JjDriver` pool operations (depends on 1 and on the spike results).
5. Migration tool: daemon RPC, record table, git→jj path (depends on 3 and 4).
6. Migration tool: reverse path and UI.
7. Disk track steps 2–3 (separately scoped once step 1 has numbers).

Pieces 1 and 2 can run in parallel; the rest depend on 1.

## 8. Decisions

All seven rows were accepted by the operator on 2026-11-15.

| # | Question | Decision |
|---|---|---|
| 1 | Goal | jj + disk fixes |
| 2 | jj mode | Colocated |
| 3 | What agents use inside a workspace | jj, with git as fallback |
| 4 | Phase 1 scope | Driver extraction first, then the jj pool; landing in phase 3 |
| 5 | Migration | Both ways; refuse while workspaces are held; import branches as bookmarks; rebuild the pool |
| 6 | Spike | Install jj via winget and measure (§3) |
| 7 | Disk order | Prune → shared dependency store → copy-on-write cloning |

## 9. Spike results (measured 2026-11-15, Windows 11, jj 0.46.0 via `winget install jj-vcs.jj`)

Throwaway clone of this branch (790 tracked files) at `%TEMP%\jj spike\repo` (path contains a space),
colocated. Scripts: `spike2.ps1`, `spike3.ps1` in this conversation's scratch dir (not committed).

| # | Question | Measured | Consequence for the plan |
|---|---|---|---|
| 1 | Disk: jj workspace vs git worktree | **27.9 MB each**, identical; `.jj` metadata 0.1 MB | Confirms §1: jj saves no disk; the disk track stands alone |
| 1b | Time | `jj workspace add` 1,514 ms vs `git worktree add` 581 ms; `jj git init --colocate` 2,636 ms | Acceptable for a pool slot; not on any hot path |
| 2 | Secondary workspace has `.git`? | **Yes.** In colocated mode jj 0.46 *creates a git worktree* for it (`git worktree list` shows it, `detached HEAD`). `git status`, `git rev-parse` work | Agents' git habits keep working. Q3 fallback is free |
| 2b | Agent runs plain `git commit` inside a jj workspace | Works; next `jj` command prints *Reset the working copy parent to the new Git HEAD* and adopts it | Mixed git/jj use by agents is safe (one case measured) |
| 2c | jj bookmark visible to git | **Immediately**, as a branch, in colocated mode (`jj git export` → *No export needed*) | `taskBranches`, `commitsOnlyOn`, Loose ends can keep reading git refs in phase 2 |
| 2d | ⚠️ HEAD of the colocated **main checkout** | After jj operations it is **detached** (`git symbolic-ref HEAD` exit 1) | Breaks every trunk read of `rev-parse --abbrev-ref HEAD` (`landing.ts:454,536,1307,1953`, `worktrees.ts:1298,2056`). The driver must read the target from the bookmark, not HEAD. Trunk mode on a jj project is out of scope until then |
| 3 | Paths with a space | Work through pwsh; jj *prints* paths as 8.3 relative (`..\..\SUNGHW~1\…`) | Never parse jj's human output; use `-T` templates (same rule as *never parse ANSI*). node-pty / `cmd /d /s /c` still unmeasured |
| 3b | ⛔ Long paths | `jj git init` **fails** at a 262-char internal path (`.jj\repo\index\segments\<128 hex>`) with `LongPathsEnabled=1` | jj 0.46 is not long-path aware. A repo root longer than ≈106 chars cannot host jj: the driver checks and refuses with that reason |
| 4 | Snapshot cost | `jj status` 65 ms clean, 107 ms after an edit (790 files) | Cheap here; 50k-file tree unmeasured |
| 5 | Push / landing | `jj git push --bookmark B` → origin has B at the same SHA, local `origin/B` updated | `landedRef()` (`origin/<target>`) is unchanged for jj projects |
| 5b | ⚠️ Flags drift | `--allow-new` (in older docs) is **rejected** by 0.46 | Pin a minimum version; every flag carries `verification` like an adapter capability |
| 5c | ⚠️ `jj git fetch` after the remote changed | Deleted remote bookmarks and **abandoned an unreachable commit** (a remote-only commit, t1394) | The migration never repoints remotes; local bookmarks are checked before and after every fetch |
| 5d | `trunk()` alias | `jj git init` set it to the *current branch*@origin, which broke when that ref vanished | Migration sets `revset-aliases.trunk()` to `<landing target>@origin` explicitly |
| 6 | Two workspaces mutating at once | *Concurrent modification detected, resolving automatically*; op log shows `reconcile divergent operations` | No lock needed beyond the existing one-holder-per-slot claim |
| 7 | Stored conflict | Rebase produced a commit with `conflict=true`; markers written to the file; git sees ` M README.md` | Conflicted work is a *commit*, not a blocked rebase; landing must refuse a conflicted bookmark (`conflicts()` revset) |
| 8 | `jj workspace forget` | Also removed the git worktree | Release/retire is one command; the directory is removed separately |

Not measured: node-pty spawn, a 50k-file tree, macOS/Linux, jj ≥ 0.47.
