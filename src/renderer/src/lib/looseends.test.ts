import { describe, expect, it } from 'vitest'
import { delegateNote, mergedSweepNote } from './looseends'

describe('the note after checking merged pull requests', () => {
  it('names every non-zero outcome, and counts what is left as still open', () => {
    expect(mergedSweepNote({ ran: true, checked: 4, cleanedUp: 1, kept: 1, failed: 1 })).toBe(
      'checked 4 pull request(s): 1 merged and cleaned up, 1 merged but kept — the row says why, ' +
        '1 could not be read from GitHub, 1 still open'
    )
  })

  it('says a sweep that had nothing to check found nothing, rather than "checked 0"', () => {
    expect(mergedSweepNote({ ran: true, checked: 0, cleanedUp: 0, kept: 0, failed: 0 })).toBe(
      'no open or unfinished pull requests to check'
    )
  })

  it('does not report a sweep that was already running as having found nothing', () => {
    expect(mergedSweepNote({ ran: false, checked: 0, cleanedUp: 0, kept: 0, failed: 0 })).toContain(
      'already running'
    )
  })
})

describe('the note after handing everything to an agent', () => {
  it('names every filed task, every skipped project and the rows already gone', () => {
    expect(
      delegateNote({
        filed: [{ seq: 4, title: 'a' }, { seq: 5, title: 'b' }],
        skipped: [{ projectName: 'beta', reason: 't3 is already handling them' }],
        gone: 2
      })
    ).toBe('filed t4, t5 to work through them; beta: t3 is already handling them; 2 already resolved since the list was drawn')
  })

  it('says so when there was nothing to hand over', () => {
    expect(delegateNote({ filed: [], skipped: [], gone: 0 })).toBe('nothing left to hand over')
  })
})
