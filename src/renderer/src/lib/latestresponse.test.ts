import { describe, expect, it } from 'vitest'
import { LatestResponse } from './latestresponse'

describe('LatestResponse', () => {
  it('does not restore a question from a list fetched before its answer', async () => {
    const latest = new LatestResponse()
    const shown: string[][] = []
    let finishBeforeAnswer!: (questions: string[]) => void
    const beforeAnswer = new Promise<string[]>((resolve) => { finishBeforeAnswer = resolve })

    const stale = latest.apply(beforeAnswer, (questions) => shown.push(questions))
    await latest.apply(Promise.resolve(['second question']), (questions) => shown.push(questions))
    finishBeforeAnswer(['answered question', 'second question'])
    await stale

    expect(shown).toEqual([['second question']])
  })

  it('does not clear a newer list when an older request fails', async () => {
    const latest = new LatestResponse()
    const shown: string[][] = []
    let failOld!: (reason: Error) => void
    const old = new Promise<string[]>((_, reject) => { failOld = reject })

    const stale = latest.apply(old, (questions) => shown.push(questions), () => shown.push([]))
    await latest.apply(Promise.resolve(['second question']), (questions) => shown.push(questions))
    failOld(new Error('old request failed'))
    await stale

    expect(shown).toEqual([['second question']])
  })
})
