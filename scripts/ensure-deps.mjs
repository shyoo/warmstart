#!/usr/bin/env node
/**
 * Sync `node_modules` with `package-lock.json` before building or packaging when dependencies change.
 *
 * A checkout whose `node_modules` predates a landed `package.json` / `package-lock.json` addition
 * (for example, bundled `@fontsource-variable/*` fonts in t1416) fails mid-build with a Rollup
 * missing-import error instead of refreshing `node_modules` automatically. Checking every declared
 * dependency against `node_modules/<pkg>/package.json` takes ~15 ms when in sync and runs `npm
 * install` only when something is missing or out of date.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = resolve(import.meta.dirname, '..')

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function tryReadJson(filePath) {
  try {
    return readJson(filePath)
  } catch {
    return null
  }
}

/**
 * Return every top-level `dependencies` / `devDependencies` entry whose installed version in
 * `node_modules` is absent or differs from the version locked in `package-lock.json`.
 */
export function findStaleDependencies(repoDir = REPO) {
  const pkg = readJson(join(repoDir, 'package.json'))
  const lock = tryReadJson(join(repoDir, 'package-lock.json'))
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const stale = []

  for (const name of Object.keys(declared).sort()) {
    const expected = lock?.packages?.[`node_modules/${name}`]?.version ?? null
    const modPkg = tryReadJson(join(repoDir, 'node_modules', ...name.split('/'), 'package.json'))
    const installed = typeof modPkg?.version === 'string' ? modPkg.version : null
    if (!installed || (expected && installed !== expected)) {
      stale.push({ name, expected, installed })
    }
  }
  return stale
}

export function formatStaleDependencies(stale) {
  return stale
    .map(({ name, expected, installed }) => {
      if (!installed) {
        return expected ? `${name} (missing, expected ${expected})` : `${name} (missing)`
      }
      return `${name} (installed ${installed}, expected ${expected})`
    })
    .join(', ')
}

function defaultRunner(command, args, opts) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: 'inherit',
    windowsHide: true,
    shell: opts.shell ?? false
  })
  if (result.error) {
    return { status: 1, error: result.error }
  }
  if (result.signal) {
    return { status: 1, error: new Error(`${command} killed by ${result.signal}`) }
  }
  return { status: result.status ?? 1 }
}

function npmInvocation(env) {
  const execPath = env?.npm_execpath
  if (execPath && /\.(?:[cm]?js)$/i.test(execPath) && existsSync(execPath)) {
    return { command: process.execPath, prefixArgs: [execPath], shell: false }
  }
  if (process.platform === 'win32') {
    return { command: 'npm.cmd', prefixArgs: [], shell: true }
  }
  return { command: 'npm', prefixArgs: [], shell: false }
}

/**
 * Ensure `node_modules` matches `package.json` + `package-lock.json` for `repoDir`.
 * Runs `npm install --no-audit --no-fund` followed by `scripts/ensure-electron.mjs` when stale
 * locally, or refuses without mutating when `checkOnly` or `CI` is active.
 */
export function ensureDeps(opts = {}) {
  const repoDir = opts.repoDir ?? REPO
  const checkOnly = opts.checkOnly ?? false
  const env = opts.env ?? process.env
  const run = opts.run ?? defaultRunner
  const log = opts.log ?? console.log
  const errorLog = opts.errorLog ?? console.error

  const stale = findStaleDependencies(repoDir)
  if (stale.length === 0) {
    return { ok: true, installed: false, stale: [] }
  }

  const summary = formatStaleDependencies(stale)
  if (checkOnly || env.CI === 'true' || env.CI === '1') {
    const reason = `node_modules is out of date with package-lock.json: ${summary}. Run \`npm install\` (or \`npm ci\`).`
    errorLog(reason)
    return { ok: false, installed: false, stale, reason }
  }

  log(`Syncing node_modules (${summary})...`)
  const npmCmd = npmInvocation(env)
  const installRes = run(
    npmCmd.command,
    [...npmCmd.prefixArgs, 'install', '--no-audit', '--no-fund'],
    { cwd: repoDir, env, shell: npmCmd.shell }
  )
  if (installRes.status !== 0) {
    const detail = installRes.error ? `: ${installRes.error.message}` : ` (exit ${installRes.status})`
    const reason = `npm install failed while syncing stale dependencies${detail}`
    errorLog(reason)
    return { ok: false, installed: false, stale, reason }
  }

  const remaining = findStaleDependencies(repoDir)
  if (remaining.length > 0) {
    const reason = `dependencies still out of date after npm install: ${formatStaleDependencies(remaining)}`
    errorLog(reason)
    return { ok: false, installed: true, stale: remaining, reason }
  }

  const ensureElectron = join(repoDir, 'scripts', 'ensure-electron.mjs')
  if (existsSync(ensureElectron)) {
    const electronRes = run(process.execPath, [ensureElectron], { cwd: repoDir, env, shell: false })
    if (electronRes.status !== 0) {
      const detail = electronRes.error ? `: ${electronRes.error.message}` : ` (exit ${electronRes.status})`
      const reason = `ensure-electron failed after syncing dependencies${detail}`
      errorLog(reason)
      return { ok: false, installed: true, stale, reason }
    }
  }

  return { ok: true, installed: true, stale }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const checkOnly = process.argv.includes('--check')
  const res = ensureDeps({ checkOnly })
  process.exit(res.ok ? 0 : 1)
}
