import { describe, expect, it } from 'vitest'
import { ConfirmationQueue } from './confirmation'

const options = { title: 'Delete?', message: 'Discard the work.', actions: [{ label: 'Cancel' }, { label: 'Delete', danger: true }] }

describe('in-app confirmation queue', () => {
  it('waits for a valid answer and dismisses safely', async () => {
    const queue = new ConfirmationQueue()
    let settled = false
    const answer = queue.ask(options).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    queue.snapshot()!.answer(8)
    await Promise.resolve()
    expect(settled).toBe(false)
    queue.snapshot()!.answer(0)
    expect(await answer).toBe(0)
    expect(queue.snapshot()).toBeNull()
  })

  it('keeps overlapping requests separate and ignores repeat clicks', async () => {
    const queue = new ConfirmationQueue()
    const first = queue.ask(options)
    const request = queue.snapshot()!
    const second = queue.ask({ ...options, title: 'Archive?' })
    expect(queue.snapshot()).toBe(request)
    request.answer(1)
    expect(await first).toBe(1)
    expect(queue.snapshot()!.options.title).toBe('Archive?')
    request.answer(1)
    expect(queue.snapshot()!.options.title).toBe('Archive?')
    queue.snapshot()!.answer(0)
    expect(await second).toBe(0)
  })
})
