import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ORIENTATION_READING_ORDER,
  projectOrientationChoice,
  projectSeedPrompt,
  type Project,
  type ProjectDocName
} from '@shared/tasks.js'

/**
 * What a **cold** agent is told before it is told the task.
 *
 * ⛔ **Cold only.** Everything here is orientation — where this project keeps the things an agent
 * should read before it touches anything — and orientation is worth exactly one telling per
 * conversation. `promptFor` sends this block on the prompts that restate the task's own instruction
 * and on no others, which is the same rule the task prompt itself follows and for the same reason.
 *
 * ⛔ **Nothing is named that is not on disk.** A prompt that says *read HANDOFF.md* to an agent in a
 * repository that has never had one sends it looking for a file, finding nothing, and deciding for
 * itself whether that means the tool is wrong or the repository is — which costs a tool call and a
 * paragraph of reasoning to arrive back where it started. The three names are `PROJECT_DOC_NAMES`,
 * the same set the add-project wizard offers to scaffold, so a project that took the scaffolding
 * gets the sentence and one that declined it is untouched.
 */

/**
 * Why each one is worth opening.
 *
 * ⚠️ One clause each, because the alternative is an agent opening all three to find out which
 * answers the question it has. It costs ~6 tokens per file and saves a read of whichever two were
 * not the one it needed.
 */
const WHAT_IT_HOLDS: Record<ProjectDocName, string> = {
  'AGENTS.md': 'how to work in this codebase',
  'HANDOFF.md': 'where the work currently stands',
  'README.md': 'what this project is'
}

/**
 * Which orientation docs this project actually has, in reading order.
 *
 * ⚠️ Read from the project **root**, not from the pooled worktree the agent will run in. The
 * worktree is a checkout of the same repository and holds the same files, and the root is the one
 * path that is known here — `promptFor` composes a prompt before a workspace has been claimed.
 */
export function orientationDocs(root: string): ProjectDocName[] {
  return ORIENTATION_READING_ORDER.filter((name) => {
    try {
      return existsSync(join(root, name))
    } catch {
      // ⚠️ A root that cannot be read is not an error worth failing a dispatch over. It means no
      // sentence, which is exactly the state of every project that keeps none of these files.
      return false
    }
  })
}

/** The sentence naming the docs, or null when this project has none of them (or has said `off`). */
export function orientationSentence(project: Project): string | null {
  if (projectOrientationChoice(project) === 'off') return null
  const docs = orientationDocs(project.root)
  if (docs.length === 0) return null
  const named = docs.map((name) => `\`${name}\` (${WHAT_IT_HOLDS[name]})`)
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  return (
    `Start by reading ${list}, at the root of this project. ` +
    'They are the orientation this project keeps for agents, so they are the cheapest place to ' +
    'find out how work is done here before you change anything.'
  )
}

/**
 * The whole cold-start block: the detected docs, then the operator's own seed, or null for neither.
 *
 * ⛔ **The seed comes after, never instead of.** A project that wants only its own sentence turns
 * `orientation` off, which is a key in the committed file that says so. A seed that silently
 * replaced the doc line would make that same choice invisible to the next person to read it.
 *
 * ⚠️ The seed travels **verbatim**. It is the operator's own prompt text and nothing here reformats,
 * truncates or wraps it in a sentence of its own — the box they typed it into is what the agent
 * reads.
 */
export function coldStartBlock(project: Project | null | undefined): string | null {
  if (!project) return null
  const parts = [orientationSentence(project), projectSeedPrompt(project)].filter(
    (p): p is string => !!p
  )
  return parts.length > 0 ? parts.join('\n\n') : null
}
