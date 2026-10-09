import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * The scratchpad file (t994), against real files: what VS Code and this app share is the disk, so
 * the refusal to overwrite has to be proven by writing to the disk behind the store's back.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let scratchpad: typeof import('./scratchpad.js')

let seq = 0

function makeProject(): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  return projects.addProject({ root })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-scratchpad-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  scratchpad = await import('./scratchpad.js')
  db.openDb(join(dir, 'scratchpad.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the default file', () => {
  it('is private, absent until the first save, and created by it', () => {
    const project = makeProject()
    const empty = scratchpad.readScratchpad(project.id)
    expect(empty).toMatchObject({ exists: false, text: '', version: '', relativePath: null })
    expect(empty.path).toBe(join(dir, 'scratchpads', `${project.id}.md`))

    const saved = scratchpad.saveScratchpad(project.id, '* New\n\nfirst\n', '')
    expect(saved.saved).toBe(true)
    expect(readFileSync(empty.path, 'utf8')).toBe('* New\n\nfirst\n')
    expect(saved.doc.version).not.toBe('')
  })
})

describe('a save', () => {
  it('is refused, and writes nothing, when the file changed since it was read', () => {
    const project = makeProject()
    const first = scratchpad.saveScratchpad(project.id, 'one\n', '').doc
    // Somebody edits the file in another editor.
    writeFileSync(first.path, 'one\n\n---\n\ntwo from VS Code\n')

    const refused = scratchpad.saveScratchpad(project.id, 'one, edited here\n', first.version)
    expect(refused.saved).toBe(false)
    expect(refused.doc.text).toBe('one\n\n---\n\ntwo from VS Code\n')
    expect(readFileSync(first.path, 'utf8')).toBe('one\n\n---\n\ntwo from VS Code\n')

    // Saving against what is there now goes through.
    expect(scratchpad.saveScratchpad(project.id, 'merged\n', refused.doc.version).saved).toBe(true)
  })

  it('keeps a CRLF file CRLF while handing the renderer LF', () => {
    const project = makeProject()
    const file = join(project.root, 'notes.md')
    writeFileSync(file, 'a\r\n\r\n---\r\n\r\nb\r\n')
    const doc = scratchpad.setScratchpadPath(project.id, 'notes.md')
    expect(doc).toMatchObject({ text: 'a\n\n---\n\nb\n', eol: '\r\n', relativePath: 'notes.md' })

    expect(scratchpad.saveScratchpad(project.id, 'a\n\n---\n\nb, edited\n', doc.version).saved).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('a\r\n\r\n---\r\n\r\nb, edited\r\n')
  })
})

describe('setPath', () => {
  it('accepts a file inside the root, relative or absolute, and null goes back to the default', () => {
    const project = makeProject()
    mkdirSync(join(project.root, 'internal_docs'))
    writeFileSync(join(project.root, 'internal_docs', 'history.md'), 'kept\n')

    expect(scratchpad.setScratchpadPath(project.id, join(project.root, 'internal_docs', 'history.md')).text).toBe('kept\n')
    expect(scratchpad.readScratchpad(project.id).relativePath).toBe(join('internal_docs', 'history.md'))

    const back = scratchpad.setScratchpadPath(project.id, null)
    expect(back.relativePath).toBeNull()
    expect(back.path).toBe(scratchpad.defaultScratchpadPath(project.id))
  })

  it('refuses a file outside the root, the root itself, a directory, and a non-text extension', () => {
    const project = makeProject()
    mkdirSync(join(project.root, 'folder.md'))
    expect(() => scratchpad.setScratchpadPath(project.id, '../elsewhere.md')).toThrow(/inside/)
    expect(() => scratchpad.setScratchpadPath(project.id, join(dir, 'outside.md'))).toThrow(/inside/)
    expect(() => scratchpad.setScratchpadPath(project.id, '.')).toThrow(/inside/)
    expect(() => scratchpad.setScratchpadPath(project.id, 'folder.md')).toThrow(/not a file/)
    expect(() => scratchpad.setScratchpadPath(project.id, 'package.json')).toThrow(/\.md/)
    // Nothing refused was stored.
    expect(scratchpad.readScratchpad(project.id).relativePath).toBeNull()
  })
})
