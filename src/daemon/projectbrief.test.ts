import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let brief: typeof import('./projectbrief.js')
let api: typeof import('./api.js')
let prompt: typeof import('./prompt.js')
let claude: Worker

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-projectbrief-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  brief = await import('./projectbrief.js')
  api = await import('./api.js')
  prompt = await import('./prompt.js')
  db.openDb(join(dir, 'projectbrief.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'claude-1', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may retain a handle. */ }
})

/** A git repo with a committed project.json and the given remotes. */
function repo(name: string, config: object, remotes: Record<string, string>): string {
  const root = join(dir, name)
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  writeFileSync(join(root, '.warmstart', 'project.json'), JSON.stringify({ schema_version: 1, ...config }))
  execFileSync('git', ['init', '-q', root])
  for (const [remote, url] of Object.entries(remotes)) execFileSync('git', ['-C', root, 'remote', 'add', remote, url])
  return root
}

describe('project_settings (t906)', () => {
  it('reads remotes once each and never repeats a credential', () => {
    const parsed = brief.parseRemotes(
      'origin\thttps://shyoo:ghp_secret@github.com/shyoo/x.git (fetch)\n' +
        'origin\thttps://shyoo:ghp_secret@github.com/shyoo/x.git (push)\n' +
        'upstream\tgit@github.com:org/x.git (fetch)\n'
    )
    expect(parsed).toEqual([
      { name: 'origin', url: 'https://github.com/shyoo/x.git' },
      { name: 'upstream', url: 'git@github.com:org/x.git' }
    ])
  })

  it('tells a fork-home project’s agent where work lands and that upstream is not its to touch', async () => {
    // t905's project, as t903 left it: origin is the fork, upstream the original.
    const root = repo(
      'fork',
      { landing: { finish: 'commit-and-push', target: 'general', upstreamRemote: 'upstream' }, check: ['npm test'] },
      { origin: 'https://github.com/shyoo/Optiscaler-Client.git', upstream: 'https://github.com/Optiscaler-Client/Optiscaler-Client.git' }
    )
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'Reapply docs', status: 'ready', projectId: project.id })
    const sessionId = '00000000-0000-0000-0000-000000000906'
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
         values (?, ?, 'claude-code', 'stream', ?, ?, 'live', 'work', ?)`
      )
      .run(sessionId, claude.id, project.id, root, Date.now())
    tasks.startRun({ taskId: task.id, workerId: claude.id, sessionId, projectId: project.id, quotaUnverified: true, costModelId: null })
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })

    const result = await handlers['agent.projectSettings']({ sessionId })

    expect(result?.landing.finish).toMatchObject({ policy: 'commit-and-push', source: 'project' })
    expect(result?.landing.landsWith).toBe('commit-and-push')
    expect(result?.landing.target).toBe('general')
    expect(result?.landing.checks).toEqual(['npm test'])
    expect(result?.landing.whatHappens).toContain('pushes it to `origin` (your fork — never to `upstream`)')
    expect(result?.remotes.find((r) => r.name === 'origin')?.role).toContain('your fork, and home')
    expect(result?.remotes.find((r) => r.name === 'upstream')?.role).toContain('nothing lands here')
    expect(result?.mandate.mayLand).toBe(true)
    expect(result?.howToChange).toContain('Project Settings')
    // A session with no task is told so, not handed somebody else's project.
    expect(await handlers['agent.projectSettings']({ sessionId: 'not-a-live-session' })).toBeNull()
    // And the first prompt names the tool, so the agent reaches for it instead of asking.
    expect(prompt.promptFor(task, 'claude-code', false, { markDelivered: false }).text).toContain('`project_settings`')
  })

  it('names the gaps a person would want to fix', () => {
    const root = repo('nochecks', { landing: { finish: 'commit-and-merge' } }, {})
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'x', status: 'ready', projectId: project.id })
    const noLand = { ...task, mandate: { ...task.mandate, allowed: task.mandate.allowed.filter((op) => op !== 'land') } }

    const result = brief.projectBrief(noLand, project, [])

    expect(result.observations.join('\n')).toContain('declares no check commands, so every landing will hold')
    expect(result.observations.join('\n')).toContain('mandate does not include `land`')
    expect(result.landing.whatHappens).toContain('fast-forwards the local `main`')
  })

  it('says a non-landing policy needs a person, and where that is changed', () => {
    const root = repo('waits', { landing: { finish: 'await-human' } }, { origin: 'https://example.com/a.git' })
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'y', status: 'ready', projectId: project.id })

    const result = brief.projectBrief(task, project, brief.parseRemotes('origin\thttps://example.com/a.git (fetch)'))

    expect(result.landing.whatHappens).toContain('Nothing is landed')
    expect(result.observations.join('\n')).toContain('Project Settings › Finish policy')
  })
})
