import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Shared test harness.
 *
 * ⛔ Four fixture rules, and the first two exist because breaking them damages the developer's own
 * machine (plan §19.3):
 *
 *  1. `AGENTYARD_DATA_DIR` always points at a fresh temp directory. No test touches the real fleet.
 *  2. **Never kill by image name.** `stop()` kills the pid it started, and nothing else. A
 *     `taskkill /IM electron.exe` also takes out the developer's editor and any agent window they had
 *     open - that happened for real during M2.
 *  3. Git tests use a throwaway repo with a local bare origin, created and destroyed here.
 *  4. Adopting a real credential root is read-only: prove identity detection, never log in or out.
 */

export const REPO = process.cwd()
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const ELECTRON_POSIX = join(REPO, 'node_modules', 'electron', 'dist', 'electron')

export function electronBinary() {
  if (existsSync(ELECTRON)) return ELECTRON
  if (existsSync(ELECTRON_POSIX)) return ELECTRON_POSIX
  throw new Error(
    'Electron binary is missing. If npm blocked its postinstall, run:\n' +
      '  node node_modules/electron/install.js'
  )
}

/**
 * Stop a process **and its children**, by pid.
 *
 * ⚠️ `child.kill()` on Windows kills only the process you started. Electron's renderer and GPU
 * children survive it, and one of them keeps holding the remote-debugging port - so the next run of
 * this suite fails with "the app did not expose a debugging target", which looks like a product bug
 * and is not one.
 *
 * ⛔ `/PID <pid> /T` walks that one tree. Never `/IM`, which walks every process sharing the binary -
 * the developer's editor included.
 */
export function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // Already gone, or never started. Either way there is nothing to stop.
  }
}

// ---------------------------------------------------------------------------- assertions

let failures = 0
let checks = 0

export function check(name, condition, detail = '') {
  checks++
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  return condition
}

export function section(title) {
  console.log(`\n--- ${title} ---`)
}

export function summary(label) {
  console.log(
    failures === 0
      ? `\n${label}: ALL ${checks} CHECKS PASSED`
      : `\n${label}: ${failures} of ${checks} CHECKS FAILED`
  )
  return failures
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------- the daemon

export class Daemon {
  constructor() {
    this.dataDir = mkdtempSync(join(tmpdir(), 'agentyard-test-'))
    this.child = null
    this.endpoint = null
  }

  async start() {
    const script = join(REPO, 'out', 'main', 'orchestratord.js')
    if (!existsSync(script)) throw new Error(`${script} is missing - run npm run build first`)

    this.child = spawn(electronBinary(), [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTYARD_DATA_DIR: this.dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child.stdout.on('data', (d) => process.env.AGENTYARD_TEST_VERBOSE && process.stdout.write(`[d] ${d}`))
    this.child.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`))

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await wait(250)
      try {
        this.endpoint = JSON.parse(readFileSync(join(this.dataDir, 'orchestratord.json'), 'utf8'))
        if (await this.healthy()) return this
      } catch {
        // Not up yet.
      }
    }
    throw new Error('orchestratord did not start within 30s')
  }

  async healthy() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.endpoint.port}/health`, {
        headers: { authorization: `Bearer ${this.endpoint.token}` },
        signal: AbortSignal.timeout(2000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  async rpc(method, params) {
    const res = await fetch(`http://127.0.0.1:${this.endpoint.port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.endpoint.token}`
      },
      body: JSON.stringify({ id: Date.now(), method, params })
    })
    const body = await res.json()
    if (!body.ok) throw new Error(`${method}: ${body.error.message}`)
    return body.result
  }

  /** For asserting on failures without try/catch noise. */
  async rpcResult(method, params) {
    try {
      return { ok: true, result: await this.rpc(method, params) }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  stop() {
    // ⛔ By pid, never by image name. See the rule at the top of this file.
    killTree(this.child?.pid)
    this.child = null
  }

  cleanup() {
    this.stop()
    try {
      rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A locked sqlite file on Windows is not worth failing a passing test over.
    }
  }
}

// ---------------------------------------------------------------------------- a throwaway repo

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * A real git project with a local bare `origin`, so landing can be asserted against a real push.
 * ⛔ Never the agentyard repository, and never a remote that exists.
 */
export function makeProject(root, options = {}) {
  const origin = `${root}-origin.git`
  for (const p of [origin, root, `${root}_workspaces`]) {
    rmSync(p, { recursive: true, force: true })
  }
  mkdirSync(origin, { recursive: true })
  mkdirSync(root, { recursive: true })
  git(origin, 'init', '--bare', '--initial-branch=main')
  git(root, 'init', '--initial-branch=main')
  git(root, 'remote', 'add', 'origin', origin)
  // Local identity, so the test does not depend on the developer's global git config.
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')

  writeFileSync(join(root, 'README.md'), '# fixture\n')
  mkdirSync(join(root, '.agentyard'), { recursive: true })
  writeFileSync(
    join(root, '.agentyard', 'project.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        name: options.name ?? 'fixture',
        vcs: 'git',
        workspaces: { poolSize: options.poolSize ?? 2 },
        prepare: [],
        check: options.check ?? [],
        landing: { strategy: 'auto-land', target: 'main' }
      },
      null,
      2
    )}\n`
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  git(root, 'push', '-u', 'origin', 'main')
  return { root, origin, git }
}

export function destroyProject(root) {
  for (const p of [`${root}-origin.git`, root, `${root}_workspaces`]) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Windows holds git pack files briefly; a leftover temp dir is harmless.
    }
  }
}

export { git }
