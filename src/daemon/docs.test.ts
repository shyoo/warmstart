import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The documentation guard.
 *
 * ⛔ Documentation in this repository goes stale in one direction: the code moves and nobody reads
 * the page that described it. Prose cannot be checked by a test, but the *mechanical* half can be -
 * a link that resolves to nothing, a page nobody indexed, a `src/…` path that was renamed, a handoff
 * that grew past the length at which the next session stops reading it.
 *
 * ⚠️ This is deliberately not a spell-check on the reasoning. It catches the failures that are
 * detectable and leaves the ones that need a reader to the commit workflow (`docs/development.md` §7).
 */

const REPO = resolve(import.meta.dirname, '..', '..')
const DOCS = join(REPO, 'docs')

/** Files loaded into every agent's context, so their length is a real and recurring cost. */
const LINE_BUDGETS: Record<string, number> = {
  'AGENTS.md': 200,
  'HANDOFF.md': 200
}

function read(relative: string): string {
  return readFileSync(join(REPO, relative), 'utf8')
}

function docPages(): string[] {
  return readdirSync(DOCS)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
}

function markdownFiles(): string[] {
  return ['AGENTS.md', 'HANDOFF.md', 'README.md', ...docPages().map((f) => `docs/${f}`), 'docs/README.md']
}

/**
 * Every `[text](target)` in a file, minus the ones no filesystem can answer for.
 *
 * ⚠️ Anchors are stripped rather than resolved: a heading can be renamed without breaking the link's
 * usefulness, and checking them would make every heading edit a test failure.
 */
function links(markdown: string): string[] {
  const found: string[] = []
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown))) {
    const target = m[1]
    if (!target) continue
    if (/^(https?:|mailto:|#)/.test(target)) continue
    found.push(target.split('#')[0] ?? '')
  }
  return found.filter(Boolean)
}

describe('documentation', () => {
  it('indexes every page in docs/README.md', () => {
    const index = read('docs/README.md')
    const missing = docPages().filter((page) => !index.includes(`(${page})`))
    expect(missing, `add these to docs/README.md: ${missing.join(', ')}`).toEqual([])
  })

  it('has no relative link pointing at a file that does not exist', () => {
    const broken: string[] = []
    for (const file of markdownFiles()) {
      const from = dirname(join(REPO, file))
      for (const target of links(read(file))) {
        if (!existsSync(resolve(from, target))) broken.push(`${file} → ${target}`)
      }
    }
    expect(broken, `broken links:\n${broken.join('\n')}`).toEqual([])
  })

  /**
   * ⛔ The check that actually catches drift. A doc naming `src/daemon/eligibility.ts` is making a
   * claim about where something lives, and a rename that leaves the claim behind is exactly the kind
   * of wrongness a reader trusts.
   *
   * ⚠️ Only paths under `src/` and `test/`, and only inside backticks - prose mentioning a directory
   * is not a claim about a file, and a glob is not a path.
   */
  it('cites no source file that has been moved or deleted', () => {
    const re = /`((?:src|test|scripts|costmodels)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|json|css|ps1|sh))`/g
    const missing: string[] = []
    for (const file of markdownFiles()) {
      const text = read(file)
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const path = m[1]
        if (!path) continue
        if (!existsSync(join(REPO, path))) missing.push(`${file} → ${path}`)
      }
    }
    expect(missing, `documented paths that no longer exist:\n${missing.join('\n')}`).toEqual([])
  })

  /**
   * ⚠️ A budget, not a style rule. `AGENTS.md` is loaded into every session and `HANDOFF.md` is read
   * at the start of each one; both have been rewritten from scratch once already because they grew
   * past the point where anybody read to the end. Adding a line means finding the one it obsoletes.
   */
  it.each(Object.entries(LINE_BUDGETS))('keeps %s under its line budget', (file, budget) => {
    const lines = read(file).split('\n').length
    expect(lines, `${file} is ${lines} lines; the budget is ${budget}`).toBeLessThanOrEqual(budget)
  })

  it('points AGENTS.md at the documentation index', () => {
    expect(read('AGENTS.md')).toContain('docs/README.md')
  })
})
