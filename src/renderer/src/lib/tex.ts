/**
 * The published weight formulas, as TeX.
 *
 * ⛔ **Built from the scheduler's own strings, never hand-typed beside them.** `WEIGHT_FORMULAS`
 * (`@shared/routing.ts`) is stamped on every stored decision and checked against `weights()` by
 * `cost.test.ts`; the Routing Model page typesets *those* strings, so the formula a reader sees is
 * the formula the sum used. A second, prettier copy in the renderer would be the drift that test
 * exists to prevent.
 *
 * ⚠️ The grammar is the same tiny one `evaluateWeightFormula` reads — signed terms of `number` or
 * `number×name` — and anything outside it is passed through as text rather than guessed at, so an
 * unexpected token typesets as itself and is visible instead of silently rewritten.
 *
 * ⛔ Written with the Write tool, not a shell heredoc: every string below carries a TeX backslash,
 * and a heredoc on this platform silently drops one (`AGENTS.md`, *Things that will bite*).
 */
export function weightFormulaTex(formula: string): string {
  return formula
    .split(/\s+/)
    .map((token) => {
      if (token === '+' || token === '−' || token === '-') return token === '+' ? '+' : '-'
      const [num, name] = token.split('×')
      if (name === undefined) return num
      return `${num}\\,${objectiveVarTex(name)}`
    })
    .join(' ')
}

/**
 * The three objective axes as the single letters the paper uses — `q`, `c`, `v` — so a formula reads
 * as arithmetic rather than as a sentence. Anything else is set upright in `\mathrm`, which is what a
 * name (as opposed to a variable) is in a paper.
 */
export function objectiveVarTex(name: string): string {
  switch (name) {
    case 'quality':
      return 'q'
    case 'cost':
      return 'c'
    case 'velocity':
      return 'v'
    default:
      return `\\mathrm{${name.replace(/[^a-zA-Z0-9]/g, '')}}`
  }
}

/** A term name such as `cacheWarmth` as its weight symbol: `\lambda_{\mathrm{cacheWarmth}}`. */
export function termTex(name: string): string {
  return `\\lambda_{\\mathrm{${name.replace(/[^a-zA-Z0-9]/g, '')}}}`
}
