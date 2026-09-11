import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/**
 * A formula, typeset.
 *
 * ⛔ **Every string that reaches KaTeX here is a constant of this program** — a TeX literal written
 * in a component, or a `WEIGHT_FORMULAS` entry run through `lib/tex.ts`. Nothing an agent wrote and
 * nothing a person typed is ever typeset, which is the rule `docs/ui.md` states for markup in
 * general; `trust` is left off so `\href` and friends are refused even so.
 *
 * ⚠️ `throwOnError: false`, so a formula KaTeX cannot parse renders as red source text rather than
 * taking the page down. `lib/tex.test.ts` typesets every published formula with errors *on*, so the
 * page-level fallback should never actually be seen.
 */
function render(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, { throwOnError: false, displayMode, strict: 'ignore' })
}

/** Inline mathematics, in the running text. */
export function M({ tex }: { tex: string }): React.JSX.Element {
  const html = useMemo(() => render(tex, false), [tex])
  return <span className="math" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * Display mathematics, on its own line, numbered when the paper refers back to it.
 *
 * ⚠️ The number is set by the caller rather than counted, because equations sit inside tabs that
 * mount independently and a counter would restart on every one of them.
 */
export function Eq({ tex, n }: { tex: string; n?: string }): React.JSX.Element {
  const html = useMemo(() => render(tex, true), [tex])
  return (
    <div className="eq">
      <div className="eq-body" dangerouslySetInnerHTML={{ __html: html }} />
      {n ? <span className="eq-number">({n})</span> : null}
    </div>
  )
}
