import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-projectarchive-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  db.openDb(join(dir, 'projectarchive.db'))
})

afterAll(() => {
  db.closeDb()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may retain a handle. */ }
})

function add(name: string) {
  const root = join(dir, name)
  mkdirSync(root)
  return { root, project: projects.addProject({ root, name }) }
}

describe('archiving a project (t901)', () => {
  it('is refused while a task can still dispatch, run or land', () => {
    const { project } = add('busy')
    const task = tasks.createTask({ title: 'still going', projectId: project.id })
    expect(projects.archiveRefusal(project.id)).toContain('1 unfinished task')
    expect(() => projects.archiveProject(project.id)).toThrow('unfinished task')
    expect(projects.listProjects().map((p) => p.id)).toContain(project.id)

    // Terminal, draft and deleted tasks do not hold a project open.
    tasks.setStatus(task.id, 'failed')
    const draft = tasks.createTask({ title: 'not yet', projectId: project.id })
    tasks.setStatus(draft.id, 'draft')
    expect(projects.archiveRefusal(project.id)).toBeNull()
    const archived = projects.archiveProject(project.id)
    expect(archived.archivedAt).not.toBeNull()
    expect(projects.listProjects().map((p) => p.id)).not.toContain(project.id)
    expect(projects.listArchivedProjects().map((p) => p.id)).toEqual([project.id])
  })

  it('unarchives to the end of the active order', () => {
    const { project: other } = add('other')
    const [archived] = projects.listArchivedProjects()
    const back = projects.unarchiveProject(archived!.id)
    expect(back.archivedAt).toBeNull()
    expect(projects.listProjects().map((p) => p.id)).toEqual([other.id, archived!.id])
    expect(projects.listArchivedProjects()).toEqual([])
  })

  it('comes back when its folder is added again', () => {
    const { root, project } = add('readded')
    projects.archiveProject(project.id)
    expect(projects.listProjects().map((p) => p.id)).not.toContain(project.id)
    const again = projects.addProject({ root })
    expect(again.id).toBe(project.id)
    expect(again.archivedAt).toBeNull()
    expect(projects.listProjects().map((p) => p.id)).toContain(project.id)
  })
})
