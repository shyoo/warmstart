#!/usr/bin/env node
/**
 * Point `.codex` at `.claude` in this checkout, as a link this filesystem actually understands.
 *
 * ⛔ **This used to be a committed symlink, and on Windows that is a seven-byte text file.** git
 * with `core.symlinks=false` — the default wherever the user cannot create links, which is most
 * Windows checkouts — writes the link *target* into a regular file rather than making a link. So
 * `.codex` was a file whose contents were the string `.claude`, which bought codex nothing and cost
 * the fleet Muse: measured 2026-09-14 (t436), Muse Code 1.1.1 opens `<workspace>/.codex/skills` at
 * startup and, finding a non-directory there, exits 1 in ~4.5s with
 * `runtime host failed to start: failed to read skill file at …/.codex/skills: Not a directory
 * (os error 20)` before the model is ever called. Every Muse quality review in this repo failed
 * that way for a day. A directory works, and no `.codex` at all works; only the placeholder file
 * breaks it, and only a checkout can know which of those it got.
 *
 * ⚠️ So the link is **made locally and never committed** (`.gitignore`). Junction on Windows —
 * directory-only, and the one link kind an unprivileged user can always create — and a plain
 * symlink everywhere else.
 *
 * Usage: `node scripts/link-agent-skills.mjs [directory]` (default: the repository root).
 * Idempotent, and safe to run on a checkout that already has the right thing.
 */
import { lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LINK = '.codex'
const TARGET = '.claude'

/** What is at `path` today: `'link'`, `'dir'`, `'file'`, or `null` for nothing at all. */
function whatIsThere(path) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'link'
    if (stat.isDirectory()) return 'dir'
    return 'file'
  } catch {
    return null
  }
}

export function linkAgentSkills(root = process.cwd()) {
  const link = join(resolve(root), LINK)
  const target = join(resolve(root), TARGET)
  if (whatIsThere(target) !== 'dir') {
    return { ok: false, action: 'skipped', why: `${TARGET} is not a directory in ${root}` }
  }

  const found = whatIsThere(link)
  if (found === 'link') {
    // ⚠️ A junction resolves to an absolute path and a symlink to whatever was written; either is
    // fine as long as it lands on this checkout's own `.claude`.
    try {
      if (resolve(root, readlinkSync(link)) === target) return { ok: true, action: 'already-linked' }
    } catch {
      // Unreadable link: replaced below rather than trusted.
    }
  }
  if (found === 'dir') {
    // ⛔ Not removed. A real directory somebody put there is theirs, and it is not the failure this
    // script exists for — Muse starts fine against a directory.
    return { ok: true, action: 'left-directory' }
  }

  // ⚠️ The placeholder file is the fault itself, so removing it is the fix and not collateral: its
  // whole content is the string `.claude`, which is about to become a real link to the same place.
  if (found === 'file' || found === 'link') rmSync(link, { force: true })
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (err) {
    // ⚠️ Not fatal. `.codex` missing is a codex that does not find the shared skills; `.codex`
    // wrong is a Muse that will not start. Having removed the placeholder, the worse of the two is
    // already gone.
    return { ok: false, action: 'failed', why: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, action: 'linked' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = linkAgentSkills(process.argv[2] ?? process.cwd())
  console.log(`${LINK} → ${TARGET}: ${result.action}${result.why ? ` (${result.why})` : ''}`)
  if (!result.ok && result.action === 'failed') process.exitCode = 1
}
