import { db, rows } from './db.js'
import { emit } from './events.js'
import { tryGit } from './git.js'
import { log } from './log.js'
import { getTask, addMessage } from './tasks.js'

/**
 * Later push observations for local-only landings.
 *
 * A `merge-local` landing correctly says that it did not push.  That is an observation about the
 * landing itself, though, not a promise that an operator will never push the resulting trunk.  A
 * later push used to leave that honest historical line looking like a current warning forever.
 * This reconciler fetches first, then reports the new, separately observed fact without rewriting
 * the landing record or claiming that Warmstart made the push.
 */

interface LocalLanding {
  id: number
  taskId: string
  projectId: string
  root: string
  sha: string
  target: string
}

const LOCAL_ONLY = /^Landed as `?([0-9a-f]{7,40})`? onto `?([^\s.`]+)`? — local only, \*\*not pushed\*\*/i

function localLandings(): LocalLanding[] {
  const messages = rows<{
    id: number
    task_id: string
    project_id: string
    root: string
    text: string
  }>(
    db().prepare(
      `select m.id, m.task_id, t.project_id, p.root, m.text
         from task_messages m
         join tasks t on t.id = m.task_id
         join projects p on p.id = t.project_id
        where m.event = 'landing.landed'
          and m.text like '%local only, **not pushed**%'
          and not exists (
            select 1 from task_messages observed
             where observed.task_id = m.task_id
               and observed.event = 'landing.pushed-later'
               and observed.detail like '%[landing-message:' || m.id || ']%'
          )`
    ).all()
  )
  return messages.flatMap((message) => {
    const match = LOCAL_ONLY.exec(message.text)
    if (!match?.[1] || !match[2]) return []
    return [{
      id: message.id,
      taskId: message.task_id,
      projectId: message.project_id,
      root: message.root,
      sha: match[1],
      target: match[2]
    }]
  })
}

/**
 * Fetch each affected origin and announce any local-only landing whose commit is now on its remote.
 *
 * Returns the number of new observations.  A fetch failure is unknown, never a negative result;
 * the next five-minute sweep tries again.
 */
export async function reconcilePushedLandings(): Promise<number> {
  const candidates = localLandings()
  const byProject = new Map<string, LocalLanding[]>()
  for (const landing of candidates) {
    byProject.set(landing.projectId, [...(byProject.get(landing.projectId) ?? []), landing])
  }

  let observed = 0
  for (const landings of byProject.values()) {
    const root = landings[0]?.root
    if (!root || await tryGit(root, ['remote', 'get-url', 'origin']) === null) continue
    if (await tryGit(root, ['fetch', 'origin', '--prune']) === null) {
      log.debug(`could not fetch origin while reconciling ${landings.length} local landing(s) in ${root}`)
      continue
    }
    for (const landing of landings) {
      // `merge-base --is-ancestor` exits non-zero for the ordinary "not there" answer.  The short
      // SHA is deliberately resolved by Git after the fetch, so an ambiguous historic abbreviation
      // is not silently assigned to a different commit.
      if (await tryGit(root, ['merge-base', '--is-ancestor', landing.sha, `origin/${landing.target}`]) === null) continue
      addMessage(
        landing.taskId,
        'system',
        `Later observed: \`${landing.sha.slice(0, 8)}\` is now on \`origin/${landing.target}\``,
        null,
        [],
        {
          event: 'landing.pushed-later',
          detail: `The landing itself was local only; a later fetch confirmed this commit reached the remote. [landing-message:${landing.id}]`
        }
      )
      const task = getTask(landing.taskId)
      if (task) emit({ type: 'task.changed', task })
      observed += 1
    }
  }
  return observed
}
