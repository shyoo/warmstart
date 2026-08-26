import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { REPO, check, killTree, section, skip, summary, wait } from './lib/harness.mjs'

/**
 * L5: the packaged application.
 *
 * ⛔ **This is the only suite that can fail for reasons none of the others can see.** L0–L4 all run
 * against `out/`, from a source tree, with `node_modules` on disk. A packaged app is a different
 * world: the code lives inside an asar archive, native modules must have been unpacked out of it,
 * and there is no system Node — the daemon and the MCP server exist only because the app can run its
 * own binary as Node. Every one of those is a way to ship something that passed every test and does
 * not start.
 *
 * Free: it spends no tokens and signs nothing in. Slow: it builds a real package, so it is its own
 * script (`npm run test:pack`) rather than part of `test:all`.
 *
 * ⚠️ Windows-and-macOS-and-Linux-shaped, but only ever *run* on the platform you are on. It cannot
 * tell you the macOS build works; it can tell you this platform's does. That limitation is the
 * milestone's honest state and is recorded in HANDOFF rather than papered over.
 */

const OUT = join(REPO, 'release')
const dataDir = mkdtempSync(join(tmpdir(), 'agentyard-pack-'))
let app = null

/** Where electron-builder leaves the unpacked app for this platform. */
function unpackedDir() {
  const candidates = {
    win32: ['win-unpacked', 'win-arm64-unpacked'],
    darwin: ['mac', 'mac-arm64', 'mac-universal'],
    linux: ['linux-unpacked', 'linux-arm64-unpacked']
  }[process.platform] ?? []
  for (const name of candidates) {
    const full = join(OUT, name)
    if (existsSync(full)) return full
  }
  return null
}

/** The executable inside it. */
function binaryIn(dir) {
  if (process.platform === 'win32') return join(dir, 'agentyard.exe')
  if (process.platform === 'darwin') return join(dir, 'agentyard.app', 'Contents', 'MacOS', 'agentyard')
  return join(dir, 'agentyard')
}

function findFiles(dir, predicate, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return []
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) found.push(...findFiles(full, predicate, depth + 1))
    else if (predicate(name, full)) found.push(full)
  }
  return found
}

/**
 * A declarative adapter pointing at the OS command processor.
 *
 * ⛔ It is a *probe*, not an agent, and could not become one: M6's generic driver reports unknown
 * for identity and quota, meters nothing, and cannot be granted `mcp` or `mintsSessionId` from a
 * file. It exists so the native-module check has something certain to open a pseudo-terminal on.
 */
const PROBE_ID = 'pack-pty-probe'
const PROBE_COMMAND = process.platform === 'win32' ? 'cmd' : 'sh'
const PROBE_ARGV =
  process.platform === 'win32'
    ? ['/d', '/c', 'echo agentyard-pty-probe']
    : ['-c', 'echo agentyard-pty-probe']

function writeProbeAdapter(root) {
  const dir = join(root, 'adapters')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${PROBE_ID}.json`),
    `${JSON.stringify(
      {
        schema_version: 1,
        id: PROBE_ID,
        label: 'packaging probe (not an agent)',
        command: PROBE_COMMAND,
        // ⚠️ `--version` is the default and means nothing to a shell. Detection runs this, so it has
        // to be something the command actually answers.
        version_args: process.platform === 'win32' ? ['/d', '/c', 'ver'] : ['-c', 'echo sh'],
        cost_model_id: 'anthropic.subscription.2026-08'
      },
      null,
      2
    )}
`
  )
}

try {
  section('the package exists')
  const dir = unpackedDir()
  check(
    'electron-builder produced an unpacked app for this platform',
    dir !== null,
    dir ?? `nothing under ${OUT} — run: npm run pack`
  )
  if (!dir) throw new Error('nothing to test')

  const binary = binaryIn(dir)
  check('the executable is where the packaging config says', existsSync(binary), binary)

  const resources = join(dir, process.platform === 'darwin' ? 'agentyard.app/Contents/Resources' : 'resources')
  check('the app is archived into an asar', existsSync(join(resources, 'app.asar')))

  // ---------------------------------------------------------------- natives
  section('native modules')
  const unpacked = join(resources, 'app.asar.unpacked')
  const natives = findFiles(unpacked, (name) => name.endsWith('.node'))
  check(
    'the PTY native is unpacked OUT of the asar',
    natives.length > 0,
    natives.map((n) => n.slice(unpacked.length + 1)).join(', ')
  )
  // ⛔ The failure this catches: a `.node` left inside the archive loads fine in development and
  // throws at runtime in a packaged build, because dlopen needs a real path and an asar is virtual.
  const insideArchive = findFiles(join(resources, 'app'), (name) => name.endsWith('.node'))
  check('and none was left behind inside it', insideArchive.length === 0)

  check(
    'no second native module crept in',
    natives.every((n) => n.includes('node-pty')),
    'node:sqlite was chosen at M1 precisely so there is only ever one thing to unpack'
  )

  // ---------------------------------------------------------------- it runs
  section('the packaged app starts its own daemon')
  // ⛔ A private data directory. This must not touch the developer's real fleet, and the packaged
  // app reads AGENTYARD_DATA_DIR exactly as the development build does - which is itself the thing
  // being checked.
  // ⛔ Declared before the app starts, because adapters are read once at daemon boot.
  //
  // Two checks below need a CLI that is certainly installed, and no *agent* CLI qualifies: CI has
  // none, and writing them as "skip if absent" would retire the single most valuable check in this
  // suite — whether the unpacked native actually loads — on every machine that has not already got
  // an agent set up. The OS command processor is always there, so M6's declarative adapter is
  // pointed at it. Nothing here spends, signs in, or resembles an agent: it echoes and exits.
  writeProbeAdapter(dataDir)

  // ⚠️ Piped, not ignored. When the app failed to start on Linux this said only "the packaged app
  // did not launch orchestratord", with the reason - printed by the app to stderr - thrown away.
  // A check that cannot say why it failed costs a CI round trip every time it goes red.
  const appOutput = []
  app = spawn(binary, [], {
    env: { ...process.env, AGENTYARD_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  app.stdout.on('data', (d) => appOutput.push(String(d)))
  app.stderr.on('data', (d) => appOutput.push(String(d)))
  app.on('error', (err) => appOutput.push(`spawn failed: ${err.message}
`))

  const endpointFile = join(dataDir, 'orchestratord.json')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !existsSync(endpointFile)) await wait(500)

  const launched = existsSync(endpointFile)
  check(
    'the packaged app launches orchestratord with no system Node installed',
    launched,
    launched
      ? 'ELECTRON_RUN_AS_NODE on its own binary - the reason M1 chose this topology'
      : `exited ${app.exitCode}; it said: ${appOutput.join('').trim().slice(-1500) || '(nothing)'}`
  )

  if (existsSync(endpointFile)) {
    const { readFileSync } = await import('node:fs')
    const endpoint = JSON.parse(readFileSync(endpointFile, 'utf8'))
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
      headers: { authorization: `Bearer ${endpoint.token}` }
    })
    const body = await res.json()
    check('and it answers on its own RPC', body.ok === true, `v${body.version ?? body.result?.version ?? '?'}`)

    const rpc = async (method, params) => {
      const r = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ id: 1, method, params })
      })
      return r.json()
    }

    const models = await rpc('costmodel.list')
    check(
      'every cost model survived packaging',
      (models.result ?? []).length >= 3,
      // ⛔ The reason they are compiled in rather than copied beside the binary: a `files` glob that
      // missed them would leave a scheduler that cannot price anything, and nothing would say so.
      (models.result ?? []).map((m) => m.id).join(', ')
    )

    const adapters = await rpc('adapter.list')
    const ids = (adapters.result ?? []).map((a) => a.id)
    // ⛔ By name, not by count. The claim is that the three compiled-in adapters survived being put
    // inside an asar; a length check also silently asserted that nobody ever declares a fourth, and
    // the probe adapter below is a fourth.
    check(
      'every built-in adapter survived packaging',
      ['claude-code', 'antigravity-cli', 'openai-compatible'].every((id) => ids.includes(id)),
      ids.join(', ')
    )

    const detect = await rpc('adapter.detect')
    const detected = detect.result ?? []
    // ⛔ The property is *PATH survives packaging*, not *this machine has an agent installed*. They
    // are not the same claim, and asserting the second is how this failed on a runner while the app
    // was fine. A packaged GUI app really can be handed a stripped environment — that is the failure
    // worth catching — so it is checked against a command every machine has.
    check(
      'a packaged app still resolves commands on PATH',
      detected.find((d) => d.adapterId === PROBE_ID)?.found === true,
      detected.find((d) => d.adapterId === PROBE_ID)?.error ?? `${PROBE_COMMAND} resolved`
    )
    // And the agent CLIs, where there are any. ⚠️ Reported separately so a green CI run is never
    // read as "the packaged app found Claude Code".
    const agents = detected.filter((d) => d.adapterId !== PROBE_ID)
    if (agents.some((d) => d.found)) {
      check(
        'and it finds the agent CLIs this machine has',
        true,
        agents.map((d) => `${d.adapterId}:${d.found ? d.version : 'no'}`).join(' ')
      )
    } else {
      skip('and it finds the agent CLIs this machine has', 'no agent CLI is installed here')
    }

    // ---------------------------------------------------------------- the native, for real
    section('node-pty, from inside the package')
    const worker = await rpc('worker.create', {
      // ⛔ The probe adapter, not claude-code. This used to spawn `claude --version`, which made the
      // packaging check that matters most conditional on the developer having an agent installed —
      // and it is CI, with nothing installed, that this check exists to serve.
      adapterId: PROBE_ID,
      label: 'pack test',
      // ⛔ Closed to work at creation. This suite must not be able to dispatch anything.
      enabled: false
    })
    const session = await rpc('session.spawn', {
      workerId: worker.result.id,
      cwd: REPO,
      transport: 'pty',
      purpose: 'login',
      // Echoes one line and exits. All that is being proved here is that the native module loaded
      // and a pseudo-terminal opened at all - nothing about any agent.
      argv: PROBE_ARGV,
      cols: 80,
      rows: 24
    })
    check(
      'a PTY opens from the packaged app',
      typeof session.result?.pid === 'number' && session.result.pid > 0,
      // ⛔ The single most likely packaging failure, and invisible until someone opens a terminal:
      // conpty.node inside the asar loads in dev and throws here.
      `pid ${session.result?.pid} — the unpacked native actually loaded`
    )
    // ⚠️ Polled rather than slept once. A packaged app on a cold start is slower than a development
    // one - Windows Defender inspects a freshly written, unsigned binary the first time it runs -
    // and a fixed sleep here would be a test that fails on somebody else's machine for no reason.
    let back = { result: { data: '' } }
    const outputBy = Date.now() + 20_000
    while (Date.now() < outputBy) {
      back = await rpc('session.backscroll', { id: session.result.id })
      if ((back.result?.data ?? '').length > 0) break
      await wait(500)
    }
    check(
      'and it produces output through the packaged binary',
      (back.result?.data ?? '').length > 0,
      `${(back.result?.data ?? '').length} bytes`
    )
    await rpc('session.close', { id: session.result.id })

    const doctor = await rpc('doctor.run')
    check(
      'doctor reports the packaged data directory, not a development one',
      doctor.result?.daemon?.dbPath?.startsWith(dataDir),
      doctor.result?.daemon?.dbPath
    )
  }
} catch (err) {
  check('the suite ran to completion', false, err instanceof Error ? err.stack : String(err))
} finally {
  // ⛔ By pid, verified, and the whole tree. Never by image name - that takes out the developer's
  // editor and any agent window they had open, which happened for real during M2. And never a bare
  // pid: killTree re-reads the command line first, because a recycled pid points at a stranger.
  killTree(app?.pid, 'agentyard')
  await wait(1000)
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // A locked file is not worth failing a passing suite over.
  }
}

process.exit(summary('pack') === 0 ? 0 : 1)
