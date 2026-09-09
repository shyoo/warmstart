import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError, pairDevice, rpc, store } from './api.js'

function respond(status: number, json: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ status, json: () => Promise.resolve(json) }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  store.clear()
})

describe('remote rpc client', () => {
  it('sends the bearer token and returns the result', async () => {
    store.set('tok-1')
    respond(200, { id: 'm1', ok: true, result: [] })
    const out = await rpc('approval.list', undefined)
    expect(out).toEqual([])
    const [, init] = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      { headers: Record<string, string> }
    ]
    expect(init.headers.authorization).toBe('Bearer tok-1')
  })

  it('clears the token and reports pair-again on 401', async () => {
    store.set('tok-1')
    respond(401, { error: 'unauthorized' })
    await expect(rpc('fleet.list', undefined)).rejects.toMatchObject({ status: 401 })
    expect(store.get()).toBeNull()
  })

  it('keeps the token on any other failure', async () => {
    store.set('tok-1')
    respond(500, { error: 'boom' })
    await expect(rpc('fleet.list', undefined)).rejects.toBeInstanceOf(RemoteError)
    expect(store.get()).toBe('tok-1')
  })

  it('surfaces the daemon refusal message from an ok:false body', async () => {
    store.set('tok-1')
    respond(200, { id: 'm1', ok: false, error: { message: 'no such task' } })
    await expect(rpc('task.get', { id: 'x' })).rejects.toThrow('no such task')
  })

  it('pairs by code and stores the token without returning it', async () => {
    respond(200, { token: 'tok-2', deviceId: 'd1' })
    await expect(pairDevice('  ABC123 ', '')).resolves.toBeUndefined()
    expect(store.get()).toBe('tok-2')
  })

  it('says plainly when the code is wrong', async () => {
    respond(401, { error: 'invalid pairing code' })
    await expect(pairDevice('nope', 'Phone')).rejects.toThrow(/fresh one/)
    expect(store.get()).toBeNull()
  })
})
