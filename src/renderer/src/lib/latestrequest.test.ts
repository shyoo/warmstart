import { describe, expect, it } from 'vitest'
import { latestRequest } from './latestrequest'

describe('quality selection during a delayed request', () => {
  it('drops the old result and runs only the latest queued selection', async () => {
    const q = latestRequest()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const drawn: string[] = []
    const calls: string[] = []
    q.select('none')
    const first = q.run('none', async (current) => {
      calls.push('none'); await wait
      if (current()) drawn.push('none')
    })
    q.select('one')
    await q.run('one', async (current) => { calls.push('one'); if (current()) drawn.push('one') })
    q.select('all:page2')
    await q.run('all:page2', async (current) => { calls.push('all:page2'); if (current()) drawn.push('all:page2') })
    release(); await first
    expect(calls).toEqual(['none', 'all:page2'])
    expect(drawn).toEqual(['all:page2'])
  })

  it('rejects an old answer even if the selection changes away and back', async () => {
    const q = latestRequest()
    q.select('none')
    let accepted = true
    await q.run('none', async (current) => {
      q.select('one'); q.select('none'); accepted = current()
    })
    expect(accepted).toBe(false)
  })
})
