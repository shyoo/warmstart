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
const ELECTRON_DIR = join(REPO, 'node_modules', 'electron')

/**
 * The Electron executable, wherever this platform puts it.
 *
 * ⛔ Ask `path.txt` rather than guessing. The installer writes the platform's own relative path
 * there - `electron.exe`, `electron`, or `Electron.app/Contents/MacOS/Electron` - and the guess this
 * replaced knew only the first two. Every macOS job in CI died here, on a machine where the binary
 * was present and correctly installed, reporting it missing.
 */
export function electronBinary() {
  const dist = join(ELECTRON_DIR, 'dist')
  const candidates = []
  try {
    candidates.push(join(dist, readFileSync(join(ELECTRON_DIR, 'path.txt'), 'utf8').trim()))
  } catch {
    // Not installed yet; the guesses below still give a useful answer on two of the three platforms.
  }
  candidates.push(
    join(dist, 'electron.exe'),
    join(dist, 'electron'),
    join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  )
  for (const candidate of candidates) if (existsSync(candidate)) return candidate

  // ⚠️ Not "npm blocked the postinstall". Electron 44 has no postinstall to block, so that
  // advice sent people looking for an npm setting that does not exist.
  throw new Error(
    'Electron binary is missing. Electron does not download itself; run:\n' +
      '  node scripts/ensure-electron.mjs'
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
 *
 * ⚠️ And never a bare pid either: pids are recycled, so identity is checked first. See below.
 */
export function killTree(pid, expect) {
  if (!pid) return
  // ⛔ No default. A wrong-but-plausible default silently declines to kill and leaks a process; being
  // forced to name what you expect is what makes the check honest rather than decorative.
  if (!expect) throw new Error('killTree needs a string that must appear in the target command line')

  // ⛔ Identity before force, and the harness is held to the same rule as the product.
  //
  // `ownsProcess()` in sessions.ts refuses to kill a pid it cannot prove is agentyard's, because
  // **pids are recycled**: a process we spawned can exit, Windows can hand its number to something
  // else, and a `finally` block firing seconds later then kills a stranger. The product has guarded
  // against that since M2. This harness did not - it killed a number it wrote down earlier - and it
  // is the harness that has actually damaged this machine before.
  //
  // If the command line cannot be read, the answer is **no**. A leaked test process costs a stale
  // port; killing the wrong one costs somebody their work.
  const line = commandLineOf(pid)
  if (line === null) {
    console.log(`SKIP  not stopping pid ${pid}: its command line could not be read`)
    return
  }
  if (!line.includes(expect)) {
    console.log(`SKIP  not stopping pid ${pid}: it is not ours any more (expected '${expect}')`)
    return
  }

  try {
    if (process.platform === 'win32') {
      // /T for the tree: Electron's renderer and GPU children outlive a kill of the parent, and one
      // of them keeps holding the debug port.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // Already gone. Nothing to stop.
  }
}

/** The process's own command line, or null if it cannot be read. ⛔ Null means "do not kill". */
function commandLineOf(pid) {
  try {
    if (process.platform === 'win32') {
      // ⚠️ Absolute, not on PATH. A thin PATH — a CI runner, a stripped shell — would otherwise make
      // this throw, and a failed identity read means "do not kill", which silently leaks the process
      // this was called to stop.
      //
      // ⛔ Built with `join`, never a backslash literal. Written as a template string this path was
      // silently wrong: `\S`, `\W` and `\v` are escape sequences, so it resolved to
      // `C:\WINDOWSSystem32WindowsPowerShell1.0powershell.exe` and threw ENOENT every time — which
      // read as "cannot verify" and quietly declined to kill anything.
      const root = process.env.SystemRoot ?? 'C:/Windows'
      return execFileSync(
        join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true }
      )
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 15_000
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------- assertions

let failures = 0
let checks = 0
let skipped = 0

export function check(name, condition, detail = '') {
  checks++
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
  return condition
}

/**
 * A check that could not run, with the reason it could not.
 *
 * ⛔ Counted and printed, never silent. A suite that quietly does less on a machine missing a CLI
 * would report "all checks passed" while proving less than it did yesterday, and nobody would notice
 * the coverage draining away. A skip is visible, states why, and is summarised separately from a pass.
 *
 * ⚠️ Only ever for a **capability of the machine** — an agent CLI that is not installed, a display
 * that does not exist. Never for something the code under test might have broken.
 */
export function skip(name, why) {
  skipped++
  console.log(`SKIP  ${name}  -- ${why}`)
}

/**
 * Which agent CLIs this machine actually has.
 *
 * A bare CI runner has none, and that is a normal machine rather than a broken one: scheduling,
 * tasks, cancellation, approvals, the controller and every piece of cost arithmetic are testable
 * without one. Only *spawning a real agent* needs a real binary.
 */
export async function detectClis(daemon) {
  const all = await daemon.rpc('adapter.detect')
  const byId = new Map(all.map((d) => [d.adapterId, d]))
  return {
    all,
    has: (id) => byId.get(id)?.found === true,
    any: all.some((d) => d.found)
  }
}

export function section(title) {
  console.log(`\n--- ${title} ---`)
}

export function summary(label) {
  // ⚠️ Skips are reported next to the result, never folded into it. "ALL 96 CHECKS PASSED" on a
  // machine that silently ran 80 of them is the kind of green nobody should trust.
  const tail = skipped ? ` (${skipped} skipped — no agent CLI on this machine)` : ''
  console.log(
    failures === 0
      ? `\n${label}: ALL ${checks} CHECKS PASSED${tail}`
      : `\n${label}: ${failures} of ${checks} CHECKS FAILED${tail}`
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
    // ⚠️ `orchestratord`, not `agentyard`. The daemon runs as `electron <path>/orchestratord.js`, so
    // that script name is what identifies it - the product name appears nowhere in its command line.
    // Getting this wrong does not fail loudly; it leaks a daemon and prints one SKIP line.
    killTree(this.child?.pid, 'orchestratord')
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

// ------------------------------------------------------------------ a CLI that is always installed

/**
 * A declarative adapter (M6) pointing at the OS command processor.
 *
 * ⛔ A probe, not an agent, and it could not become one: the generic driver reports unknown for
 * identity and quota, meters nothing, and cannot be granted `mcp` or `mintsSessionId` from a file.
 * It exists so that checks needing a *certainly present* command - does the PTY native load, does a
 * session that exits immediately keep its output - do not quietly become "skipped unless you have an
 * agent installed", which is every CI runner and every new contributor.
 *
 * ⛔ It spends nothing and resembles nothing: it echoes one line and exits.
 */
export const PROBE_ID = 'pack-pty-probe'
export const PROBE_COMMAND = process.platform === 'win32' ? 'cmd' : 'sh'
export const PROBE_ARGV =
  process.platform === 'win32'
    ? ['/d', '/c', 'echo agentyard-pty-probe']
    : ['-c', 'echo agentyard-pty-probe']

/** ⚠️ Must be written before the daemon starts: adapters are read once at boot. */
export function writeProbeAdapter(root) {
  const dir = join(root, 'adapters')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${PROBE_ID}.json`),
    `${JSON.stringify(
      {
        schema_version: 1,
        id: PROBE_ID,
        label: 'test probe (not an agent)',
        command: PROBE_COMMAND,
        // ⚠️ `--version` is the default and means nothing to a shell. Detection runs this, so it has
        // to be something the command actually answers.
        version_args: process.platform === 'win32' ? ['/d', '/c', 'ver'] : ['-c', 'echo sh'],
        cost_model_id: 'anthropic.subscription.2026-08'
      },
      null,
      2
    )}\n`
  )
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
