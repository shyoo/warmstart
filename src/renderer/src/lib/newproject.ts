import type {
  CompletionModeChoice,
  FinishPolicyChoice,
  ProjectCloneResult,
  ProjectDocName,
  ProjectInspection,
  ScaffoldingGitChoice,
  SessionSharingChoice
} from '@shared/tasks'
import { cloneDirectoryName } from '@shared/github'

/**
 * The add-project wizard's rules, as a pure function.
 *
 * ⭐ Extracted for the reason `lib/` exists: the UI suite drives a real window but its worker has no
 * credentials and its assertions read rendered text, so *why a button is disabled* is provable here
 * at L1 and only observable there. Every blocker below is a sentence the operator is shown — a
 * disabled Next with no reason beside it is the failure this module exists to prevent.
 *
 * ⛔ Nothing here touches a disk or an RPC. It decides using `ProjectInspection`, which is the
 * daemon's answer about the directory; the renderer cannot see a filesystem and must not pretend to.
 */

/** The three steps, in order. ⚠️ Named rather than numbered so a blocker can say which one it is on. */
export type NewProjectStep = 'directory' | 'setup' | 'review'

export const NEW_PROJECT_STEPS: NewProjectStep[] = ['directory', 'setup', 'review']

export const STEP_TITLES: Record<NewProjectStep, string> = {
  directory: 'Project directory',
  setup: 'Workspace, policy and verification',
  review: 'Starter files and review'
}

/** A doc the wizard is offering to write, and whether the operator still wants it. */
export interface DocDraftState {
  name: ProjectDocName
  include: boolean
  content: string
  /**
   * ⛔ Has the operator typed in it? A template is regenerated when the name, the branch or the check
   * list it quotes changes — going Back and editing the policy has to leave the starter files
   * agreeing with it — but regenerating over text somebody wrote would silently discard their work.
   * Once this is true the content is theirs and nothing rewrites it.
   */
  edited: boolean
}

/**
 * What the templates were generated from. ⚠️ A signature rather than a timestamp: the question is
 * *are these still the right files*, and the answer depends on these three values and nothing else.
 */
export function docSignature(
  draft: Pick<NewProjectDraft, 'name' | 'landingTarget' | 'checksText'>
): string {
  return [draft.name.trim(), draft.landingTarget.trim(), checksFromText(draft.checksText).join('\n')].join('\u0000')
}

/**
 * Where the project comes from: a directory already on this computer, or a clone made here (t897).
 * ⚠️ A clone is still a directory by the time the wizard leaves step one — `root` is where it went.
 */
export type ProjectSource = 'folder' | 'clone'

export interface NewProjectDraft {
  source: ProjectSource
  /** What to clone: `owner/repo`, a GitHub URL, or any `git clone` source. */
  cloneSource: string
  /** Fork it on GitHub and make the fork home — `origin` — with the original as `upstream`. */
  fork: boolean
  /** Where the clone landed, once it has. ⛔ Set only by a clone that happened. */
  clonedRoot: string | null
  /**
   * The remote a pull request pushes to, blank for origin. See `ProjectConfig.landing.pushRemote`.
   */
  pushRemote: string
  /**
   * The remote naming the repository a fork was made from, blank when nothing was forked. See
   * `ProjectConfig.landing.upstreamRemote`. ⛔ Set only by a fork that happened.
   */
  upstreamRemote: string
  root: string
  name: string
  createDirectory: boolean
  gitInit: boolean
  /** Only one location is used for this project. */
  workspaceLocation: 'managed' | 'custom'
  /** Required when workspaceLocation is custom. */
  workspaceRoot: string
  finish: FinishPolicyChoice
  landingTarget: string
  sessionShare: SessionSharingChoice
  completion: CompletionModeChoice
  poolSize: number
  /** One command per line, exactly as `ChecksPanel` treats it. */
  checksText: string
  docs: DocDraftState[]
  /**
   * What `.warmstart/project.json` becomes in git. ⚠️ Asked, never assumed — committing to
   * somebody's repository unasked is what made the trunk dirty-looking work Warmstart's own
   * doing, and silently gitignoring would be the same surprise in the other direction.
   */
  scaffoldingGit: ScaffoldingGitChoice
}

export const EMPTY_DRAFT: NewProjectDraft = {
  source: 'folder',
  cloneSource: '',
  fork: false,
  clonedRoot: null,
  pushRemote: '',
  upstreamRemote: '',
  root: '',
  name: '',
  createDirectory: false,
  gitInit: false,
  workspaceRoot: '',
  workspaceLocation: 'managed',
  finish: 'inherit',
  landingTarget: 'main',
  sessionShare: 'inherit',
  completion: 'inherit',
  poolSize: 3,
  checksText: '',
  docs: [],
  // ⚠️ `commit`: the documented default — committed policy is what every clone pulls. The review
  // step always shows the choice, so a click-through keeps the old answer knowingly, not silently.
  scaffoldingGit: 'commit'
}

/** One command per line, trimmed, blanks dropped. ⚠️ The same reading `setProjectChecks` does. */
export function checksFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Where a clone of `source` would go under `parent`, in `parent`'s own separator — or null.
 *
 * ⚠️ The separator is read off the parent rather than off this computer, because on a remote fleet
 * the path is the other machine's.
 */
export function cloneDestination(parent: string | null, source: string): string | null {
  const name = cloneDirectoryName(source)
  if (!parent || !name) return null
  const sep = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${sep}${name}`
}

/**
 * What a finished clone decides about the rest of the wizard.
 *
 * ⛔ **A repository you cloned is somebody else's until shown otherwise**, so the config is kept to
 * this checkout (`local`) whether or not it was forked: the trunk tracks their repository, and a
 * commit of Warmstart's scaffolding onto it would ride along in every pull request.
 *
 * ⛔ **A fork is home, and lands like a repository the operator owns** (t903). The finish moves to
 * `commit-and-push` — merged and pushed to the fork — and never to `pull-request`: t902's wizard set
 * that, and the first finished task opened a pull request on the original with nobody asked. The
 * original is reached only by **Propose upstream…**, on a click. Without a fork the finish is left
 * as it was, and the landing refuses to push to or open a PR on a repository that is not yours.
 */
export function applyClone(draft: NewProjectDraft, result: ProjectCloneResult): Partial<NewProjectDraft> {
  return {
    root: result.root,
    clonedRoot: result.root,
    landingTarget: result.defaultBranch ?? draft.landingTarget,
    pushRemote: '',
    upstreamRemote: result.upstreamRemote ?? '',
    scaffoldingGit: 'local',
    ...(result.upstreamRemote ? { finish: 'commit-and-push' as const } : {})
  }
}

/**
 * Will this project have a repository once the wizard is done?
 *
 * ⚠️ Not the same question as `inspection.vcs`, because the operator may have ticked *initialise a
 * repository* — and the answer changes what the pool size control even means. A project with no repo
 * gets exactly one workspace, which `policyFor` enforces regardless of what the file says.
 */
export function willHaveRepo(
  inspection: ProjectInspection | null,
  draft: Pick<NewProjectDraft, 'gitInit'>
): boolean {
  if (inspection?.vcs === 'git') return true
  return draft.gitInit
}

/**
 * Why the wizard cannot leave this step. Empty means it can.
 *
 * ⛔ Every entry is shown to the operator verbatim. A blocker that cannot be phrased as an
 * actionable sentence is a bug in the check, not a reason to return a bare boolean.
 */
export function stepBlockers(
  step: NewProjectStep,
  draft: NewProjectDraft,
  inspection: ProjectInspection | null
): string[] {
  const blockers: string[] = []

  if (step === 'directory') {
    if (draft.source === 'clone' && !draft.clonedRoot) {
      if (!draft.cloneSource.trim()) return ['Name the repository to clone.']
      if (!draft.root.trim()) return ['Choose where the clone goes.']
      return ['Clone the repository to go on.']
    }
    if (!draft.root.trim()) return ['Choose the directory this project lives in.']
    if (!inspection) return ['Checking that directory…']
    if (inspection.alreadyAdded) {
      blockers.push(`This directory is already the project “${inspection.alreadyAdded.name}”.`)
    }
    if (!inspection.exists && !draft.createDirectory) {
      blockers.push('That directory does not exist. Tick “Create it” or choose another.')
    }
    if (inspection.exists && !inspection.isDirectory) {
      blockers.push('That path is a file, not a directory.')
    }
    if (!draft.name.trim()) blockers.push('Give the project a name.')
    return blockers
  }

  if (step === 'setup') {
    if (draft.workspaceLocation === 'custom' && !draft.workspaceRoot.trim() && !inspection?.hasConfig) {
      blockers.push('Choose a custom workspace directory.')
    }
    if (inspection && !inspection.workspace.usable) {
      blockers.push(inspection.workspace.note ?? 'That workspace directory cannot be used.')
    }
    if (!draft.landingTarget.trim()) {
      blockers.push('Name the branch this project’s work lands on.')
    }
    // ⚠️ Zero is trunk-only — no pool at all — and is a real choice, not a missing value.
    if (!Number.isInteger(draft.poolSize) || draft.poolSize < 0 || draft.poolSize > 32) {
      blockers.push('The workspace pool must be between 0 and 32 (0 is trunk-only).')
    }
    return blockers
  }

  return blockers
}

/**
 * What pressing Create will actually do, as the sentences the review step lists.
 *
 * ⛔ **Every line is something that writes.** A review step that summarised the *choices* rather than
 * the *writes* would leave the two files this lands in a repository — `project.json` and any starter
 * doc — as things a person discovers in `git status` afterwards.
 */
export function creationPlan(
  draft: NewProjectDraft,
  inspection: ProjectInspection | null
): string[] {
  const plan: string[] = []
  const root = inspection?.root ?? draft.root

  if (inspection && !inspection.exists && draft.createDirectory) plan.push(`Create ${root}.`)
  if (draft.gitInit && inspection?.vcs !== 'git') {
    plan.push(`Run git init -b ${draft.landingTarget.trim() || 'main'} in ${root}.`)
  }
  plan.push(`Add “${draft.name.trim()}” as a project.`)
  if (draft.scaffoldingGit === 'local') {
    plan.push(
      willHaveRepo(inspection, draft)
        ? 'Write .warmstart/project.json with these policies and list .warmstart/ in .git/info/exclude — kept to this checkout, nothing committed, no tracked file changed.'
        : 'Write .warmstart/project.json with these policies.'
    )
  } else if (draft.scaffoldingGit === 'ignore') {
    plan.push(
      inspection?.hasConfig
        ? 'Leave the existing .warmstart/project.json in place and add it to .gitignore.'
        : 'Write .warmstart/project.json with these policies, add it to .gitignore, and commit that rule — the config itself stays untracked.'
    )
  } else {
    plan.push(
      inspection?.hasConfig
        ? 'Update the committed .warmstart/project.json with these policies.'
        : 'Write .warmstart/project.json with these policies — a new file in the repository.'
    )
    if (willHaveRepo(inspection, draft)) {
      plan.push('Commit the scaffolding so the trunk starts clean.')
    }
  }

  const checks = checksFromText(draft.checksText)
  plan.push(
    checks.length > 0
      ? `Record ${checks.length} check command${checks.length === 1 ? '' : 's'}.`
      : 'Record no check commands — verifying finish policies would verify nothing.'
  )

  const docs = draft.scaffoldingGit === 'local' ? [] : draft.docs.filter((d) => d.include).map((d) => d.name)
  if (docs.length > 0) plan.push(`Write ${docs.join(', ')} into the project directory.`)

  const upstreamRemote = draft.upstreamRemote.trim()
  if (upstreamRemote && willHaveRepo(inspection, draft)) {
    plan.push(
      `Land into your fork (origin); open nothing on ${upstreamRemote} unless you press Propose upstream on a task. Name task branches warmstart/t<n>, with nothing from the prompt.`
    )
  }
  const pushRemote = draft.pushRemote.trim()
  if (!upstreamRemote && pushRemote && pushRemote !== 'origin' && willHaveRepo(inspection, draft)) {
    plan.push(
      `Push pull-request branches to ${pushRemote} and open them on origin; name task branches warmstart/t<n>, with nothing from the prompt.`
    )
  }

  if (willHaveRepo(inspection, draft)) {
    plan.push(
      draft.poolSize === 0
        ? 'Keep no worktree pool — every task will take the trunk lease and run serially in the checkout.'
        : `Create up to ${draft.poolSize} pooled worktree${draft.poolSize === 1 ? '' : 's'} under ` +
            `${inspection?.workspace.path ?? 'the workspace directory'}.`
    )
  } else {
    // ⚠️ Said out loud, because it is the consequence of the checkbox two steps back and it is not
    // otherwise visible anywhere: no repo means no branches, one workspace, and nothing to land.
    plan.push('Run with no repository: one workspace, no branches, and nothing to land onto.')
  }

  return plan
}
