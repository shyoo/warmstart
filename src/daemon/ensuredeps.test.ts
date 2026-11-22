import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureDeps,
  findStaleDependencies,
  formatStaleDependencies,
  type EnsureDepsRunner
} from '../../scripts/ensure-deps.mjs'

const REPO = resolve(import.meta.dirname, '..', '..')
const tempDirs: string[] = []

function makeFixture(opts: {
  deps?: Record<string, string>
  devDeps?: Record<string, string>
  locked?: Record<string, string>
  installed?: Record<string, string>
  withEnsureElectron?: boolean
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentyard-ensuredeps-'))
  tempDirs.push(dir)

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      dependencies: opts.deps ?? {},
      devDependencies: opts.devDeps ?? {}
    }),
    'utf8'
  )

  const lockPackages: Record<string, { version: string }> = {}
  for (const [name, version] of Object.entries(opts.locked ?? {})) {
    lockPackages[`node_modules/${name}`] = { version }
  }
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: lockPackages }), 'utf8')

  for (const [name, version] of Object.entries(opts.installed ?? {})) {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  }

  if (opts.withEnsureElectron) {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'ensure-electron.mjs'), '// stub\n', 'utf8')
  }
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ensure-deps', () => {
  it('detects missing scoped packages and version mismatches against package-lock.json', () => {
    const synced = makeFixture({
      deps: { react: '^19.2.0' },
      devDeps: { '@fontsource-variable/google-sans-flex': '^5.3.2' },
      locked: { react: '19.2.0', '@fontsource-variable/google-sans-flex': '5.3.2' },
      installed: { react: '19.2.0', '@fontsource-variable/google-sans-flex': '5.3.2' }
    })
    expect(findStaleDependencies(synced)).toEqual([])

    const staleDir = makeFixture({
      deps: { react: '^19.2.0' },
      devDeps: {
        '@fontsource-variable/google-sans-flex': '^5.3.2',
        '@fontsource-variable/google-sans-code': '^5.3.2'
      },
      locked: {
        react: '19.2.1',
        '@fontsource-variable/google-sans-flex': '5.3.2',
        '@fontsource-variable/google-sans-code': '5.3.2'
      },
      installed: {
        react: '19.2.0',
        '@fontsource-variable/google-sans-flex': '5.3.2'
      }
    })
    const stale = findStaleDependencies(staleDir)
    expect(stale).toEqual([
      { name: '@fontsource-variable/google-sans-code', expected: '5.3.2', installed: null },
      { name: 'react', expected: '19.2.1', installed: '19.2.0' }
    ])
    expect(formatStaleDependencies(stale)).toBe(
      '@fontsource-variable/google-sans-code (missing, expected 5.3.2), react (installed 19.2.0, expected 19.2.1)'
    )
  })

  it('skips npm install when dependencies already match package-lock.json', () => {
    const dir = makeFixture({
      deps: { zod: '^4.4.3' },
      locked: { zod: '4.4.3' },
      installed: { zod: '4.4.3' }
    })
    const calls: string[] = []
    const run: EnsureDepsRunner = (cmd) => {
      calls.push(cmd)
      return { status: 0 }
    }

    const res = ensureDeps({ repoDir: dir, run, log: () => {}, errorLog: () => {} })
    expect(res).toEqual({ ok: true, installed: false, stale: [] })
    expect(calls).toEqual([])
  })

  it('refuses without running install under checkOnly or CI', () => {
    const dir = makeFixture({
      devDeps: { '@fontsource-variable/google-sans-flex': '^5.3.2' },
      locked: { '@fontsource-variable/google-sans-flex': '5.3.2' },
      installed: {}
    })
    const calls: string[] = []
    const run: EnsureDepsRunner = (cmd) => {
      calls.push(cmd)
      return { status: 0 }
    }

    const checkRes = ensureDeps({
      repoDir: dir,
      checkOnly: true,
      env: {},
      run,
      log: () => {},
      errorLog: () => {}
    })
    expect(checkRes.ok).toBe(false)
    expect(checkRes.installed).toBe(false)
    expect(checkRes.reason).toContain('@fontsource-variable/google-sans-flex (missing, expected 5.3.2)')
    expect(calls).toEqual([])

    const ciRes = ensureDeps({
      repoDir: dir,
      env: { CI: 'true' },
      run,
      log: () => {},
      errorLog: () => {}
    })
    expect(ciRes.ok).toBe(false)
    expect(ciRes.installed).toBe(false)
    expect(calls).toEqual([])
  })

  it('runs npm install then ensure-electron when stale locally and reports failure if still missing', () => {
    const dir = makeFixture({
      devDeps: { '@fontsource-variable/google-sans-flex': '^5.3.2' },
      locked: { '@fontsource-variable/google-sans-flex': '5.3.2' },
      installed: {},
      withEnsureElectron: true
    })

    const calls: Array<{ command: string; args: string[] }> = []
    const succeedRunner: EnsureDepsRunner = (command, args) => {
      calls.push({ command, args })
      if (args.includes('install')) {
        const modDir = join(dir, 'node_modules', '@fontsource-variable', 'google-sans-flex')
        mkdirSync(modDir, { recursive: true })
        writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name: '@fontsource-variable/google-sans-flex', version: '5.3.2' }))
      }
      return { status: 0 }
    }

    const okRes = ensureDeps({
      repoDir: dir,
      env: {},
      run: succeedRunner,
      log: () => {},
      errorLog: () => {}
    })
    expect(okRes).toEqual({
      ok: true,
      installed: true,
      stale: [{ name: '@fontsource-variable/google-sans-flex', expected: '5.3.2', installed: null }]
    })
    expect(calls.length).toBe(2)
    expect(calls[0]?.args).toEqual(['install', '--no-audit', '--no-fund'])
    expect(calls[1]?.args).toEqual([join(dir, 'scripts', 'ensure-electron.mjs')])

    // Failure case: npm install exits 0 without installing the missing package.
    const staleDir = makeFixture({
      devDeps: { '@fontsource-variable/google-sans-code': '^5.3.2' },
      locked: { '@fontsource-variable/google-sans-code': '5.3.2' },
      installed: {}
    })
    const failRes = ensureDeps({
      repoDir: staleDir,
      env: {},
      run: () => ({ status: 0 }),
      log: () => {},
      errorLog: () => {}
    })
    expect(failRes.ok).toBe(false)
    expect(failRes.installed).toBe(true)
    expect(failRes.reason).toContain('@fontsource-variable/google-sans-code')
  })

  it('passes CLI --check cleanly on this synced checkout', () => {
    const cli = spawnSync(process.execPath, [join(REPO, 'scripts', 'ensure-deps.mjs'), '--check'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true
    })
    expect(cli.status, cli.stderr).toBe(0)
  })
})
