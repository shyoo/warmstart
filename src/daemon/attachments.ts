import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { Attachment } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { log } from './log.js'
import { paths } from './paths.js'

/**
 * Images a person pasted into a task.
 *
 * ⛔ **This is the only place in the daemon that writes attachment bytes.** Everything else moves
 * ids around. Bytes live under `<dataDir>/attachments/`, metadata lives in sqlite, and the two are
 * kept together by `bindAttachments` and by the `on delete cascade` on the row.
 *
 * ⛔ **The declared media type is never trusted.** It arrives from the renderer, which read it off
 * the clipboard, which read it off whatever produced the image. The magic number of the bytes
 * themselves is what decides, because these bytes are handed to a CLI as an image and written to a
 * path an agent is separately instructed by name to open.
 */

/** How many bytes of one image we will take, before the renderer's downscale is even considered. */
const MAX_BYTES = 10 * 1024 * 1024

/** Per message. Refused at the door with a real reason, never silently truncated. */
export const MAX_PER_MESSAGE = 8

/** An unbound upload older than this was pasted into a form nobody ever submitted. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000

interface AttachmentRow {
  id: string
  message_id: number | null
  task_id: string | null
  kind: string
  media_type: string
  file: string
  bytes: number
  width: number | null
  height: number | null
  created_at: number
}

/**
 * The four image formats every one of the three CLIs will read, and the leading bytes that prove a
 * file is one.
 *
 * ⚠️ WebP is matched on its container, which is why it carries a second offset check — `RIFF` alone
 * is shared with every other RIFF file there is.
 */
const MAGIC: {
  mediaType: Attachment['mediaType']
  ext: string
  matches: (b: Buffer) => boolean
}[] = [
  {
    mediaType: 'image/png',
    ext: 'png',
    matches: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  },
  {
    mediaType: 'image/jpeg',
    ext: 'jpg',
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  },
  {
    mediaType: 'image/webp',
    ext: 'webp',
    matches: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
  },
  {
    mediaType: 'image/gif',
    ext: 'gif',
    matches: (b) => b.subarray(0, 3).toString('latin1') === 'GIF'
  }
]

/** What these bytes actually are, or null if they are not an image this fleet can send. */
export function sniffImage(
  bytes: Buffer
): { mediaType: Attachment['mediaType']; ext: string } | null {
  const hit = MAGIC.find((m) => bytes.length >= 12 && m.matches(bytes))
  return hit ? { mediaType: hit.mediaType, ext: hit.ext } : null
}

function toAttachment(r: AttachmentRow): Attachment {
  return {
    id: r.id,
    messageId: r.message_id,
    taskId: r.task_id,
    kind: r.kind as Attachment['kind'],
    mediaType: r.media_type,
    file: r.file,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    createdAt: r.created_at
  }
}

function attachmentDir(...parts: string[]): string {
  const path = join(paths.root, 'attachments', ...parts)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Put one pasted image on disk.
 *
 * ⛔ Refuses on the magic number rather than on the extension or the declared type: a `.exe` renamed
 * `.png` is exactly the payload this check exists for, and the file it would write is one an agent
 * is then told by name to open.
 *
 * The row comes back unbound — `messageId` and `taskId` null. It joins the thread when
 * `bindAttachments` is called with the message that carried it.
 */
export function createAttachment(
  bytes: Buffer,
  declaredMediaType: string,
  size?: { width?: number | null; height?: number | null; name?: string | null }
): Attachment {
  if (bytes.length === 0) throw new Error('an attachment needs some bytes')
  if (bytes.length > MAX_BYTES) {
    throw new Error(
      `that file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB and the limit is ${MAX_BYTES / 1024 / 1024} MB`
    )
  }
  const sniffed = sniffImage(bytes)
  const kind: Attachment['kind'] = sniffed ? 'image' : 'file'
  // ⚠️ A mismatch is not an error. The clipboard routinely mislabels, and we already know what the
  // bytes are; the sniffed type is what gets stored and what the CLI is told. Logged once, so that
  // a pattern of them is visible rather than silent.
  if (sniffed && declaredMediaType !== sniffed.mediaType) {
    log.warn(
      `attachment declared ${declaredMediaType} but the bytes are ${sniffed.mediaType}; using the bytes`
    )
  }
  const id = randomUUID()
  const extension = sniffed?.ext ?? (extname(basename(size?.name ?? '')).replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'bin')
  const mediaType = sniffed?.mediaType ?? (declaredMediaType || 'application/octet-stream')
  const file = join(attachmentDir('pending'), `${id}.${extension}`)
  writeFileSync(file, bytes)
  db()
    .prepare(
      'insert into attachments (id, message_id, task_id, kind, media_type, file, bytes, width, height, created_at) ' +
        'values (?,null,null,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      kind,
      mediaType,
      file,
      bytes.length,
      size?.width ?? null,
      size?.height ?? null,
      Date.now()
    )
  return requireAttachment(id)
}

/** An explicit operator-selected directory. It stays in place and is granted to the spawned CLI. */
export function createFolderAttachment(path: string): Attachment {
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new Error('that folder is no longer available')
  const id = randomUUID()
  db().prepare(
    'insert into attachments (id, message_id, task_id, kind, media_type, file, bytes, width, height, created_at) values (?,null,null,?,?,?,?,?,?,?)'
  ).run(id, 'folder', 'inode/directory', path, 0, null, null, Date.now())
  return requireAttachment(id)
}

export function getAttachment(id: string): Attachment | null {
  const r = row<AttachmentRow>(db().prepare('select * from attachments where id = ?').get(id))
  return r ? toAttachment(r) : null
}

export function requireAttachment(id: string): Attachment {
  const found = getAttachment(id)
  if (!found) throw new Error(`no attachment '${id}'`)
  return found
}

/**
 * Attach uploaded images to the message that carried them, moving the bytes out of `pending/`.
 *
 * ⛔ Ignores an id that is already bound. The renderer holds ids in component state, and a form
 * submitted twice — a double click, a retry after a hiccup — must not steal another message's image
 * or move a file out from under a prompt that already names it.
 */
export function bindAttachments(ids: string[], taskId: string, messageId: number): Attachment[] {
  if (ids.length === 0) return []
  if (ids.length > MAX_PER_MESSAGE) {
    throw new Error(`${ids.length} images on one message; the limit is ${MAX_PER_MESSAGE}`)
  }
  const bound: Attachment[] = []
  const update = db().prepare(
    'update attachments set message_id = ?, task_id = ?, file = ? where id = ? and message_id is null'
  )
  for (const id of ids) {
    const found = getAttachment(id)
    if (!found || found.messageId !== null) continue
    // ⛔ A folder is an external reference selected by the operator, not an upload. Moving it into
    // the data directory would both surprise the person and potentially move their whole project.
    if (found.kind === 'folder') {
      update.run(messageId, taskId, found.file, id)
      bound.push(requireAttachment(id))
      continue
    }
    const ext = found.file.split('.').pop() ?? 'png'
    const target = join(attachmentDir(taskId), `${id}.${ext}`)
    try {
      if (existsSync(found.file)) renameSync(found.file, target)
    } catch (err) {
      // ⚠️ A rename across devices, or a file a scanner still has open. The row is better pointing
      // at where the bytes are than at where they were meant to go.
      log.warn(`could not move attachment ${id.slice(0, 8)} into t${taskId.slice(0, 8)}:`, err)
      update.run(messageId, taskId, found.file, id)
      bound.push(requireAttachment(id))
      continue
    }
    update.run(messageId, taskId, target, id)
    bound.push(requireAttachment(id))
  }
  return bound
}

/** How many attachments are bound to this task, across every message. One indexed count. */
export function attachmentCountFor(taskId: string): number {
  return (
    (
      db().prepare('select count(*) as n from attachments where task_id = ?').get(taskId) as
        | { n: number }
        | undefined
    )?.n ?? 0
  )
}

/** Every attachment on these messages, keyed by message id. One query, not one per message. */
export function attachmentsFor(messageIds: number[]): Map<number, Attachment[]> {
  const byMessage = new Map<number, Attachment[]>()
  if (messageIds.length === 0) return byMessage
  const placeholders = messageIds.map(() => '?').join(',')
  const found = rows<AttachmentRow>(
    db()
      .prepare(
        `select * from attachments where message_id in (${placeholders}) order by created_at, id`
      )
      .all(...messageIds)
  )
  for (const r of found) {
    if (r.message_id === null) continue
    const list = byMessage.get(r.message_id) ?? []
    list.push(toAttachment(r))
    byMessage.set(r.message_id, list)
  }
  return byMessage
}

/**
 * Delete uploads that never became messages.
 *
 * ⛔ An image pasted into a form that was then abandoned is otherwise a file nobody ever deletes,
 * and these are megabytes each. Runs at startup and daily. ⚠️ Only ever touches rows with no
 * message — a bound attachment is part of a thread and outlives everything here.
 *
 * ⚠️ `<=`, not `<`. `prunePending(0)` has to mean *everything unbound*, and with a strict
 * comparison a row written inside the same millisecond survives its own sweep — which is a real
 * outcome on a fast machine and not only a test artefact.
 */
export function prunePending(olderThanMs = PENDING_TTL_MS, now = Date.now()): number {
  const stale = rows<AttachmentRow>(
    db()
      .prepare('select * from attachments where message_id is null and created_at <= ?')
      .all(now - olderThanMs)
  )
  for (const r of stale) {
    // ⛔ A folder is an operator-owned external reference, not upload data. Abandoning the form
    // deletes our row but must never remove the folder the person selected.
    if (r.kind === 'folder') {
      db().prepare('delete from attachments where id = ?').run(r.id)
      continue
    }
    try {
      if (existsSync(r.file)) rmSync(r.file, { force: true })
    } catch (err) {
      log.warn(`could not delete the abandoned attachment ${r.id.slice(0, 8)}:`, err)
    }
    db().prepare('delete from attachments where id = ?').run(r.id)
  }
  if (stale.length > 0) log.info(`pruned ${stale.length} attachment(s) nobody ever sent`)
  return stale.length
}

/**
 * The bytes back, for a CLI's inline block or the renderer's thumbnail.
 *
 * ⚠️ Returns null when the file is gone. A row whose bytes were deleted underneath it is a thing
 * that happens — a cleared data directory, half a backup restored — and every caller here can do
 * something sensible with "no image" and nothing sensible with a throw from inside a prompt build.
 */
export function attachmentBytes(attachment: Attachment): Buffer | null {
  try {
    if (!existsSync(attachment.file)) return null
    return readFileSync(attachment.file)
  } catch (err) {
    log.warn(`could not read attachment ${attachment.id.slice(0, 8)}:`, err)
    return null
  }
}

/**
 * The directories a run's attachments live in, so an adapter can grant its sandbox exactly those.
 *
 * ⚠️ Plural, and deduplicated. A message re-sent after a preemption can carry images bound under
 * one task while a note added since carries others; granting only the first directory would leave
 * the agent a path it is not allowed to open, which is worse than not naming it.
 */
export function attachmentDirs(attachments: Attachment[]): string[] {
  const seen = new Set<string>()
  for (const a of attachments) seen.add(a.kind === 'folder' ? a.file : dirname(a.file))
  return [...seen]
}

/** Human-facing size, for the sentence the agent is given. */
export function describeAttachment(a: Attachment): string {
  if (a.kind === 'folder') return `${a.file} (folder)`
  const size = a.width && a.height ? `, ${a.width}×${a.height}` : ''
  const bytes =
    a.bytes >= 1024 * 1024
      ? `${(a.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(a.bytes / 1024)} KB`
  return `${a.file} (${a.mediaType}${size}, ${bytes})`
}

/** Are the bytes really where the row says, at the size the row claims? Used by the suites. */
export function attachmentExists(a: Attachment): boolean {
  try {
    const stat = statSync(a.file)
    return a.kind === 'folder' ? stat.isDirectory() : stat.size === a.bytes
  } catch {
    return false
  }
}
