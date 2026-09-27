import { describe, expect, it } from 'vitest'
import {
  clearRunActivity,
  closingReply,
  completionMessage,
  consumeRunActivity,
  noteActivity,
  noteReplyBoundary,
  noteReplyText,
  REPLY_KEEP_CHARS,
  runActivityFor
} from './activity.js'

/**
 * The agent's closing reply — what it said last, kept whole for the thread (t731 ← t734).
 *
 * ⛔ The peephole beside it cuts every line at 400 characters on purpose, and t731's answer reached
 * the operator only through it: `bash.exe -lc … i.e. a…`. These pin the other store, which must
 * not cut, must not glue, and must pick the *last* block of prose, not narration from earlier.
 */
let n = 0
const run = (): string => `closing-reply-run-${++n}`

describe('the closing reply', () => {
  it('is the prose after the last tool call, whole — not the peephole’s 400-character rows', () => {
    const id = run()
    const answer = `**Put this in project.json**: ${'y'.repeat(1200)}`
    noteReplyText(id, 'Let me read the deploy script.', 'message')
    noteReplyBoundary(id)
    noteReplyText(id, answer, 'message')
    noteActivity('peephole-task', answer, id, 'message')
    expect(closingReply(id)).toBe(answer)
    // ⚠️ The peephole still cuts, which is right for it and is why it cannot be the source.
    expect(runActivityFor(id).at(-1)?.text.endsWith('…')).toBe(true)
  })

  it('is the block a tool call just closed, which is the prose written before task_complete', () => {
    const id = run()
    noteReplyText(id, 'The answer is B.', 'message')
    noteReplyBoundary(id) // task_complete, announced before the MCP call arrives
    expect(closingReply(id)).toBe('The answer is B.')
  })

  it('is empty when the last tool call had no prose before it, rather than older narration', () => {
    const id = run()
    noteReplyText(id, 'Now let me run the tests.', 'message')
    noteReplyBoundary(id)
    noteReplyBoundary(id)
    expect(closingReply(id)).toBe('')
  })

  it('keeps each whole message as its own paragraph, with its own linebreaks and fences', () => {
    const id = run()
    noteReplyText(id, 'First paragraph.\nSecond line.', 'message')
    noteReplyText(id, '```sh\nbash -lc "./deploy.sh --go"\n```', 'message')
    expect(closingReply(id)).toBe('First paragraph.\nSecond line.\n\n```sh\nbash -lc "./deploy.sh --go"\n```')
  })

  it('reassembles streamed fragments exactly as they spell themselves', () => {
    const id = run()
    for (const piece of ['Run it', ' with cwd', ' at the repo', ' root.\n\n', '```json\n', '"x"\n', '```']) {
      noteReplyText(id, piece, 'delta')
    }
    expect(closingReply(id)).toBe('Run it with cwd at the repo root.\n\n```json\n"x"\n```')
  })

  it('is bounded, keeping the end, where an answer concludes', () => {
    const id = run()
    noteReplyText(id, 'a'.repeat(REPLY_KEEP_CHARS), 'delta')
    noteReplyText(id, 'THE END', 'delta')
    const kept = closingReply(id)
    expect(kept.length).toBe(REPLY_KEEP_CHARS)
    expect(kept.endsWith('THE END')).toBe(true)
  })

  it('is forgotten with the run', () => {
    const a = run()
    const b = run()
    noteReplyText(a, 'kept until consumed', 'message')
    noteReplyText(b, 'kept until cleared', 'message')
    consumeRunActivity(a)
    clearRunActivity(b)
    expect(closingReply(a)).toBe('')
    expect(closingReply(b)).toBe('')
  })
})

describe('the completion message', () => {
  it('is the summary, then the reply', () => {
    expect(completionMessage('answered the deploy question', 'Use `bash.exe -lc`.')).toBe(
      'answered the deploy question\n\nUse `bash.exe -lc`.'
    )
  })

  it('is the summary alone when there is no reply, or the reply adds nothing', () => {
    expect(completionMessage('fixed the gauge', '')).toBe('fixed the gauge')
    expect(completionMessage('fixed the gauge. All 12 tests pass.', 'All 12 tests pass.')).toBe(
      'fixed the gauge. All 12 tests pass.'
    )
  })

  it('is the reply alone when it already says the summary, or the summary is the placeholder', () => {
    expect(completionMessage('fixed the gauge', 'I fixed the gauge.\n\nDetails…')).toBe('I fixed the gauge.\n\nDetails…')
    expect(completionMessage('Completed', 'The answer is B.')).toBe('The answer is B.')
    expect(completionMessage('', 'The answer is B.')).toBe('The answer is B.')
  })
})
