import { commandById, type ThreadCommand } from '@shared/commands'
import { normalizeScratch, scratchImages, type ScratchAttachment } from './composerscratch'
import type { PastedImage } from './pasteimages.js'
import { appKey } from './storagekeys'

/**
 * What was half-typed into a task thread's reply box, kept per task until it is sent or cleared.
 *
 * ⛔ **The reply box unmounts with its task.** `TaskDetail` is keyed by task id (t949), so opening
 * another task, the Tasks table or Settings threw away whatever had been typed under the thread. The
 * new-task form already kept its own text (`composerscratch.ts`); this is the same memory for the
 * other box, and the rule is the same: nothing the person typed goes until they send it or empty the
 * box themselves.
 *
 * ⚠️ Keyed by task id, because each thread is a different conversation. A reply to one agent
 * appearing under another would be a message sent to the wrong one.
 *
 * ⛔ **No preview bytes**, for the reason `composerscratch.ts` gives: a restored attachment keeps the
 * id the daemon will be handed and loses its thumbnail.
 *
 * ⚠️ Guarded in both directions like every other preference: `localStorage` throws rather than
 * returning null in real configurations, and a draft is never worth a blank screen.
 */

const KEY = appKey('threadReplyDrafts')

export interface ReplyDraft {
  text: string
  /** The slash command held as a chip (t704), by id. */
  commandId: string | null
  attachments: ScratchAttachment[]
}

export const EMPTY_REPLY_DRAFT: ReplyDraft = { text: '', commandId: null, attachments: [] }

/** Nothing worth coming back to: no words (blanks do not count), no chip, no attachment. */
export function isEmptyReplyDraft(draft: ReplyDraft): boolean {
  return draft.text.trim().length === 0 && draft.commandId === null && draft.attachments.length === 0
}

/**
 * ⛔ Field by field, never all-or-nothing: a paragraph is not dropped because a field a later build
 * adds is missing from what an earlier one wrote.
 */
export function normalizeReplyDraft(raw: unknown): ReplyDraft {
  if (!raw || typeof raw !== 'object') return EMPTY_REPLY_DRAFT
  const held = raw as Record<string, unknown>
  return {
    text: typeof held.text === 'string' ? held.text : '',
    // ⚠️ A chip whose command no longer exists is dropped, and its words stay.
    commandId: typeof held.commandId === 'string' && commandById(held.commandId) ? held.commandId : null,
    // ⚠️ The scratch's own normaliser, so an attachment is read exactly as the new-task form reads one.
    attachments: normalizeScratch({ attachments: held.attachments }).attachments
  }
}

function readAll(): Record<string, unknown> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function readReplyDraft(taskId: string): ReplyDraft {
  return normalizeReplyDraft(readAll()[taskId])
}

/** ⚠️ An empty draft **removes** its task rather than storing a row of blanks. */
export function writeReplyDraft(taskId: string, draft: ReplyDraft): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const held = readAll()
    if (isEmptyReplyDraft(draft)) {
      if (!(taskId in held)) return
      delete held[taskId]
    } else held[taskId] = draft
    window.localStorage.setItem(KEY, JSON.stringify(held))
  } catch {
    // A draft that cannot be saved is not an error worth showing anybody.
  }
}

export function clearReplyDraft(taskId: string): void {
  writeReplyDraft(taskId, EMPTY_REPLY_DRAFT)
}

/** The chip a stored draft names, or null. */
export function draftCommand(draft: ReplyDraft): ThreadCommand | null {
  return commandById(draft.commandId)
}

/** The attachments of a restored draft, as the chips strip wants them. */
export function draftImages(draft: ReplyDraft): PastedImage[] {
  return scratchImages({
    prompt: '',
    dependsOn: [],
    schedule: 'now',
    customTime: '',
    attachments: draft.attachments
  })
}
