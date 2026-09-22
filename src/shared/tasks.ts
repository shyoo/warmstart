/**
 * The task domain.
 *
 * Three objects that look alike in a UI and are nothing alike in the scheduler:
 *
 *  - a **Task** is a thread of work with an assignee. It can be scheduled, reassigned, made to
 *    depend on other work, and it outlives every session that touches it.
 *  - an **Approval** is an interrupt on one live session. It blocks that session right now, only
 *    that session can consume the answer, its answer set is closed, and it dies with the session.
 *  - a **Question** is an interrupt too, but its answer set is written by whoever asked and its
 *    answer is *content*. So it can never become a project rule the way an approval can, an
 *    unanswered one parks rather than denying, and it outlives its session on purpose.
 *
 * Filing any of them as another is wrong on every axis the first exists for. See the implementation
 * plan §7.3 and §7.4.
 */

import type { QuotaSnapshot, QuotaWindow, Worker } from './protocol.js'
import type { ModelClass } from './modelclass.js'

export type { ModelClass } from './modelclass.js'

// ---------------------------------------------------------------------------- project

export type Vcs = 'git' | 'none'

/** Committed at `<project>/.warmstart/project.json`. Nothing secret goes in it. */
export interface ProjectConfig {
  schema_version: number
  name?: string
  vcs?: Vcs
  objective?: string
  /**
   * `mode` is where this project's tasks run by default — see `WorkspaceMode`. ⚠️ Absent means
   * `worktree`, which is what every project did before trunk mode existed.
   *
   * `poolSize` is how many pooled worktrees the project keeps. ⚠️ Zero means **trunk-only**: no
   * pool at all, every task takes the trunk lease — see `projectTrunkOnly`. Absent means the
   * default pool, which is what every project did before trunk-only mode existed.
   */
  workspaces?: { poolSize?: number; root?: string; mode?: WorkspaceMode }
  prepare?: string[]
  check?: string[]
  /**
   * ⚠️ `strategy` is the pre-2026-08-28 spelling and is still read, so an existing project.json keeps
   * working. It is migrated to `finish` on load; write `finish` in new files.
   */
  landing?: {
    strategy?: LandingStrategyId
    target?: string
    finish?: FinishPolicyChoice
    /** What a `custom` finish tells the agent to do. Defaults to `DEFAULT_FINISH_INSTRUCTION`. */
    finishInstruction?: string
  }
  session?: {
    share?: SessionSharingChoice
    completion?: CompletionModeChoice
  }
  /**
   * What this project says to an agent that is starting **cold**.
   *
   * ⛔ Cold only, and that is the whole of the design. Both halves below travel on exactly the
   * prompts that restate the task's own instruction — a session that already holds this task's
   * context has read them, and re-sending them would be the same re-teaching this project spent
   * t260 removing from follow-ups. See `promptFor`.
   */
  prompt?: {
    /**
     * `auto` — name whichever of `AGENTS.md`, `HANDOFF.md` and `README.md` are actually on disk.
     * `off` — name none of them.
     *
     * ⚠️ Absent means `auto`, and a project with none of the three is unaffected either way: the
     * sentence is built from what was found, so nothing found is no sentence.
     */
    orientation?: OrientationChoice
    /**
     * The operator's own opening instruction, sent verbatim after the doc line.
     *
     * ⚠️ *After*, never *instead of*: turning `orientation` off is how a project says "mine only",
     * and a seed that silently suppressed the other half would make that suppression invisible in
     * the file it is written in.
     */
    seed?: string
  }
  permission?: {
    mode?: string
    allow?: string[]
    deny?: string[]
  }
  env?: Record<string, string | number>
  resources?: Array<{ ref: string }>
  mandate?: Partial<Mandate>
}

/** Whether a cold prompt names this project's orientation docs. See `ProjectConfig.prompt`. */
export type OrientationChoice = 'auto' | 'off'

export const ORIENTATION_LABELS: Record<OrientationChoice, string> = {
  auto: 'name the docs that exist',
  off: 'say nothing about docs'
}

export interface ProjectPolicyPatch {
  finish?: FinishPolicyChoice
  landingTarget?: string
  finishInstruction?: string | null
  sessionShare?: SessionSharingChoice
  completion?: CompletionModeChoice
  poolSize?: number
  /** See `ProjectConfig.workspaces.mode`. */
  workspaceMode?: WorkspaceMode
  prepare?: string[]
  /**
   * Where this project's pooled worktrees go.
   *
   * ⛔ **Written to the committed file as a path *relative to the project root*, never absolute.**
   * `project.json` is pulled by every clone and by every machine, and an absolute path is a fact
   * about one disk — the one rule that file has is that nothing machine-specific goes in it. The
   * resolver already reads it relatively (`policyFor` does `resolve(project.root, …)`), so the
   * only thing that had to change was the writer.
   *
   * ⚠️ An empty string means *go back to the derived default* — `<root>_workspaces` — which is an
   * absent key, not a stored copy of the default. A clone in a directory with a different name
   * then derives its own sibling rather than inheriting somebody else's.
   */
  workspaceRoot?: string
  /** See `ProjectConfig.prompt.orientation`. */
  promptOrientation?: OrientationChoice
  /**
   * See `ProjectConfig.prompt.seed`. ⚠️ An empty string means *this project has no seed*, written
   * as an absent key rather than as `""` — the same rule `finishInstruction` follows, and for the
   * same reason: an empty string in a committed file reads as a decision somebody made.
   */
  promptSeed?: string | null
}

export interface Project {
  id: string
  name: string
  /** The trunk. Agents run here only when a task's workspace mode is `trunk`. */
  root: string
  vcs: Vcs
  config: ProjectConfig
  /** Where the config was read from, or null when the project has none yet. */
  configPath: string | null
  createdAt: number
  archivedAt: number | null
  /**
   * Read fresh off disk on every list/get. False means `root` was moved, renamed, or deleted
   * outside Warmstart since it was added — dispatch, Doctor, and the Project header all surface
   * this the same way, so it is never `true` on a stale cached copy.
   */
  rootExists: boolean
}

// ------------------------------------------------------------------- adding a project

/**
 * What the tool found in a directory somebody is about to add.
 *
 * ⛔ **Every field is something read off the disk, and nothing here changes it.** The add wizard
 * shows a person what is there before they commit to it, which is the whole difference between
 * "type a path and hope" and a setup step — a directory that is already a project, a workspace
 * sibling another project has claimed, and a repo with no `AGENTS.md` are three different situations
 * with three different next moves, and none of them is visible from a text box.
 */
export interface ProjectInspection {
  /** Canonical, because this is the spelling that would be stored. See `canonicalPath`. */
  root: string
  exists: boolean
  isDirectory: boolean
  /**
   * Nothing in it but entries that carry no project — `.git`, `.DS_Store`, `Thumbs.db`, `desktop.ini`.
   * ⚠️ A fresh `git init` is still an *empty* project, which is exactly the case the scaffolding is for.
   */
  empty: boolean
  vcs: Vcs
  /** The project already registered at this root, if there is one. Adding it again is refused. */
  alreadyAdded: { id: string; name: string } | null
  /** From the committed config, then `package.json`, then the directory's own name. */
  suggestedName: string
  hasConfig: boolean
  /** The committed config if there is one, so the wizard opens on what the repo already says. */
  config: ProjectConfig | null
  /** Which of the three orientation docs are already there. */
  docs: Record<ProjectDocName, boolean>
  /** What this project appears to be built with, in the order the detectors ran. */
  stack: string[]
  proposedChecks: string[]
  workspace: WorkspaceRootReport
}

/**
 * What is at the workspace directory, and whether that is a problem.
 *
 * ⚠️ Only two of these states refuse. The rest are things to *say*: a directory that already holds
 * something is usually a pool from a previous install, which is fine, and a person who is told what
 * is in there can decide that for themselves.
 */
export type WorkspaceRootState =
  /** Does not exist. The pool creates it on first dispatch. */
  | 'free'
  /** Exists and holds nothing. */
  | 'empty'
  /** Exists and holds something. Named, not refused — an existing pool looks exactly like this. */
  | 'occupied'
  /** ⛔ Another project's workspace root. Two pools in one directory is two projects' worktrees. */
  | 'taken'
  /** ⛔ Inside the project itself, so every worktree would be a subdirectory of the repo. */
  | 'inside-project'
  /** ⛔ On another drive, so it cannot be written to the committed file as a relative path. */
  | 'other-drive'

export interface WorkspaceRootReport {
  /** Canonical and absolute — what the pool would actually use. */
  path: string
  state: WorkspaceRootState
  /** ⛔ A `taken` report names the project that has it. A refusal with no name is unactionable. */
  takenBy: string | null
  /** May the project be created with this? False for `taken`, `inside-project` and `other-drive`. */
  usable: boolean
  /** What to tell the operator, or null when there is nothing worth saying. */
  note: string | null
  /**
   * How it would be written into `project.json`, forward-slashed — or null when it is the derived
   * default and therefore written as no key at all.
   */
  relative: string | null
}

/** The three orientation files, and the only names the scaffolder will write. */
export type ProjectDocName = 'README.md' | 'AGENTS.md' | 'HANDOFF.md'

export const PROJECT_DOC_NAMES: ProjectDocName[] = ['README.md', 'AGENTS.md', 'HANDOFF.md']

/**
 * The same three, in the order a cold agent is told to read them — which is not the order above.
 *
 * ⛔ Rules, then state, then what the thing is. `AGENTS.md` is what an agent must not break and is
 * therefore worth reading before it can break anything; `HANDOFF.md` is where the work actually
 * stands; `README.md` is the slowest and least urgent of the three. `PROJECT_DOC_NAMES` is ordered
 * for the wizard's checklist instead, and a test pins these two lists to the same **set** so neither
 * can gain a name the other has not got.
 *
 * ⚠️ Shared rather than daemon-side because the project's Cold start panel lists the docs it found
 * and the prompt names them, and an operator comparing the two should not find them in two orders.
 */
export const ORIENTATION_READING_ORDER: ProjectDocName[] = [
  'AGENTS.md',
  'HANDOFF.md',
  'README.md'
]

/**
 * A starter file, as proposed and as the operator edited it.
 *
 * ⛔ The content travels with the request. The template is generated in the daemon, shown in an
 * editable box, and sent back — so what lands on disk is what the person read and approved, and
 * there is no second generation step that could produce something they never saw.
 */
export interface ProjectDocDraft {
  name: ProjectDocName
  content: string
}

/**
 * Everything the add wizard decided, in one call.
 *
 * ⛔ **One RPC, not six.** Creating a project is `mkdir` → `git init` → register → write the config →
 * write the checks → write the docs, and a renderer driving that as six calls has six places to fail
 * halfway and leave a project that is registered but unconfigured. The daemon does the sequence and
 * reports what it could not do in `warnings` rather than failing the whole thing over a scaffold file.
 */
/**
 * What `.warmstart/project.json` becomes in git when the wizard creates it.
 *
 * ⛔ **`commit` is the default, and the choice is always asked.** Committed policy is what the docs
 * describe and what every clone pulls — but committing to somebody's repository unasked is what
 * made the trunk dirty-looking work Warmstart's own doing. Absent keeps the old answer
 * (`commit`); the wizard always sends an explicit value, so nothing here is silent either way.
 */
export type ScaffoldingGitChoice = 'commit' | 'ignore'

export interface ProjectCreateRequest {
  root: string
  name?: string
  /** ⚠️ Off unless asked. Creating a directory somebody mistyped is worse than refusing. */
  createDirectory?: boolean
  /** `git init -b <landing target>`. Without a repo a project gets one workspace and no branches. */
  gitInit?: boolean
  /**
   * `commit` stages the scaffolding beside the starter docs; `ignore` appends
   * `.warmstart/project.json` to the root `.gitignore` and commits that instead, leaving the
   * config untracked. Either way the trunk the wizard hands back is clean.
   */
  scaffoldingGit?: ScaffoldingGitChoice
  /** Empty or absent keeps the derived `<root>_workspaces`. */
  workspaceRoot?: string
  policy?: ProjectPolicyPatch
  /** ⚠️ Absent leaves whatever the repo already declared; `[]` is an operator clearing the list. */
  checks?: string[]
  docs?: ProjectDocDraft[]
}

export interface ProjectCreateResult {
  project: Project
  /** Where the policy was written. ⛔ Always written — that is what the wizard's answers *are*. */
  configPath: string | null
  docsWritten: ProjectDocName[]
  /** ⛔ Asked for and did not happen. Never silent, never a thrown error over a scaffold file. */
  warnings: string[]
}

// ---------------------------------------------------------------------------- task

/**
 * What kind of thing this task is.
 *
 * ⛔ A `plan` task is **decomposed, not dispatched**. Its output is a set of draft children with
 * dependency edges - which keeps decomposition visible, cancellable, billable to a budget and
 * re-runnable when the plan turns out wrong, rather than being a hidden phase. Plan §18.1.
 *
 * ⛔ A `conversation` is **the same work with the single-turn contract removed**. A `work` task is
 * told to run to the end and commit in one turn if it can, which is right for unattended progress
 * and wrong for the case a person is sitting there: every turn ends in a landing decision nobody
 * asked for. A conversation keeps the thread, the session, the branch and the workspace between
 * turns, ends each turn back at `awaiting_human`, and commits only when a person presses the
 * button. It is not a different scheduler path — it is `work` with a different closing instruction
 * and a stickier route. See `isOpenConversation`.
 *
 * ⛔ A `debate` task is **arbitrated, not dispatched alone**. Two to five *seats* — child tasks, each
 * pinned to exactly one (account, model, effort) — answer the same question blind and in parallel;
 * the parent is an **organizer** that reads all of them, may send them each a brief for another
 * round, and finally reports an agreement *with its dissent* and asks the operator what to do next.
 * ⛔ **Its product is a decision, not a commit**, which is why its seats are filed `report-only`.
 * See `transient_docs/debate_mode_2026-09-12.md`.
 */
export type TaskKind = 'work' | 'plan' | 'conversation' | 'debate'

/**
 * The two shapes a `plan` task comes in.
 *
 * ⛔ **Plan & Execute is a plan that may file exactly one piece**, and every difference in its
 * behaviour follows from that one fact: with no fan-out there is nothing built by agents that could
 * not see each other, so there are no seams, so there is nothing for a third turn to integrate. The
 * planner therefore hands off and finishes, the executor lands onto the *project's* target rather
 * than onto a plan branch, and the resolution turn is never reached.
 *
 * ⛔ **Derived from the child cap, never stored beside it.** A `plan_mode` column would be a second
 * copy of a fact `mandate.maxChildren` already carries — and `mandate` is what `createTask` actually
 * enforces, so the two would disagree the first time somebody wrote one and not the other. This is
 * the rule `planPhaseOf`, `debatePhaseOf` and `isOpenConversation` already keep.
 *
 * ⚠️ Every plan task filed before this existed reads as `split`: the composer's fan-out pill has
 * never offered anything below `MIN_PIECES` (2), and `ROOT_MANDATE.maxChildren` is 5.
 */
export type PlanMode = 'split' | 'execute'

/** ⛔ One piece, not "at most one". A Plan & Execute that filed none delegated nothing. */
export const PLAN_EXECUTE_CHILDREN = 1

/**
 * The most children this task may file, reading the same two fields `validateSplit` resolves.
 *
 * ⛔ **The mandate is the authority and `childDefaults` may only narrow it.** `createTask` enforces
 * the mandate; the composer's pill writes both. Taking the minimum is what makes the number on the
 * pill the number that is allowed — the bug §D5 of the Plan & Split plan was written about.
 */
export function planChildCap(
  task: Pick<Task, 'mandate' | 'childDefaults'> | null | undefined
): number {
  const caps = [task?.mandate?.maxChildren, task?.childDefaults?.maxChildren].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n)
  )
  return caps.length ? Math.min(...caps) : ROOT_MANDATE.maxChildren
}

/** ⚠️ Answers `split` for anything that is not a plan task, because nothing else has a plan mode. */
export function planModeOf(
  task: Pick<Task, 'kind' | 'mandate' | 'childDefaults'> | null | undefined
): PlanMode {
  if (task?.kind !== 'plan') return 'split'
  return planChildCap(task) <= PLAN_EXECUTE_CHILDREN ? 'execute' : 'split'
}

export function isPlanExecute(
  task: Pick<Task, 'kind' | 'mandate' | 'childDefaults'> | null | undefined
): boolean {
  return planModeOf(task) === 'execute'
}

/**
 * One seat at a debate: exactly one account, and optionally the model and effort it argues with.
 *
 * ⛔ **Not `ChildDefaults.workerIds`, which is a closed list the scheduler may pick *from*.** A
 * debate needs seat *i* to be exactly one (account, model, effort) — reusing the candidate set would
 * let the scheduler put three seats on one account and call it a debate. A duplicate triple is
 * allowed, because a homogeneous debate is a thing an operator may want; it is what the composer's
 * heterogeneity notice counts.
 */
export interface DebateSeat {
  workerId: string
  model?: string | null
  effort?: string | null
  /**
   * An evidence base this seat is asked to examine first — never a stance to hold. Offered by the
   * composer only when the roster is one model family (`adapterSpread === 1`), where prompt-level
   * diversity is the only diversity there is; see `seatPromptFor`.
   */
  lens?: string | null
}

/** What each seat reads in round 2 and after. ⚠️ Data in `debate_json`, never a branch on seat count. */
export type DebateExchange = 'full' | 'digest'

/** The operator's five answers to *what now*, raised as one `choice` question the tool blocks on. */
export type DebateVerdict = 'execute' | 'split' | 'discuss' | 'complete' | 'stop'

export const DEBATE_VERDICTS: DebateVerdict[] = ['execute', 'split', 'discuss', 'complete', 'stop']

export const DEBATE_VERDICT_LABELS: Record<DebateVerdict, string> = {
  execute: 'Execute as agreed',
  split: 'Split the work',
  discuss: 'Ask follow-up questions',
  complete: 'Mark completed',
  stop: 'Stop the work'
}

export const DEBATE_VERDICT_DETAILS: Record<DebateVerdict, string> = {
  execute: 'the organizer does the work now, in the session that holds the whole debate',
  split: 'the organizer files the pieces; they branch off this debate and merge back into it',
  discuss: 'this becomes a conversation you keep talking in, in the organizer’s own warm session',
  complete: 'the agreement is the result; nothing more is built',
  stop: 'wind down and rest. Every position, round and run is kept'
}

/** ⛔ The cap, and the number the composer offers. Also `ROOT_MANDATE.maxChildren` — one cap, not two. */
export const MIN_DEBATE_SEATS = 2
export const MAX_DEBATE_SEATS = 5
/** ⚠️ 1–3 is where the published gain lives; 4–5 are offered behind the diminishing-return notice. */
export const MIN_DEBATE_ROUNDS = 1
export const MAX_DEBATE_ROUNDS = 5

/**
 * The whole of a debate's state, in one column.
 *
 * ⛔ `rounds` is the **operator's cap** and nothing may raise it. The organizer may converge early —
 * that only ever saves money — and a request for one more round is refused with the reason.
 * *Preference never widens authority*, applied to a budget instead of to a mandate.
 */
export interface DebateState {
  seats: DebateSeat[]
  rounds: number
  exchange: DebateExchange
  /** Which round the seats are in now, 1-based. */
  round: number
  verdict: DebateVerdict | null
}

export function isDebateVerdict(v: unknown): v is DebateVerdict {
  return typeof v === 'string' && (DEBATE_VERDICTS as readonly string[]).includes(v)
}

/**
 * Read a debate blob written by any version of this tool.
 *
 * ⚠️ A malformed blob reads as *no debate*, never a throw — the rule `parseChildDefaults` already
 * keeps. This column is read on every task load, and a task that cannot be listed because its
 * settings did not parse is a worse failure than a debate that has to be re-filed.
 */
export function readDebateState(raw: unknown): DebateState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const seats = Array.isArray(r.seats)
    ? r.seats
        .map((s): DebateSeat | null => {
          if (!s || typeof s !== 'object') return null
          const seat = s as Record<string, unknown>
          if (typeof seat.workerId !== 'string' || !seat.workerId) return null
          return {
            workerId: seat.workerId,
            model: typeof seat.model === 'string' && seat.model ? seat.model : null,
            effort: typeof seat.effort === 'string' && seat.effort ? seat.effort : null,
            lens: typeof seat.lens === 'string' && seat.lens.trim() ? seat.lens.trim() : null
          }
        })
        .filter((s): s is DebateSeat => s !== null)
    : []
  if (seats.length === 0) return null
  const rounds = typeof r.rounds === 'number' && Number.isFinite(r.rounds) ? Math.round(r.rounds) : 1
  const round = typeof r.round === 'number' && Number.isFinite(r.round) ? Math.round(r.round) : 1
  return {
    seats,
    rounds: Math.min(MAX_DEBATE_ROUNDS, Math.max(MIN_DEBATE_ROUNDS, rounds)),
    exchange: r.exchange === 'digest' ? 'digest' : 'full',
    round: Math.max(1, round),
    verdict: isDebateVerdict(r.verdict) ? r.verdict : null
  }
}

/**
 * How many distinct **adapters** a roster spans.
 *
 * ⛔ Counted on the adapter, not the model name: published work finds cross-*family* pairs are what
 * carry debate's gain, and two Claude models are one family. The caller resolves worker → adapter,
 * because this file cannot see the fleet.
 */
export function adapterSpread(adapterIds: Array<string | null | undefined>): number {
  return new Set(adapterIds.filter((id): id is string => !!id)).size
}

/**
 * A conversation still running under the conversation contract.
 *
 * ⛔ **The one flag that decides which contract a turn runs under**, and it is derived rather than
 * stored so it cannot disagree with the finish policy beside it. A conversation's finish policy is
 * `inherit` for its whole life — `resolveFinishPolicy` reads the kind and answers `await-human`,
 * which is what keeps a project set to `commit-and-merge` from landing a chat on its own.
 * ⚠️ **Neither Commit nor Land writes a level any more** (t343): a conversation lands through
 * `land_work` or the Land button as often as it is asked to and stays open, and migration 64 reset
 * the rows an older build had left carrying one. The only thing that takes a conversation out of this
 * contract now is an operator choosing a real level on the task's own *finish* setting.
 */
export function isOpenConversation(
  task: Pick<Task, 'kind' | 'finishPolicy'> | null | undefined
): boolean {
  return !!task && task.kind === 'conversation' && task.finishPolicy === 'inherit'
}

/**
 * What a dependency edge counts as met.
 *
 * ⛔ `completed` is the default and the meaning every edge in the fleet already had: *"do B after A"*
 * means A succeeded. `settled` releases on any resting terminal state — `completed`, `failed` or
 * `cancelled` — and is written by `task_split` alone, because a planner has to be woken by the
 * children that failed as well as the ones that worked. It is told which was which.
 */
export type DependencyRequirement = 'completed' | 'settled'

/**
 * The settings a Plan & Split parent hands to each piece it files.
 *
 * ⛔ **Separate from the parent's own settings, which is decision D5.** "Plan with one model, build
 * with another" is the case that motivated Plan & Split at all: the planning turn wants a model that
 * reads a repository well and asks good questions, and the pieces want whatever is cheapest that can
 * follow a concrete instruction. One row of settings would have forced them to be the same.
 *
 * ⚠️ Every field is optional and an absent one means *inherit*, resolved against the project exactly
 * as an ordinary task's would be. A stored `null` and an absent key mean the same thing here on
 * purpose: this is written by a form where "leave it alone" is the common answer.
 */
export interface ChildDefaults {
  workerId?: string | null
  /**
   * Every account a piece of this plan may run on.
   *
   * ⛔ **A closed list, not a preference.** The composer's Pieces row lets an operator name two or
   * three cheap accounts for work they have already decided is small, and the scheduler must pick
   * from *that* list or from none — a split whose pieces were routed to whatever the fleet felt like
   * is a split whose settings did nothing. It was exactly that until 2026-09-04: the composer sent
   * this field, `applySplit` read only the singular `workerId` beside it, and every child was filed
   * with no constraint at all and picked up by the largest model in the fleet.
   *
   * ⚠️ Empty or absent means *the scheduler chooses*, which is the honest reading of a control
   * nobody touched. One entry is a pin, and is written to `workerId` as well so every other reader
   * of a pinned account sees it.
   */
  workerIds?: string[]
  model?: string | null
  effort?: string | null
  /** The model each named account runs a piece with — a model id belongs to one CLI, never to a fleet. */
  modelsByWorker?: Record<string, string>
  /** The effort each named account is asked for, where its CLI takes an effort flag at all. */
  effortsByWorker?: Record<string, string>
  finishPolicy?: FinishPolicyChoice
  sessionSharing?: SessionSharingChoice
  priority?: Priority
  /** How many pieces the planner may file. Bounded by the task's mandate, which stays the authority. */
  maxChildren?: number
}

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'blocked'
  | 'scheduled'
  | 'assigned'
  | 'running'
  | 'awaiting_human'
  | 'paused_quota'
  | 'paused_user'
  /**
   * Finished and verified-ready, waiting for the trunk to be free before its landing runs again.
   *
   * ⛔ **A hold, not a person's job.** A worktree task whose `merge-local` landing found the trunk
   * busy — a trunk task holding it, or files uncommitted in it — used to rest at `awaiting_human`
   * for somebody to press Retry. Once agents work in the trunk that is the normal case, so the tick
   * re-attempts the landing (`retryQueuedLandings`, zero tokens) as soon as the trunk is free.
   */
  | 'landing_queued'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'cancelled', 'failed'])

/**
 * The buckets the task list can be filtered by.
 *
 * ⛔ **Every status belongs to exactly one bucket.** Not "at least one" — exactly one. That is what
 * makes a multi-select a plain union with no row appearing twice and no count double-adding, and it
 * is what stops a status added later from being invisible in every view except All. The test that
 * pins this checks both directions, because only one of them is the interesting failure.
 *
 * ⚠️ **All is not in here.** It is the *empty* selection, so that "everything" has one representation
 * rather than two — an empty array and a full one would look identical to a reader and different to
 * a `Set`.
 *
 * `draft` sits under Blocked rather than in a bucket of its own: a draft dispatches nothing until
 * somebody promotes it, which is the same thing Blocked means to the person scanning this list —
 * *not going anywhere without me*.
 */
export const TASK_VIEWS = {
  active: ['ready', 'scheduled', 'assigned', 'running', 'landing_queued', 'cancelling'],
  needs_you: ['awaiting_human', 'paused_user'],
  blocked: ['blocked', 'paused_quota', 'draft'],
  done: ['completed'],
  failed: ['failed', 'cancelled']
} as const satisfies Record<string, readonly TaskStatus[]>

export type TaskView = keyof typeof TASK_VIEWS

/** In the order they are drawn, with the label each chip carries. */
export const TASK_VIEW_ORDER: Array<{ id: TaskView; label: string }> = [
  { id: 'active', label: 'Active' },
  // ⭐ The one an operator actually scans for. A task waiting on a person is stopped and nothing in
  // the fleet will restart it, so it is the only bucket whose contents are *your* backlog.
  { id: 'needs_you', label: 'Needs you' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' }
]

/** The statuses a set of views selects, as one flat list. Empty selection means no filter at all. */
export function statusesForViews(views: readonly TaskView[]): TaskStatus[] {
  return views.flatMap((v) => [...TASK_VIEWS[v]])
}

/** Which bucket a status falls in. Used to fold a `group by status` count into chip counts. */
export function viewForStatus(status: TaskStatus): TaskView | null {
  for (const [view, statuses] of Object.entries(TASK_VIEWS)) {
    if ((statuses as readonly string[]).includes(status)) return view as TaskView
  }
  return null
}

/** One page of the task table, with the counts the chips above it draw. */
export interface TaskPage {
  tasks: Task[]
  /** How many rows the filter matches, which is what the pager counts pages out of. */
  total: number
  /**
   * How many tasks are in each bucket, **ignoring the current selection**.
   *
   * ⛔ Unfiltered on purpose. A chip whose count reflected the filter would read `Needs you 0` while
   * three tasks were waiting on you, purely because you were looking at Done — the number would then
   * only ever be right for the chip you had already clicked, which is the one you least need it on.
   */
  counts: Record<TaskView, number>
}

/** A compact, durable project timeline entry for the remote overview. */
export interface ProjectActivity {
  id: string
  taskId: string
  taskSeq: number
  title: string
  kind: 'filed' | 'run_started' | 'run_finished' | 'completed' | 'status_changed'
  at: number
  status?: TaskStatus
  activeMs?: number
  priceUsd?: number | null
}

/**
 * What the table can be ordered by — one value per column it has.
 *
 * ⛔ **Two kinds, and the split is not cosmetic.** `seq`, `title`, `status`, `quality`, `created`
 * and `updated` are real columns: SQLite orders them and the pager slices the result, which is what
 * keeps a page stable while the fleet writes underneath it. The rest — `from`, `worker`, `dep`,
 * `took`, `price` — are **derived on read** and the database cannot see them: active time is folded
 * from a task's runs minus every stretch spent waiting on a person, and a price is this task's share
 * of an account's billing window, recomputed whenever a later overlapping run is discovered. Sorting
 * those means loading the whole filtered set and slicing afterwards, which `pageTasks` does; ordering
 * a page by a number the `order by` could not see would quietly drop and repeat rows between pages.
 *
 * ⚠️ `worker` orders by the account's **id**, not by the label the cell prints. The point of the
 * column is to bring one account's tasks together, and the daemon does not carry the display names.
 */
export type TaskSort =
  | 'seq'
  | 'title'
  | 'from'
  | 'worker'
  | 'dep'
  | 'took'
  | 'price'
  | 'quality'
  | 'created'
  | 'updated'
  | 'status'

/**
 * The sorts SQLite cannot express, because the value is computed after the row is read.
 *
 * ⛔ Exported so `pageTasks` and its test name the same set: a sort that is derived but missing from
 * this list is one that silently orders a page by nothing at all.
 */
export const DERIVED_TASK_SORTS: readonly TaskSort[] = ['from', 'worker', 'dep', 'took', 'price']

/** Where a cancelled task comes to rest. Cancel is not delete: none of these destroy anything. */
export type RestingState = 'paused_user' | 'draft' | 'cancelled'

export const RESTING_STATES: RestingState[] = ['paused_user', 'draft', 'cancelled']

/** A task in one of these can be deleted; anything else must be cancelled first. */
export const DELETABLE_FROM: TaskStatus[] = [
  'draft',
  'paused_user',
  'cancelled',
  'completed',
  'failed'
]

export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

export type Principal =
  | { kind: 'human' }
  | { kind: 'controller' }
  | { kind: 'agent'; workerId: string; sessionId: string; runId: string }

/**
 * The authority a task runs under. Inherited from its creator and **narrowed, never widened** - a
 * task that has lost `spawn_tasks` cannot create children because it has no such authority, not
 * because a heuristic caught it.
 */
export interface Mandate {
  allowed: MandateOperation[]
  projectIds: string[] | 'creator'
  maxLineageDepth: number
  maxChildren: number
}

export type MandateOperation = 'read' | 'write' | 'commit' | 'push' | 'spawn_tasks' | 'land'

export const ROOT_MANDATE: Mandate = {
  allowed: ['read', 'write', 'commit', 'push', 'spawn_tasks', 'land'],
  projectIds: 'creator',
  maxLineageDepth: 3,
  maxChildren: 5
}

/** A token grant, inherited as a *share* so a subtree cannot outspend its root. */
export interface Budget {
  grantedTokens: number
  spentTokens: number
  /**
   * What every run of this task has cost in money, summed.
   *
   * ⛔ **Derived on read, never written to `budget_json`.** A task's total moves when a *later* run
   * is found to have overlapped one of its own — see daemon/price.ts. Persisting it would freeze an
   * estimate the moment a parallel run ended. `creditTurn` writes the two token fields explicitly
   * for exactly this reason.
   *
   * `null` means nothing could be priced at all, and is `n/a` in the UI rather than $0.00.
   */
  spentUsd?: number | null
  /** At least one contributing run's number was a split, a stale reading, or still in flight. */
  spentUsdEstimated?: boolean
  /** ⚠️ At least one run could not be priced, so the total above is a **lower bound**. */
  spentUsdPartial?: boolean
  /**
   * The vendor's API-equivalent list price for every run of this task, summed.
   *
   * ⛔ **Not a component of `spentUsd`**, for the reason `RunPrice.listUsd` gives: it is what
   * this task *would* have cost on a market-rated API, not what anybody was billed.
   *
   * ⚠️ Derived on read like `spentUsd`, and never written to `budget_json`.
   */
  spentListUsd?: number | null
  /**
   * The directly-billed pay-as-you-go share of `spentUsd` — overage and credits, not the amortised
   * subscription. ⚠️ Derived on read like `spentUsd`, and never written to `budget_json`.
   */
  spentOverageUsd?: number | null
}

export type MessageRole = 'human' | 'agent' | 'controller' | 'system'

/** The closed set of concise system timeline entries the UI can render specially. */
export type MessageEvent =
  | 'worker.assigned'
  | 'worker.switched'
  | 'conversation.joined'
  /**
   * A resting conversation whose agent started speaking again without being prompted.
   *
   * ⚠️ Rare and worth a line: the turn is real work, on a task that read *your turn* a moment ago.
   * See `resumeIdleConversation`.
   */
  | 'conversation.resumed'
  /**
   * A landing an operator asked for, said *before* it runs.
   *
   * ⚠️ It is the one event here that describes something still happening, and it is written to the
   * thread anyway: a rebase, the project's checks and a push take minutes, and the only feedback a
   * person pressing Land used to get was the buttons going grey (t369). See `announceLandingStarted`.
   */
  | 'landing.started'
  /** *Landed as `sha` onto `target`* — the headline `salvageLandedCommits` reads back. */
  | 'landing.landed'
  /** A later fetch proved a local-only landing has subsequently reached its remote target. */
  | 'landing.pushed-later'
  | 'landing.failed'
  /** A finish verdict that stopped short of landing; the resolve buttons read the last of these. */
  | 'finish.held'
  | 'quota.parked'
  | 'quota.preempted'
  | 'provider.overloaded'
  | 'compaction'

/**
 * An image a person put on a message, stored as bytes on disk with its metadata in sqlite.
 *
 * ⛔ **Bytes on disk, never in the row.** A pasted screenshot is 1-3 MB and this database is
 * opened by the daemon on every tick; a blob column would bloat the WAL for data that is only ever
 * read whole, by path, and mostly by a CLI rather than by us.
 *
 * ⚠️ `kind` is a column rather than an assumption so that audio, when it arrives, is a value and
 * not a migration.
 */
export interface Attachment {
  id: string
  /** Null until the attachment is bound to the message it was pasted into. */
  messageId: number | null
  taskId: string | null
  kind: 'image' | 'file' | 'folder'
  mediaType: string
  /** Absolute path. This is what travels in the prompt text on every adapter. */
  file: string
  bytes: number
  width: number | null
  height: number | null
  createdAt: number
}

export interface TaskMessage {
  id: number
  taskId: string
  role: MessageRole
  text: string
  /** Machine-readable kind for a concise system entry; null for ordinary messages. */
  event: MessageEvent | null
  /** Supporting evidence shown only when the concise entry is expanded. */
  detail: string | null
  runId: string | null
  /**
   * When this message reached an agent. A note typed into a live session is answered in that
   * session - `0.1·C` - and must not also be replayed into the next prompt, which would charge for
   * it twice and leave the agent unsure what is still outstanding.
   */
  deliveredAt: number | null
  ts: number
  /**
   * Images pasted onto this message. Empty on almost every row, which is why they live in their own
   * table rather than as nullable columns here.
   */
  attachments: Attachment[]
}

export interface CancelRecord {
  requestedBy: 'human' | 'controller' | 'system'
  requestedAt: number
  reason: string | null
  restingState: RestingState
}

export interface Task {
  id: string
  /** Short human-facing number, stable and far easier to say out loud than a uuid. */
  seq: number
  projectId: string | null
  /**
   * ⛔ **This is the prompt.** `promptFor()` pushes it verbatim as the first part of what the agent
   * is told, and the task-creation form files the whole textarea into it. So it is routinely a
   * paragraph rather than a label, and nothing may overwrite it with something shorter for the sake
   * of a table — a truncated title is a truncated instruction.
   */
  title: string
  /**
   * A one-line label for `title`, written by the controller. Null until one exists.
   *
   * ⚠️ **Display only, and additive by construction.** Nothing in the prompt path reads it: the UI
   * renders `titleSummary ?? title` wherever a task needs a name in a row, a header or a chip, and
   * the thread still shows the full prompt as its first entry. That split is the whole feature — a
   * readable board without losing a word of what the agent was actually asked.
   */
  titleSummary: string | null
  kind: TaskKind
  status: TaskStatus
  /** True only while this task is rebasing, verifying or merging its branch. */
  landing?: boolean
  priority: Priority
  createdBy: Principal
  parentTaskId: string | null
  lineageDepth: number
  assignee: string | null
  /** `human`, `any`, or a worker id. Open, because a hint is advisory - the scheduler may ignore it. */
  assigneeHint: string | null
  mandate: Mandate
  budget: Budget
  dependsOn: string[]
  notBefore: number | null
  deadline: number | null
  requires: Array<{ resourceId: string; amount: number }>
  constraints: TaskConstraints
  /**
   * ⛔ Superseded by `finishPolicy` and kept only so old rows and old callers still parse. `required`
   * was migrated to `finishPolicy: 'await-human'`; nothing writes it any more and nothing gates on
   * it. It goes when the last database written before 2026-08-28 is gone.
   */
  verification: 'required' | 'not_required' | 'auto'
  /** This task's own answer, or `inherit` to take the project's — which may itself inherit. */
  finishPolicy: FinishPolicyChoice
  /**
   * May this task borrow a conversation? Resolved task → project → fleet, `inherit` by default.
   *
   * ⚠️ `inherit` is a real value rather than a blank: a task left on it follows its project as the
   * project changes, and one set explicitly to the same value does not.
   */
  sessionSharing: SessionSharingChoice
  /** How far the agent is expected to get before it stops. `inherit` follows the project. */
  completionMode: CompletionModeChoice
  /**
   * Where the agent works: a pooled worktree on its own branch, or the project's trunk checkout.
   * `inherit` follows the project. ⛔ Fixed once the task's first run starts — see
   * `resolveWorkspaceMode`.
   */
  workspaceMode: WorkspaceModeChoice
  /** What this task is optimising for, or `inherit` to follow project/fleet. */
  objective: ObjectiveChoice
  /**
   * May the cache clock compact this task's conversation? `inherit` follows the fleet switch.
   *
   * ⛔ Resolved by `resolveAutoCompact`, task → fleet, and read by every place the fleet switch was
   * read before — the four clock moves that can issue a `/compact` and the resume path. A control
   * that reached only some of them would be a switch that appears to be on and mostly is not, which
   * is the mirror of the rule `settings.autoCompact` already carries.
   */
  autoCompact: AutoCompactChoice
  /**
   * When the finish instruction was sent to the agent, if it has been.
   *
   * ⛔ The guard against re-asking. The instruction is sent, the agent works, and it calls
   * `task_complete` again — and between those two moments nothing about the task has changed, so the
   * same decision would be reached again. That is the preemption loop of 2026-08-28 in a different
   * costume, and each repeat here is a billed turn spent telling an agent to do what it just did.
   */
  finishAskedAt: number | null
  /** When the agent was asked to resolve a rebase conflict. ⛔ One ask, then a person. */
  conflictAskedAt: number | null
  /** When the scheduler used this task's one automatic resolve-and-retry attempt. */
  resolveRetryAskedAt: number | null
  preemptible: boolean
  estTokens: number | null
  cancel: CancelRecord | null
  handoffNote: string | null
  /**
   * Why this task is not moving, and whether anybody is expected to do something about it.
   *
   * Two callers, one question. The **scheduler** writes it every tick it passes a `ready` task over;
   * anything that hands a task to a **person** writes the reason it did. ⛔ An `awaiting_human` task
   * with no stated reason is the least actionable thing this app can show — it says a decision is
   * wanted without saying what about, and it sits next to a run marked `completed`, which reads as a
   * contradiction until somebody opens the thread and finds the sentence.
   *
   * ⛔ `ready` is not a state an operator can act on. It is the scheduler's word for "eligible", and
   * a task can sit in it for hours because every worker is at capacity, because a routing question is
   * open, or because the only account that could take it is out of window - three situations with
   * three different answers, rendered identically as a task that appears to be doing nothing while
   * the person who filed it wonders which button they forgot to press.
   *
   * The scheduler already computes its half on every tick and used to fold it into a log line. It
   * costs nothing to keep - the tick is arithmetic - and it is written only when it *changes*, so a
   * held task is not a write every ten seconds.
   *
   * ⚠️ Moves atomically with the status and is cleared by any transition that does not supply one. A
   * stale reason is worse than none, because it is read as current.
   */
  holdReason: string | null
  /**
   * The earliest moment the thing named in `holdReason` could stop being true, or null when nothing
   * can say.
   *
   * ⛔ **The machine-readable half of `holdReason`, and it exists because prose was the only half.**
   * A task held on a quota window is held until that window resets, and the scheduler read that
   * reset time in order to write the sentence — then discarded it. Two consumers needed the number:
   * the operator, who was shown *"at 92% of its 5h window"* with no way to know whether that meant
   * five minutes or five hours, and `expectedIdleMs`, which counted a task that could not move for
   * 2h29m as *"ready now"* and so told every live session in the fleet to expect work imminently.
   *
   * ⚠️ **Descriptive, never a gate.** Nothing refuses to dispatch because of it; the hold is
   * re-decided from the world on every tick exactly as it was before. It is deliberately not
   * `notBefore`, which `admit()` reads and would turn into a status change.
   */
  holdUntil: number | null
  /**
   * Until when a person has said to dispatch this task despite the quota high-water mark.
   *
   * ⛔ **It overrules a percentage of ours and nothing else.** The 92% gate is this fleet's own
   * caution, computed from a reading; it is not the vendor declining anything. So an override lets
   * the dispatch gate, the mid-run percentage preempt, and the early window-boundary preempt pass.
   * It leaves untouched every gate that rests on something else — a disabled or signed-out account,
   * a worker at capacity, and above all a turn the vendor actually **refused**, which no operator
   * setting can talk out of having happened.
   *
   * ⚠️ A deadline, not a boolean, and it is written from the reset of the window being overruled —
   * so the permission expires with the reason for it, whether or not anything ran meanwhile.
   */
  quotaOverrideUntil: number | null
  /**
   * A deterministic grace period before an automatic quota preemption.
   *
   * ⛔ Persisted before it is shown: every watchdog tick re-evaluates the trigger, so an in-memory
   * countdown would restart on daemon restart and could postpone the action forever. `trigger`
   * identifies the evidence class; changing percentages update the reason without buying another
   * minute. A vendor refusal is never represented here because the turn has already been denied.
   */
  quotaPreemptWarning: {
    trigger: 'window' | 'overrun'
    reason: string
    preemptAt: number
    resumeAt: number
    /** The capability-derived action that will run when the countdown expires. */
    action?: 'compact' | 'handoff'
    /** True when the live adapter can compact, so the operator may choose either safe action. */
    canCompact?: boolean
    /**
     * Set only on a `handoff` chosen to redirect rather than to wait. `null` means the scheduler
     * picks the destination; a worker id names one. Undefined (the default) means "hand off and pause
     * here, resuming this same account when its window reopens" — compaction can never carry this,
     * because a compacted context belongs to the session that built it, not to another account.
     */
    reassignWorkerId?: string | null
  } | null
  branch: string | null
  /**
   * Which numbered branch this task is on: 1 for `warmstart/t12-…`, 2 for `warmstart/t12.2-…`.
   *
   * ⛔ **Because a conversation can land more than once, and a landed branch is retired.** Every
   * other kind of task has exactly one branch for its whole life, so the name could be derived from
   * the seq alone. A conversation that lands keeps talking: the target has moved, the old branch is
   * gone, and the next stretch of work has to be cut fresh from the landed target under a name
   * nothing else holds. The counter is what makes that name derivable rather than guessed — see
   * `branchNameFor` and `landConversationWork`.
   *
   * ⚠️ 1 on every task that has never landed twice, which is every task that existed before this
   * column, so `branchNameFor(seq, title)` keeps answering exactly what it always did.
   */
  branchUnit: number
  /**
   * The level a **Commit** press promised to land on once the agent's turn ends, and has not yet.
   *
   * ⛔ **The tool's own half of the Commit button, written down.** Commit asks the agent for a
   * commit and tells it explicitly not to merge or push. On an adapter with MCP the agent closes
   * that loop itself with `land_work`; on one without — muse-code, codex — nothing did, so the level
   * the operator picked was dropped on the floor. t578 (2026-09-20) ended with one squashed commit
   * on its branch, an agent that had said *"the commit is ready to land"*, and no landing; pressing
   * Commit again only re-sent the same instruction.
   *
   * ⛔ Recorded before the turn and re-read after it, never acted on from memory —
   * `landAfterCommitTurn` looks at the workspace again and stands down if the agent already landed
   * it. That is AGENTS.md's rule about an ask and the evidence that would prove it landed.
   *
   * ⚠️ `null` on every task nobody has pressed Commit on, and cleared the moment the turn that was
   * asked for ends, however it ends.
   */
  landAfterTurn: FinishPolicy | null
  /**
   * The ref this task's work lands onto, or null to take the project's.
   *
   * ⛔ **Null on every task that is not a split**, which is what makes the resolver inert. `landing
   * TargetFor(task, project)` returns the project's answer whenever this is null, so the 24 readers
   * that went through it changed nothing for any task that existed when it was added.
   *
   * ⚠️ Set on a split's **children**, to their planner's branch — the integration branch — so that
   * child 2 is cut from a base that already contains child 1's work. Read `docs/landing.md`: a base
   * and a measurement that disagree is t22, and it reports success.
   */
  landingTarget: string | null
  /**
   * What each piece of a Plan & Split inherits, set on the planner when the task is filed.
   *
   * ⚠️ Null for every `work` task. Only a `plan` task carries one, and `task_split` reads it when it
   * files the children rather than asking the agent to choose — a model picked by the operator in
   * the composer is not something an agent should be able to talk its way out of.
   */
  childDefaults: ChildDefaults | null
  /**
   * The roster, the round budget, the exchange rule and the verdict — the whole of a debate.
   *
   * ⚠️ Null for every task that is not a `debate`, and for every row written before migration 68.
   */
  debate: DebateState | null
  /**
   * When work first started on this task, and when the last attempt stopped.
   *
   * ⛔ Derived from the runs, not stored on the task, because they are facts about attempts and a
   * copy on the task would drift the first time a run was re-attributed. They live here because a
   * table of tasks must be able to say **how long this took** without loading every run of every
   * row - `createdAt` is when somebody typed it, which is a different and much less interesting
   * number.
   *
   * `lastRunEndedAt` is null while an attempt is still open, which is what makes "running for 4m"
   * distinguishable from "took 4m".
   */
  firstRunAt: number | null
  lastRunEndedAt: number | null
  /**
   * How long an agent was actually working on this, and whether that number is still moving.
   *
   * ⛔ **Not `lastRunEndedAt - firstRunAt`.** That span is how long the task *existed inside*, and
   * it counts every minute the task spent queued, held on a busy workspace pool, paused on quota,
   * or waiting for a person to answer a question — none of which anybody worked. The two diverge
   * without limit, so every per-task, per-agent and per-model duration derived from the wall-clock
   * is describing the operator's evening rather than the agent's work.
   *
   * Read them together: the total is `activeMs + (activeSince ? now - activeSince : 0)`. ⚠️ Split
   * in two so a running task ticks in the renderer without the daemon pushing a new row every
   * second; `activeSince` is null whenever the number has stopped moving, which includes *a run
   * that is open but blocked on a person right now*.
   *
   * See daemon/activetime.ts for what this can and cannot see.
   */
  activeMs: number
  activeSince: number | null
  /**
   * The account the most recent run was on, whoever the task is *with* right now.
   *
   * ⛔ Derived from the runs, and it exists because `assignee` cannot answer this. Nine hand-off
   * sites set `assignee` to `human` when a task starts waiting on a person, which is honest about
   * who is being waited on and destroys the one fact the Worker column exists to show: a task that
   * ran on ClaudeSecond and then asked a question rendered as worked on by **you**, and stayed that
   * way after it was marked done. The account that spent the tokens is not the person who answered.
   *
   * ⚠️ Null until something has actually run. A task assigned a moment ago and not yet started has
   * an `assignee` and no runs, which is a different state and reads as one.
   */
  ranOn: string | null
  /**
   * The model the most recent run was dispatched with, from the same run `ranOn` names.
   *
   * ⛔ Read off the run, never re-resolved. What a task *would* be given next is a different
   * question with a different answer - `resolveModelChoice` answers that one - and the two diverge
   * the moment an account's default changes under a task that has already finished. A column that
   * silently re-labels last week's work with this week's default is the failure `ranOn` exists to
   * avoid, one field over.
   *
   * ⚠️ Null until something has run, and null on a run whose session never learned a model.
   */
  ranModel: string | null
  /**
   * The commit range this task landed, recorded at the moment the landing knew it.
   *
   * ⛔ **The only record that survives the branch.** `mergeLocal` fast-forwards the trunk and then
   * deletes the branch; after that the task's commits are in the trunk's history and nothing
   * identifies which ones they are. These two SHAs are what `git diff base..head` needs, and after a
   * fast-forward both stay reachable from the trunk forever.
   *
   * ⚠️ Null on every task that landed before this was recorded, and that is not repairable —
   * `runs.trunkShaBefore` is read at *dispatch*, before the rebase, so it is not a parent of the
   * landed commits. A reader that cannot resolve a range refuses rather than guessing: a review of
   * the wrong commits is worse than no review, because it produces a number that looks real.
   */
  landedBaseSha: string | null
  landedHeadSha: string | null
  /**
   * The latest quality review of this task, denormalised for the table.
   *
   * ⛔ **The only denormalisation in this feature**, and it is paid for: the task table sorts and
   * filters over hundreds of rows, and a join per row on every keystroke of the filter box is a real
   * cost. All four fields are written by `recordReview` and by nothing else.
   *
   * ⚠️ `null` means *not reviewed*, which is a different thing from *reviewed and scored zero*.
   * The score is the arithmetic mean across `qualityReviewCount` completed, scored peer reviews
   * **and** the operator's own rating, when there is one — `TASK_QUALITY_RECOMPUTE_SQL` in
   * `review.ts` is the one place that arithmetic lives.
   */
  qualityReviewId: string | null
  qualityScore: number | null
  /** Number of grades included in `qualityScore`'s arithmetic mean, the operator's rating included. */
  qualityReviewCount: number
  qualityReviewedAt: number | null
  /** The newest peer reviewer's adapter id. ⛔ Never the subject's — a review never grades its own author. */
  qualityReviewer: string | null
  /**
   * How many of `qualityReviewCount` are the operator's own rating: 0 or 1, since a task keeps at
   * most one (`createManualReview`). Read live from `manual_reviews`, not stored on the row.
   */
  qualityManualCount: number
  /** Reviewer account while a peer grade is in flight; display state, not task lifecycle state. */
  gradingWorkerId?: string | null
  /**
   * Leave this task out of the fleet's own statistics.
   *
   * ⛔ **An escape hatch for a measurement that is wrong, not for a result somebody dislikes.** The
   * case it exists for, measured 2026-09-06: t52 reported 639 minutes of active time against a 9.8
   * minute median for the same model, because a run reaped with *"orchestratord restarted"* carried
   * ten and a half hours of daemon downtime inside its span. That particular reading is now clamped
   * at source in `activetime.ts`; this is for the next one nobody has thought of yet, and the thread
   * pane that sets it says so.
   *
   * ⚠️ **Descriptive surfaces only, and the boundary is deliberate.** Statistics, the pace factor
   * and every quality aggregate skip an excluded task. The **estimator** does not: its samples are
   * token counts, and a task excluded for reporting an impossible duration still spent exactly the
   * tokens it spent.
   */
  excludedFromStats: boolean
  /**
   * This task cannot and should not be peer-reviewed.
   *
   * ⛔ **Set by a human when a task's work is not gradable** — database-only changes, configuration
   * updates, or other valid work that produces no commits to review. A task marked non-gradable is
   * excluded from batch grading runs and ineligible for peer review. It is not a quality judgment;
   * it is a statement that quality review does not apply to this work.
   */
  nonGradable: boolean
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * One commit a task put on its landing target.
 *
 * ⛔ **The record that survives the branch, and the only one that is exact.** `landedBaseSha` /
 * `landedHeadSha` describe a *range*, which is exact for the ordinary task — one landing, one
 * commit — and wrong for a task that landed twice with somebody else's work in between. These
 * rows name the commits themselves, so nothing has to be interpolated from adjacency.
 *
 * ⚠️ `subject` and `authoredAt` are copied at the moment the commit is recorded rather than read
 * back from git on every render. A commit that later leaves the target's history keeps its row and
 * stops resolving; `review.ts` checks reachability before it grades, and the pane says what it has.
 */
export interface TaskCommit {
  /** The full 40-character SHA. Abbreviations are resolved before anything is stored. */
  sha: string
  /** The commit's first line, as it read when the commit was recorded. */
  subject: string | null
  /** The author date in epoch milliseconds — preserved across a rebase, unlike the commit date. */
  authoredAt: number | null
  /** The branch it landed onto, which is not always the project's trunk under Plan & Split. */
  target: string | null
  /** When this row was written, which for a salvaged row is long after the commit was made. */
  recordedAt: number
  /**
   * How this row came to exist.
   *
   * ⛔ `landing` was recorded by the landing that made it, `salvage` was read back out of the
   * task's own *"Landed as …"* thread message afterwards. The difference is worth keeping: a
   * salvaged row names the tip of a landing and cannot name a second commit under the same one.
   */
  source: 'landing' | 'salvage' | 'pull-request'
}

export interface TaskConstraints {
  /**
   * Pin this task to one account.
   *
   * ⛔ A pin, not a preference. The scheduler skips every other worker outright, so a pinned task
   * waits for that one account rather than routing around it when it is busy, out of window or
   * quarantined. That is the point - somebody choosing an account has a reason - but it is also why
   * the control that sets it has to say so rather than call itself a hint.
   */
  workerId?: string
  /** Multiple workers allowed for this task. Pinned to any of these accounts. */
  workerIds?: string[]
  adapterId?: string
  model?: string
  /**
   * How the model is chosen on a task that does not pin one.
   *
   * ⛔ **`auto` is the absence of this field and the behaviour every task filed before it had.**
   * The scheduler scores each of the chosen worker's routable models as its own candidate and the
   * winner is not knowable until the tick that dispatches. `inherit` says the opposite out loud:
   * take the account's own default model and route nothing — what `resolveModelChoice` answers with
   * no pin, which on a multi-pool account is still the emptier pool's default.
   *
   * ⚠️ Only meaningful while `model` is unset. A pinned model is a mandate, and a pin plus a policy
   * is one instruction, not two.
   */
  modelPolicy?: 'auto' | 'inherit'
  /**
   * Preferred model capability tier when model is chosen automatically ('high' | 'med' | 'low').
   */
  modelClass?: ModelClass
  /**
   * How hard the model should think, where the CLI can be told.
   *
   * ⛔ Only ever sent to an adapter that declares `selectableEffort`. Effort is otherwise an
   * *observed* property in this codebase - it arrives from the agent's own transcript and is a record
   * of what happened. Passing a level to a CLI that has no flag for one would produce a task that
   * claims a setting nothing applied, which is worse than not offering the choice.
   */
  effort?: string
  /** Model per worker ID, when multiple workers or a specific worker model is specified. */
  modelsByWorker?: Record<string, string>
  /** Effort per worker ID, where selectable. */
  effortsByWorker?: Record<string, string>
  /** Capabilities the task cannot run without, e.g. `manualCompact`. */
  needs?: string[]
  workspacePolicy?: 'pooled' | 'trunk' | 'direct' | 'any'
  /** For plan tasks: priority for each decomposed piece. */
  piecePriority?: Priority
  /** For plan tasks: max piece limit (e.g. <=5). */
  pieceLimit?: number
  /** For plan tasks: finish policy for each piece (e.g. commit-and-merge into planner branch). */
  pieceFinishPolicy?: FinishPolicyChoice
  /** For plan tasks: session sharing for each piece. */
  pieceSessionSharing?: SessionSharingChoice
  /** For plan tasks: constraints for each piece (e.g. allowed workers & models). */
  pieceConstraints?: TaskConstraints
}

/** One attempt of a task on one session. Runs are what the estimator learns from. */
/**
 * What a run *was*, which until 2026-09-03 was always the same answer.
 *
 * ⛔ A quality review is a `runs` row so that it is metered by the one path that meters runs and
 * numbered by the one timeline that numbers them. That makes this discriminator load-bearing rather
 * than descriptive: every query that means *work* — the estimator's training data, a task's "what
 * ran on it", `activeMs` — has to say so, or a one-turn grade contaminates a number every gate reads.
 */
export type RunKind = 'work' | 'quality_review'

export interface Run {
  id: string
  taskId: string
  sessionId: string | null
  workerId: string
  /** ⚠️ `'work'` on every row written before the column existed, which is what they all were. */
  kind: RunKind
  startedAt: number
  endedAt: number | null
  outcome: RunOutcome | null
  /** ⚠️ True when the run was dispatched without a trustworthy quota reading. See quota.ts. */
  quotaUnverified: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costModelId: string | null
  /**
   * Which agent and model spent this run's tokens, stamped on the run rather than joined from the
   * session that has since been closed.
   *
   * ⚠️ Both are nullable. `adapterId` is null only on runs that predate the column; `model` is null
   * there too, and on any run whose session never learned one. The estimator treats a null model as
   * "this adapter, model unknown" and falls back a level rather than inventing one.
   */
  adapterId: string | null
  model: string | null
  note: string | null
  /**
   * The account's own window, read either side of this run.
   *
   * ⛔ **Two readings or none.** A cost is a difference, and a difference needs a baseline - a run
   * that reports "the account is at 41%" afterwards says nothing about what the run itself spent.
   * The `before` is taken at dispatch (the scheduler refreshes a stale reading and waits a tick
   * rather than dispatching blind); the `after` is taken once the run has ended and nothing is
   * waiting on it.
   *
   * ⚠️ This is *not* the same number as the token counts above, and the gap between them is the
   * point: this app meters assistant turns exactly, while quota measures everything the account
   * spent - the auto-mode classifier, title generation, whatever else. HANDOFF calls that gap the
   * instrument. Both are shown, never merged.
   */
  quotaBefore: RunQuota | null
  quotaAfter: RunQuota | null
  /**
   * Where the trunk's landing target stood when this run was dispatched.
   *
   * ⛔ The tripwire's baseline. A run whose branch ends up empty while *this* has moved is the
   * signature of work done in the trunk directly — which every check, rebase and landing policy
   * sits downstream of and therefore never sees.
   *
   * ⚠️ `null` means no reading was taken (a projectless task, a non-git project, or a run predating
   * the column), never "the trunk did not move". The check declines rather than guessing.
   */
  trunkShaBefore: string | null
  /**
   * The files already uncommitted in the trunk when a **trunk-mode** run started, or null for any
   * other run.
   *
   * ⛔ The operator's, not the agent's. A trunk run is dispatched onto whatever the checkout holds
   * (and told what that is), so its finish must not ask the agent to commit these nor count them as
   * its loose ends.
   */
  trunkDirtyBefore?: string[] | null
  /**
   * Did this run inherit a conversation, or build one from nothing?
   *
   * ⛔ **`null` is not `false`.** Runs that predate the column recorded nothing, and rendering those
   * as *new* would be an assertion nobody measured. The UI says nothing at all for null.
   */
  startedWarm: boolean | null
  /**
   * The exact prompt sent to the agent CLI for this run.
   *
   * Includes prepended handoff notes, branch notices, the task prompt and completion instructions.
   * Null for runs that predated this column.
   */
  prompt: string | null
  /** Intermediate streaming activity (e.g. tool invocations, assistant thoughts) captured during the run. */
  activity?: Array<{ text: string; ts: number }> | null
  /** The effective optimization objective vector active when this run was dispatched. */
  objective?: Objective | null
  /**
   * What this run cost in money, or why it cannot be said.
   *
   * ⛔ Derived from the account's own window readings, never stored — see `RunPrice`.
   */
  price?: RunPrice | null
  /**
   * How long this attempt spent waiting on a person — an open question or an escalated approval.
   *
   * ⛔ Derived from the `questions` and `approvals` rows that name this run, never stamped on it, so
   * a question answered an hour after the fact corrects the number rather than leaving a stale copy.
   * An approval the project's rules settled contributes nothing: it was answered in the same
   * millisecond it was asked.
   *
   * ⚠️ Subtract it from the run's wall-clock to get the time the agent was working:
   * `(endedAt ?? now) - startedAt - blockedMs`. That is what `Task.activeMs` sums.
   */
  blockedMs: number
}

/**
 * Why a run costs what it costs — or why it costs nothing that can be said.
 *
 * ⛔ **Six of these eight are `n/a`, and they are deliberately not one value.** "the account is
 * free", "nobody read the window either side of this run" and "the window rolled over mid-run" are
 * three different facts about the same missing number, and a reader who is shown one dash for all
 * three has no way to tell a run that cost nothing from a run nobody measured.
 */
export type PriceReason =
  /** One run held the window for its whole life. The number is a measurement. */
  | 'measured'
  /** Parallel runs shared the window; the split is duration-weighted, and shown with a `*`. */
  | 'shared_window'
  /** No complete pair of readings around the run. */
  | 'no_reading'
  /** The window rolled over mid-run, so the difference either side of it is not a cost. */
  | 'window_reset'
  /** The provider reports no window the subscription can be divided over. */
  | 'no_window'
  /** A free or self-hosted plan: known, and with no price to divide. */
  | 'unpriced_plan'
  /** No plan could be resolved at all. */
  | 'no_plan'
  /**
   * No meter reached this run: neither a subscription window nor a spend meter had anything to say.
   *
   * ⚠️ Distinct from `no_reading`, which means a meter exists and this run fell between two of its
   * readings. This one means there was nothing to read from in the first place.
   */
  | 'no_meter'

/**
 * A run's cost in money, with the basis every cost belief in this repo has to carry.
 *
 * ⛔ **Money here is layered, and `usd` is the headline sum of exactly two of the layers.**
 * Every agent on this fleet runs on a subscription, so what an operator pays is an amortised share
 * of a flat monthly fee (`subscriptionUsd`) **plus** whatever was billed directly on top of it
 * (`overageUsd`). `listUsd` is carried beside them and is **never** part of `usd` — see its own
 * note. See daemon/price.ts and docs/cost-model.md §13.
 */
export interface RunPrice {
  /**
   * The headline: `subscriptionUsd + overageUsd`, treating `null` as *absent* rather than zero.
   *
   * ⛔ `null` is `n/a`, and `reason` says which `n/a`. Never rendered as $0.00. Where only one
   * of the two layers could be priced this is that layer alone, and `basis` says the total is a
   * lower bound.
   *
   * ⚠️ Kept as the field name, and as the number every existing call site already reads, so that
   * adding the layers below broke no surface that only ever wanted "what did this cost".
   */
  usd: number | null
  /**
   * This run's share of the billing window × the plan's monthly fee.
   *
   * ⚠️ **Amortised, not cash.** Nobody is charged this at the moment the run happens; the
   * subscription was already paid. It is what the run consumed *of* that payment.
   */
  subscriptionUsd: number | null
  /**
   * Directly-measured pay-as-you-go dollars: Claude extra-usage overage, Antigravity cloud credits,
   * Codex credits. Attributed from `spend_samples` the same way the window percent is.
   */
  overageUsd: number | null
  /**
   * What the same work would have cost on the vendor's market-rated API.
   *
   * ⛔ **Never part of `usd`, and never summed with either layer above.** It answers "is the
   * subscription worth it", which is a different question from "what did this cost me"; adding it
   * would double-count a bill that was never issued.
   */
  listUsd: number | null
  /** Whether this run was drawing on paid overage rather than the subscription. `null` = unknown. */
  onOverage: boolean | null
  /** The share of the billing window attributed to this run. */
  percent: number | null
  /** The `*`: a split, a stale reading, a corrected panel, or a run still in flight. */
  estimated: boolean
  /**
   * How much of the run no window reading covered, in milliseconds — `0` when they covered it end
   * to end, `null` when the run has no price at all.
   *
   * ⛔ **Non-zero makes `usd` a lower bound**, and that is the one flavour of `estimated` with a
   * *direction*. A shared or stale share is imprecise about a movement that was read; this one is
   * short of a stretch nobody read, so the truth is this or more and never less. Carried to the UI
   * rather than left in the basis prose, because the tooltip has to be able to say which of the
   * two it is looking at.
   *
   * ⚠️ Routinely non-zero for a real reason: a vendor's closing reading carries the *vendor's*
   * timestamp, which is commonly a minute or two before the run actually ended.
   */
  unmeasuredMs: number | null
  reason: PriceReason
  /** One sentence, straight into the tooltip. */
  basis: string
  planId: string | null
  planLabel: string | null
  /** How the plan was decided: from the run's own window shape, the vendor string, or a default. */
  planSource: 'window_shape' | 'identity' | 'neighbour' | 'default' | 'stored' | null
  windowId: string | null
  /** Runs that held the same window at the same time. */
  parallelRunIds: string[]
}

/** A quota reading kept beside a run, with enough of its basis to be distrusted properly. */
export interface RunQuota {
  /**
   * Windows are paired across the run's two readings by pool and kind, never by bare id.
   *
   * ⛔ Antigravity aliases its busiest five-hour window to the bare id `5h`, and whichever pool
   * is busiest holds that id — so the id moves between pools from one reading to the next and
   * pairing by id alone attributes one pool's spend to the other (t273). `group` is the stable
   * half of the pair: it survives the aliasing by contract (see `QuotaWindow.group`).
   * `undefined` on a single-pool provider, where the id is already stable.
   */
  windows: Array<{ id: string; label: string; percent: number; group?: string }>
  /**
   * The pay-as-you-go meters read at the same moment, so a run that spent credits past the plan
   * limit can show the movement beside the window percents (t285).
   *
   * ⚠️ Optional and best-effort: runs that predate it, and runs on workers with no spend meter,
   * carry nothing here, and the thread pairs only the meters present on *both* readings.
   */
  spend?: RunSpend[]
  sampledAt: number
  /** True when this was the best available reading and was already too old to act on. */
  stale: boolean
}

/**
 * One money meter as a run bracketed it: the raw vendor balance, not dollars.
 *
 * ⛔ Raw, because the dollar conversion (`usdPerUnit`) is a property of the meter that a later
 * correction could restate — the snapshot keeps what the vendor said and the reader converts.
 * `usdPerUnit: null` means the vendor bills in a currency nobody here prices, and the row is
 * shown as `n/a` rather than converted at a guessed rate.
 */
export interface RunSpend {
  meterId: string
  label: string
  balance: number | null
  /** Which way the number moves when money is spent. See `SpendMeter.direction`. */
  direction: 'balance_falls' | 'spend_rises'
  /** What one unit is worth in dollars. Always 1 for a `usd` meter. */
  usdPerUnit: number | null
}

/**
 * How a run ended.
 *
 * ⛔ **`blocked` is not a kind of failure.** A run that stopped because the agent asked a person
 * something did work, metered turns, and is one answer away from continuing — filing that as `failed`
 * says the opposite of what happened, and it was doing so on the strength of nothing more than the
 * absence of a completion signal. Measured 2026-08-30 (R14.c): the CLI says which of the two it is,
 * in `post_turn_summary`, and the terminal record cannot.
 *
 * ⚠️ `blocked` is still not `completed`, and nothing that reasons about finished work may treat it as
 * one: the estimator medians `completed` runs only, because a run that stopped half way through is
 * not a measurement of what the whole job costs.
 */
export type RunOutcome =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'terminated'
  | 'preempted'

// ---------------------------------------------------------------------------- approval

export type ApprovalOrigin = 'permission_prompt' | 'tool_gate' | 'resource_gate'
export type ApprovalDecision = 'allow' | 'allow_always' | 'deny'
export type ApprovalPolicyResult = 'auto_allow' | 'auto_deny' | 'escalate'

export interface Approval {
  id: string
  sessionId: string
  runId: string | null
  taskId: string | null
  projectId: string | null
  origin: ApprovalOrigin
  tool: string
  target: string | null
  /** A one-line rendering of what is about to happen, supplied by the caller, never inferred. */
  summary: string
  policyResult: ApprovalPolicyResult
  matchedRule: string | null
  askedAt: number
  /** The blocked session's cache expiry. Waiting is priced, which is why this is not a notification. */
  deadlineAt: number | null
  escalateAfterMs: number
  answeredAt: number | null
  answer: ApprovalDecision | null
  answeredBy: 'policy' | 'human' | 'timeout' | null
  escalatedAt: number | null
}

// ---------------------------------------------------------------------------- question

/**
 * A question put to a person by an agent that is still running.
 *
 * ⛔ **The third object, and it is neither of the other two.** A Task is schedulable, durable and
 * outlives every session. An Approval is an interrupt on one live session whose answer set is closed
 * at allow/deny and whose answer can become a rule. A Question is an interrupt like the second with
 * an answer set supplied by **whoever asked** — and an answer that is *content*, returned into the
 * tool result, not a verdict. You cannot remember the answer to "which auth approach" as a project
 * rule, and a default of "no" answers nothing.
 *
 * ⚠️ It can outlive its session. See `parkedAt`.
 */
export type QuestionKind = 'text' | 'choice' | 'multi'

/**
 * Where the question came from.
 *
 * ⚠️ `native_tool` is a question the vendor's own CLI raised — measured on Claude Code's
 * `AskUserQuestion`, 2026-08-30 — and it arrives whether or not the agent was ever told this tool
 * exists. `ask_human` is one the agent asked for deliberately. Worth keeping apart: the first says
 * something about the CLI, the second about the prompt.
 */
export type QuestionOrigin =
  | 'ask_human'
  | 'native_tool'
  | 'checkpoint'
  | 'task_split'
  | 'debate'
  /** An agent asking for a directory outside its workspace. See `daemon/dirgrants.ts`. */
  | 'request_directory'

export interface QuestionOption {
  id: string
  label: string
  /** The asker's own prose about what choosing this means. Never summarised or rewritten. */
  detail?: string
}

export interface QuestionAnswer {
  /** Empty for a `text` question; one entry for `choice`; any number for `multi`. */
  optionIds: string[]
  /** Free text, which every kind may carry — an option plus a caveat is a common and useful answer. */
  text: string | null
  /**
   * Attachments filed with the answer — the operator's route to handing the agent a directory.
   * Bound to the answer's thread message, so a folder here is granted exactly as one attached in
   * the composer is. Absent on answers recorded before attachments could be answered with.
   */
  attachmentIds?: string[]
}

export interface Question {
  id: string
  sessionId: string
  runId: string | null
  taskId: string | null
  projectId: string | null
  origin: QuestionOrigin
  kind: QuestionKind
  question: string
  /** A short label for the question, where the asker gave one. Claude Code's `AskUserQuestion` does. */
  header: string | null
  options: QuestionOption[]
  askedAt: number
  /** The blocked session's cache expiry. Waiting is priced, which is why this is not a notification. */
  deadlineAt: number | null
  answeredAt: number | null
  answer: QuestionAnswer | null
  answeredBy: 'human' | null
  /**
   * When the session that asked went away with this still open.
   *
   * ⛔ A parked question is **not** an answered one and not a closed one. D1: nobody answered before
   * the cache expired, so holding the process stopped paying for itself and the task went to
   * `awaiting_human` — but the question is exactly as valid as it was, and answering it is what
   * starts the work again. Timing out has never been an answer here.
   */
  parkedAt: number | null
}

/** What the asker is told. `reply` is the sentence handed back to the agent, wherever it asked from. */
export interface QuestionResolution {
  status: 'answered' | 'parked' | 'void'
  reply: string
  answer: QuestionAnswer | null
}

/**
 * Detect whether a question was intended to be multi-select / checkboxes.
 *
 * Checks for:
 * 1. Bracketed tags like `[multi]`, `[multi-select]`, `[checkbox]`, `(multi-select)`, `(select all that apply)`
 * 2. Explicit multi-select phrases like "pick everything", "select all", "choose all", "check all", "any number of", "all that apply", "multiple options", etc.
 * 3. Header tags like "multi", "checkbox"
 */
export function isMultiSelectQuestion(
  question: string,
  options?: Array<{ label?: string; detail?: string } | string>,
  header?: string
): boolean {
  if (header && /\b(multi|multi-?select|checkbox(?:es)?)\b/i.test(header)) return true
  if (/\[(multi|multi-?select|checkbox(?:es)?)\]/i.test(question)) return true
  if (/\((multi|multi-?select|multiple|checkbox(?:es)?|select all that apply)\)/i.test(question)) return true
  if (
    /\b(pick everything|select all|choose all|check all|check any|select any|choose any|any number of|all that apply|all of the above|everything that applies|multiple options|more than one option|multiple choices)\b/i.test(
      question
    )
  ) {
    return true
  }
  if (options) {
    for (const opt of options) {
      const text = typeof opt === 'string' ? opt : `${opt.label ?? ''} ${opt.detail ?? ''}`
      if (/\b(select all that apply|all that apply|check all|multiple choices)\b/i.test(text)) {
        return true
      }
    }
  }
  return false
}

/** Clean bracketed multi-select tags from question text so they don't clutter the UI. */
export function cleanQuestionText(text: string): string {
  return text
    .replace(/\s*\[(multi|multi-?select|checkbox(?:es)?)\]\s*/gi, ' ')
    .replace(/\s*\((multi|multi-?select|checkbox(?:es)?)\)\s*/gi, ' ')
    .trim()
}

/**
 * Recover tool-call parameters that leaked into the question **text**.
 *
 * ⛔ **This is not prose parsing, and the difference is the whole justification.** What it reads is
 * the vendor's own serialisation of a tool call the CLI failed to finish parsing: a literal
 * `<parameter name="options">[…]` block sitting inside the `question` string, in the exact syntax
 * the model was made to emit. Reading choices out of an agent's *sentences* is the inference this
 * project refuses to make (see `needsDecisionIn`); reading them out of a half-parsed argument list
 * is recovering an argument the model did send.
 *
 * ⛔ **Measured, on t235, 2026-09-06, claude-code.** Three `ask_human` calls in a row arrived with
 * `header` intact, `options` empty, and the question text ending in
 * `</parameter>` + `<parameter name="options">["A - …", "B - …", "C - …"]`. Each had been offered by
 * the agent as a three-way choice and reached the operator as **an open text box with the XML still
 * in it**; the answers came back as the letters `B`, `A`, `A` typed by hand, and `options_json` was
 * `null` on all three. `kind` is derived from whether there are options, so one lost argument turns
 * a multiple-choice question into an answer-in-a-sentence one.
 *
 * ⚠️ The block may be unterminated — none of the three carried a closing `</parameter>` — so every
 * pattern here ends at `</parameter>` *or* at the end of the string, and the JSON is parsed
 * tolerantly. ⚠️ What is recovered is only ever a *default*: an asker that passed real arguments
 * wins, because those are what it meant to send.
 */
export function extractEmbeddedParameters(rawQuestion: string): {
  question: string
  header?: string
  multiSelect?: boolean
  options?: QuestionOption[]
} {
  let question = rawQuestion
  let header: string | undefined
  let multiSelect: boolean | undefined
  let options: QuestionOption[] | undefined

  // ⚠️ The question's own block first, and its *content* is the question. A call serialised whole
  // leaves the prose wrapped in one of these, and stripping the wrapper without keeping the inside
  // would throw away the only thing the operator actually has to read.
  const questionMatch = parameterBlock(question, 'question')
  if (questionMatch && questionMatch.body.trim()) {
    // ⚠️ A function replacement, because the body is somebody's prose: a question mentioning `$&` or
    // `$1` would otherwise have the match spliced into it by `String.replace`'s own syntax.
    question = question.replace(questionMatch.matched, () => questionMatch.body).trim()
  }

  const headerMatch = parameterBlock(question, 'header')
  if (headerMatch?.body.trim()) {
    header = headerMatch.body.trim()
    question = question.replace(headerMatch.matched, '').trim()
  }

  const multiMatch = parameterBlock(question, 'multi_select|multiSelect|is_multi_select|multiple')
  if (multiMatch?.body.trim()) {
    multiSelect = /^(true|1|yes)$/i.test(multiMatch.body.trim())
    question = question.replace(multiMatch.matched, '').trim()
  }

  const optionsMatch = parameterBlock(question, 'options|choices')
  if (optionsMatch?.body.trim()) {
    const parsed = parseOptionList(optionsMatch.body)
    // ⛔ The block goes either way. Text nobody could read as choices is not question prose either,
    // and leaving it in puts raw XML in front of the operator — which is what t235 looked like.
    if (parsed.length > 0) options = parsed
    question = question.replace(optionsMatch.matched, '').trim()
  }

  return { question: stripCallSyntax(question), header, multiSelect, ...(options ? { options } : {}) }
}

/** One `<parameter name="…">…` block, ended by its closing tag **or by the end of the string**. */
function parameterBlock(text: string, names: string): { matched: string; body: string } | null {
  const found = new RegExp(
    `<parameter\\s+name=["']?(?:${names})["']?\\s*>([\\s\\S]*?)(?:</parameter>|$)`,
    'i'
  ).exec(text)
  return found ? { matched: found[0], body: found[1] ?? '' } : null
}

/**
 * The leftovers of a tool call that was serialised into prose.
 *
 * ⚠️ Tags only, never content: an unrecognised `<parameter name="foo">` opener and a stray
 * `</parameter>` are punctuation from a machine, and whatever sits between them is still the
 * asker's own words.
 */
export function stripCallSyntax(text: string): string {
  return text
    .replace(/<\/?parameter(?:\s+name=["']?[^>]*)?>/gi, '')
    .replace(/<\/?(?:question|invoke|antml:parameter|antml:invoke)[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The options as the model wrote them: a JSON array, or one choice per line.
 *
 * ⚠️ Exported because the same text arrives two ways — inside a leaked `<parameter>` block, and as a
 * bare string where the schema asked for an array. Both are a model writing a list; one parser.
 *
 * ⚠️ Tolerant of an array that was cut off, because the block carrying it was cut off too — a list
 * whose last entry is truncated still names the choices before it, and refusing the whole thing puts
 * the operator back in front of a text box. ⛔ Capped at eight, the ceiling `needsDecisionIn` uses:
 * a card of twenty buttons is not a decision anybody makes by clicking.
 */
export function parseOptionList(body: string): QuestionOption[] {
  const text = body.trim()
  const raw: Array<
    string | { label?: unknown; text?: unknown; detail?: unknown; description?: unknown }
  > = []

  if (text.startsWith('[')) {
    const parsed = parseTolerantJsonArray(text)
    if (parsed) raw.push(...(parsed as typeof raw))
  }

  if (raw.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      const bullet = /^[ \t]*(?:[-*•]|\d+[.)])?[ \t]*(.+?)[ \t]*,?$/.exec(line)
      const value = bullet?.[1]?.replace(/^["']|["']$/g, '').trim()
      if (value) raw.push(value)
    }
  }

  const options: QuestionOption[] = []
  for (const entry of raw) {
    const label =
      typeof entry === 'string'
        ? entry
        : typeof entry.label === 'string'
          ? entry.label
          : typeof entry.text === 'string'
            ? entry.text
            : null
    if (!label?.trim()) continue
    const detail =
      typeof entry === 'string'
        ? null
        : typeof entry.detail === 'string'
          ? entry.detail
          : typeof entry.description === 'string'
            ? entry.description
            : null
    options.push({
      id: `opt${options.length + 1}`,
      label: label.trim().slice(0, 200),
      ...(detail?.trim() ? { detail: detail.trim().slice(0, 500) } : {})
    })
    if (options.length === 8) break
  }
  return options
}

/**
 * `["a", "b"` — a JSON array that lost its tail. Read as far as it is readable.
 *
 * ⛔ **A half-written entry is dropped, never completed.** Closing the quote on `"Someth` would put
 * the word *Someth* on a button and let an operator choose it; the choices before it are real and
 * the one that was cut off is not. For an array of plain strings that falls out of the syntax — a
 * complete string literal has both its quotes — and for objects the last element is dropped when the
 * array did not close.
 */
function parseTolerantJsonArray(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) return [...(parsed as unknown[])]
  } catch {
    // Cut off somewhere. ⚠️ Never throws: a question whose options cannot be read is still a
    // question, and losing its text along with them would be the worse failure.
  }

  if (!text.includes('{')) {
    const quoted = text.match(/"(?:[^"\\]|\\.)*"/g) ?? []
    const values: unknown[] = []
    for (const entry of quoted) {
      try {
        values.push(JSON.parse(entry))
      } catch {
        // Not a complete string literal.
      }
    }
    return values.length > 0 ? values : null
  }

  for (const candidate of [`${text}]`, `${text}}]`, `${text}"}]`]) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      // The last object was closed by this repair rather than by the model, so it is the truncated
      // one and goes with the rest of the tail.
      if (Array.isArray(parsed)) return (parsed as unknown[]).slice(0, -1)
    } catch {
      // Try the next repair.
    }
  }
  return null
}

/** A remembered answer. `Bash(npm test)`-shaped, matched by tool plus a glob over the target. */
export interface ApprovalRule {
  id: string
  projectId: string | null
  tool: string
  pattern: string
  effect: 'allow' | 'deny'
  createdBy: 'human' | 'project-config'
  createdAt: number
}

// ---------------------------------------------------------------------------- resources

export type ResourceKind = 'exclusive' | 'counted' | 'rate_limited'

/**
 * Anything contended for. Workspaces are just a counted Resource, which collapses two mechanisms
 * into one: if the scheduler owns the claim, the lock is unnecessary.
 */
export interface Resource {
  id: string
  projectId: string | null
  kind: ResourceKind
  label: string
  capacity: number
  /** For a pool, the identity of each member - a workspace path, a profile name, a port block. */
  members: string[]
  meta: Record<string, unknown>
}

export interface ResourceClaim {
  id: string
  resourceId: string
  member: string | null
  holder: string
  amount: number
  acquiredAt: number
  releasedAt: number | null
}

export interface ResourceAvailability {
  resource: Resource
  inUse: number
  free: number
  claims: ResourceClaim[]
}

// ---------------------------------------------------------------------------- objectives

/**
 * What the operator is optimising for, as a weight vector summing to 1.
 *
 * ⛔ Presets are just named vectors, and nothing may branch on a preset's *name*. The vector is
 * consumed in exactly two places - scheduler scoring and a cost policy object - and the effective
 * objective is recorded on every Run, so "why did it pick that" is answerable months later.
 */
export interface Objective {
  cost: number
  velocity: number
  quality: number
}

export type ObjectivePreset = 'economy' | 'balanced' | 'velocity' | 'quality'
export type ObjectiveChoice = ObjectivePreset | Objective | 'inherit'

export const PRESETS: Record<ObjectivePreset, Objective> = {
  economy: { cost: 0.7, velocity: 0.15, quality: 0.15 },
  balanced: { cost: 0.3, velocity: 0.3, quality: 0.4 },
  velocity: { cost: 0.15, velocity: 0.7, quality: 0.15 },
  quality: { cost: 0.15, velocity: 0.15, quality: 0.7 }
}

export const OBJECTIVE_PRESET_ORDER: ObjectivePreset[] = ['balanced', 'economy', 'velocity', 'quality']

export const OBJECTIVE_PRESET_LABELS: Record<ObjectivePreset, string> = {
  balanced: 'balanced (40% quality, 30% cost, 30% velocity)',
  economy: 'economy (70% cost, 15% velocity, 15% quality)',
  velocity: 'velocity (15% cost, 70% velocity, 15% quality)',
  quality: 'quality (15% cost, 15% velocity, 70% quality)'
}

export const DEFAULT_OBJECTIVE: Objective = PRESETS.balanced

/**
 * Scale a weight vector to sum to 1, so a caller may state weights in whatever units it likes.
 *
 * ⛔ **This is the one implementation**, and it lives here rather than in `policy.ts` only because
 * `parseObjective` below needs it and `policy.ts` imports *this* file — the other direction would
 * close a cycle. `policy.ts` re-exports it as `normalise`, which is the name every other process
 * calls it by; nothing outside this file should import it from here.
 *
 * ⚠️ An all-zero vector is not a valid objective, so it resolves to the balanced preset rather than
 * dividing by zero and publishing three `NaN` weights into the score arithmetic.
 */
export function normaliseObjective(objective: Partial<Objective>): Objective {
  const cost = Math.max(0, objective.cost ?? 0)
  const velocity = Math.max(0, objective.velocity ?? 0)
  const quality = Math.max(0, objective.quality ?? 0)
  const total = cost + velocity + quality
  if (total === 0) return DEFAULT_OBJECTIVE
  return { cost: cost / total, velocity: velocity / total, quality: quality / total }
}

/** A preset name, an explicit vector, or nothing. Presets are just named vectors. */
export function parseObjective(value: unknown): Objective | null {
  if (typeof value === 'string') {
    const preset = PRESETS[value.toLowerCase() as ObjectivePreset]
    return preset ? { ...preset } : null
  }
  if (value && typeof value === 'object') {
    const record = value as Partial<Objective>
    if ('cost' in record || 'velocity' in record || 'quality' in record) return normaliseObjective(record)
  }
  return null
}

/** Return the matching preset name if the objective matches a preset vector, or null if custom. */
export function presetOf(objective: Objective): ObjectivePreset | null {
  const eps = 0.005
  for (const [key, preset] of Object.entries(PRESETS) as Array<[ObjectivePreset, Objective]>) {
    if (
      Math.abs(objective.cost - preset.cost) < eps &&
      Math.abs(objective.velocity - preset.velocity) < eps &&
      Math.abs(objective.quality - preset.quality) < eps
    ) {
      return key
    }
  }
  return null
}

/**
 * What the cache clock decided to do with a session, and why.
 *
 * ⚠️ `revive_compact` is the one move that acts on a session with **no process**: it starts one, for
 * the sole purpose of compacting a conversation before its prompt cache lapses, and closes it again.
 * Every other move is a prompt sent to something already running.
 */
export type CacheMove =
  | 'dispatch'
  | 'keepalive'
  | 'compact'
  | 'revive_compact'
  | 'let_expire'
  | 'handoff_close'
  | 'none'

export interface ClockDecision {
  sessionId: string
  move: CacheMove
  reason: string
  contextTokens: number | null
  expectedIdleMs: number | null
  /** Input-token-equivalents this move is expected to cost. */
  estimatedCost: number | null
  expiresAt: number | null
}

/**
 * One compaction: asked for, or observed, and what it left behind.
 *
 * ⚠️ **Three nullable numbers, and each null means something different from zero.** `preTokens` is
 * null when the CLI did not say how big the context was; `postTokens` is null until a turn measures
 * the compacted context, and stays null forever if the session never runs another; `landedAt` is
 * null on a compaction that was **asked for and never happened** - the case worth seeing, and the
 * one a success-only ledger would hide.
 */
export interface Compaction {
  id: number
  sessionId: string
  taskId: string | null
  /** `clock` - this fleet bought it. `agent` - the agent asked. `auto` - the CLI did it unprompted. */
  trigger: 'clock' | 'agent' | 'auto'
  reason: string | null
  preTokens: number | null
  postTokens: number | null
  durationMs: number | null
  askedAt: number | null
  landedAt: number | null
  ts: number
}

export interface ReserveReport {
  workerId: string
  verdict: 'ok' | 'at_risk' | 'unknown'
  requiredTokens: number
  remainingTokens: number | null
  liveSessions: number
  reason: string
}

// ---------------------------------------------------------------------------- controller

/**
 * A judgment event.
 *
 * ⛔ **Every one of these has a deterministic fallback, and the fallback is what happens by default.**
 * The scheduler enqueues a consult and carries on; if the controller is out of quota, mis-configured,
 * slow or wrong, the fallback fires on a timer and the fleet keeps working. That is the whole reason
 * the controller can be an LLM at all: it is never in the critical path, only ever an improvement on
 * an answer that already exists.
 *
 *  - `decompose` — a coarse goal becomes draft children with dependency edges. Plan §18.1.
 *  - `triage`    — a task that has failed twice: retry, rewrite, escalate, or hand to a person.
 *  - `gate`      — an agent filed a task at a controller gate: accept, rescope, reject, escalate. §7.2.
 *  - `route`     — two workers score within ε on an expensive task. The weakest of the four, and
 *                  gated hardest, because a tie means the alternatives are by definition close.
 *  - `title`     — a task whose prompt is a paragraph gets a one-line label for the board. The only
 *                  kind that changes nothing about what runs: it writes `titleSummary`, which
 *                  nothing but the UI reads, so its fallback is to go on showing the prompt.
 */
export type ConsultKind = 'decompose' | 'triage' | 'gate' | 'route' | 'title'

export type ConsultStatus = 'pending' | 'answered' | 'fallback' | 'failed'

export interface Consult {
  id: string
  kind: ConsultKind
  /** The task this is about, where there is one. */
  subjectId: string | null
  subjectSeq?: number | null
  subjectTitle?: string | null
  status: ConsultStatus
  question: string
  /**
   * The working shown *only to a person*: the score legend and every candidate's term-by-term
   * derivation, in full.
   *
   * ⛔ **Generated exactly as before, and deliberately not in `question`.** The derivation is
   * debugging evidence - it answers "why did the arithmetic land there" for a human reading the
   * judgment call afterwards - and putting it in the prompt charged every routing consult for
   * fifteen lines of legend plus nine lines per candidate that the controller does not need to
   * pick an id. The prompt now carries the totals and one line of what was weighed; this carries
   * the rest, and nothing reads it but the UI.
   *
   * ⚠️ Null for kinds that have no arithmetic behind them (decompose, triage, gate).
   */
  detail: string | null
  workerId: string | null
  workerLabel?: string | null
  sessionId: string | null
  answer: unknown
  /** What was applied, in one line. Populated for answers and fallbacks alike. */
  outcome: string | null
  /** Why the deterministic answer was used: no controller, out of time, or a malformed reply. */
  fallbackReason: string | null
  /** Metered from the consult session's own transcript. A judgment call is not free. */
  spentTokens: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

/** Whether an agent-filed task is admitted, reviewed by the controller, or handed to a person. §7.2. */
export type RiskGate = 'auto' | 'controller' | 'human'

export interface ChatMessage {
  id: number
  threadId: string
  role: 'human' | 'controller' | 'system'
  text: string
  sessionId: string | null
  /** The controller worker that served this message, retained for an auditable conversation. */
  workerLabel?: string | null
  ts: number
}

// ---------------------------------------------------------------------------- landing

export type LandingStrategyId =
  | 'auto-land'
  | 'leave-branch'
  | 'pull-request'
  /** Run the project's checks against the branch as committed, and report. Moves nothing. */
  | 'verify-only'
  /** Rebase, check, fast-forward the **local** trunk, retire the branch. No remote. */
  | 'merge-local'
  /**
   * Rebase, check, and fast-forward a target **ref** that is checked out nowhere.
   *
   * ⛔ The strategy a split child lands with, and it exists because `merge-local` cannot do this.
   * `merge-local` runs `git merge --ff-only` inside the operator's own trunk checkout and is gated
   * on that checkout having the target *checked out* — correct, because git refuses to update a
   * branch a worktree holds. A child landing onto its plan branch would therefore require the
   * operator's checkout to be sitting on the plan branch, which is never acceptable: the trunk is
   * the operator's, and agents work in a pooled worktree.
   *
   * ⚠️ Chosen from **data** — whether the task's resolved landing target is the project's own — and
   * never from `task.kind`. A landing path that branches on a mode name is the thing this codebase
   * refuses everywhere else.
   */
  | 'merge-branch'
  /**
   * A trunk-mode task: its commits are already on the local target. Verify them in the trunk, and
   * push the target if the level pushes. No rebase, no branch. See `landTrunk`.
   */
  | 'trunk'

/**
 * What happens to a task's work when the agent says it is finished.
 *
 * ⛔ **One field, replacing three half-answers.** Until 2026-08-28 this question was split across
 * `landing.strategy` (project only), `task.verification` (task only, and named after a different
 * idea), and nothing at all at the fleet level — so "why did this not land?" needed two fields
 * checked in two files, and neither of them could be changed while a task was running.
 *
 * ⚠️ Not the same question as `mandate.allowed` ⊇ `'land'`, which stays exactly where it is. That is
 * **authority** — may this task ever land — and it is inherited down a lineage precisely so an
 * agent-spawned subtask cannot grant itself more than its parent had. This is **preference**: given
 * that it may, should it, unattended. A dropdown may set a preference; nothing settable in the UI
 * may widen an authority.
 */
export type FinishPolicy =
  /** Stop. The branch is intact, the work is preserved, a person decides. */
  | 'await-human'
  /**
   * The agent commits on its branch. Nothing is verified and nothing is merged.
   *
   * WARNSIGN For early work and single-trunk projects, where there is often no suite to run yet.
   */
  | 'commit-only'
  /**
   * Commit, then run the project's declared `check` commands and report the verdict.
   *
   * ⛔ The **commit is unconditional; the verdict is not**. The daemon never authors a commit,
   * so verification can only happen after there is something to verify - `commit-after-verified`
   * was considered and cannot exist. A red check rests the task carrying the output and the commit
   * stays, because destroying committed work is the one thing this tool refuses to do.
   */
  | 'commit-and-verify'
  /**
   * The above, and then fast-forward the **local** trunk and retire the branch. No remote.
   *
   * ⛔ Merging always verifies, which is why `verify` is not in the name: merging unverified
   * work into the trunk is worse than leaving it on a branch.
   *
   * WARNSIGN Only into a **clean** trunk. Git refuses to update a branch a worktree holds, and the
   * operator's own checkout is usually that worktree - so a dirty or busy trunk means the branch is
   * kept and the task says so. The tool never stashes or resets a checkout somebody is typing in.
   */
  | 'commit-and-merge'
  /**
   * The above, and push the trunk to its remote.
   *
   * WARNSIGN The pre-2026-08-30 default, under its old name `agent-lands`. It stopped being the
   * default because a push is not free: on this install every push to `main` started a ten-job CI
   * matrix, 103 runs in five days, and the account's CI allowance ran out on 2026-08-29.
   */
  | 'commit-and-push'
  /** Push the branch and open a pull request; a human merges. */
  | 'pull-request'
  /**
   * Do whatever this project says finishing means.
   *
   * ⚠️ An **instruction to the agent**, never a command the daemon runs. Deciding what to stage,
   * what to leave, and what to test first is judgement that differs per project and per person —
   * it is what a `/commit` skill encodes — and a daemon running it headless would be a worse copy
   * of that judgement applied with less context at the one moment nobody is watching.
   */
  | 'custom'
  /**
   * The deliverable is on the **thread**. Nothing is expected on the branch, so a clean branch with
   * no commits completes rather than being handed back to a person.
   *
   * ⛔ **Not a level, and it does strictly *less* than `await-human`** — hence its place at the end
   * of `FINISH_ORDER` beside `pull-request` and `custom` rather than anywhere in the ladder.
   * `decideFinish`'s empty-branch guard (t17) is correct and stays: a `work` task whose branch is
   * empty is indistinguishable from one whose agent committed in the trunk. This policy is the
   * operator saying, in advance, that this particular task was never going to write a commit.
   *
   * ⭐ **Wider than debate, which is only what motivated it.** Migration 51 added `non_gradable`
   * because *"some tasks complete valid work with no commits"* and the only answer was ticking a box
   * afterwards. A research task, a question, a review can now be filed as what it is.
   *
   * ⚠️ Anything uncommitted in the workspace is still carried onto the task's own branch by
   * `rescueDirt`, exactly as today. Nothing is discarded and nothing is swept into a commit.
   */
  | 'report-only'

/**
 * The same question at the project and task tiers, where "say nothing" is a real answer.
 *
 * ⛔ `inherit` is a distinct value, not a missing one. A task that has never been touched and a task
 * somebody deliberately set to the fleet default look identical without it, and the second is a
 * decision worth keeping when the default later changes.
 */
export type FinishPolicyChoice = FinishPolicy | 'inherit'

/** Where a resolved policy came from, so the UI can say "inherited from the project". */
export interface ResolvedFinishPolicy {
  policy: FinishPolicy
  source: 'task' | 'project' | 'fleet'
  /** Only for `custom`: what the agent is told to do. */
  instruction: string | null
}

/**
 * ⚠️ The instruction a `custom` policy sends when a project has not written its own. Deliberately
 * names a slash command: on Claude Code that resolves to the project's skill, and on an adapter
 * with no skills it still reads as a sentence an agent can act on.
 */
/**
 * ⚠️ The fleet default, and it lives here rather than in `finish.ts` because `settings.ts`
 * needs it and `finish.ts` needs `settings.ts` - a cycle that resolves to `undefined` at import time
 * and would have made the fleet tier silently empty.
 *
 * ⛔ **`commit-and-merge`, not `commit-and-push`, since 2026-08-30.** The old default pushed
 * the trunk on every completed task, and every push to `main` starts a ten-job CI matrix - three of
 * them macOS, which bills at 10x. Measured on this install: 103 runs in five days, 39 in one day, and
 * the account's CI allowance exhausted on 2026-08-29. Nothing about finishing a task needed a remote.
 * A push is now something a person does on purpose.
 */
export const DEFAULT_FLEET_FINISH: FinishPolicy = 'commit-and-merge'

/** The pre-2026-08-30 spelling of `commit-and-push`, still read off any config that has it. */
const LEGACY_FINISH: Record<string, FinishPolicy> = { 'agent-lands': 'commit-and-push' }

/**
 * Read a finish policy written by any version of this tool.
 *
 * ⛔ A rename that silently changed what an existing `project.json` *does* would be worse than
 * the bug it fixes. `agent-lands` meant "push the trunk" when it was written, and it still does.
 */
export function readFinishPolicy(raw: unknown): FinishPolicyChoice | null {
  if (typeof raw !== 'string') return null
  const migrated = LEGACY_FINISH[raw] ?? raw
  return (FINISH_ORDER as readonly string[]).includes(migrated) || migrated === 'inherit'
    ? (migrated as FinishPolicyChoice)
    : null
}

/**
 * The ladder, in order. Each level does everything the one below does plus one thing.
 *
 * ⚠️ `pull-request` and `custom` are deliberately last and are **not levels**: a PR pushes the
 * branch and never touches the trunk, and `custom` is an instruction to the agent rather than an
 * action the daemon takes.
 */
export const FINISH_ORDER: FinishPolicy[] = [
  'await-human',
  'commit-only',
  'commit-and-verify',
  'commit-and-merge',
  'commit-and-push',
  'pull-request',
  'custom',
  // ⚠️ Last, and deliberately not a level: it does strictly *less* than `await-human`. See the
  // union member's own note.
  'report-only'
]

export const FINISH_LABELS: Record<FinishPolicy, string> = {
  'await-human': 'await human',
  'commit-only': 'commit only',
  'commit-and-verify': 'commit, then verify',
  'commit-and-merge': 'commit, verify and merge into main',
  'commit-and-push': 'commit, verify, merge and push',
  'pull-request': 'open a pull request',
  'custom': 'this project’s own policy',
  'report-only': 'report on the thread; expect no commits'
}

/**
 * The same ladder, short enough to sit on a pill beside five other controls.
 *
 * ⛔ A second map of the same keys, so it is a second chance to drift — `tasks.test.ts` asserts it
 * covers `FINISH_ORDER` exactly and adds nothing to it, which is the only reason a short form is
 * allowed to exist at all. The **long** label is what the menu shows; this is what is left on the
 * button once the menu closes, and the two must name the same policy.
 */
export const FINISH_SHORT: Record<FinishPolicy, string> = {
  'await-human': 'Await human',
  'commit-only': 'Commit',
  'commit-and-verify': 'Commit·Verify',
  'commit-and-merge': 'Commit·Verify·Merge',
  'commit-and-push': 'Commit·Verify·Merge·Push',
  'pull-request': 'Pull request',
  'custom': 'Project policy',
  'report-only': 'Report only'
}

/**
 * Does this policy ask the daemon to run the project's checks?
 *
 * ⛔ `commit-only` deliberately does not. Each level does strictly more than the one below, and
 * the early-phase case it exists for usually has no suite to run.
 */
export function policyVerifies(policy: FinishPolicy): boolean {
  return policy === 'commit-and-verify' || policy === 'commit-and-merge' || policy === 'commit-and-push'
}

/**
 * Does the **tool** do something with the branch once the commit is in place?
 *
 * ⛔ The other half of `policyVerifies`, and the question the thread's Land button asks: `commit-only`
 * and `commit-and-verify` leave the branch exactly where the agent put it, so offering them as ways
 * to *land* a branch that is already committed would be offering to do nothing. ⚠️ `pull-request`
 * counts — the tool pushes the branch and opens the PR; a person merges it — and `custom` does not,
 * because its own last step is the landing and the tool must not add a second one.
 */
export function policyLands(policy: FinishPolicy): boolean {
  return policy === 'commit-and-merge' || policy === 'commit-and-push' || policy === 'pull-request'
}

/**
 * May this level be *offered* for work already sitting on the landing target?
 *
 * ⛔ A narrower question than `trunkPolicyConflict`, which answers what cannot *run*.
 * `commit-and-merge` runs fine on a trunk task — the daemon verifies in place — but its name
 * promises a merge that cannot happen, so offering it is offering a lie (t583). `pull-request`
 * needs a branch the trunk task does not have and is refused downstream. Everything else means
 * the same thing on the trunk as on a branch: committing commits, verifying verifies, pushing
 * pushes.
 */
export function policyOfferedInTrunk(policy: FinishPolicy): boolean {
  return policy !== 'commit-and-merge' && policy !== 'pull-request'
}

/**
 * A policy that promises verification, on a project that has declared none.
 *
 * ⛔ An empty `check` list must never read as a clean verification. Every project starts this
 * way, so without this warning `commit-and-merge` would merge unverified work and call it verified on
 * the first day of every project - and the policy's name would be a lie.
 */
export function verificationWarning(
  policy: FinishPolicy,
  checkCount: number
): string | null {
  if (!policyVerifies(policy) || checkCount > 0) return null
  return (
    `${FINISH_LABELS[policy]} verifies nothing here: this project declares no check commands. ` +
    'Add them in Project settings, or file a task to work them out.'
  )
}

/**
 * May a task be given a conversation another task has already been having?
 *
 * ⛔ The saving is real and measured - a cold Claude turn cost **41,542 cache-creation tokens** on
 * 2026-08-28 for a trivial prompt in an empty directory, and a resumed one read all of it back for 65
 * - but it is not free of consequence. An agent joining a conversation *sees everything said in it*,
 * so this is an information boundary, and the answer belongs to whoever owns the project rather than
 * to the scheduler.
 *
 * ⚠️ Authority is elsewhere and this cannot widen it. `mandate` still decides what a task may do;
 * turning sharing on lets a task read a conversation, never act beyond what it was granted.
 */
export type SessionSharing =
  /** Every task opens its own conversation. What the tool did before any of this existed. */
  | 'off'
  /** A task may join a conversation already open in its project, when the gates allow. */
  | 'on'

export type SessionSharingChoice = SessionSharing | 'inherit'

/** Where a resolved answer came from, so the UI can say "inherited from the project". */
export interface ResolvedSessionSharing {
  sharing: SessionSharing
  source: 'task' | 'project' | 'fleet'
}

/**
 * ⛔ **On** (changed from `off`, 2026-09-19, after a from-scratch install showed *Fresh* by default).
 * Reuse is the point of the product - a warm session is the cheap one - and the information boundary
 * it crosses is already narrow: same project, same account, same model and effort, clean, room to
 * grow. A project or a task can still say `off`, and a debate's seats always do.
 */
export const DEFAULT_FLEET_SHARING: SessionSharing = 'on'

export const SHARING_LABELS: Record<SessionSharing, string> = {
  on: 'reuse one if possible',
  off: 'always start a new one'
}

/** The pill form of the above. Same rule as `FINISH_SHORT`: pinned by a test, never hand-synced. */
export const SHARING_SHORT: Record<SessionSharing, string> = {
  on: 'Reuse',
  off: 'Fresh'
}

/**
 * May the cache clock spend a `/compact` on the conversation this task is holding?
 *
 * ⛔ **A preference, and never a capability.** Whether an agent *can* be asked to compact is
 * `capabilities.manualCompact`, declared by the adapter — Codex takes one prompt per session and
 * has no `/compact` at all, Antigravity does not implement one. This answers the second question
 * only, *should we*, and it is asked after the capability question has already said yes. A task set
 * to `on` against an adapter that cannot compact stays exactly as inert as the fleet switch is
 * there, which is the whole reason the two are separate values rather than one tri-state.
 *
 * ⚠️ **It changes the answer to "may I compact?" and nothing downstream of it.** Context size, growth
 * since the last compaction, the cache TTL, the reserve and the cost model all still decide *whether
 * this particular compaction buys anything* — so turning it on schedules a compaction on exactly the
 * terms the fleet switch would have, at exactly the moment the clock would have chosen. It is a
 * permission, not an instruction, and it is emphatically not a "compact now" button.
 */
export type AutoCompact =
  /** Compact when the clock works out that a compaction is worth its tokens. */
  | 'on'
  /** Never spend a compaction on this task's conversation, whatever the fleet is set to. */
  | 'off'

export type AutoCompactChoice = AutoCompact | 'inherit'

export interface ResolvedAutoCompact {
  autoCompact: AutoCompact
  /**
   * ⚠️ Travels with the answer for the same reason it does on sharing and completion: a value whose
   * origin is invisible is one nobody trusts. The picker says *inherit (compact when it is worth
   * it)* rather than showing a bare `inherit` the operator has to go and look up.
   */
  source: 'task' | 'fleet'
}

export const AUTO_COMPACT_LABELS: Record<AutoCompact, string> = {
  on: 'compact when it is worth it',
  off: 'never compact'
}

/**
 * Task, then fleet — the first that is not `inherit`.
 *
 * ⛔ **Two tiers, not the three that sharing, completion and objective use, and the omission is a
 * decision rather than an oversight.** Those three answer questions a *project* plausibly owns —
 * who may read whose conversation, how a repository is landed. This one is spending policy on one
 * account's window, which is a fleet-wide concern with per-task exceptions and has no natural
 * middle. Adding the tier later is an additive `session.autoCompact` key in project.json and one
 * more branch here; adding it now would be surface nobody asked for.
 *
 * ⚠️ `inherit` is a real value. A task left on it follows the Settings > Global switch as that
 * switch changes; a task set explicitly to the same value does not — which is precisely what an
 * operator wants when they pin one long-running task's behaviour and then go and change the fleet.
 */
export function resolveAutoCompact(
  task: Pick<Task, 'autoCompact'> | null | undefined,
  fleetAutoCompact: boolean
): ResolvedAutoCompact {
  if (task && task.autoCompact !== 'inherit') {
    return { autoCompact: task.autoCompact, source: 'task' }
  }
  return { autoCompact: fleetAutoCompact ? 'on' : 'off', source: 'fleet' }
}

/**
 * How far a dispatched agent is expected to get before it stops.
 *
 * ⛔ Two different things, and neither is "how careful should you be". `autonomous` says
 * *finish the whole task*, and an agent on it still stops for a decision that changes what it builds
 * - that is what `ask_human` is for, and it is never discouraged. `checkpointed` says *report at each
 * phase boundary and wait*, which is a different contract: the agent is being steered.
 */
export type CompletionMode = 'autonomous' | 'checkpointed'
export type CompletionModeChoice = CompletionMode | 'inherit'

export interface ResolvedCompletionMode {
  mode: CompletionMode
  source: 'task' | 'project' | 'fleet'
}

/**
 * ⛔ `autonomous`, because the premise of the tool is unattended progress across quota windows
 * that are hours long. A fleet defaulting to `checkpointed` would need a person present for every
 * task, which is the thing this exists not to require. Interactivity is chosen, per task, for the
 * work that is worth steering.
 */
export const DEFAULT_FLEET_COMPLETION: CompletionMode = 'autonomous'

export const COMPLETION_LABELS: Record<CompletionMode, string> = {
  autonomous: 'run to the end',
  checkpointed: 'check in at each phase'
}

export function projectCompletionChoice(
  project: Project | null | undefined
): CompletionModeChoice {
  const raw = project?.config?.session?.completion
  return raw === 'autonomous' || raw === 'checkpointed' || raw === 'inherit' ? raw : 'inherit'
}

/**
 * Where a task's agent works.
 *
 * - `worktree` — a pooled git worktree, on a branch named for the task, landed by the finish policy.
 * - `trunk` — the project's own checkout, on the landing target itself. No task branch, no pool
 *   claim: the task holds the project's single **trunk lease** instead, and its commits are on the
 *   local target the moment it makes them. This is the mode for work that *is* trunk work — pull and
 *   resolve a conflict, release bookkeeping — which a worktree could only reach by a detour that left
 *   a branch behind to clean up (t400, 2026-09-12).
 *
 * ⛔ **Data, not a name to branch on.** Everything that behaves differently asks
 * `resolveWorkspaceMode` once and acts on the answer; the answer is a fact about where the files are.
 */
export type WorkspaceMode = 'worktree' | 'trunk'
export type WorkspaceModeChoice = WorkspaceMode | 'inherit'

export const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: 'worktree (own branch)',
  trunk: 'trunk (project checkout)'
}

export interface ResolvedWorkspaceMode {
  mode: WorkspaceMode
  source: 'task' | 'project' | 'default'
}

export function projectWorkspaceModeChoice(project: Pick<Project, 'config'> | null | undefined): WorkspaceMode {
  return project?.config?.workspaces?.mode === 'trunk' ? 'trunk' : 'worktree'
}

/**
 * Whether this project keeps no worktree pool at all: every task takes the trunk lease.
 *
 * ⛔ **Git only, and only an explicit zero.** A non-git project's pool of one already *is* its own
 * directory, so there is nothing to remove; an absent `poolSize` is the default pool, not a choice.
 */
export function projectTrunkOnly(project: Pick<Project, 'config' | 'vcs'> | null | undefined): boolean {
  return !!project && project.vcs === 'git' && project.config?.workspaces?.poolSize === 0
}

/**
 * Task, then project, then `worktree`.
 *
 * ⚠️ Two tiers and a default, not three: where an agent may write is a fact about a repository and
 * the person working in it, and a fleet-wide "work in every trunk" has no sensible reading.
 * ⛔ A project that is not a git repository is always `worktree` — its pool of one already *is* its
 * own directory, and there is no branch for the distinction to be about.
 */
export function resolveWorkspaceMode(
  task: Pick<Task, 'workspaceMode'> | null | undefined,
  project: Pick<Project, 'config' | 'vcs'> | null | undefined
): ResolvedWorkspaceMode {
  if (!project || project.vcs !== 'git') return { mode: 'worktree', source: 'default' }
  if (task && task.workspaceMode && task.workspaceMode !== 'inherit') {
    return { mode: task.workspaceMode, source: 'task' }
  }
  if (project.config?.workspaces?.mode === 'trunk') return { mode: 'trunk', source: 'project' }
  return { mode: 'worktree', source: project.config?.workspaces?.mode ? 'project' : 'default' }
}

/**
 * Why this finish policy cannot run in the trunk, or null when it can.
 *
 * ⛔ `pull-request` needs a branch to push, and a trunk task has none — its commits are already on
 * the local target. Cutting one at the finish would leave local and remote `main` diverged until the
 * PR merged, so the combination is refused where it is chosen and held where it arrives anyway.
 */
export function trunkPolicyConflict(policy: FinishPolicy): string | null {
  return policy === 'pull-request'
    ? 'a pull request needs a branch, and a trunk task commits straight onto the landing target. ' +
        'Run it in a worktree, or pick a finish policy that does not open a pull request.'
    : null
}

/** The pre-2026-08-28 spelling, still read off any project.json that has not been rewritten. */
const FROM_STRATEGY: Record<string, FinishPolicy> = {
  'auto-land': 'commit-and-push',
  'leave-branch': 'await-human',
  'pull-request': 'pull-request'
}

/**
 * The project's finish choice, from either spelling.
 *
 * ⛔ `finish` wins over `strategy` when both are present. A file carrying both was written by
 * somebody who edited it after this landed, and the new field is the one they meant.
 */
export function projectFinishChoice(project: Project | null | undefined): FinishPolicyChoice {
  const landing = project?.config?.landing
  // ⛔ Through `readFinishPolicy`, so a file still saying `agent-lands` keeps doing what it
  // said when it was written - pushing the trunk - rather than silently acquiring the new default.
  if (landing?.finish) return readFinishPolicy(landing.finish) ?? 'inherit'
  if (landing?.strategy) return FROM_STRATEGY[landing.strategy] ?? 'inherit'
  return 'inherit'
}

export function projectSharingChoice(project: Project | null | undefined): SessionSharingChoice {
  const raw = project?.config?.session?.share
  return raw === 'on' || raw === 'off' || raw === 'inherit' ? raw : 'inherit'
}

export function finishInstructionFor(project: Project | null | undefined): string {
  return project?.config?.landing?.finishInstruction?.trim() || DEFAULT_FINISH_INSTRUCTION
}

/**
 * What is sitting in a task's workspace right now, as the thread's own buttons need it.
 *
 * ⛔ **A measurement, not a status.** It exists because Finish on a conversation is irreversible in
 * the way that matters — it releases the workspace, and the branch and the tree go back to the pool
 * — while the thing it would discard is invisible from every record the task keeps. So the answer
 * has to be read out of git at the moment somebody is about to press the button, and it has to be
 * able to say *I could not look* as a distinct answer from *there is nothing there*.
 *
 * ⛔ **And the distinction cuts both ways.** A branch that is not in `refs/heads` is *there is
 * nothing there* — nothing can be uncommitted on a branch that does not exist — and answering *I
 * could not look* for it put a warning under every conversation the moment it landed, about a tree
 * released precisely because it was empty (t369). See `branchExists` and `pendingWorkFor`.
 *
 * ⚠️ Counts rather than file lists. The card says "4 files"; it does not need their names, and
 * shipping a hundred paths through the RPC to render one number is the kind of surplus that ends up
 * being logged.
 */
export interface PendingWork {
  /** False when there is no git project or no workspace to look in; `reason` says which. */
  supported: boolean
  reason: string
  branch: string | null
  /**
   * The workspace was found by the branch it has checked out, not by a claim this task holds.
   *
   * ⛔ **A conversation outlives its claim.** When its session ends the workspace goes back to the
   * pool, but the worktree keeps the branch — and with it every uncommitted file. Looking only at
   * the claim answered *"this task is not holding a workspace"*, the card drew no Commit button, and
   * the hold reason went on telling the operator to press one (t280). ⚠️ It is still the honest
   * place to look: this is where the files are, and it is the tree the next run prefers.
   */
  unclaimed: boolean
  dirtyFiles: number
  untrackedFiles: number
  /** Commits on the branch the landing target does not have. Safe work — see `hasDiff`. */
  unlandedCommits: number
  /** Is there **uncommitted** work here? The one question the Commit button and the Finish warning ask. */
  hasDiff: boolean
}

/** One changed file in a task's diff. Counts always; contents only on request. */
export interface TaskDiffFileEntry {
  path: string
  added: number
  removed: number
  /** Counted as changed, never inlined — there is nothing here a person can read. */
  binary: boolean
  /** A lockfile or a build output: listed with its counts, never inlined. */
  generated: boolean
}

/**
 * What this task's branch would put on the trunk, as a file list.
 *
 * ⛔ **The committed change and the uncommitted tree are two different answers, and this carries
 * both because only one of them lands.** `files` is what pressing Land moves. `uncommittedFiles` is
 * what is sitting in the workspace *not* going anywhere — the thing the Finish warning already
 * exists for — and showing them merged would tell somebody a file was about to land when it was
 * about to be left behind.
 *
 * ⚠️ Shaped like `PendingWork` on purpose: `ok` plus a `reason`, with neutral values rather than a
 * union, because "I could not resolve a range" is a sentence the panel shows rather than an absence
 * it hides.
 */
export interface TaskDiffSummary {
  ok: boolean
  /** Why there is no diff to show. `''` when `ok`. */
  reason: string
  base: string | null
  head: string | null
  /** Which level of `resolveRange` answered — the vocabulary is `review.ts`'s, not a second one. */
  from: 'commits' | 'landed' | 'branch' | 'commit' | null
  /**
   * How many commits are being shown separately rather than as one range.
   *
   * ⚠️ `> 1` means this task landed more than once and other tasks' work fell between its commits.
   * The panel says so, for the same reason the grader's prompt does.
   */
  separateCommits: number
  files: TaskDiffFileEntry[]
  insertions: number
  deletions: number
  /** The file list hit its cap. There are more changed files than are listed. */
  filesTruncated: boolean
  /** Uncommitted and untracked files in the workspace. ⛔ These do **not** land. */
  uncommittedFiles: number
  /** Commits on the branch the landing target does not have. */
  unlandedCommits: number
  /** Could the workspace be read at all? `false` means the two counts above are unknown, not zero. */
  workspaceReadable: boolean
}

/** One file's patch text, capped. */
export interface TaskDiffFile {
  ok: boolean
  reason: string
  path: string
  /** ⛔ Untrusted text. Rendered as text nodes, never as markup. See `docs/ui.md`. */
  patch: string
  /** The patch was cut at a line boundary because it exceeded the cap. */
  truncated: boolean
  /** The full size before any cut, so the panel can say "showing X of Y". */
  bytes: number
}

/**
 * Work that exists and is going nowhere.
 *
 * ⛔ **Preserving work silently is only half a fix.** `rescueDirt` stashes what a run left behind so
 * the next task can claim the slot, and `leave-branch` keeps a branch intact when landing is
 * refused — both correct, and both invisible, which makes them indistinguishable from loss to the
 * person who wanted the work. t5's commit sat on its branch for a day; the stash that preserved
 * ws1's edits was found only because somebody went looking with `git stash list`.
 *
 * ⚠️ Derived on demand, never a table. A loose end is a *fact about a repository right now* — the
 * branch got landed by hand, the stash got popped, somebody cleaned the slot — and a cached copy of
 * that fact would be wrong within minutes and would need its own reconciliation. Only the
 * dismissals are stored, because "I know, leave me alone" is the one part git cannot tell us.
 */
export interface LooseEnd {
  /** Stable across scans, so a dismissal sticks to the thing dismissed. */
  id: string
  /**
   * ⚠️ `merged` is a branch whose recorded pull request GitHub reports merged and whose local head
   * is still the head it merged — a squash leaves its commits "ahead" forever, so without this kind
   * it read as `unlanded` and was offered a landing it had already had.
   */
  kind: 'uncommitted' | 'unlanded' | 'stash' | 'stranded' | 'merged'
  projectId: string
  projectName: string
  workspacePath: string
  branch: string | null
  /** Files for `uncommitted`, commits for `unlanded` and `merged`, entries for `stash`, 0 for `stranded`. */
  count: number
  /** The merged pull request, for `merged` only. */
  url?: string
  /** The task this branch belongs to, when the name still parses to one. */
  taskSeq: number | null
  summary: string
}

export const DEFAULT_FINISH_INSTRUCTION =
  'Run /commit and follow every step of it. Do not stop until the work is committed.'

export type DeliveryState = 'open' | 'merged' | 'closed_unmerged'

export interface PullRequestDelivery {
  id: string
  taskId: string
  projectId: string
  url: string
  target: string
  branch: string
  headSha: string
  state: DeliveryState
  mergeSha: string | null
  observedAt: number | null
  observationError: string | null
  reconciledAt: number | null
  /** Why the merged PR's local branch was last kept, or `null`. See migration 69. */
  retireBlocked: string | null
}

export interface LandingResult {
  strategy: LandingStrategyId
  ok: boolean
  commit?: string
  /**
   * The commit the landed work sits on top of — the other half of a reviewable range.
   *
   * ⛔ Captured *after* the rebase and beside `commit`, because that is the only moment both are
   * known. Without it a landed task's diff is unrecoverable the instant `retireBranch` runs, which
   * it does on every successful merge-local and auto-land. See `Task.landedBaseSha`.
   */
  base?: string
  branch?: string
  prUrl?: string
  /** Why it fell back or refused. Always populated when `ok` is false. */
  reason?: string
  checkOutput?: string
  /**
   * The branch carried no commits the target did not already have, so nothing was landed and nothing
   * needed to be.
   *
   * ⛔ `ok: true` with nothing done, and the distinction is load-bearing: a task that answers a
   * question is a success that touched no trunk, while a task that *meant* to change something and
   * committed nothing is a failure. Only the person who filed it can tell those apart, so the
   * message says plainly that the trunk was not touched rather than claiming a commit landed.
   */
  nothingToLand?: boolean
  /**
   * The id of the task this one had to queue behind, because landing is serialised per project.
   *
   * ⚠️ Set whether or not the wait paid off: with `ok: true` it means *landed, after waiting*, and
   * with `ok: false` it means the wait ran out. Present at all means two tasks finished close enough
   * together to contend, which is the thing worth saying out loud either way.
   */
  contendedWith?: string
  /**
   * The task branch was retired — its every commit is in the landing target, so the ref held a name
   * and nothing else.
   *
   * ⚠️ `false` is not a failure. Another worktree may still hold the branch, in which case it is left
   * alone and the finish is still a success; see `retireBranch`.
   */
  branchDeleted?: boolean
  /**
   * How many of the project's own check commands ran and passed before anything was moved.
   *
   * ⛔ **`0` and `undefined` are different verdicts and the message says so.** `0` is *this project
   * declares no checks*, which is a real answer and the first day of every project — it must never
   * read as a clean verification. `undefined` is *this strategy does not verify at all*, which is
   * true of `open-pr` on purpose: a pull request exists so that CI and a person do that.
   */
  checksPassed?: number
  /**
   * The thread line this landing would have written, handed back instead of posted.
   *
   * ⛔ **Only under `LandingContext.quiet`, and only so one landing writes one message.** A
   * conversation landing composes its own headline — it has a next branch to name that `landTask`
   * knows nothing about — and needs `landedMessage`'s clauses underneath it. Letting `landTask`
   * post its own as well would put two *"Landed as …"* lines on the thread for one landing, which
   * `salvageLandedCommits` would then read twice.
   */
  message?: { headline: string; detail: string }
  /**
   * How many commits this landing put on the target, counted from the target's own history.
   *
   * ⚠️ Filled in by `landTask` after `recordLandedCommits` has enumerated them, not by the strategy:
   * the strategy knows the tip it produced, and only a `git log` against the target knows how many
   * commits sit behind it.
   */
  commitsLanded?: number
  /**
   * The work reached a remote.
   *
   * ⚠️ `false` is *landed locally and deliberately not pushed*, which is what `merge-local` does and
   * what an operator needs told — the trunk in front of them has the commit and `origin` does not.
   * `undefined` is a strategy for which the question does not arise.
   */
  pushed?: boolean
  /**
   * The refusal was the trunk being **occupied** — a trunk task holds it, or files are uncommitted in
   * it, or it is off its target — rather than anything wrong with the branch.
   *
   * ⛔ The one refusal that is a hold, not a hand-off: the task goes to `landing_queued` and the tick
   * lands it once the trunk is free. Every other `ok: false` still rests at `awaiting_human`.
   */
  trunkBusy?: boolean
}

/** Where a resolved model or effort came from, so the UI can say rather than just show. */
export type ModelSource = 'task' | 'worker' | 'cli'

export interface ResolvedModelChoice {
  /** `null` means "let the CLI pick", which is a real answer and not a missing one. */
  model: string | null
  modelSource: ModelSource
  effort: string | null
  effortSource: ModelSource
}

/**
 * The share of a five-hour window past which this fleet stops starting new work on an account.
 *
 * ⛔ **One number, three readers, and until 2026-08-31 three copies of it.** The routing gate
 * (`chooseTarget`), the pool balance below, and — since t73 — the compaction reserve all turn on
 * exactly this percentage, and a fleet where the gate that stops dispatching and the gate that
 * saves the context disagree by a point is a fleet that strands a session for a rounding error.
 *
 * ⚠️ Lower than the mid-run preemption water (95%), deliberately: refusing *new* work is cheap and
 * reversible, stopping work already in flight is neither.
 */
export const WINDOW_HIGH_WATER = 92

/**
 * The share of a 7-day (weekly) window past which this fleet stops starting new work
 * or reserves compaction on an account.
 *
 * ⚠️ 7d usage has significantly more runway left than 5h windows (3% remaining is many hours
 * of active work), so compaction and dispatch gates turn around 97-98%, not at 92-93%.
 */
export const WINDOW_7D_HIGH_WATER = 97

export function isWeeklyWindow(window: { id?: string | null; label?: string | null }): boolean {
  const id = (window.id ?? '').toLowerCase()
  const label = (window.label ?? '').toLowerCase()
  return id.includes('weekly') || id.includes('7d') || label.includes('weekly') || label.includes('7d')
}

export function windowHighWater(window?: { id?: string | null; label?: string | null } | null): number {
  if (window && isWeeklyWindow(window)) {
    return WINDOW_7D_HIGH_WATER
  }
  return WINDOW_HIGH_WATER
}

/**
 * The percentage at which the provider has nothing left to sell on this window.
 *
 * ⛔ **Not a water mark and not tunable.** `WINDOW_HIGH_WATER` and `WINDOW_7D_HIGH_WATER` are this
 * fleet's own caution — arithmetic of ours over a reading the vendor has been serving turns against,
 * which is exactly why a person is allowed to overrule them. This is the vendor's own answer, and
 * there is nothing on the other side of it to overrule: a turn started here is refused, and the only
 * thing it buys is a spawned process, a cold start and a `paused_quota` five seconds later.
 */
export const WINDOW_EXHAUSTED = 100

/** Has this window been spent outright? See `WINDOW_EXHAUSTED`. */
export function windowExhausted(window: { percent: number }): boolean {
  return window.percent >= WINDOW_EXHAUSTED
}

/**
 * A window that has already turned over, and therefore counts nothing.
 *
 * ⛔ **`stale` is an age test and this is not.** A reading taken two minutes before a reset is as
 * fresh as a reading gets, and every number in it stops being true the moment the window rolls. The
 * dispatch gate believed one for the better part of two hours: measured on t60, 2026-08-31,
 * ClaudeThird's 5h window read `percent: 88` with `resetsAt` 06:39:59Z and was still offered as 88%
 * at 06:46Z, on an account whose window had emptied.
 *
 * ⚠️ Expired means **unknown**, never zero. What the new window holds cannot be derived from the old
 * one, and a caller that reads this as free capacity is making up a number.
 *
 * ⭐ `windowResetsAt` has always discarded a reset in the past for exactly this reason; this is that
 * rule applied to the percentage sitting beside it.
 *
 * ⚠️ Lives here rather than in the daemon's `quota.ts` — which re-exports it — because `poolVerdict`
 * below is the shared answer to *does this reading refuse this pool*, and an expiry test that lived
 * on the other side of that boundary would be a second copy of this rule waiting to disagree.
 */
export function windowExpired(window: QuotaWindow, now = Date.now()): boolean {
  return window.resetsAt !== null && window.resetsAt !== undefined && window.resetsAt <= now
}

/** The window furthest past its gate, and how far past it is. */
export interface BlockingWindow {
  window: QuotaWindow
  /** The percentage this window is gated at — `windowHighWater`, which differs for a weekly. */
  threshold: number
  /** How far past the gate, so the *worst* window in a pool is the one named. */
  deficit: number
  /** Spent outright, which no override lifts. See `WINDOW_EXHAUSTED`. */
  exhausted: boolean
}

/** What one pool's windows say about starting new work on it. */
export interface PoolVerdict {
  /**
   * The windows whose numbers still describe something that exists — everything unexpired.
   *
   * ⚠️ Nothing here is a claim about *freshness*: an old reading of an unreset window is still in
   * this list, because it can still refuse. A caller that means to *score* headroom rather than
   * refuse a dispatch has to ask its own staleness question. See `chooseTarget`'s `trustedWindows`.
   */
  active: QuotaWindow[]
  /** At least one window here has reset since it was read, so what it holds now is unknown. */
  turnedOver: boolean
  /** The window that refuses this pool, or `null` when none does. */
  blocking: BlockingWindow | null
}

/**
 * Does this pool's reading refuse new work, and on which window?
 *
 * ⛔ **One place, because the answer was written out three times and the copies drifted.** The
 * dispatch gate, the override note and the compaction reserve all ask this and all have to agree —
 * a fleet where the gate that stops dispatching and the gate that saves the context disagree by a
 * point strands a session for a rounding error.
 */
export function poolVerdict(windows: QuotaWindow[], now = Date.now()): PoolVerdict {
  const active: QuotaWindow[] = []
  let turnedOver = false
  let blocking: BlockingWindow | null = null
  for (const window of windows) {
    if (!window) continue
    if (windowExpired(window, now)) {
      turnedOver = true
      continue
    }
    active.push(window)
    const threshold = windowHighWater(window)
    if (window.percent < threshold) continue
    const deficit = window.percent - threshold
    // ⚠️ Worst by deficit, and an exhausted window wins outright however small its deficit is: the
    // weekly gate sits at 97, so a 7d at 100% is 3 past its mark while a 5h at 96 is 4 past its own,
    // and naming the second would report a refusal a person could lift over one they cannot.
    const better =
      !blocking ||
      (windowExhausted(window) && !blocking.exhausted) ||
      (windowExhausted(window) === blocking.exhausted && deficit > blocking.deficit)
    if (better) blocking = { window, threshold, deficit, exhausted: windowExhausted(window) }
  }
  return { active, turnedOver, blocking }
}

/**
 * Beyond this, a reading is reported but must not be treated as the current state of the window.
 *
 * ⛔ **Shared, because the renderer has to answer the same question the daemon does.** The daemon
 * stamps `ageMs` and `stale` onto a reading when it *sends* it, and a card that reads those fields
 * off the payload is frozen at the moment it arrived — a reading that was two minutes old when the
 * event fired still says "read 2m ago" an hour later, and a reading that was fresh never goes stale
 * on screen at all. `quotaFreshness` recomputes both against a ticking clock; keeping the threshold
 * here is what stops the two answers drifting apart. `STALE_AFTER_MS` in the daemon is this.
 */
export const QUOTA_STALE_AFTER_MS = 15 * 60 * 1000

/**
 * How old this reading is *now*, and whether anything may still be believed about it.
 *
 * ⚠️ **`stale` can only ever be added to, never cleared.** The flag that arrives on the reading
 * carries more than age: `lastQuotaReading` sets it when the newest attempt *failed* and these are
 * the last numbers that worked, which is a different reason to distrust them and one no clock can
 * rediscover. So this ORs with what came in rather than replacing it.
 */
export function quotaFreshness(
  quota: { sampledAt: number; windows: unknown[]; stale?: boolean } | null,
  now: number
): { ageMs: number; stale: boolean } {
  if (!quota) return { ageMs: 0, stale: true }
  const ageMs = Math.max(0, now - quota.sampledAt)
  return {
    ageMs,
    stale: (quota.stale ?? false) || quota.windows.length === 0 || ageMs > QUOTA_STALE_AFTER_MS
  }
}

/**
 * Does this account have an expired or disabled subscription?
 *
 * ⛔ Distinct from a general re-auth requirement or setup failure: re-authenticating or running
 * first-run setup cannot fix a subscription that has expired.
 */
export function isWorkerSubscriptionExpired(worker: Worker): boolean {
  if (worker.identity?.subscriptionExpired === true) return true
  if (worker.health?.subscriptionExpired === true) return true
  if (worker.identity?.subscriptionType === 'expired') return true
  const reason = (worker.health?.reason ?? '').toLowerCase()
  if (
    reason.includes('disabled claude subscription access') ||
    reason.includes('subscription has expired') ||
    reason.includes('subscription expired') ||
    reason.includes('subscription access for claude code')
  ) {
    return true
  }
  return false
}

/**
 * The five-hour window that governs *this* model pool, on a provider that meters more than one pool.
 *
 * ⛔ **The pessimistic fallback is still the default, and has to be.** With no model in hand — the
 * reset countdown, the reserve's sample query — the only safe reading is the busiest pool, which the
 * Antigravity adapter aliases to the bare id `5h` for exactly that reason.
 */
export function sessionWindowFor(
  windows: QuotaWindow[],
  pool: string | null
): QuotaWindow | undefined {
  const fallback = windows.find((w) => w.id === 'session' || w.id === '5h')
  if (!pool) return fallback

  const mine = windows.find(
    (w) => (w.id.startsWith('5h') || w.id === 'session') && (w.group?.includes(pool) ?? false)
  )
  return mine ?? fallback
}

/**
 * All quota windows that apply to a given pool (e.g. 5h and 7d for 'gemini' or 'claude').
 *
 * For a multi-pool provider (e.g. Antigravity), windows have `group` (e.g. 'gemini', 'claude-and-gpt').
 * For single-pool providers (e.g. Claude Code), windows have no `group` and apply to all pools.
 */
export function windowsForPool(
  windows: QuotaWindow[],
  pool: string | null
): QuotaWindow[] {
  if (!pool) {
    const ungrouped = windows.filter((w) => !w.group)
    return ungrouped.length > 0 ? ungrouped : windows
  }
  const matched = windows.filter((w) => w.group?.includes(pool))
  if (matched.length > 0) return matched
  const ungrouped = windows.filter((w) => !w.group)
  return ungrouped.length > 0 ? ungrouped : windows
}

/**
 * Task, then worker (with budget-aware balance across pools when configured), then whatever the CLI does on its own.
 *
 * ⛔ **Two tiers, not the three that finish policy uses.** A model id belongs to one CLI - `opus`
 * means nothing to Antigravity and `gemini-3.1-pro-high` means nothing to Claude Code - so a default
 * held at the project or the fleet would be invalid for every task that routed to a different
 * adapter, which is most of them on a mixed fleet. The worker is the narrowest tier that always
 * knows which CLI it is, and so the only one where the value is always meaningful.
 *
 * ⚠️ **`null` is an answer.** It means the CLI chooses, which is what every install did before there
 * was a control and what a worker keeps doing until somebody sets one. It is not "unset, fall
 * through" - there is nothing further to fall through to.
 *
 * ⛔ **Effort is dropped whole where the adapter cannot be told one.** Not defaulted, not passed and
 * ignored: `selectableEffort` is false on Antigravity because agy *refuses* the flag for every model
 * this fleet dispatches (measured 2026-08-29), so sending it would fail the dispatch outright rather
 * than being politely ignored.
 *
 * ⚠️ Effort resolves independently of model. A task that pins only the model still inherits the
 * worker's effort, because the two are separate choices the CLI takes as separate flags.
 */
export function resolveModelChoice(
  constraints:
    | (Pick<TaskConstraints, 'model' | 'effort'> & {
        modelsByWorker?: Record<string, string>
        effortsByWorker?: Record<string, string>
      })
    | null
    | undefined,
  // ⚠️ Structural, not `Pick<Worker, …>`: `Worker` is not imported here and TypeScript resolved the
  // name to the DOM's own `Worker` global without complaining, which typechecked into nonsense.
  worker:
    | {
        id?: string
        defaultModel: string | null
        defaultEffort: string | null
        defaultModels?: Record<string, string | null> | null
        modelEfforts?: Record<string, string | null> | null
      }
    | null
    | undefined,
  selectableEffort: boolean,
  quota?: QuotaSnapshot | null
): ResolvedModelChoice {
  const workerSpecificModel =
    worker && 'id' in worker && worker.id && constraints?.modelsByWorker
      ? constraints.modelsByWorker[worker.id]
      : undefined
  const model = workerSpecificModel || constraints?.model || null
  let workerModel: string | null = null

  if (worker?.defaultModels && Object.keys(worker.defaultModels).length > 0) {
    const poolEntries = Object.entries(worker.defaultModels).filter(
      (entry): entry is [string, string] => entry[1] != null && entry[1].trim() !== ''
    )
    if (poolEntries.length === 1) {
      workerModel = poolEntries[0]![1]
    } else if (poolEntries.length > 1) {
      if (quota && quota.windows && quota.windows.length > 0) {
        // Budget-aware pool balance: evaluate windows for each pool.
        // Pools below WINDOW_HIGH_WATER are candidates; choose the one with lowest utilization (most headroom).
        let bestCandidate: { pool: string; model: string; percent: number; blocked: boolean } | null = null
        for (const [pool, m] of poolEntries) {
          const wins = windowsForPool(quota.windows, pool)
          const worstWin = wins.reduce<QuotaWindow | null>((worst, w) => {
            return !worst || w.percent > worst.percent ? w : worst
          }, null)
          const percent = worstWin ? worstWin.percent : 0
          const blocked = worstWin ? worstWin.percent >= windowHighWater(worstWin) : false
          if (!bestCandidate) {
            bestCandidate = { pool, model: m, percent, blocked }
          } else if (bestCandidate.blocked && !blocked) {
            bestCandidate = { pool, model: m, percent, blocked }
          } else if (bestCandidate.blocked === blocked && percent < bestCandidate.percent) {
            bestCandidate = { pool, model: m, percent, blocked }
          }
        }
        workerModel = bestCandidate?.model ?? poolEntries[0]![1]
      } else {
        // No quota reading available: fallback to worker.defaultModel if set, otherwise first pool default
        workerModel = worker.defaultModel ?? poolEntries[0]![1]
      }
    }
  }

  if (!workerModel) {
    workerModel = worker?.defaultModel ?? null
  }

  const resolvedModel = model ?? workerModel
  const modelSource: ModelSource = model ? 'task' : workerModel ? 'worker' : 'cli'

  if (!selectableEffort) {
    return { model: resolvedModel, modelSource, effort: null, effortSource: 'cli' }
  }

  const workerSpecificEffort =
    worker && 'id' in worker && worker.id && constraints?.effortsByWorker
      ? constraints.effortsByWorker[worker.id]
      : undefined
  const effort = workerSpecificEffort || constraints?.effort || null
  const workerEffort =
    (resolvedModel && worker?.modelEfforts?.[resolvedModel]) ??
    worker?.defaultEffort ??
    null
  return {
    model: resolvedModel,
    modelSource,
    effort: effort ?? workerEffort,
    effortSource: effort ? 'task' : workerEffort ? 'worker' : 'cli'
  }
}

// ---------------------------------------------------------------------------- flow

/**
 * One workspace of a project's pool, with the ticket and the account currently bound to it.
 *
 * ⛔ **The binding is read off the claim, never guessed from a session's `cwd`.** A workspace claim
 * is the only record of *which ticket owns which tree*: it is taken before the run starts, it is
 * passed from the task to its session and back again between runs, and it survives a session that
 * has closed with the operator still deciding. Matching live sessions to worktree paths answers a
 * different and weaker question — *who has a process open there* — which is silent for exactly the
 * cases an operator most needs named: a task holding ws2 between runs, and a landing attempt.
 *
 * ⚠️ Resolved in the daemon because no single renderer input can answer it. The claim's `holder` is
 * a task id, a session id or `reland:<taskId>` — three shapes whose resolution needs the runs table
 * that `task.list` does not ship.
 */
export interface FlowWorkspace {
  /** The worktree path. `ws1`-style short name is `label`. */
  path: string
  label: string
  /**
   * `trunk` for the project's own checkout, drawn first and labelled with its landing target; every
   * pool member is `worktree`. ⚠️ The trunk row exists for every git project, trunk tasks or not:
   * whether it is free is what decides whether a worktree landing can merge.
   */
  kind: WorkspaceMode
  /** On the trunk row only: the project's default mode, so the board can place an `inherit` task. */
  defaultMode?: WorkspaceMode
  /**
   * Whether this member is still in the configured pool.
   *
   * ⚠️ False for a claim that outlived a narrowing of `poolSize` — those stay valid until the run
   * ends, so the board keeps drawing them rather than dropping a task that is plainly running.
   */
  inPool: boolean
  /** What is holding the claim, or null when the workspace is free. */
  holding: 'session' | 'task' | 'landing' | 'releasing' | null
  taskId: string | null
  taskSeq: number | null
  /** `titleSummary ?? title`, so the board never renders a paragraph. */
  taskTitle: string | null
  taskStatus: TaskStatus | null
  workerId: string | null
  workerLabel: string | null
  /** The adapter behind `workerLabel`, for the brand icon beside it. */
  adapterId: string | null
  sessionId: string | null
  /** What the tree is checked out to, from the live session when one has reported it. */
  branch: string | null
  claimedAt: number | null
}

// ---------------------------------------------------------------------------- landing failures

/**
 * Why a landing stopped, read off the hold reason — one classifier for the card and the daemon.
 *
 * ⛔ **One rule in one place, because two copies drifted and the drift cost three billed runs.**
 * The thread's *Resolve & retry* card matched `/conflict/` for a conflict while the daemon behind
 * the button matched `/conflict|rebase/` — and the hold reason a red check writes is *"the project
 * checks failed after rebase"*. So the card correctly said *Project checks failed* and the daemon
 * sent the agent the **rebase** instruction, which was a no-op every time (t344 and t347,
 * 2026-09-11: three retries each, the same test red on every landing, and the failing test's name
 * was never in what the agent was told). Both sides now read this list, in this order.
 *
 * ⚠️ *Uncommitted* deliberately excludes every trunk-checkout blocker: that is the operator's
 * own working tree in the way, not the agent's work, and an agent sent to commit on the task branch
 * would be fixing something that is not broken. ⛔ The exclusion must be `isTrunkBlockedReason` and
 * not a phrase from one of those sentences — it was `/the trunk has uncommitted/` alone, which
 * `trunkNotReady` has not written since it began naming the files: it writes *"the trunk has 16
 * uncommitted file(s) in it … Commit, stash, or clear them"*, whose own remedy word **stash** then
 * matched the positive branch. Measured on t614 (2026-09-22): its stored hold reason classified as
 * `uncommitted`, which both offered a billed *Resolve & retry* that would have sent an agent to
 * commit nothing and hid the *Retry landing* button that was the one thing that could have worked.
 */
export type ResolveRetryCause = 'conflicted' | 'checksFailed' | 'uncommitted' | 'trunkMoved'

/**
 * Whether a hold reason says the **trunk checkout** is what is in the way.
 *
 * ⛔ Every sentence `trunkNotReady` and `trunkOccupiedBy` can produce, plus the wrappers the landing
 * preflight and `retryQueuedLandings` put around them. Nothing here is the task's own workspace: a
 * reason matching this is cleared in the operator's checkout or by another task finishing, never by
 * sending this task's branch back to an agent.
 */
export function isTrunkBlockedReason(reason: string | null | undefined): boolean {
  return /the trunk is not ready to receive this|the trunk has \d+ uncommitted file|the trunk has uncommitted|is working in the trunk|checked out rather than|the trunk is on a detached HEAD|the trunk could not be read/i.test(
    reason ?? ''
  )
}

export function resolveRetryCauses(task: { holdReason: string | null }): ResolveRetryCause[] {
  const reason = task.holdReason ?? ''
  const out: ResolveRetryCause[] = []
  if (/conflict/i.test(reason)) out.push('conflicted')
  if (/checks? failed|verification failed/i.test(reason)) out.push('checksFailed')
  if (
    !isTrunkBlockedReason(reason) &&
    /workspace has uncommitted|file\(s\) are uncommitted|changes on .* are uncommitted|cannot be asked after its turn ends|rescue|stash/i.test(
      reason
    )
  ) {
    out.push('uncommitted')
  }
  if (/trunk moved.*branch is empty/i.test(reason)) out.push('trunkMoved')
  return out
}
