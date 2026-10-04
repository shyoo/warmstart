import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

describe('renaming and deleting a project (t906)', () => {
  it('renames on the row and refuses an empty name', () => {
    const { project } = add('renamed')
    expect(projects.renameProject(project.id, '  New name  ').name).toBe('New name')
    expect(() => projects.renameProject(project.id, '   ')).toThrow('needs a name')
    expect(projects.requireProject(project.id).name).toBe('New name')
  })

  it('is refused while a task can still run, even on an archived project', () => {
    const { project } = add('deletebusy')
    projects.archiveProject(project.id)
    // A reply to a finished task can re-run it inside an archived project.
    tasks.createTask({ title: 'woken up', projectId: project.id })
    expect(projects.deleteRefusal(project.id)).toContain('before deleting')
    expect(() => projects.deleteProject(project.id)).toThrow('unfinished task')
  })

  it('leaves every list but keeps the row, its history and the folder, and comes back when re-added', () => {
    const { root, project } = add('deleted')
    const done = tasks.createTask({ title: 'history', projectId: project.id })
    tasks.setStatus(done.id, 'completed')
    projects.deleteProject(project.id)
    expect(projects.listProjects().map((p) => p.id)).not.toContain(project.id)
    expect(projects.listArchivedProjects().map((p) => p.id)).not.toContain(project.id)
    expect(projects.listProjects(true).map((p) => p.id)).not.toContain(project.id)
    // Soft: what its tasks and runs name still resolves, and nothing on disk moved.
    expect(projects.getProject(project.id)?.name).toBe('deleted')
    expect(existsSync(root)).toBe(true)
    expect(tasks.getTask(done.id)?.projectId).toBe(project.id)

    const again = projects.addProject({ root })
    expect(again.id).toBe(project.id)
    expect(again.archivedAt).toBeNull()
    expect(projects.listProjects().map((p) => p.id)).toContain(project.id)
  })
})
