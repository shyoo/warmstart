import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, db } from './db.js'
import { addProject, relocateProject } from './projects.js'
import { git, openTestDb } from './testkit.js'

describe('relocateProject VCS preservation', () => {
  let dbDir: string
  let workDir: string

  beforeAll(() => {
    dbDir = openTestDb('proj-reloc-')
    workDir = mkdtempSync(join(tmpdir(), 'proj-reloc-repo-'))
  })

  afterAll(() => {
    closeDb()
    try {
      rmSync(dbDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  })

  it('preserves local jj migration when relocated directory project.json declares git', () => {
    const oldRoot = join(workDir, 'old')
    const newRoot = join(workDir, 'new')
    for (const root of [oldRoot, newRoot]) {
      mkdirSync(join(root, '.warmstart'), { recursive: true })
      git(root, 'init', '--initial-branch=main')
      writeFileSync(
        join(root, '.warmstart', 'project.json'),
        JSON.stringify({ schema_version: 1, name: 'reloc-jj', vcs: 'git' })
      )
    }

    const project = addProject({ root: oldRoot })
    expect(project.vcs).toBe('git')
    db().prepare("update projects set vcs = 'jj' where id = ?").run(project.id)

    const relocated = relocateProject(project.id, newRoot)
    expect(relocated.vcs).toBe('jj')
    expect(relocated.root.toLowerCase()).toBe(newRoot.toLowerCase())

    writeFileSync(
      join(newRoot, '.warmstart', 'project.json'),
      JSON.stringify({ schema_version: 1, name: 'reloc-jj', vcs: 'none' })
    )
    const nonVcs = relocateProject(project.id, newRoot)
    expect(nonVcs.vcs).toBe('none')
  })
})
