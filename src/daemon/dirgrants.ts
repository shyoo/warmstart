import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createFolderAttachment, grantedDirsFor } from './attachments.js'
import { samePath, withinPath } from './fspath.js'
import { log } from './log.js'
import { askQuestion } from './questions.js'
import { resumeWithGrant } from './scheduler.js'
import { addMessage, getTask, runForSession } from './tasks.js'
import { getSession } from './sessions.js'

/**
 * An agent asking for a directory outside its workspace, and the operator answering with something
 * that actually changes the sandbox.
 *
 * ⛔ **The hole this fills is not "the agent could not ask".** It could: `ask_human` reached the
 * operator perfectly well. The hole is that no answer they were able to give could do anything.
 * Measured on t469, 2026-09-15 — codex asked *"Grant write access to
 * `C:\Dev\warmstart-site\.git` so the completed changes can be committed"*, the operator typed
 * *"Continue."*, and the sandbox was exactly as it had been. The work was eventually redone on
 * another worker. A question whose only useful answer is outside the answerer's reach is worse than
 * no question, because it costs a person's attention and returns nothing.
 *
 * ⛔ **And granting one cannot help the process that asked.** A sandbox fixes what it may write
 * before the first token: codex reads its roots off the `exec` argv and re-applies the ACLs from
 * that frozen payload before every command, and the stream transport has no mid-flight channel to
 * widen anything. The grant is therefore a fact about the *next* run, which is what
 * `resumeWithGrant` arranges — and why the operator's card says so in as many words rather than
 * letting a restart that costs tokens arrive as a surprise.
 *
 * ⚠️ **Nothing here is new machinery.** A granted folder is the same `folder` attachment the
 * composer's *Attach a folder* writes, so it is inherited down a lineage and re-granted on every
 * later run by `grantedDirsFor` exactly as an operator-attached one is (t462). The question is an
 * ordinary `Question`, so it draws on the desktop and the phone with no card of its own. The
 * restart is `continueTask`, which is what a person replying to a stopped task already does.
 */

/** What the operator's two buttons are called. Read back off the answer, so they are ids, not prose. */
const GRANT = 'grant'
const REFUSE = 'refuse'

export interface DirectoryRequest {
  sessionId: string
  path: string
  reason: string
  /** Where the work stands, recorded as the handoff so the resumed run does not rediscover it. */
  state?: string
}

/**
 * ⛔ **Refusals here are deliberately *not* terminal.** Every early return below leaves the run
 * open and hands the agent a sentence it can act on, because none of them is a reason to throw a
 * turn away: a path that does not exist is a typo, and a path already granted means the agent
 * should look again at the error it actually got rather than ask twice.
 */
export async function requestDirectory(
  request: DirectoryRequest
): Promise<{ ok: boolean; reply: string }> {
  const run = runForSession(request.sessionId)
  const task = run?.taskId ? getTask(run.taskId) : null
  if (!run || !task || run.outcome) {
    return { ok: false, reply: 'This session is not working on a task, so there is nothing to grant to.' }
  }

  const asked = (request.path ?? '').trim()
  if (!asked || !isAbsolute(asked)) {
    return {
      ok: false,
      reply: `'${asked}' is not an absolute path. Ask for a directory by its full path, e.g. C:\\Dev\\site.`
    }
  }
  const path = resolve(asked)
  let isDirectory: boolean
  try {
    isDirectory = existsSync(path) && statSync(path).isDirectory()
  } catch {
    // A path this process may not stat is one the agent could not have used either.
    isDirectory = false
  }
  if (!isDirectory) {
    // ⛔ Refused before a person is interrupted, and refused *here* rather than at the spawn. A
    // grant naming nothing is a flag codex will not start with (`grantedDirsFor`), so a path that
    // is wrong now is a failed dispatch later.
    return {
      ok: false,
      reply: `${path} is not a directory on this machine, so there is nothing to grant. Check the path.`
    }
  }

  // ⛔ **The loop guard, and it is the invariant rather than a nicety.** A decision re-evaluated
  // before its action lands is a loop: the resumed run arrives holding a conversation in which it
  // asked for this directory, and if asking again could raise a second card an agent that
  // misreads one error would spend the operator's attention repeatedly. The evidence that the ask
  // landed is the grant itself, and it is read here before anything else happens.
  const already = grantedDirsFor(task.id).find((dir) => samePath(dir, path))
  if (already) {
    return {
      ok: false,
      reply:
        `${path} is already granted to this task and is on this run's argv. Whatever was refused, ` +
        'the grant is not what refused it — read the error itself and say plainly what it was.'
    }
  }
  const session = getSession(request.sessionId)
  if (session?.cwd && withinPath(session.cwd, path)) {
    return {
      ok: false,
      reply: `${path} is inside your workspace and is already writable. Read the error you actually got.`
    }
  }

  const why = (request.reason ?? '').trim() || 'the work needs it'
  const resolution = await askQuestion({
    sessionId: request.sessionId,
    origin: 'request_directory',
    kind: 'choice',
    header: 'Directory access',
    question:
      `The agent is asking to read and write \`${path}\`, which is outside its workspace.\n\n` +
      `Why it says it needs it: ${why}`,
    options: [
      {
        id: GRANT,
        label: `Grant ${path}`,
        // ⛔ The token cost is said on the button, not discovered afterwards. A grant restarts the
        // run, and a restart is billed — a person clicking *yes* to a permission should not be
        // surprised by a charge.
        detail:
          'Attached to this task exactly as a folder you attach yourself is, so every later run and ' +
          'any piece it files keeps it. This run then ends and a new one starts immediately, ' +
          'resuming the same conversation with the directory writable — that new run costs tokens.'
      },
      {
        id: REFUSE,
        label: "Don't grant it",
        detail: 'The agent is told no and carries on in this same run without the directory.'
      }
    ]
  })

  // ⚠️ Parked or void: nobody answered before the session stopped paying for itself, and the task
  // is already resting at `awaiting_human` with the question still open. The agent gets the
  // question layer's own words, which tell it to stop rather than guess.
  if (resolution.status !== 'answered') return { ok: false, reply: resolution.reply }

  const granted = resolution.answer?.optionIds.includes(GRANT) ?? false
  if (!granted) {
    const note = resolution.answer?.text?.trim()
    return {
      ok: false,
      reply:
        `The operator did not grant ${path}.${note ? ` They said: ${note}` : ''} Carry on without ` +
        'it, and say plainly in your summary what you could not do as a result.'
    }
  }

  // ⭐ The same row the composer's *Attach a folder* writes, bound to this task by the message that
  // records it. From here `grantedDirsFor` does the rest, on every run and down every lineage.
  const attachment = createFolderAttachment(path)
  addMessage(
    task.id,
    'system',
    `Granted \`${path}\` to this task`,
    run.id,
    [attachment.id],
    {
      detail:
        `The agent asked for it: ${why}. It is now attached to this task, so every later run — and ` +
        'any piece this task files — is given it. This run was closed and a new one started to ' +
        'pick it up, because a sandbox cannot be widened once its process has started.'
    }
  )
  log.info(`t${task.seq}: operator granted ${path}; restarting the run to pick it up`)

  // ⛔ **Also on the thread as an undelivered instruction, and that is not a duplicate of the
  // handoff.** The next run is a resume, and a resumed prompt does not restate the task — so the
  // one thing the agent must be told on arrival is what changed and what to do about it.
  addMessage(
    task.id,
    'human',
    `\`${path}\` is now granted to you and writable. Pick up where the last turn stopped: it had ` +
      'already done the work that did not need this directory, so re-read what is there before ' +
      'redoing any of it, then finish the part that was blocked.'
  )

  return await resumeWithGrant(request.sessionId, path, request.state)
}
