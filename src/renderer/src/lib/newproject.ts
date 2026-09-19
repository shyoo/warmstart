import type {
  CompletionModeChoice,
  FinishPolicyChoice,
  ProjectDocName,
  ProjectInspection,
  SessionSharingChoice
} from '@shared/tasks'

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

export interface NewProjectDraft {
  root: string
  name: string
  createDirectory: boolean
  gitInit: boolean
  /** Empty means the recommended sibling — `<root>_workspaces`. */
  workspaceRoot: string
  finish: FinishPolicyChoice
  landingTarget: string
  sessionShare: SessionSharingChoice
  completion: CompletionModeChoice
  poolSize: number
  /** One command per line, exactly as `ChecksPanel` treats it. */
  checksText: string
  docs: DocDraftState[]
}

export const EMPTY_DRAFT: NewProjectDraft = {
  root: '',
  name: '',
  createDirectory: false,
  gitInit: false,
  workspaceRoot: '',
  finish: 'inherit',
  landingTarget: 'main',
  sessionShare: 'inherit',
  completion: 'inherit',
  poolSize: 3,
  checksText: '',
  docs: []
}

/** One command per line, trimmed, blanks dropped. ⚠️ The same reading `setProjectChecks` does. */
export function checksFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
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
    if (inspection && !inspection.workspace.usable) {
      blockers.push(inspection.workspace.note ?? 'That workspace directory cannot be used.')
    }
    if (!draft.landingTarget.trim()) {
      blockers.push('Name the branch this project’s work lands on.')
    }
    if (!Number.isInteger(draft.poolSize) || draft.poolSize < 1 || draft.poolSize > 32) {
      blockers.push('The workspace pool must be between 1 and 32.')
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
  plan.push(
    inspection?.hasConfig
      ? 'Update the committed .warmstart/project.json with these policies.'
      : 'Write .warmstart/project.json with these policies — a new file in the repository.'
  )

  const checks = checksFromText(draft.checksText)
  plan.push(
    checks.length > 0
      ? `Record ${checks.length} check command${checks.length === 1 ? '' : 's'}.`
      : 'Record no check commands — verifying finish policies would verify nothing.'
  )

  const docs = draft.docs.filter((d) => d.include).map((d) => d.name)
  if (docs.length > 0) plan.push(`Write ${docs.join(', ')} into the project directory.`)

  if (willHaveRepo(inspection, draft)) {
    plan.push(
      `Create up to ${draft.poolSize} pooled worktree${draft.poolSize === 1 ? '' : 's'} under ` +
        `${inspection?.workspace.path ?? 'the workspace directory'}.`
    )
  } else {
    // ⚠️ Said out loud, because it is the consequence of the checkbox two steps back and it is not
    // otherwise visible anywhere: no repo means no branches, one workspace, and nothing to land.
    plan.push('Run with no repository: one workspace, no branches, and nothing to land onto.')
  }

  return plan
}
