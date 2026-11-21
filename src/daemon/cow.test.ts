import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetCowProbeCacheForTest,
  cloneDirectoryCow,
  normalizeCowCloneConfig,
  probeCowSupport,
  readCowCloneConfig,
  seedWorkspaceCow,
  type CowCapability,
  type CowProbeRunner
} from './cow.js'

let sandbox: string

beforeEach(() => {
  _resetCowProbeCacheForTest()
  sandbox = mkdtempSync(join(tmpdir(), 'agentyard-cow-'))
})

afterEach(() => {
  _resetCowProbeCacheForTest()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('normalizeCowCloneConfig & readCowCloneConfig', () => {
  it('returns null when absent and canonicalizes valid configs', () => {
    expect(normalizeCowCloneConfig(null)).toBeNull()
    expect(normalizeCowCloneConfig(undefined)).toBeNull()

    expect(normalizeCowCloneConfig({ enabled: true })).toEqual({ enabled: true })
    expect(
      normalizeCowCloneConfig({
        enabled: true,
        seedPaths: ['.\\node_modules\\', 'packages\\web\\node_modules/', 'node_modules']
      })
    ).toEqual({
      enabled: true,
      seedPaths: ['node_modules', 'packages/web/node_modules']
    })
  })

  it('rejects non-boolean enabled and unsafe seedPaths', () => {
    expect(() => normalizeCowCloneConfig('invalid')).toThrow(/object/i)
    expect(() => normalizeCowCloneConfig({ enabled: 'yes' })).toThrow(/boolean/i)

    for (const bad of [
      '',
      '   ',
      '.',
      './',
      '..',
      '../node_modules',
      'a/../../b',
      '/abs/path',
      'C:\\repo\\node_modules',
      ':/magic',
      '.git',
      '.git/objects',
      'sub/.git/hooks',
      '.jj',
      '.jj/working_copy',
      'nested/.JJ/repo'
    ]) {
      expect(() => normalizeCowCloneConfig({ enabled: true, seedPaths: [bad] })).toThrow(/seedPath/i)
    }
  })

  it('readCowCloneConfig returns null on malformed input rather than throwing', () => {
    expect(readCowCloneConfig(null)).toBeNull()
    expect(readCowCloneConfig({ enabled: 'true' })).toBeNull()
    expect(readCowCloneConfig({ enabled: true, seedPaths: ['../escape'] })).toBeNull()
    expect(readCowCloneConfig({ enabled: false })).toEqual({ enabled: false })
  })
})

describe('probeCowSupport across platforms (mocked runners)', () => {
  it('win32: supports ReFS with block refcounting, rejects NTFS and cross-volume', async () => {
    const target = join(sandbox, 'nonexistent-child', 'pool')
    const source = sandbox

    const refsRunner: CowProbeRunner = async (file) => {
      expect(file).toBe('powershell.exe')
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          targetRoot: 'D:\\',
          targetFs: 'ReFS',
          targetFlags: 0x08000000,
          targetBlockClone: true,
          sourceRoot: 'D:\\',
          sourceFs: 'ReFS',
          sourceBlockClone: true
        })
      }
    }
    const refs = await probeCowSupport(target, source, { platform: 'win32', runner: refsRunner })
    expect(refs).toMatchObject({
      supported: true,
      filesystem: 'ReFS',
      mechanism: 'refs-block-clone',
      probedPath: sandbox
    })

    const ntfsRunner: CowProbeRunner = async () => ({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        targetRoot: 'C:\\',
        targetFs: 'NTFS',
        targetFlags: 0x03e700ff,
        targetBlockClone: false,
        sourceRoot: 'C:\\',
        sourceFs: 'NTFS',
        sourceBlockClone: false
      })
    })
    const ntfs = await probeCowSupport(target, source, { platform: 'win32', runner: ntfsRunner })
    expect(ntfs.supported).toBe(false)
    expect(ntfs.mechanism).toBe('none')
    expect(ntfs.filesystem).toBe('NTFS')
    expect(ntfs.reason).toContain('this volume cannot clone; slots are full copies')

    const crossVolRunner: CowProbeRunner = async () => ({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        targetRoot: 'D:\\',
        targetFs: 'ReFS',
        targetFlags: 0x08000000,
        targetBlockClone: true,
        sourceRoot: 'C:\\',
        sourceFs: 'NTFS',
        sourceBlockClone: false
      })
    })
    const cross = await probeCowSupport(target, source, { platform: 'win32', runner: crossVolRunner })
    expect(cross.supported).toBe(false)
    expect(cross.mechanism).toBe('none')
    expect(cross.reason).toContain('this volume cannot clone; slots are full copies')
    expect(cross.reason).toContain('different volumes')
  })

  it('darwin: verifies cp -c and always deletes temp probe files', async () => {
    const okRunner: CowProbeRunner = async (file, args) => {
      expect(file).toBe('cp')
      expect(args[0]).toBe('-c')
      writeFileSync(args[2]!, 'cloned')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const ok = await probeCowSupport(sandbox, undefined, { platform: 'darwin', runner: okRunner })
    expect(ok).toMatchObject({
      supported: true,
      filesystem: 'APFS',
      mechanism: 'apfs-clonefile',
      probedPath: sandbox
    })
    expect(readdirSync(sandbox)).toEqual([])

    const failRunner: CowProbeRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'cp: Cross-device link'
    })
    const fail = await probeCowSupport(sandbox, undefined, { platform: 'darwin', runner: failRunner })
    expect(fail.supported).toBe(false)
    expect(fail.mechanism).toBe('none')
    expect(fail.reason).toContain('this volume cannot clone; slots are full copies')
    expect(readdirSync(sandbox)).toEqual([])
  })

  it('linux: queries filesystem with stat and verifies cp --reflink=always', async () => {
    const okRunner: CowProbeRunner = async (file, args) => {
      if (file === 'stat') return { exitCode: 0, stdout: 'btrfs\n', stderr: '' }
      expect(file).toBe('cp')
      expect(args[0]).toBe('--reflink=always')
      writeFileSync(args[2]!, 'reflinked')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const btrfs = await probeCowSupport(sandbox, undefined, { platform: 'linux', runner: okRunner })
    expect(btrfs).toMatchObject({
      supported: true,
      filesystem: 'btrfs',
      mechanism: 'reflink'
    })
    expect(readdirSync(sandbox)).toEqual([])

    const ext4Runner: CowProbeRunner = async (file) => {
      if (file === 'stat') return { exitCode: 0, stdout: 'ext2/ext3\n', stderr: '' }
      return { exitCode: 1, stdout: '', stderr: 'failed to clone: Operation not supported' }
    }
    const ext4 = await probeCowSupport(sandbox, undefined, { platform: 'linux', runner: ext4Runner })
    expect(ext4.supported).toBe(false)
    expect(ext4.mechanism).toBe('none')
    expect(ext4.filesystem).toBe('ext2/ext3')
    expect(ext4.reason).toContain('this volume cannot clone; slots are full copies')
    expect(readdirSync(sandbox)).toEqual([])
  })
})

describe('probeCowSupport (live host sanity check)', () => {
  it('returns a measured shape without asserting host CoW capability', async () => {
    const res = await probeCowSupport(sandbox, undefined, { force: true })
    expect(typeof res.supported).toBe('boolean')
    expect(res.filesystem.length).toBeGreaterThan(0)
    expect(res.measuredAt).toBeGreaterThan(0)
    expect(res.probedPath).toBeTruthy()
    if (!res.supported) {
      expect(res.mechanism).toBe('none')
      expect(res.reason).toContain('this volume cannot clone; slots are full copies')
    } else {
      expect(res.mechanism).not.toBe('none')
    }
  })
})

describe('cloneDirectoryCow', () => {
  it('refuses immediately when capability is unsupported', async () => {
    const src = join(sandbox, 'src')
    const dst = join(sandbox, 'dst')
    mkdirSync(src)
    const unsupportedCap: CowCapability = {
      supported: false,
      filesystem: 'NTFS',
      mechanism: 'none',
      reason: 'this volume cannot clone; slots are full copies (NTFS)',
      measuredAt: Date.now(),
      probedPath: sandbox
    }
    const runner = vi.fn<CowProbeRunner>()
    await expect(cloneDirectoryCow(src, dst, unsupportedCap, { runner })).rejects.toThrow(/cannot CoW-clone/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('dispatches robocopy for ReFS (0..7 success, 8+ failure with cleanup)', async () => {
    const src = join(sandbox, 'src-refs')
    const dstOk = join(sandbox, 'dst-refs-ok')
    const dstFail = join(sandbox, 'dst-refs-fail')
    mkdirSync(src)

    const cap: CowCapability = {
      supported: true,
      filesystem: 'ReFS',
      mechanism: 'refs-block-clone',
      reason: 'ReFS block cloning supported',
      measuredAt: Date.now(),
      probedPath: sandbox
    }

    const okRunner: CowProbeRunner = async (file, args) => {
      expect(file).toBe('robocopy')
      expect(args.slice(0, 2)).toEqual([src, dstOk])
      mkdirSync(dstOk)
      return { exitCode: 3, stdout: 'copied', stderr: '' }
    }
    await cloneDirectoryCow(src, dstOk, cap, { runner: okRunner })
    expect(existsSync(dstOk)).toBe(true)

    const failRunner: CowProbeRunner = async () => {
      mkdirSync(dstFail)
      writeFileSync(join(dstFail, 'partial.txt'), 'half')
      return { exitCode: 8, stdout: '', stderr: 'copy error' }
    }
    await expect(cloneDirectoryCow(src, dstFail, cap, { runner: failRunner })).rejects.toThrow(/robocopy failed/)
    expect(existsSync(dstFail)).toBe(false)
  })

  it('dispatches cp -cR on APFS and cp -a --reflink=always on Linux reflink', async () => {
    const src = join(sandbox, 'src-posix')
    const dstApfs = join(sandbox, 'dst-apfs')
    const dstReflink = join(sandbox, 'dst-reflink')
    mkdirSync(src)

    const apfsCap: CowCapability = {
      supported: true,
      filesystem: 'APFS',
      mechanism: 'apfs-clonefile',
      reason: 'APFS',
      measuredAt: Date.now(),
      probedPath: sandbox
    }
    const reflinkCap: CowCapability = {
      supported: true,
      filesystem: 'btrfs',
      mechanism: 'reflink',
      reason: 'btrfs',
      measuredAt: Date.now(),
      probedPath: sandbox
    }

    const calls: Array<{ file: string; args: string[] }> = []
    const runner: CowProbeRunner = async (file, args) => {
      calls.push({ file, args })
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await cloneDirectoryCow(src, dstApfs, apfsCap, { runner })
    await cloneDirectoryCow(src, dstReflink, reflinkCap, { runner })
    expect(calls).toEqual([
      { file: 'cp', args: ['-cR', src, dstApfs] },
      { file: 'cp', args: ['-a', '--reflink=always', src, dstReflink] }
    ])
  })
})

describe('seedWorkspaceCow', () => {
  it('skips trunk, disabled configs, unsupported volumes, missing/existing targets, and tracked dirs; clones valid untracked dirs', async () => {
    const repo = join(sandbox, 'repo')
    const ws = join(sandbox, 'ws1')
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    mkdirSync(join(repo, 'tracked_dir'), { recursive: true })
    mkdirSync(join(repo, 'already_dir'), { recursive: true })
    mkdirSync(join(ws, 'already_dir'), { recursive: true })

    // Disabled config skips without invoking runner.
    const disabled = await seedWorkspaceCow(repo, ws, { enabled: false })
    expect(disabled.cloned).toEqual([])
    expect(disabled.skipped).toEqual([{ path: 'node_modules', reason: 'copy-on-write cloning disabled' }])

    // Trunk target always skipped.
    const trunk = await seedWorkspaceCow(repo, repo, { enabled: true })
    expect(trunk.cloned).toEqual([])
    expect(trunk.skipped).toEqual([{ path: 'node_modules', reason: 'never clone into trunk' }])

    // Unsupported capability skips all seed paths.
    const unsupportedCap: CowCapability = {
      supported: false,
      filesystem: 'NTFS',
      mechanism: 'none',
      reason: 'this volume cannot clone; slots are full copies (NTFS)',
      measuredAt: Date.now(),
      probedPath: sandbox
    }
    const noCow = await seedWorkspaceCow(repo, ws, { enabled: true }, { capability: unsupportedCap })
    expect(noCow.cloned).toEqual([])
    expect(noCow.skipped[0]?.reason).toContain('this volume cannot clone; slots are full copies')

    // Supported capability clones untracked node_modules and skips missing / existing / tracked dirs.
    const supportedCap: CowCapability = {
      supported: true,
      filesystem: 'ReFS',
      mechanism: 'refs-block-clone',
      reason: 'ReFS block cloning supported',
      measuredAt: Date.now(),
      probedPath: sandbox
    }
    const runner: CowProbeRunner = async (_file, args) => {
      mkdirSync(args[1]!, { recursive: true })
      writeFileSync(join(args[1]!, 'marker.txt'), 'cloned')
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const res = await seedWorkspaceCow(
      repo,
      ws,
      { enabled: true, seedPaths: ['node_modules', 'missing_dir', 'already_dir', 'tracked_dir'] },
      {
        capability: supportedCap,
        runner,
        gitLsFiles: async (_root, rel) => rel === 'tracked_dir'
      }
    )

    expect(res.cloned).toEqual(['node_modules'])
    expect(res.errors).toEqual([])
    expect(res.skipped).toEqual([
      { path: 'missing_dir', reason: 'missing in trunk' },
      { path: 'already_dir', reason: 'already exists in workspace' },
      { path: 'tracked_dir', reason: 'contains tracked files' }
    ])
    expect(existsSync(join(ws, 'node_modules', 'marker.txt'))).toBe(true)
  })
})
