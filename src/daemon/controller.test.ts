import { describe, expect, it } from 'vitest'
import { extractJson } from './controller.js'
import {
  MAX_DECOMPOSE_CHILDREN,
  validateDecomposition,
  validateGate,
  validateRoute,
  validateTriage
} from './judgment.js'

/**
 * The boundary between a language model's output and a scheduler that spends money.
 *
 * ⛔ Everything here is a place where being permissive is expensive and being wrong is silent. A
 * hallucinated worker id becomes a dispatch; a forward dependency edge becomes a deadlock; an
 * invented model name becomes a failed spawn on somebody's real account. So each of these tests is a
 * *refusal* the controller must keep making.
 */

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']

describe('extractJson', () => {
  it('reads a fenced block, ignoring the prose around it', () => {
    const reply = 'Sure — here is my answer.\n```json\n{"verdict":"accept"}\n```\nHope that helps.'
    expect(extractJson(reply)).toEqual({ verdict: 'accept' })
  })

  it('reads a bare object with no fence', () => {
    expect(extractJson('I think {"action":"retry"} is right.')).toEqual({ action: 'retry' })
  })

  it('takes the last object when the model shows its working first', () => {
    // Models routinely sketch a shape, then correct it. The final answer is the answer.
    const reply = 'First I considered {"action":"human"}. On reflection: {"action":"retry"}'
    expect(extractJson(reply)).toEqual({ action: 'retry' })
  })

  it('does not truncate at a brace inside a quoted string', () => {
    // A rewritten prompt very often contains braces. A naive lastIndexOf('}') would cut here and
    // silently drop the rest of the answer.
    const reply = '{"action":"rewrite","prompt":"use the shape { id, name } for the record"}'
    expect(extractJson(reply)).toMatchObject({
      action: 'rewrite',
      prompt: 'use the shape { id, name } for the record'
    })
  })

  it('handles an escaped quote inside a string', () => {
    const reply = String.raw`{"why":"it said \"no such file\" every time"}`
    expect(extractJson(reply)).toEqual({ why: 'it said "no such file" every time' })
  })

  it('returns null for prose with no object, rather than guessing', () => {
    expect(extractJson('I would retry it, personally.')).toBeNull()
  })

  it('returns null for a bare array — the contract is an object', () => {
    expect(extractJson('```json\n[1,2,3]\n```')).toBeNull()
  })

  it('returns null for malformed JSON rather than repairing it', () => {
    expect(extractJson('{"action": retry}')).toBeNull()
  })
})

describe('validateDecomposition', () => {
  const child = (title: string, dependsOn?: number[]) => ({ title, ...(dependsOn ? { dependsOn } : {}) })

  it('accepts a chain in dependency order', () => {
    const result = validateDecomposition({
      children: [child('M1'), child('M2', [0]), child('M3', [1])]
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.map((c) => c.dependsOn)).toEqual([[], [0], [1]])
  })

  it('rejects a forward edge, which is the only way a cycle could get in', () => {
    const result = validateDecomposition({ children: [child('M1', [1]), child('M2')] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not an earlier child')
  })

  it('rejects a self-reference', () => {
    const result = validateDecomposition({ children: [child('M1', [0])] })
    expect(result.ok).toBe(false)
  })

  it('rejects an index past the end of the list', () => {
    expect(validateDecomposition({ children: [child('M1'), child('M2', [7])] }).ok).toBe(false)
  })

  it('caps fan-out however much the goal seems to want', () => {
    const children = Array.from({ length: MAX_DECOMPOSE_CHILDREN + 1 }, (_, i) => child(`M${i}`))
    const result = validateDecomposition({ children })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('exceeds the cap')
  })

  it('rejects an empty plan rather than completing the task with nothing', () => {
    expect(validateDecomposition({ children: [] }).ok).toBe(false)
    expect(validateDecomposition({}).ok).toBe(false)
  })

  it('rejects a child with no title', () => {
    expect(validateDecomposition({ children: [{ acceptance: 'it works' }] }).ok).toBe(false)
    expect(validateDecomposition({ children: [child('   ')] }).ok).toBe(false)
  })

  it('drops a nonsense estimate instead of believing it', () => {
    const result = validateDecomposition({ children: [{ title: 'M1', estTokens: -5 }] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value[0]?.estTokens).toBeNull()
  })
})

describe('validateTriage', () => {
  it('accepts the two answers that need no argument', () => {
    expect(validateTriage({ action: 'retry', why: 'looks transient' }, MODELS).ok).toBe(true)
    expect(validateTriage({ action: 'human' }, MODELS).ok).toBe(true)
  })

  it('refuses a rewrite with no replacement prompt', () => {
    expect(validateTriage({ action: 'rewrite' }, MODELS).ok).toBe(false)
  })

  it('refuses to escalate to a model the cost model cannot price', () => {
    // ⛔ An invented id would reach a CLI and fail at spawn time on a real account.
    const result = validateTriage({ action: 'escalate', model: 'claude-omega-9' }, MODELS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not a model this cost model can price')
  })

  it('accepts a model it does know', () => {
    expect(validateTriage({ action: 'escalate', model: 'claude-opus-5' }, MODELS).ok).toBe(true)
  })

  it('refuses an action outside the four', () => {
    expect(validateTriage({ action: 'delete' }, MODELS).ok).toBe(false)
    expect(validateTriage({}, MODELS).ok).toBe(false)
  })
})

describe('validateGate', () => {
  it('accepts the three verdicts that need no argument', () => {
    for (const verdict of ['accept', 'reject', 'human']) {
      expect(validateGate({ verdict }).ok, verdict).toBe(true)
    }
  })

  it('refuses a rescope with no replacement title', () => {
    expect(validateGate({ verdict: 'rescope' }).ok).toBe(false)
    expect(validateGate({ verdict: 'rescope', title: '  ' }).ok).toBe(false)
  })

  it('refuses a verdict outside the four', () => {
    expect(validateGate({ verdict: 'defer' }).ok).toBe(false)
  })
})

describe('validateRoute', () => {
  const ids = ['worker-a', 'worker-b']

  it('accepts one of the candidates offered', () => {
    const result = validateRoute({ workerId: 'worker-b', why: 'warmer' }, ids)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.workerId).toBe('worker-b')
  })

  it('refuses an id that was not on the list', () => {
    expect(validateRoute({ workerId: 'worker-z' }, ids).ok).toBe(false)
  })

  it('refuses an empty answer', () => {
    expect(validateRoute({}, ids).ok).toBe(false)
  })
})
