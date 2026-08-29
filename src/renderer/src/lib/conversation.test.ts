import { describe, expect, it } from 'vitest'
import { conversationIdFor } from './conversation.js'

/**
 * ⛔ This is tested here rather than in the UI suite because the UI suite **cannot** test it. That
 * suite's worker has no credentials, so nothing it files ever dispatches, so there are no runs and
 * no sessions — a check written there reported PASS against an empty list, which is the worst
 * possible outcome: coverage that reads as green and asserts nothing.
 *
 * What can be wrong here is the *choice of id*, and it is wrong silently: a plausible-looking id
 * that resumes nothing sends somebody to a CLI to paste a string that fails.
 */

const session = (id: string, vendorSessionId: string | null) => ({ id, vendorSessionId })

describe('naming the conversation that served a run', () => {
  it('prefers the id the CLI named itself', () => {
    // ⭐ Antigravity mints its own conversation id and reports it back; `--conversation` accepts
    // that one and nothing else. The row is filed under ours, so reading our column would give an
    // id that looks entirely right and resumes nothing.
    expect(
      conversationIdFor({ sessionId: 'ours' }, [session('ours', 'theirs')])
    ).toBe('theirs')
  })

  it('falls back to ours when the CLI took the one it was given', () => {
    // Claude Code is handed `--session-id` and keeps it, so there is no second id to prefer.
    expect(conversationIdFor({ sessionId: 'ours' }, [session('ours', null)])).toBe('ours')
  })

  it('says nothing for a run that never got a session', () => {
    // ⚠️ Not a dash, not "unknown". Dispatch can fail while claiming a workspace or running a
    // project's prepare hook, and that run was genuinely served by no conversation — a placeholder
    // would send somebody looking for one.
    expect(conversationIdFor({ sessionId: null }, [session('ours', 'theirs')])).toBeNull()
  })

  it('falls back to the run’s own session id when the session row is gone', () => {
    expect(conversationIdFor({ sessionId: 'ours' }, [])).toBe('ours')
  })

  it('does not take a different session’s id', () => {
    // ⛔ The failure that would put one conversation's id against another's run. A task can have run
    // in several conversations — that is what resuming and sharing are for — so `sessions` routinely
    // holds more than one and matching the wrong one is invisible.
    expect(
      conversationIdFor({ sessionId: 'second' }, [
        session('first', 'first-vendor'),
        session('second', 'second-vendor')
      ])
    ).toBe('second-vendor')
  })
})
