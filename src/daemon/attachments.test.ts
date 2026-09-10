import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let attachments: typeof import('./attachments.js')

/** A real 1×1 PNG. Small enough to inline, and its magic number is the thing under test. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** A real GIF header, so that "not a PNG" and "not an image" stay different failures. */
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 7)])

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-attachment-test-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  attachments = await import('./attachments.js')
  db.openDb(join(dir, 'attachments.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file locks
  }
})

describe('what may become an attachment', () => {
  it('takes a real PNG and keeps the bytes byte for byte', () => {
    const made = attachments.createAttachment(PNG, 'image/png', { width: 1, height: 1 })
    expect(made.mediaType).toBe('image/png')
    expect(made.bytes).toBe(PNG.length)
    expect(readFileSync(made.file).equals(PNG)).toBe(true)
  })

  /**
   * ⛔ The one that matters. `mediaType` arrives from the renderer, which read it off the clipboard,
   * which read it off whatever produced the image — and the file this writes is one an agent is
   * separately instructed by name to open.
   */
  it('keeps a non-image file as a file even when its declared type is wrong', () => {
    const exe = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64, 0x90)])
    const made = attachments.createAttachment(exe, 'image/png', { name: 'tool.exe' })
    expect(made.kind).toBe('file')
    expect(made.file.endsWith('.exe')).toBe(true)
  })

  it('believes the bytes over the label when both are images', () => {
    const made = attachments.createAttachment(GIF, 'image/png')
    // ⚠️ Not an error — the clipboard mislabels routinely — but the *sniffed* type is what is
    // stored, because that is what a CLI will be told this file is.
    expect(made.mediaType).toBe('image/gif')
    expect(made.file.endsWith('.gif')).toBe(true)
  })

  it('refuses an empty paste rather than storing nothing under a real id', () => {
    expect(() => attachments.createAttachment(Buffer.alloc(0), 'image/png')).toThrow(/some bytes/)
  })
})

describe('binding an upload to the message that carried it', () => {
  it('moves the file out of pending and fills in the row', () => {
    const task = tasks.createTask({ title: 'A task with a screenshot', status: 'draft' })
    const made = attachments.createAttachment(PNG, 'image/png')
    expect(made.file.includes('pending')).toBe(true)
    const messageId = tasks.addMessage(task.id, 'human', 'look at this', null, [made.id])

    const bound = attachments.requireAttachment(made.id)
    expect(bound.messageId).toBe(messageId)
    expect(bound.taskId).toBe(task.id)
    expect(bound.file.includes('pending')).toBe(false)
    expect(bound.file.includes(task.id)).toBe(true)
    expect(attachments.attachmentExists(bound)).toBe(true)
    // The bytes really moved; nothing was left behind for the pruner to find later.
    expect(existsSync(made.file)).toBe(false)
  })

  it('comes back on the message it belongs to, and on no other', () => {
    const task = tasks.createTask({ title: 'Two messages, one image', status: 'draft' })
    const made = attachments.createAttachment(PNG, 'image/png')
    const withImage = tasks.addMessage(task.id, 'human', 'here it is', null, [made.id])
    tasks.addMessage(task.id, 'human', 'and a second thought')

    const thread = tasks.messagesFor(task.id)
    const carrying = thread.filter((m) => m.attachments.length > 0)
    expect(carrying).toHaveLength(1)
    expect(carrying[0]?.id).toBe(withImage)
    expect(carrying[0]?.attachments[0]?.id).toBe(made.id)
  })

  /**
   * ⛔ A double-clicked Send must not move a file out from under a prompt that already names it.
   * The renderer holds these ids in component state and will happily offer them twice.
   */
  it('ignores an id that is already bound rather than stealing it', () => {
    const first = tasks.createTask({ title: 'The owner', status: 'draft' })
    const second = tasks.createTask({ title: 'The thief', status: 'draft' })
    const made = attachments.createAttachment(PNG, 'image/png')
    const owned = tasks.addMessage(first.id, 'human', 'mine', null, [made.id])
    const stolen = tasks.addMessage(second.id, 'human', 'also mine?', null, [made.id])

    const still = attachments.requireAttachment(made.id)
    expect(still.messageId).toBe(owned)
    expect(still.taskId).toBe(first.id)
    expect(tasks.messagesFor(second.id).find((m) => m.id === stolen)?.attachments).toEqual([])
  })

  it('refuses more than eight images on one message', () => {
    const task = tasks.createTask({ title: 'Nine screenshots', status: 'draft' })
    const ids = Array.from(
      { length: attachments.MAX_PER_MESSAGE + 1 },
      () => attachments.createAttachment(PNG, 'image/png').id
    )
    expect(() => tasks.addMessage(task.id, 'human', 'all of them', null, ids)).toThrow(
      /the limit is 8/
    )
  })

  it('binds a selected folder without moving or owning it', () => {
    const task = tasks.createTask({ title: 'Read this folder', status: 'draft' })
    const folder = join(dir, 'operator-context')
    mkdirSync(folder, { recursive: true })
    const made = attachments.createFolderAttachment(folder)
    tasks.addMessage(task.id, 'human', 'use this context', null, [made.id])

    const bound = attachments.requireAttachment(made.id)
    expect(bound.kind).toBe('folder')
    expect(bound.file).toBe(folder)
    expect(attachments.attachmentExists(bound)).toBe(true)
    expect(attachments.attachmentDirs([bound])).toEqual([folder])
  })
})

describe('uploads nobody ever sent', () => {
  it('deletes an abandoned one, bytes and row together', () => {
    const orphan = attachments.createAttachment(PNG, 'image/png')
    expect(attachments.prunePending(0)).toBeGreaterThanOrEqual(1)
    expect(attachments.getAttachment(orphan.id)).toBeNull()
    expect(existsSync(orphan.file)).toBe(false)
  })

  it('never touches one that became part of a thread', () => {
    const task = tasks.createTask({ title: 'A kept image', status: 'draft' })
    const made = attachments.createAttachment(PNG, 'image/png')
    tasks.addMessage(task.id, 'human', 'keep this', null, [made.id])
    const bound = attachments.requireAttachment(made.id)

    // ⛔ `0` means "everything older than now", which is every row there is. A bound attachment
    // must survive that, because the age of an upload says nothing about whether it was used.
    attachments.prunePending(0)
    expect(attachments.getAttachment(made.id)).not.toBeNull()
    expect(attachments.attachmentExists(bound)).toBe(true)
  })

  it('leaves a recent upload alone, because somebody is still typing', () => {
    const fresh = attachments.createAttachment(PNG, 'image/png')
    attachments.prunePending(60_000)
    expect(attachments.getAttachment(fresh.id)).not.toBeNull()
  })

  it('forgets an abandoned folder reference without deleting the operator’s folder', () => {
    const folder = join(dir, 'still-the-operators')
    mkdirSync(folder, { recursive: true })
    const made = attachments.createFolderAttachment(folder)

    attachments.prunePending(0)

    expect(attachments.getAttachment(made.id)).toBeNull()
    expect(existsSync(folder)).toBe(true)
  })
})

describe('the sentence the agent is given', () => {
  it('names the absolute path, the type and the size', () => {
    const made = attachments.createAttachment(PNG, 'image/png', { width: 1, height: 1 })
    const said = attachments.describeAttachment(made)
    expect(said).toContain(made.file)
    expect(said).toContain('image/png')
    expect(said).toContain('1×1')
  })

  it('gives one directory per place the files actually are, deduplicated', () => {
    const task = tasks.createTask({ title: 'Two in one message', status: 'draft' })
    const a = attachments.createAttachment(PNG, 'image/png')
    const b = attachments.createAttachment(PNG, 'image/png')
    tasks.addMessage(task.id, 'human', 'both', null, [a.id, b.id])
    const bound = [attachments.requireAttachment(a.id), attachments.requireAttachment(b.id)]
    expect(attachments.attachmentDirs(bound)).toHaveLength(1)
  })
})
