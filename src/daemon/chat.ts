import { sessionEnded } from '@shared/protocol.js'
import type { ChatMessage } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import { chooseController } from './controller.js'
import { getWorker } from './workers.js'
import {
  getSession,
  listSessions,
  onSessionEnd,
  onSessionStream,
  sendPrompt,
  spawnSession
} from './sessions.js'

/**
 * Talking to the controller.
 *
 * This is the **one place the controller gets tools**, and the reason is not a preference: a person
 * is watching. An unattended judgment call answers with JSON that the daemon validates and applies
 * itself (judgment.ts); a conversation is a different bargain, because you can see what it does and
 * stop it.
 *
 * Two consequences, both deliberate:
 *
 *  - ⛔ The chat session runs in the operator's **home directory**, not a worktree, so there is no
 *    branch to throw away if it goes wrong. It therefore runs in the adapter's *prompting* mode
 *    rather than an auto mode: every tool use it makes goes through the same approval policy and the
 *    same Approvals bar as an agent's, and lands in front of you before it happens.
 *  - It is a **warm session that is kept**, because a conversation with a person is exactly the case
 *    the cost model was built for: a reply into a live session costs `0.1·C` and refreshes the TTL,
 *    while the same reply into a dead one costs `2.0·C`, and human latency routinely straddles the
 *    hour. The cache clock decides when to let it go.
 */

export const DEFAULT_THREAD = 'main'

/** A reply that takes longer than this has stopped being a conversation. */
const REPLY_TIMEOUT_MS = 5 * 60 * 1000

/** The CLI needs a moment before it reads stdin on a freshly spawned session. */
const COLD_PROMPT_DELAY_MS = 2500

interface ChatRow {
  id: number
  thread_id: string
  role: string
  text: string
  session_id: string | null
  ts: number
}

function toMessage(r: ChatRow): ChatMessage {
  const workerId = r.session_id ? getSession(r.session_id)?.workerId : null
  return {
    id: r.id,
    threadId: r.thread_id,
    role: r.role as ChatMessage['role'],
    text: r.text,
    sessionId: r.session_id,
    workerLabel: workerId ? getWorker(workerId)?.label ?? workerId : null,
    ts: r.ts
  }
}

export function chatHistory(threadId = DEFAULT_THREAD, limit = 200): ChatMessage[] {
  return rows<ChatRow>(
    db()
      .prepare('select * from chat_messages where thread_id = ? order by ts desc, id desc limit ?')
      .all(threadId, limit)
  )
    .map(toMessage)
    .reverse()
}

function append(
  threadId: string,
  role: ChatMessage['role'],
  text: string,
  sessionId: string | null
): ChatMessage {
  const ts = Date.now()
  db()
    .prepare('insert into chat_messages (thread_id, role, text, session_id, ts) values (?,?,?,?,?)')
    .run(threadId, role, text, sessionId, ts)
  const r = row<ChatRow>(
    db().prepare('select * from chat_messages where thread_id = ? order by id desc limit 1').get(threadId)
  )
  if (!r) throw new Error('the chat message vanished immediately after insert')
  const message = toMessage(r)
  emit({ type: 'chat.message', message })
  return message
}

/** The live chat session for a thread, if there is one. */
export function chatSessionFor(threadId: string): string | null {
  const live = listSessions().find(
    (s) => s.purpose === 'chat' && !sessionEnded(s.state)
  )
  void threadId
  return live?.id ?? null
}

export interface SendResult {
  ok: boolean
  sessionId?: string
  reason?: string
}

/**
 * Say something to the controller.
 *
 * Returns as soon as the message is on its way; the reply arrives as `chat.message` events, because
 * a turn can take minutes and an RPC that waits for one is an RPC that times out.
 */
export function sendChat(text: string, threadId = DEFAULT_THREAD): SendResult {
  const body = text.trim()
  if (!body) return { ok: false, reason: 'nothing to send' }

  let sessionId = chatSessionFor(threadId)
  let cold = false

  if (!sessionId) {
    const choice = chooseController()
    if (!choice.worker) {
      // ⛔ Said plainly rather than queued. A chat message that silently waits for an account to free
      // up is a chat that appears broken.
      const reason =
        choice.reason ||
        'no account is designated a controller. Set one to “controller” or “both” in Workers.'
      append(threadId, 'system', `Nobody to ask: ${reason}`, null)
      return { ok: false, reason }
    }
    try {
      const session = spawnSession({
        workerId: choice.worker.id,
        transport: 'stream',
        purpose: 'chat',
        // ⛔ Not an auto mode. See the note at the top of this file: this session runs in the
        // operator's home directory, so its tool use is answered by the approval policy.
        permissionMode: 'default'
      })
      sessionId = session.id
      cold = true
      append(
        threadId,
        'system',
        `Controller session opened on ${choice.worker.label}. Its tool use goes through the ` +
          'Approvals bar, the same as an agent’s.',
        session.id
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      append(threadId, 'system', `Could not open a controller session: ${reason}`, null)
      return { ok: false, reason }
    }
  }

  append(threadId, 'human', body, sessionId)
  listen(threadId, sessionId)

  const deliver = () => {
    try {
      sendPrompt(sessionId, body)
    } catch (err) {
      log.warn('could not deliver a chat message:', err)
      append(threadId, 'system', `Could not deliver that: ${String(err)}`, sessionId)
    }
  }
  if (cold) setTimeout(deliver, COLD_PROMPT_DELAY_MS)
  else deliver()

  return { ok: true, sessionId }
}

/** One listener per session, however many messages are sent into it. */
const listening = new Set<string>()

function listen(threadId: string, sessionId: string): void {
  if (listening.has(sessionId)) return
  listening.add(sessionId)

  let buffer = ''
  let timer: NodeJS.Timeout | null = null

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    const text = buffer.trim()
    buffer = ''
    if (text) append(threadId, 'controller', text, sessionId)
  }

  const offStream = onSessionStream(sessionId, (event) => {
    if (event.kind === 'assistant_text') {
      buffer += event.text
      // A turn that produces prose, then a tool call, then more prose is one reply. Flushing on the
      // result record keeps it that way rather than posting it in fragments.
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, REPLY_TIMEOUT_MS)
    }
    if (event.kind === 'result') {
      if (event.text && !buffer.includes(event.text)) buffer = event.text
      flush()
      if (event.isError) {
        append(threadId, 'system', `The controller's turn ended in an error (${event.terminalReason ?? 'unknown'}).`, sessionId)
      }
    }
  })

  const offEnd = onSessionEnd(sessionId, () => {
    flush()
    append(threadId, 'system', 'The controller session ended. The next message opens a new one.', sessionId)
    offStream()
    offEnd()
    listening.delete(sessionId)
  })
}

/** Clear the transcript shown in the controller panel; the live conversation remains warm. */
export function clearChat(threadId = DEFAULT_THREAD): void {
  db().prepare('delete from chat_messages where thread_id = ?').run(threadId)
}
