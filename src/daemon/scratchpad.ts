import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ScratchpadDoc, ScratchpadSave } from '@shared/protocol.js'
import { db, row } from './db.js'
import { samePath, withinPath } from './fspath.js'
import { log } from './log.js'
import { paths } from './paths.js'
import { requireProject } from './projects.js'

/**
 * A project's scratchpad: one markdown file of prompts the operator has not filed yet (t994).
 *
 * ⛔ **The file is the record, not a table.** The operator kept these by hand in VS Code before this
 * existed, split by `---` lines and marked with `* New`; the renderer splits the same text into cards
 * and writes the same text back, so the file stays readable and editable where it was. Nothing here
 * parses it — the daemon reads and writes bytes and answers *has it changed*.
 *
 * ⭐ **Private by default.** The default file is `<data dir>/scratchpads/<project id>.md`: never in the
 * repository, never in an agent's worktree. `scratchpad.setPath` re-points one project at a file
 * inside its own root (an existing prompt history, say); the choice is a row in `scratchpads`, on
 * this install only, and never written to `project.json`.
 *
 * ⛔ **A save names the version it was edited from.** VS Code and this app may both have the file
 * open; a save whose base no longer matches the disk is refused with what *is* there, and never
 * written over it. Nothing is merged on the operator's behalf.
 */

/** Extensions a scratchpad may be pointed at. It is drawn as markdown, so it should be text. */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

function storedPath(projectId: string): string | null {
  return row<{ path: string }>(db().prepare('select path from scratchpads where project_id = ?').get(projectId))?.path ?? null
}

export function defaultScratchpadPath(projectId: string): string {
  return join(paths.root, 'scratchpads', `${projectId}.md`)
}

/** The file, and what it was named relative to, for a project. */
function locate(projectId: string): { file: string; relativePath: string | null } {
  const project = requireProject(projectId)
  const chosen = storedPath(projectId)
  if (!chosen) return { file: defaultScratchpadPath(project.id), relativePath: null }
  return { file: resolve(project.root, chosen), relativePath: chosen }
}

/** Over the bytes on disk, so a save made through a different line ending still reads as a change. */
function versionOf(raw: string | null): string {
  return raw === null ? '' : createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** `\r\n` only when the file already uses it more often than not; a new file is `\n`. */
function eolOf(raw: string): '\n' | '\r\n' {
  const crlf = raw.split('\r\n').length - 1
  const lf = raw.split('\n').length - 1 - crlf
  return crlf > lf ? '\r\n' : '\n'
}

function readRaw(file: string): string | null {
  if (!existsSync(file)) return null
  if (!statSync(file).isFile()) throw new Error(`${file} is not a file`)
  return readFileSync(file, 'utf8')
}

/**
 * ⚠️ The renderer edits in a `<textarea>`, which reads every line ending as `\n`. The text goes out
 * as `\n` and comes back through `eol`, so saving one card of a CRLF file does not rewrite every line
 * of it.
 */
export function readScratchpad(projectId: string): ScratchpadDoc {
  const { file, relativePath } = locate(projectId)
  const raw = readRaw(file)
  return {
    projectId,
    path: file,
    relativePath,
    exists: raw !== null,
    text: raw === null ? '' : raw.replace(/\r\n/g, '\n'),
    eol: raw === null ? '\n' : eolOf(raw),
    version: versionOf(raw)
  }
}

export function saveScratchpad(projectId: string, text: string, baseVersion: string): ScratchpadSave {
  const { file } = locate(projectId)
  const before = readRaw(file)
  if (versionOf(before) !== baseVersion) {
    log.info(`scratchpad ${projectId}: save refused, ${file} changed since it was read`)
    return { saved: false, doc: readScratchpad(projectId) }
  }
  const eol = before === null ? '\n' : eolOf(before)
  const normalized = text.replace(/\r\n/g, '\n')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, eol === '\n' ? normalized : normalized.replace(/\n/g, eol), 'utf8')
  return { saved: true, doc: readScratchpad(projectId) }
}

/**
 * Point a project's scratchpad at a file inside its root, or `null` for the private default.
 *
 * ⛔ **Inside the project root, and text.** The renderer holds no filesystem authority of its own, so
 * this is the line a path typed into Settings cannot cross: no `..`, no other repository, no data
 * directory. A file that does not exist yet is accepted and created by the first save.
 */
export function setScratchpadPath(projectId: string, path: string | null): ScratchpadDoc {
  const project = requireProject(projectId)
  const trimmed = path?.trim() ?? ''
  if (!trimmed) {
    db().prepare('delete from scratchpads where project_id = ?').run(project.id)
    return readScratchpad(project.id)
  }
  const file = isAbsolute(trimmed) ? resolve(trimmed) : resolve(project.root, trimmed)
  if (!withinPath(project.root, file) || samePath(project.root, file)) {
    throw new Error(`The scratchpad must be a file inside ${project.root}.`)
  }
  if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) {
    throw new Error('The scratchpad must be a .md, .markdown or .txt file.')
  }
  if (existsSync(file) && !statSync(file).isFile()) throw new Error(`${file} is not a file.`)
  const stored = relative(project.root, file)
  db()
    .prepare(
      `insert into scratchpads (project_id, path, updated_at) values (?,?,?)
         on conflict(project_id) do update set path = excluded.path, updated_at = excluded.updated_at`
    )
    .run(project.id, stored, Date.now())
  log.info(`scratchpad ${project.name}: now ${stored}`)
  return readScratchpad(project.id)
}
