import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { WEIGHT_FORMULAS } from '@shared/routing'
import { termTex, weightFormulaTex } from './tex.js'

describe('the published weight formulas, typeset', () => {
  it('turns the scheduler’s own string into TeX with the objective axes as single letters', () => {
    expect(weightFormulaTex('1.0 + 2.2×cost − 0.6×velocity')).toBe('1.0 + 2.2\\,c - 0.6\\,v')
    expect(weightFormulaTex('0.6 + 1.6×quality')).toBe('0.6 + 1.6\\,q')
  })

  it('passes a token outside the grammar through as upright text rather than guessing', () => {
    expect(weightFormulaTex('0.5 + 1.2×window')).toBe('0.5 + 1.2\\,\\mathrm{window}')
  })

  // ⛔ The backslash is the point. A shell heredoc on this platform drops one, which turned
  //    `\mathrm{cost}` into `mathrm{cost}` — and KaTeX typeset that as six italic letters without
  //    complaint, so nothing but this assertion would have caught it.
  it('emits a real TeX control sequence, one backslash long', () => {
    expect(termTex('cold')).toBe('\\lambda_{\\mathrm{cold}}')
    expect(termTex('cold').charCodeAt(0)).toBe(0x5c)
    expect(katex.renderToString(termTex('cold'), { throwOnError: true })).toContain('mathrm')
  })

  // ⛔ Every formula the scheduler publishes has to typeset, or the page prints KaTeX's red error
  //    text where a derivation should be. `throwOnError` is on here precisely so that a new formula
  //    that the grammar cannot read fails this test rather than a reader.
  it('typesets every formula the scheduler publishes without error', () => {
    for (const [name, formula] of Object.entries(WEIGHT_FORMULAS)) {
      const tex = `${termTex(name)} = ${weightFormulaTex(formula)}`
      const html = katex.renderToString(tex, { throwOnError: true })
      expect(html, name).toContain('katex')
    }
  })
})
