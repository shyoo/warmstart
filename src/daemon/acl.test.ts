import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deniedPaths, reown, sweepAcls } from './acl.js'

/**
 * The half of `acl.ts` a test can reach without a second Windows account.
 *
 * ⛔ What cannot be pinned here is the defect itself — a file owned by `CodexSandboxOffline` that
 * a fresh inheritable grant on the root does not reach — because creating one needs the sandbox
 * user. That was measured by hand in ws1 on 2026-09-13 (`acl.ts` has the numbers). What *is* pinned:
 * the parser reads exactly the refusal lines `icacls` prints, and `reown` gives back a file or a
 * directory with every byte and every child intact, which is the property the sweep leans on.
 */

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-acl-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reading what icacls refused', () => {
  // ⭐ Verbatim from `icacls C:\Dev\warmstart_workspaces\ws1 /reset /t /c /q`, 2026-09-13.
  const out = [
    'C:\\Dev\\warmstart_workspaces\\ws1\\CLA.md: Access is denied.',
    'C:\\Dev\\warmstart_workspaces\\ws1\\src\\renderer\\src\\components\\Workers.tsx: Access is denied.',
    'C:\\Dev\\warmstart_workspaces\\ws1\\???\\Microsoft\\Spelling\\neutral: Access is denied.',
    'Successfully processed 19706 files; Failed processing 146 files',
    ''
  ].join('\r\n')

  it('keeps the refused paths that exist and nothing else', () => {
    const exists = (p: string): boolean => !p.includes('???')
    expect(deniedPaths(out, exists)).toEqual([
      'C:\\Dev\\warmstart_workspaces\\ws1\\CLA.md',
      'C:\\Dev\\warmstart_workspaces\\ws1\\src\\renderer\\src\\components\\Workers.tsx'
    ])
  })

  it('does not read the summary line, or a localised reason, as a path', () => {
    expect(deniedPaths('Successfully processed 3 files; Failed processing 0 files\r\n', () => true)).toEqual([])
    expect(deniedPaths('C:\\a\\b.txt: Zugriff verweigert\r\n', () => true)).toEqual(['C:\\a\\b.txt'])
    // The root is echoed as given, so a forward-slash root prints mixed.
    expect(deniedPaths('C:/a/ws1\\b.txt: Access is denied.\r\n', () => true)).toEqual(['C:/a/ws1\\b.txt'])
    expect(deniedPaths('\\\\server\\share\\c.txt: Access is denied.\r\n', () => true)).toEqual([
      '\\\\server\\share\\c.txt'
    ])
  })
})

describe('re-owning by replacement', () => {
  it('gives a file back with the same bytes', () => {
    const file = join(dir, 'kept.bin')
    const bytes = Buffer.from([0, 1, 2, 255, 13, 10, 0])
    writeFileSync(file, bytes)
    reown(file)
    expect(readFileSync(file)).toEqual(bytes)
    // No stray copy is left beside it.
    expect(readdirSync(dir).filter((n) => n.includes('.reown'))).toEqual([])
  })

  it('gives a directory back with every child under the same name', () => {
    const root = join(dir, 'tree')
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'nested', 'b.txt'), 'b')
    reown(root)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(root, 'nested', 'b.txt'), 'utf8')).toBe('b')
    expect(readdirSync(dir).filter((n) => n.includes('.reown'))).toEqual([])
  })
})

describe('the sweep', () => {
  it('is a no-op that refuses nothing on a tree the operator owns', async () => {
    const root = join(dir, 'owned')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'f.txt'), 'x')
    const sweep = await sweepAcls([
      { path: root, recursive: true },
      { path: join(dir, 'does-not-exist'), recursive: true }
    ])
    expect(sweep.denied).toEqual([])
    expect(sweep.reowned).toBe(0)
    expect(sweep.stuck).toEqual([])
    expect(existsSync(join(root, 'f.txt'))).toBe(true)
  })
})
