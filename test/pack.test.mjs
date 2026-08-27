import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PROBE_ARGV,
  PROBE_COMMAND,
  PROBE_ID,
  REPO,
  check,
  killTree,
  section,
  skip,
  summary,
  wait,
  writeProbeAdapter
} from './lib/harness.mjs'

/** Split an .ico into its layers, each of which is a standalone BMP or PNG payload. */
function icoLayers(path) {
  const ico = readFileSync(path)
  const count = ico.readUInt16LE(4)
  const layers = []
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    const size = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    layers.push(ico.subarray(offset, offset + size))
  }
  return layers
}

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

/**
 * Where `npm run pack` puts the package this suite drives — electron-builder's own default.
 *
 * ⚠️ **This was `release/suite/` until 2026-08-27**, a second unpacked copy that existed so that
 * packaging could not collide with an app being run out of `release/win-unpacked/`. That split
 * cost ~250MB and one permanent confusion — two identical executables, only ever one of them
 * new — and it is gone because the workflow it defended against is gone: the app to *use* is the
 * one the installer installs, and this directory is the build's alone.
 *
 * ⛔ So running the repo's own `release/win-unpacked/` while building will fail the pack step
 * with `EPERM`/`EBUSY` again, and that is now the correct behaviour rather than a bug: nothing
 * should be executing out of a directory electron-builder is about to delete.
 */
const OUT = join(REPO, 'release')
// ⛔ electron-builder's `productName`, not the npm package name: it names the .app bundle and its
// Resources directory on macOS.
const PRODUCT = 'Multi Agent Controller'

/**
 * The executable's own name, which is **not** `productName` on every platform.
 *
 * ⚠️ Linux sanitises it, and `electron-builder.yml` pins the result with `executableName`. This was
 * invisible while the product was called `agentyard`: a lowercase single word survives the sanitiser
 * untouched, so one constant appeared to work everywhere right up until the rename gave it a space.
 */
const EXECUTABLE = process.platform === 'linux' ? 'multi-agent-controller' : PRODUCT
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
  if (process.platform === 'win32') return join(dir, `${EXECUTABLE}.exe`)
  if (process.platform === 'darwin') return join(dir, `${PRODUCT}.app`, 'Contents', 'MacOS', EXECUTABLE)
  return join(dir, EXECUTABLE)
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

  // ⛔ **Is this package the one we just wrote?**
  //
  // This suite reads `release/` and never builds it, which is right — building is `npm run pack`'s
  // job — but it means a failed or skipped build leaves the previous package sitting there and every
  // check below passes against code that no longer exists. That happened twice on 2026-08-27, both
  // times because `npm run pack` had died with `EBUSY: rmdir release\win-unpacked` (something was
  // running the packaged app), and both times the suite reported a confident 17/17 for a tree it had
  // never seen. A green suite that proves nothing is worse than a red one.
  //
  // ⚠️ Compared against `src/`, not `out/`. `out/` is a build product and moves whenever anything
  // runs a build; the question being asked is whether the package contains the current *source*.
  //
  // ⛔ The archive is **found**, not constructed from a path. `resources/app.asar` is where it sits
  // on Windows and Linux and nowhere near where it sits on macOS, which puts it inside the bundle at
  // `<Product>.app/Contents/Resources/`. Guessing the first layout made this check report a macOS
  // package as `packaged 1970-01-01` — missing, read as infinitely stale — and fail a job that was
  // perfectly healthy. A check that cries wolf on one platform gets switched off on all three.
  const asar = findFiles(dir, (name) => name === 'app.asar')[0]
  const packagedAt = asar ? statSync(asar).mtimeMs : 0
  const newestSource = findFiles(join(REPO, 'src'), () => true).reduce(
    (newest, file) => Math.max(newest, statSync(file).mtimeMs),
    Math.max(
      statSync(join(REPO, 'package.json')).mtimeMs,
      statSync(join(REPO, 'electron-builder.yml')).mtimeMs
    )
  )
  // ⚠️ "Cannot tell" is its own answer and is not "stale". If the archive is somewhere neither
  // `findFiles` nor this comment anticipated, say so plainly rather than accusing a good build.
  if (!asar) {
    check(
      'the package was built from the source that is here now',
      false,
      `no app.asar found under ${dir} — this check cannot tell how old the package is, which is not ` +
        'the same as it being stale. Fix the search before trusting anything below.'
    )
  } else {
    check(
      'the package was built from the source that is here now',
      packagedAt >= newestSource,
      packagedAt >= newestSource
        ? `packaged ${new Date(packagedAt).toISOString()}`
        : `⛔ STALE: packaged ${new Date(packagedAt).toISOString()} but src/ changed ` +
          `${new Date(newestSource).toISOString()} — run \`npm run pack\` and check it succeeded. ` +
          'Everything below would be testing code that is no longer in the tree.'
    )
  }
  // ⚠️ On failure, say what IS there. "expected X, not found" sent someone reading electron-builder's
  // name-sanitising rules; one directory listing would have shown the answer immediately.
  check(
    'the executable is where the packaging config says',
    existsSync(binary),
    existsSync(binary) ? binary : `no ${binary}
      ${dir} holds: ${readdirSync(dir).join(', ')}`
  )

  const resources = join(dir, process.platform === 'darwin' ? `${PRODUCT}.app/Contents/Resources` : 'resources')
  check('the app is archived into an asar', existsSync(join(resources, 'app.asar')))

  // ---------------------------------------------------------------- the icon
  section('the icon')

  /**
   * ⚠️ Packaging an icon fails *quietly*. electron-builder logs `default Electron icon is used` and
   * carries on producing a perfectly good build, so nothing short of looking at the artefact tells
   * you the app shipped as a blank window in the task switcher. Each platform is asked the question
   * only that platform can answer.
   */
  if (process.platform === 'win32') {
    // The .ico is compiled into the .exe's resource section, so the honest question is whether *these
    // exact bytes* are in there. ⛔ Not "does the executable contain a PNG": measured, Electron's
    // own stock binary does too, so that check passed against an app with no icon at all.
    const ico = join(REPO, 'resources', 'icon.ico')
    check('the .ico the build reads is present and multi-layer', existsSync(ico) && icoLayers(ico).length > 1,
      existsSync(ico) ? `${icoLayers(ico).length} layers, ${statSync(ico).size} bytes` : 'resources/icon.ico is missing')
    const largest = icoLayers(ico).sort((a, b) => b.length - a.length)[0]
    check('and its largest layer is embedded in the executable',
      largest !== undefined && readFileSync(binary).includes(largest),
      `${largest?.length ?? 0} bytes of icon looked for in ${(statSync(binary).size / 1e6).toFixed(1)} MB`)
  } else if (process.platform === 'darwin') {
    const icns = readdirSync(resources).filter((f) => f.endsWith('.icns'))
    check('electron-builder generated an .icns into the bundle', icns.length > 0,
      icns.join(', ') || 'no .icns in Contents/Resources — the app will show a blank Dock tile')
  } else {
    // ⛔ `extraResources`, not `buildResources`: this is the file BrowserWindow reads at runtime.
    const png = join(resources, 'icon.png')
    check('the runtime window icon shipped beside the app', existsSync(png),
      existsSync(png) ? `${statSync(png).size} bytes` : `${png} is missing — see windowIcon()`)
  }

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
  // app reads MULTI_AGENT_CONTROLLER_DATA_DIR exactly as the development build does - which is itself the thing
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
    env: { ...process.env, MULTI_AGENT_CONTROLLER_DATA_DIR: dataDir },
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
  killTree(app?.pid, EXECUTABLE)

  // ⛔ And the daemon separately, because it is **detached by design** and is therefore not in the
  // app's process tree. That is the whole point of the topology - closing the window must not stop
  // the fleet - and it means this suite used to leave an orchestratord running against the packaged
  // binary every time it passed. Found 2026-08-27: the leak holds `release/win-unpacked` open, so
  // the *next* `npm run pack` dies with EBUSY on rmdir, which reads as a broken build.
  //
  // ⚠️ Its pid is not a guess: the daemon publishes it in its own endpoint file, and killTree
  // re-reads the command line before doing anything.
  try {
    const endpoint = JSON.parse(readFileSync(join(dataDir, 'orchestratord.json'), 'utf8'))
    killTree(endpoint.pid, 'orchestratord')
  } catch {
    // No endpoint file means it never started, which the checks above have already reported.
  }
  await wait(1000)
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // A locked file is not worth failing a passing suite over.
  }
}

process.exit(summary('pack') === 0 ? 0 : 1)
