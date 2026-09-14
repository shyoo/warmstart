import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { linkAgentSkills } from '../../scripts/link-agent-skills.mjs'

/**
 * `.codex` points at `.claude`, and *how* it points matters more than it looks.
 *
 * ⛔ **A committed symlink is a text file on most Windows checkouts.** git with
 * `core.symlinks=false` — the default wherever the user cannot create links — writes the link's
 * target into a regular file instead of making a link, so `.codex` became seven bytes reading
 * `.claude`. Codex gained nothing from that, and Muse lost everything: measured 2026-09-14 (t436),
 * Muse Code 1.1.1 opens `<workspace>/.codex/skills` at startup and, finding a non-directory,
 * answers `runtime host failed to start: failed to read skill file at …/.codex/skills: Not a
 * directory (os error 20)` and **exits 1 in ~4.5s**, before the model is called. Every Muse quality
 * review in this repository failed that way for a day, reported as *the reviewer's session ended
 * before it answered*.
 *
 * ⭐ Three workspace shapes were flown against the live CLI that day: no `.codex` starts, a `.codex`
 * **directory** starts, and a `.codex` **file** is the only one that kills it. So the link is made
 * locally by `scripts/link-agent-skills.mjs` and never committed.
 */

const REPO = resolve(import.meta.dirname, '..', '..')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skilllink-'))
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** `'link' | 'dir' | 'file' | null`, the same three shapes the CLI distinguishes. */
function shape(path: string): string | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'link'
    return stat.isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

describe('the .codex link', () => {
  it('replaces the placeholder file git left behind, which is the fault itself', () => {
    writeFileSync(join(dir, '.codex'), '.claude')
    expect(shape(join(dir, '.codex'))).toBe('file')
    expect(linkAgentSkills(dir).ok).toBe(true)
    // ⛔ A link *or* a directory; a junction lstats as a link on Windows and the point is only that
    // the CLI can open `.codex/skills`. What must never remain is the file.
    expect(shape(join(dir, '.codex'))).not.toBe('file')
    expect(shape(join(dir, '.codex', 'skills'))).toBe('dir')
  })

  it('is idempotent, so a checkout that is already right is left alone', () => {
    expect(linkAgentSkills(dir).action).toBe('linked')
    expect(linkAgentSkills(dir).ok).toBe(true)
    expect(shape(join(dir, '.codex', 'skills'))).toBe('dir')
  })

  it('never removes a real .codex directory somebody put there', () => {
    mkdirSync(join(dir, '.codex', 'skills'), { recursive: true })
    writeFileSync(join(dir, '.codex', 'skills', 'mine.md'), '# mine')
    expect(linkAgentSkills(dir).action).toBe('left-directory')
    expect(shape(join(dir, '.codex', 'skills', 'mine.md'))).toBe('file')
  })

  it('declines rather than guesses where there is no .claude to point at', () => {
    const empty = mkdtempSync(join(tmpdir(), 'skilllink-empty-'))
    try {
      expect(linkAgentSkills(empty).action).toBe('skipped')
      expect(shape(join(empty, '.codex'))).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('leaves no .codex placeholder in this checkout, whatever git did with it', () => {
    // ⛔ The guard that would have caught t436 on the commit that introduced it. Untracked, this is
    // null on a fresh clone and a link on a developed one; a `file` here means a symlink is
    // committed again and every Muse run in this repository is about to die at startup.
    expect(shape(join(REPO, '.codex'))).not.toBe('file')
  })
})
