import { describe, expect, it } from 'vitest'
import { canonicalPath, samePath } from './fspath.js'

/**
 * One directory, one identity.
 *
 * ⭐ Measured against this install on 2026-08-28: the `sessions` table held one pooled worktree under
 * two spellings — 8 Claude rows as `c:\Dev\…\ws1`, 2 as `C:\Dev\…\ws1` — and `resumableSession`
 * compared them with `!==`. The consequence is invisible and one-directional: a case mismatch never
 * resumes the *wrong* conversation, it resumes **none**, pays the full 41,542-token cold start, and
 * records `warm=false` as though that were the honest answer.
 *
 * ⚠️ These assertions are platform-split on purpose. Folding case is correct on Windows and wrong
 * everywhere else, where `/Dev` and `/dev` are two directories and merging them would be the same
 * bug with a worse ending.
 */

const win = process.platform === 'win32'

describe.runIf(win)('the same Windows directory, spelled differently', () => {
  it('treats a differing drive letter as the same directory', () => {
    // ⭐ The exact pair this install produced, and the reason it produced them: `policyFor` derived
    // an unconfigured workspace root by concatenating onto a lowercase `project.root`, while a
    // configured one came back from `resolve` in the config's own case.
    expect(samePath('c:\\Dev\\x\\ws1', 'C:\\Dev\\x\\ws1')).toBe(true)
  })

  it('normalises the drive letter up, so stored paths converge on one spelling', () => {
    expect(canonicalPath('c:\\Dev\\x')).toBe('C:\\Dev\\x')
    expect(canonicalPath('C:\\Dev\\x')).toBe('C:\\Dev\\x')
  })

  it('leaves the rest of the path alone, because these strings are shown as well as compared', () => {
    // ⚠️ Not `toLowerCase()` on the whole path. An operator recognises the worktree they configured;
    // `c:\dev\multi_agent_controller_workspaces\ws1` is the same directory and a worse label.
    expect(canonicalPath('C:\\Dev\\Multi_Agent\\WS1')).toBe('C:\\Dev\\Multi_Agent\\WS1')
  })

  it('still says two genuinely different directories are different', () => {
    // ⛔ The failure that would be worse than the one being fixed. Two pool members merged into one
    // would hand two tasks the same worktree, which is the thing the whole claim system prevents.
    expect(samePath('C:\\Dev\\x\\ws1', 'C:\\Dev\\x\\ws2')).toBe(false)
  })

  it('ignores separator and traversal differences, which reach it from config files', () => {
    // `workspaces.root` is written with forward slashes in project.json and arrives as backslashes
    // from the resource table. Both name one directory.
    expect(samePath('C:/Dev/x/ws1', 'C:\\Dev\\x\\ws1')).toBe(true)
    expect(samePath('C:\\Dev\\x\\ws2\\..\\ws1', 'C:\\Dev\\x\\ws1')).toBe(true)
  })
})

describe.runIf(!win)('POSIX paths, where case is meaning', () => {
  it('never folds case', () => {
    // ⛔ `/Dev` and `/dev` are two directories here. Treating them as one would let a resume attach
    // to a conversation from somewhere else entirely — the inverse bug, and a worse one.
    expect(samePath('/Dev/x/ws1', '/dev/x/ws1')).toBe(false)
  })

  it('still resolves traversal and duplicate separators', () => {
    expect(samePath('/dev/x/ws2/../ws1', '/dev/x/ws1')).toBe(true)
  })
})
