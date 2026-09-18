import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * Recognising and recovering from a project whose directory moved.
 *
 * ⛔ **Against real directories, not a mocked `existsSync`.** `rootExists` is exactly the fact that a
 * `c:\Dev\magic_writer` → `c:\Dev\inkland` rename needs surfaced, and the only thing that proves it
 * is watching the flag flip after an actual `renameSync`.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')

let seq = 0

function makeProject(): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  return projects.addProject({ root })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-projectrelocate-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  db.openDb(join(dir, 'projectrelocate.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('rootExists', () => {
  it('is true for a project whose directory is where it was added', () => {
    const project = makeProject()
    expect(project.rootExists).toBe(true)
  })

  it('flips false once the directory is renamed outside Warmstart, and stays false on reload', () => {
    const project = makeProject()
    const moved = join(dir, `${project.name}-renamed`)
    renameSync(project.root, moved)

    expect(projects.getProject(project.id)?.rootExists).toBe(false)
    expect(projects.listProjects().find((p) => p.id === project.id)?.rootExists).toBe(false)
  })
})

describe('relocateProject', () => {
  it('points the same project id at its new directory and marks it found again', () => {
    const project = makeProject()
    const moved = join(dir, `${project.name}-moved`)
    renameSync(project.root, moved)
    expect(projects.getProject(project.id)?.rootExists).toBe(false)

    const relocated = projects.relocateProject(project.id, moved)

    expect(relocated.id).toBe(project.id)
    expect(relocated.rootExists).toBe(true)
    expect(relocated.root).toBe(projects.getProject(project.id)?.root)
  })

  it('refuses a directory that does not exist', () => {
    const project = makeProject()
    expect(() => projects.relocateProject(project.id, join(dir, 'nowhere'))).toThrow(/does not exist/)
  })

  it('refuses a directory another project already claims', () => {
    const a = makeProject()
    const b = makeProject()
    expect(() => projects.relocateProject(a.id, b.root)).toThrow(/already registered/)
  })
})
