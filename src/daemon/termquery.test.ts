import { describe, expect, it } from 'vitest'
import { terminalAnswerer } from './termquery.js'

describe('terminalAnswerer', () => {
  it('answers a cursor-position request with the home position', () => {
    const answer = terminalAnswerer()
    expect(answer.push('\x1b[6n')).toBe('\x1b[1;1R')
    expect(answer.answered).toBe(1)
  })

  it('answers each request in a chunk and nothing else', () => {
    const answer = terminalAnswerer()
    // Measured 2026-09-13: what Muse Code 1.2.1 writes before its first cursor request.
    const startup = '\x1b]10;?\x07\x1b]11;?\x07\x1b[?2004h\x1b[?1004h\x1b[0 q\x1b[?25l\x1b[>3u\x1b[?u\x1b[c'
    expect(answer.push(startup)).toBe('')
    expect(answer.push('\x1b[6n text \x1b[6n')).toBe('\x1b[1;1R\x1b[1;1R')
    expect(answer.answered).toBe(2)
  })

  it('answers a request split across two chunks exactly once', () => {
    const answer = terminalAnswerer()
    expect(answer.push('drawn \x1b[6')).toBe('')
    expect(answer.push('n more')).toBe('\x1b[1;1R')
    expect(answer.push('n')).toBe('')
    expect(answer.answered).toBe(1)
  })

  it('does not mistake a cursor-position report for a request', () => {
    const answer = terminalAnswerer()
    expect(answer.push('\x1b[1;1R\x1b[6;1H')).toBe('')
    expect(answer.answered).toBe(0)
  })
})
