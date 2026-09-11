/** Preference resolvers shared by every process.
 *
 * Preferences describe what should happen; they never grant authority. `mandate.allowed` remains
 * the separate, inherited boundary on what a task may do.
 */
import type {
  CompletionMode,
  FinishPolicy,
  OrientationChoice,
  Project,
  QuestionKind,
  QuestionOption,
  ResolvedCompletionMode,
  ResolvedFinishPolicy,
  ResolvedSessionSharing,
  SessionSharing,
  Task
} from './tasks.js'
import {
  cleanQuestionText,
  DEFAULT_FLEET_COMPLETION,
  DEFAULT_FLEET_FINISH,
  DEFAULT_FLEET_SHARING,
  extractEmbeddedParameters,
  finishInstructionFor,
  isMultiSelectQuestion,
  isOpenConversation,
  projectCompletionChoice,
  projectFinishChoice,
  projectSharingChoice,
  stripCallSyntax
} from './tasks.js'

/**
 * ⚠️ Absent is `auto`, so a project that has never been asked still gets the line. The docs are
 * named only if they are on disk, so this is inert for a project that keeps none of them.
 */
export function projectOrientationChoice(project: Pick<Project, 'config'> | null | undefined): OrientationChoice {
  return project?.config?.prompt?.orientation === 'off' ? 'off' : 'auto'
}

/** The operator's own cold-start sentence for this project, or null when it has none. */
export function projectSeedPrompt(project: Pick<Project, 'config'> | null | undefined): string | null {
  const seed = project?.config?.prompt?.seed?.trim()
  return seed ? seed : null
}

/**
 * Everything a question needs, after recovering whatever the tool call mangled.
 *
 * ⚠️ Supplied options always beat recovered ones, and an explicit `multi` is never downgraded to a
 * single choice because a phrase match failed to fire.
 */
export function normaliseAsk(input: { question: string; header?: string | null; kind: QuestionKind; options?: QuestionOption[] | null }) {
  const embedded = extractEmbeddedParameters(input.question)
  const question = cleanQuestionText(embedded.question)
  const header = stripCallSyntax(input.header?.trim() || embedded.header || '') || null
  const supplied = (input.options ?? []).filter((option) => option.label?.trim())
  const options = supplied.length > 0 ? supplied : (embedded.options ?? [])
  const multi = input.kind === 'multi' || embedded.multiSelect === true || isMultiSelectQuestion(question, options, header ?? undefined)
  return { question, header, kind: options.length === 0 ? 'text' : multi ? 'multi' : 'choice' as QuestionKind, options }
}

/**
 * Scale a weight vector to sum to 1. **The name every process outside `tasks.ts` uses.**
 *
 * ⛔ Re-exported rather than reimplemented: `parseObjective` in `tasks.ts` needs the same
 * arithmetic, and this file imports that one, so the implementation has to sit on that side of the
 * edge or the two files close a cycle. One implementation, two names, and this is the public one.
 */
export { normaliseObjective as normalise } from './tasks.js'

/**
 * Task, then project, then fleet — the same three tiers as finish and sharing, and `inherit` is a
 * real value at each one.
 */
export function resolveCompletionMode(task: Task | null | undefined, project: Project | null | undefined, fleetMode: CompletionMode = DEFAULT_FLEET_COMPLETION): ResolvedCompletionMode {
  if (task && task.completionMode !== 'inherit') return { mode: task.completionMode, source: 'task' }
  if (project) { const choice = projectCompletionChoice(project); if (choice !== 'inherit') return { mode: choice, source: 'project' } }
  return { mode: fleetMode, source: 'fleet' }
}

function pickCustomInstruction(policy: FinishPolicy, instruction: string): string | null { return policy === 'custom' ? instruction : null }

/**
 * Task, then project, then fleet — the first one that is not `inherit`. This is preference only;
 * `mandate.allowed` remains the separate boundary on what a task *may* do.
 *
 * ⚠️ The `source` travels with the answer so the UI can say *inherited from the project* rather than
 * showing a value the operator will look for on the task and not find. A setting whose origin is
 * invisible is one nobody trusts and everybody overrides.
 *
 * ⛔ **A conversation answers `await-human` from its kind, above the project and the fleet.** Not as
 * a default it merely starts on: a chat filed into a project set to `commit-and-merge` would
 * otherwise land the repository every time the agent said something conclusive, which is the one
 * thing the kind exists to stop. ⚠️ Only while its own policy is `inherit` — a real rung set on the
 * task's own finish setting is the operator's answer from that moment. Landing a conversation does not
 * pass through here at all: `landConversationWork` hands `decideFinish` its rung directly, and leaves
 * the task on `inherit`. `isOpenConversation` is that same test read from the other side.
 */
export function resolveFinishPolicy(task: Task | null | undefined, project: Project | null | undefined, fleetFinish: FinishPolicy = DEFAULT_FLEET_FINISH): ResolvedFinishPolicy {
  const instruction = finishInstructionFor(project)
  if (isOpenConversation(task)) return { policy: 'await-human', source: 'task', instruction: null }
  if (task && task.finishPolicy !== 'inherit') return { policy: task.finishPolicy, source: 'task', instruction: pickCustomInstruction(task.finishPolicy, instruction) }
  if (project) { const choice = projectFinishChoice(project); if (choice !== 'inherit') return { policy: choice, source: 'project', instruction: pickCustomInstruction(choice, instruction) } }
  return { policy: fleetFinish, source: 'fleet', instruction: pickCustomInstruction(fleetFinish, instruction) }
}

/**
 * Resolve task → project → fleet, taking the first that is not `inherit`.
 *
 * ⚠️ `inherit` is a real value, not a blank. A task left on it follows its project as the project
 * changes; a task set explicitly to the same value does not. That difference is the reason the
 * dropdown offers it rather than showing an empty box.
 *
 * ⛔ Reuse is half of what a conversation *is*, so it comes from the kind rather than from the tier
 * below it. ⚠️ Still only while the task is on `inherit`: somebody who explicitly turns sharing off
 * on one conversation has said something, and the kind does not get to overrule it.
 */
export function resolveSessionSharing(task: Task | null | undefined, project: Project | null | undefined, fleetSharing: SessionSharing = DEFAULT_FLEET_SHARING): ResolvedSessionSharing {
  if (task && task.kind === 'conversation' && task.sessionSharing === 'inherit') return { sharing: 'on', source: 'task' }
  if (task && task.sessionSharing !== 'inherit') return { sharing: task.sessionSharing, source: 'task' }
  if (project) { const choice = projectSharingChoice(project); if (choice !== 'inherit') return { sharing: choice, source: 'project' } }
  return { sharing: fleetSharing, source: 'fleet' }
}
