/**
 * Blinding a review, and the one honest thing that can be said about how well it worked.
 *
 * ⛔ **Pure, and in its own file so that a migration can import it.** `review.ts` reads the
 * database; migration 50 has to re-decide the leak flag on rows written before this file existed,
 * and importing `review.ts` from `db.ts` to get one regular expression would close a cycle.
 */

/** Names of the things that identify an agent in structured text. */
export interface BlindVocabulary {
  /** Adapter ids, adapter labels, worker labels and model ids — anything that names who ran. */
  names: string[]
}

/** Every commit trailer that names the agent that wrote the commit. */
const TRAILER = /^[ \t]*(?:co-authored-by|assisted-by|signed-off-by)\b.*$/gim

/**
 * The tool footer, which is not a trailer and does not start at the margin.
 *
 * ⚠️ Its real form in this repository is `🤖 Generated with [Claude Code](https://claude.com/…)` —
 * an emoji, then the phrase, then a URL naming the vendor twice more. A rule anchored to the start
 * of the line, which is the right shape for a trailer, missed every one of them.
 */
const TOOL_FOOTER = /^.*\bgenerated with\b.*$/gim

/** Vendor and model families, as they are spelled in prose rather than in a model id. */
const VENDOR = String.raw`(?:claude|anthropic|opus|sonnet|haiku|codex|openai|gpt-?[\w.]*|antigravity|gemini|agy|qwen|llama|mistral)`

/**
 * A vendor name **in a position that attributes authorship**, which is the only kind of mention
 * that can un-blind a review.
 *
 * ⛔ **The bare-mention test this replaced flagged 30 of this fleet's 32 completed reviews**
 * (measured 2026-09-06 over the stored review prompts), and a flag that is true 94% of the time
 * distinguishes nothing — it silently voided almost every grade the fleet had paid for, because
 * `statistics.ts` averages *clean* reviews only. The cause is not a blinding failure: this
 * repository's whole subject matter is coding agents, so `antigravity`, `gemini` and `claude` are
 * ordinary nouns in its diffs and commit messages. A reviewer reading *"the subcommand that lets
 * codex go home"* learns what the change is **about**, not who wrote it.
 *
 * So what is looked for now is the shape of an attribution — a `…-by:` trailer that survived the
 * strip, a *generated with/by*, an `agent`/`worker`/`model`/`author` label pointing at a vendor, or
 * a vendor as the subject of a writing verb. ⚠️ Measured on the same 32 prompts: **0** flagged.
 * That is a weaker guarantee honestly stated, not a stronger one — the structured identifiers are
 * still removed exactly, and this only decides what to *say* about what could not be removed.
 */
const ATTRIBUTION = new RegExp(
  [
    // A trailer shape that survived the strip: `Co-Authored-By: Claude Opus 5`, `Reviewed-by: …`.
    String.raw`^[ \t]*[\w-]*\bby[ \t]*:.*\b${VENDOR}\b`,
    // The tool footer's wording, wherever on the line it sits.
    String.raw`\bgenerated (?:with|by)\b[^\n]*\b${VENDOR}\b`,
    // A label that names a runner: `agent: gemini`, `ran on Claude Code`, `model = gpt-5.6`.
    String.raw`\b(?:agent|worker|model|adapter|author|authored by|written by|ran on|run by|dispatched to)\b[^\n]{0,40}?\b${VENDOR}\b`,
    // A vendor as the subject of a writing verb: `Claude wrote`, `codex implemented`.
    String.raw`\b${VENDOR}\b[ \t]*(?:wrote|authored|implemented|generated|produced)\b`
  ].join('|'),
  'im'
)

/**
 * Does this text still say who did the work?
 *
 * ⛔ Exported for migration 50, which re-decides the flag on reviews graded before the definition
 * changed, and for the tests. Nothing else should ask: the answer belongs on the review row.
 */
export function namesAnAuthor(text: string): boolean {
  return ATTRIBUTION.test(text)
}

/**
 * Strip what identifies the author, and say honestly what could not be stripped.
 *
 * ⛔ **Exact on structured fields, best-effort on prose, and the difference is recorded rather than
 * papered over.** Trailers, model ids, worker labels and vendor dotfile directories come out
 * mechanically and completely. A commit body that explains a codex-specific sandbox bug does not:
 * replacing *"codex"* with *"AGENT-A"* throughout produces a paragraph that no longer means
 * anything, and a reviewer reading it would score the redaction rather than the work.
 *
 * So `leaked` is stored on the review, and a comparison across agents that has not excluded leaked
 * reviews is not a clean comparison. ⚠️ The field exists so that can be *checked* rather than
 * assumed — which is the whole difference between this and claiming a guarantee it cannot keep.
 *
 * ⭐ A pure function over strings, which is what makes it cheap to keep honest: `blinding.test.ts`
 * uses real trailers and real leak cases from this repository's own history as fixtures.
 */
export function blind(text: string, vocabulary: BlindVocabulary = { names: [] }): {
  text: string
  leaked: boolean
} {
  let out = text.replace(TRAILER, '').replace(TOOL_FOOTER, '')

  // ⛔ Longest first. `claude-opus-5` must not be half-replaced by a rule for `claude`, which would
  // leave `AGENT-opus-5` on the page — a redaction that names the thing it removed.
  const names = [...vocabulary.names]
    .filter((n) => n.trim().length >= 3)
    .sort((a, b) => b.length - a.length)
  for (const name of names) {
    out = out.replace(new RegExp(escapeRegExp(name), 'gi'), 'AGENT')
  }

  // ⚠️ The path is kept and the vendor directory generalised: *which* dotfile directory a task
  // touched names the agent as surely as a trailer does, while the fact that it touched agent
  // configuration at all is part of the change being judged.
  out = out.replace(/\.(claude|gemini|codex|agy)\//gi, '.agent-config/')

  out = out.replace(/\n{3,}/g, '\n\n')
  return { text: out, leaked: namesAnAuthor(out) }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
