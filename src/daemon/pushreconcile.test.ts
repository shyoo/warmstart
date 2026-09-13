import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string
let store: typeof import('./db.js')
let reconcile: typeof import('./pushreconcile.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function project(): { id: string; taskId: string; root: string } {
  const root = join(dir, 'repo')
  const origin = join(dir, 'origin.git')
  mkdirSync(root, { recursive: true })
  git(dir, 'init', '--bare', '--initial-branch=main', origin)
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'warmstart test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(root, 'initial.txt'), 'initial\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '-u', 'origin', 'main')
  const now = Date.now()
  store.db().prepare(
    `insert into projects (id, name, root, vcs, config_json, config_path, created_at)
     values ('p1', 'repo', ?, 'git', '{}', null, ?)`
  ).run(root, now)
  store.db().prepare(
    `insert into tasks
       (id, seq, project_id, title, status, created_by_json, mandate_json, budget_json, created_at, updated_at)
     values ('t1', 1, 'p1', 'a task', 'completed', '{}', '{}', '{}', ?, ?)`
  ).run(now, now)
  return { id: 'p1', taskId: 't1', root }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'warmstart-pushreconcile-'))
  process.env.WARMSTART_DATA_DIR = dir
  store = await import('./db.js')
  store.openDb(join(dir, 'pushreconcile.db'))
  reconcile = await import('./pushreconcile.js')
})

afterAll(() => {
  store.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held Git handle on Windows is not a product failure.
  }
})

describe('later pushes of local landings', () => {
  it('reports a later remote observation once, without changing the historical landing message', async () => {
    const { taskId, root } = project()
    writeFileSync(join(root, 'local.txt'), 'local first\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'local landing')
    const sha = git(root, 'rev-parse', 'HEAD')
    const original = `Landed as \`${sha.slice(0, 8)}\` onto \`main\` — local only, **not pushed**`
    store.db().prepare(
      `insert into task_messages (task_id, role, text, event, ts)
       values (?, 'system', ?, 'landing.landed', ?)`
    ).run(taskId, original, Date.now())

    expect(await reconcile.reconcilePushedLandings()).toBe(0)
    expect(store.db().prepare('select count(*) as count from task_messages').get()).toEqual({ count: 1 })

    git(root, 'push', 'origin', 'main')
    expect(await reconcile.reconcilePushedLandings()).toBe(1)
    expect(await reconcile.reconcilePushedLandings()).toBe(0)

    const messages = store.db().prepare(
      'select text, event, detail from task_messages where task_id = ? order by id'
    ).all(taskId) as Array<{ text: string; event: string; detail: string | null }>
    expect(messages).toHaveLength(2)
    expect(messages[0]?.text).toBe(original)
    expect(messages[1]).toMatchObject({
      text: `Later observed: \`${sha.slice(0, 8)}\` is now on \`origin/main\``,
      event: 'landing.pushed-later'
    })
    expect(messages[1]?.detail).toContain('later fetch confirmed')
  })
})
