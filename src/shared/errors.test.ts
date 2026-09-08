import { describe, expect, it } from 'vitest'
import { errorMessage } from './errors.js'

/**
 * The one renderer of a thrown value.
 *
 * ⛔ The 91 hand-written copies this replaces all agreed on the two easy cases and none of them was
 * ever asked about the rest, because a ternary cannot be tested where it is written. Everything below
 * the first two checks is behaviour that used to be whatever `String()` happened to do.
 */
describe('errorMessage', () => {
  it('takes an Error’s message, not its stack or its name', () => {
    expect(errorMessage(new Error('git said no'))).toBe('git said no')
    expect(errorMessage(new TypeError('not a function'))).toBe('not a function')
  })

  /** ⚠️ A rejected promise carrying a bare string is ordinary; it is already the message. */
  it('passes a thrown string straight through', () => {
    expect(errorMessage('ENOBUFS')).toBe('ENOBUFS')
  })

  /**
   * ⛔ The case the old ternary got wrong. A JSON-RPC fault or a vendor SDK's error object reached a
   * toast as `[object Object]` — which tells the reader nothing and cannot even be searched for.
   */
  it('renders a plain object as JSON rather than [object Object]', () => {
    expect(errorMessage({ code: 429, message: 'rate limited' })).toBe(
      '{"code":429,"message":"rate limited"}'
    )
  })

  /** ⚠️ A class that has said how it prints is not overruled with a field dump. */
  it('honours an object’s own toString', () => {
    class Refusal {
      toString(): string {
        return 'the pool is busy'
      }
    }
    expect(errorMessage(new Refusal())).toBe('the pool is busy')
  })

  it('survives an object it cannot serialise', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe('[object Object]')
    expect(errorMessage({ big: 1n })).toBe('[object Object]')
  })

  /**
   * ⛔ `throw undefined` is legal JavaScript and reaches here from an aborted fetch. The answer has
   * to be a string either way — a caller doing `.length` on it must not be the thing that crashes.
   */
  it('always answers a string, whatever it was given', () => {
    for (const value of [undefined, null, 0, false, 42, Symbol('nope'), () => 1]) {
      expect(typeof errorMessage(value)).toBe('string')
    }
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(404)).toBe('404')
  })
})
