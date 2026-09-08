/** Preference resolvers shared by every process.
 *
 * Preferences describe what should happen; they never grant authority. `mandate.allowed` remains
 * the separate, inherited boundary on what a task may do.
 */
import type {
  CompletionMode,
  FinishPolicy,
  Objective,
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
  DEFAULT_OBJECTIVE,
  extractEmbeddedParameters,
  finishInstructionFor,
  isMultiSelectQuestion,
  isOpenConversation,
  projectCompletionChoice,
  projectFinishChoice,
  projectSharingChoice,
  stripCallSyntax
} from './tasks.js'

/** ⚠️ Absent is `auto`, so a project that has never been asked still gets the line. */
export function projectOrientationChoice(project: Pick<Project, 'config'> | null | undefined): OrientationChoice {
  return project?.config?.prompt?.orientation === 'off' ? 'off' : 'auto'
}

/** The operator's own cold-start sentence for this project, or null when it has none. */
export function projectSeedPrompt(project: Pick<Project, 'config'> | null | undefined): string | null {
  const seed = project?.config?.prompt?.seed?.trim()
  return seed ? seed : null
}

/** Everything a question needs, after recovering whatever the tool call mangled. */
export function normaliseAsk(input: { question: string; header?: string | null; kind: QuestionKind; options?: QuestionOption[] | null }) {
  const embedded = extractEmbeddedParameters(input.question)
  const question = cleanQuestionText(embedded.question)
  const header = stripCallSyntax(input.header?.trim() || embedded.header || '') || null
  const supplied = (input.options ?? []).filter((option) => option.label?.trim())
  const options = supplied.length > 0 ? supplied : (embedded.options ?? [])
  const multi = input.kind === 'multi' || embedded.multiSelect === true || isMultiSelectQuestion(question, options, header ?? undefined)
  return { question, header, kind: options.length === 0 ? 'text' : multi ? 'multi' : 'choice' as QuestionKind, options }
}

export function normalise(objective: Partial<Objective>): Objective {
  const cost = Math.max(0, objective.cost ?? 0)
  const velocity = Math.max(0, objective.velocity ?? 0)
  const quality = Math.max(0, objective.quality ?? 0)
  const total = cost + velocity + quality
  if (total === 0) return DEFAULT_OBJECTIVE
  return { cost: cost / total, velocity: velocity / total, quality: quality / total }
}

/** Task, then project, then fleet — `inherit` is a real value at each tier. */
export function resolveCompletionMode(task: Task | null | undefined, project: Project | null | undefined, fleetMode: CompletionMode = DEFAULT_FLEET_COMPLETION): ResolvedCompletionMode {
  if (task && task.completionMode !== 'inherit') return { mode: task.completionMode, source: 'task' }
  if (project) { const choice = projectCompletionChoice(project); if (choice !== 'inherit') return { mode: choice, source: 'project' } }
  return { mode: fleetMode, source: 'fleet' }
}

function pickCustomInstruction(policy: FinishPolicy, instruction: string): string | null { return policy === 'custom' ? instruction : null }

/** Task, then project, then fleet. This is preference only; mandate remains the authority boundary. */
export function resolveFinishPolicy(task: Task | null | undefined, project: Project | null | undefined, fleetFinish: FinishPolicy = DEFAULT_FLEET_FINISH): ResolvedFinishPolicy {
  const instruction = finishInstructionFor(project)
  if (isOpenConversation(task)) return { policy: 'await-human', source: 'task', instruction: null }
  if (task && task.finishPolicy !== 'inherit') return { policy: task.finishPolicy, source: 'task', instruction: pickCustomInstruction(task.finishPolicy, instruction) }
  if (project) { const choice = projectFinishChoice(project); if (choice !== 'inherit') return { policy: choice, source: 'project', instruction: pickCustomInstruction(choice, instruction) } }
  return { policy: fleetFinish, source: 'fleet', instruction: pickCustomInstruction(fleetFinish, instruction) }
}

/** Resolve task → project → fleet, taking the first that is not `inherit`. */
export function resolveSessionSharing(task: Task | null | undefined, project: Project | null | undefined, fleetSharing: SessionSharing = DEFAULT_FLEET_SHARING): ResolvedSessionSharing {
  if (task && task.kind === 'conversation' && task.sessionSharing === 'inherit') return { sharing: 'on', source: 'task' }
  if (task && task.sessionSharing !== 'inherit') return { sharing: task.sessionSharing, source: 'task' }
  if (project) { const choice = projectSharingChoice(project); if (choice !== 'inherit') return { sharing: choice, source: 'project' } }
  return { sharing: fleetSharing, source: 'fleet' }
}
