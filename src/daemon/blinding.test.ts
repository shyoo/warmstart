import { describe, expect, it } from 'vitest'
import { blind } from './review.js'

/**
 * Blinding, checked against this repository's own history.
 *
 * ⭐ **The fixtures are real.** Measured 2026-09-03 over the last 60 commits on this branch: **37**
 * carry a `Co-Authored-By:` trailer naming the model, and **20** name an agent in the commit body
 * outside any trailer — `da837d9`'s subject is literally *"The subcommand that lets codex go home"*.
 * Those two numbers are why this function has two halves with different guarantees, and why the
 * weaker half reports itself instead of pretending.
 *
 * ⚠️ **The git author is not a leak.** All 60 of those commits are authored by the operator; the
 * agent commits under a human identity. Only the trailer and the prose name the agent.
 */

const VOCAB = {
  names: ['ClaudeSecond', 'claude-code', 'claude-opus-5', 'Claude Code', 'antigravity-cli', 'gpt-5.6-terra']
}

describe('what blinding removes exactly', () => {
  it('strips the Co-Authored-By trailer, which is on 37 of the last 60 commits', () => {
    const message = [
      'fix(agy): bill a stream turn from its own model calls',
      '',
      'Measured on agy 1.1.25.',
      '',
      'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
    ].join('\n')
    const { text } = blind(message, VOCAB)
    expect(text).not.toContain('Co-Authored-By')
    expect(text).not.toContain('anthropic.com')
    expect(text).toContain('fix(agy): bill a stream turn')
  })

  it('strips the generated-with footer the same way', () => {
    const { text } = blind('Body.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', VOCAB)
    expect(text).not.toContain('claude.com')
  })

  it('replaces worker labels, adapter ids and model ids wherever they appear', () => {
    const { text } = blind('Dispatched to ClaudeSecond on claude-opus-5 via claude-code.', VOCAB)
    expect(text).toBe('Dispatched to AGENT on AGENT via AGENT.')
  })

  it('replaces the longest name first, so a redaction never names what it removed', () => {
    // ⛔ A naive pass ordered by the input would turn `claude-opus-5` into `AGENT-opus-5`.
    const { text } = blind('model claude-opus-5', VOCAB)
    expect(text).toBe('model AGENT')
    expect(text).not.toContain('opus')
  })

  it('generalises the vendor dotfile directory but keeps the path', () => {
    // ⚠️ *Which* dotfile directory a task touched names the agent; *that* it touched agent
    // configuration is part of the change being judged, so the path survives.
    const { text } = blind('modified .claude/settings.json and .gemini/settings.json', VOCAB)
    expect(text).toContain('.agent-config/settings.json')
    expect(text).not.toContain('.claude/')
    expect(text).not.toContain('.gemini/')
  })

  it('is case-insensitive, because a commit body capitalises what a config file does not', () => {
    const { text } = blind('ClaudeSecond and claudesecond are the same account', VOCAB)
    expect(text).toBe('AGENT and AGENT are the same account')
  })

  it('ignores a vocabulary entry too short to be a name, which would redact ordinary prose', () => {
    const { text } = blind('it is an ok change', { names: ['ok'] })
    expect(text).toBe('it is an ok change')
  })
})

describe('what blinding cannot remove, and says so', () => {
  it('reports a leak when an agent is named in prose, rather than mangling the sentence', () => {
    // A real one: redacting this would leave a paragraph that no longer explains anything, and the
    // reviewer would score the redaction instead of the work.
    const body = 'The subcommand that lets codex go home: --sandbox workspace-write forbids the trunk’s .git.'
    const { text, leaked } = blind(body, VOCAB)
    expect(leaked).toBe(true)
    expect(text).toContain('codex')
  })

  it('reports no leak when the text names nobody', () => {
    const { leaked } = blind('Refactored the scheduler’s quota gate and added two tests.', VOCAB)
    expect(leaked).toBe(false)
  })

  it('reports no leak once the structured names are gone and nothing else identifies an agent', () => {
    const { text, leaked } = blind(
      'Dispatched to ClaudeSecond.\n\nCo-Authored-By: Claude Opus 5 <x@y>',
      VOCAB
    )
    expect(text).not.toContain('Claude')
    expect(leaked).toBe(false)
  })

  it('still reports a leak when a model family survives in prose the vocabulary did not cover', () => {
    // ⚠️ The vocabulary is built from what is *commissioned*. A commit that discusses a model this
    // machine has never run is exactly the case a name list cannot catch, and the flag is what makes
    // that visible rather than assumed.
    const { leaked } = blind('This works around a Gemini tokenizer quirk.', { names: [] })
    expect(leaked).toBe(true)
  })
})
