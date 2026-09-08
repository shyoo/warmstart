import { describe, expect, it } from 'vitest'
import { describeTarget, failed, questionsFrom, text, type NativeQuestion } from './payload.js'

/**
 * The agent-facing surface, which until now could not be tested at all.
 *
 * ⛔ All of this lived in `index.ts`, which ends by connecting a stdio transport at the top level —
 * so importing it started an MCP server, and no suite could load it. `questionsFrom` is the most
 * forgiving parser in this app (four spellings of *multi-select*, two of *label*, two of *detail*)
 * and every one of those alternatives was written from a payload somebody watched arrive. None of
 * them had a check.
 *
 * ⚠️ **The failure mode is what makes it worth pinning.** This runs inside `--permission-prompt-tool`.
 * A parse that throws is not a wrong answer on screen; it is an agent that cannot act, mid-run, with
 * the reason buried in a CLI's stderr. Everything here is required to degrade rather than throw.
 */

describe('questionsFrom', () => {
  /** The single question a payload was expected to hold. Fails loudly rather than reading undefined. */
  const one = (payload: unknown): NativeQuestion => {
    const all = questionsFrom(payload)
    expect(all).toHaveLength(1)
    return all[0] as NativeQuestion
  }

  /** The nth option of that question, likewise. */
  const optionAt = (asked: NativeQuestion, index: number): { id: string; label: string; detail?: string } => {
    const option = asked.options[index]
    expect(option, `option ${index}`).toBeDefined()
    return option as { id: string; label: string; detail?: string }
  }

  it('reads the shape the vendor actually sends', () => {
    const asked = one({
      questions: [
        {
          question: 'Which database?',
          header: 'Storage',
          options: [
            { label: 'Postgres', description: 'what we already run' },
            { label: 'SQLite', description: 'no server to operate' }
          ]
        }
      ]
    })
    expect(asked.question).toBe('Which database?')
    expect(asked.header).toBe('Storage')
    expect(asked.multiSelect).toBe(false)
    expect(asked.options).toEqual([
      { id: 'opt1', label: 'Postgres', detail: 'what we already run' },
      { id: 'opt2', label: 'SQLite', detail: 'no server to operate' }
    ])
  })

  /**
   * ⛔ Four spellings, and they are not interchangeable guesses — each was seen. Missing one turns a
   * checkbox question into a radio question, and the operator's second and third answers are lost
   * with no sign that anything went wrong.
   */
  it('accepts every spelling of multi-select', () => {
    for (const key of ['multiSelect', 'multi_select', 'is_multi_select', 'multiple']) {
      const asked = one({
        questions: [{ question: 'Which checks?', options: ['lint', 'test'], [key]: true }]
      })
      expect(asked.multiSelect, key).toBe(true)
    }
  })

  it('does not make a question multi just because the key is present and false', () => {
    const asked = one({ questions: [{ question: 'Which?', options: ['a', 'b'], multiSelect: false }] })
    expect(asked.multiSelect).toBe(false)
  })

  /** ⚠️ `text` is the other label spelling, and `detail` the other prose one. */
  it('takes the alternative spellings of label and detail', () => {
    const asked = one({
      questions: [{ question: 'Which?', options: [{ text: 'Alpha', detail: 'the first one' }] }]
    })
    expect(asked.options).toEqual([{ id: 'opt1', label: 'Alpha', detail: 'the first one' }])
  })

  it('prefers description over detail when a payload carries both', () => {
    const asked = one({
      questions: [{ question: 'Which?', options: [{ label: 'A', description: 'from', detail: 'ours' }] }]
    })
    expect(optionAt(asked, 0).detail).toBe('from')
  })

  it('takes a bare string as an option, numbering it by position', () => {
    const asked = one({ questions: [{ question: 'Which?', options: ['Alpha', 'Beta'] }] })
    expect(asked.options).toEqual([
      { id: 'opt1', label: 'Alpha' },
      { id: 'opt2', label: 'Beta' }
    ])
  })

  it('keeps an id the payload supplied, and trims it', () => {
    const asked = one({
      questions: [{ question: 'Which?', options: [{ id: '  keep-me  ', label: 'Alpha' }] }]
    })
    expect(optionAt(asked, 0).id).toBe('keep-me')
  })

  it('falls back to a positional id for a blank one', () => {
    const asked = one({
      questions: [{ question: 'Which?', options: [{ id: '   ', label: 'Alpha' }] }]
    })
    expect(optionAt(asked, 0).id).toBe('opt1')
  })

  it('drops an option with no label at all, and keeps its neighbours', () => {
    const asked = one({
      questions: [{ question: 'Which?', options: [{ label: 'Alpha' }, { nope: 1 }, 'Gamma'] }]
    })
    expect(asked.options.map((o) => o.label)).toEqual(['Alpha', 'Gamma'])
  })

  it('is a text question when no options came with it', () => {
    const asked = one({ questions: [{ question: 'What should the timeout be?' }] })
    expect(asked.options).toEqual([])
    expect(asked.multiSelect).toBe(false)
  })

  it('reads more than one question out of one payload', () => {
    const all = questionsFrom({
      questions: [{ question: 'First?' }, { question: 'Second?', options: ['a'] }]
    })
    expect(all.map((q) => q.question)).toEqual(['First?', 'Second?'])
  })

  it('skips an entry with no question text and keeps the rest', () => {
    const all = questionsFrom({ questions: [{ options: ['a'] }, { question: 'Real?' }] })
    expect(all.map((q) => q.question)).toEqual(['Real?'])
  })

  /**
   * ⛔ The degrade-don't-throw contract. Each of these is *not a question*, and the answer to that is
   * an empty list — which sends the caller down the ordinary approval path. A throw here strands a
   * running agent.
   */
  it('answers an empty list for anything that is not a question payload', () => {
    for (const payload of [
      null,
      undefined,
      'a string',
      42,
      {},
      { questions: null },
      { questions: [] },
      { questions: 'not an array' },
      { questions: [null, 7, 'text'] }
    ]) {
      expect(questionsFrom(payload), JSON.stringify(payload ?? null)).toEqual([])
    }
  })

  it('ignores a header that is not a string rather than passing it on', () => {
    const asked = one({ questions: [{ question: 'Which?', header: 42 }] })
    expect(asked.header).toBeUndefined()
  })
})

describe('describeTarget', () => {
  it('names the first key it recognises, in its stated order', () => {
    expect(describeTarget({ command: 'rm -rf /', file_path: 'a.ts' })).toBe('rm -rf /')
    expect(describeTarget({ file_path: 'a.ts', path: 'b.ts' })).toBe('a.ts')
    expect(describeTarget({ url: 'https://example.com' })).toBe('https://example.com')
    expect(describeTarget({ pattern: '*.ts' })).toBe('*.ts')
    expect(describeTarget({ query: 'select 1' })).toBe('select 1')
  })

  /** ⚠️ A bound, because this goes into a one-line summary beside an approval card. */
  it('cuts a very long value at 300 characters', () => {
    expect(describeTarget({ command: 'x'.repeat(1000) })).toHaveLength(300)
  })

  it('is an empty string for anything it does not recognise', () => {
    expect(describeTarget({ nothing: 'here' })).toBe('')
    expect(describeTarget({ command: 42 })).toBe('')
    expect(describeTarget(null)).toBe('')
    expect(describeTarget('a string')).toBe('')
  })
})

describe('a tool result', () => {
  it('sends a string as itself, not as JSON', () => {
    expect(text('Filed as t12.')).toEqual({ content: [{ type: 'text', text: 'Filed as t12.' }] })
  })

  it('pretty-prints anything else, so an agent can read it', () => {
    expect(text({ a: 1 }).content[0]?.text).toBe('{\n  "a": 1\n}')
  })

  /** ⛔ `isError` is how the CLI knows this was a failure; without it a refusal reads as an answer. */
  it('marks a failure, and says what the throw said', () => {
    expect(failed(new Error('daemon is not running'))).toEqual({
      content: [{ type: 'text', text: 'daemon is not running' }],
      isError: true
    })
  })

  it('describes a throw that was not an Error', () => {
    expect(failed({ code: 429 }).content[0]?.text).toBe('{"code":429}')
  })
})
