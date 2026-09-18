import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-projectorder-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  db.openDb(join(dir, 'projectorder.db'))
})

afterAll(() => {
  db.closeDb()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may retain a handle. */ }
})

function add(name: string) {
  const root = join(dir, name)
  mkdirSync(root)
  return projects.addProject({ root, name })
}

describe('persistent project ordering', () => {
  it('stores a complete order and appends later projects', () => {
    const alpha = add('alpha')
    const beta = add('beta')
    const gamma = add('gamma')
    expect(projects.reorderProjects([gamma.id, alpha.id, beta.id]).map((p) => p.id)).toEqual([
      gamma.id, alpha.id, beta.id
    ])
    expect(projects.listProjects().map((p) => p.id)).toEqual([gamma.id, alpha.id, beta.id])

    const delta = add('delta')
    expect(projects.listProjects().map((p) => p.id)).toEqual([gamma.id, alpha.id, beta.id, delta.id])
  })

  it('refuses duplicate, missing and unknown entries', () => {
    const ids = projects.listProjects().map((p) => p.id)
    expect(() => projects.reorderProjects(ids.slice(1))).toThrow('every active project')
    expect(() => projects.reorderProjects([...ids.slice(0, -1), ids[0] as string])).toThrow('listed twice')
    expect(() => projects.reorderProjects([...ids.slice(0, -1), 'missing'])).toThrow("no active project 'missing'")
  })
})
