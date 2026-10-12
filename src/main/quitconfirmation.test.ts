import { describe, expect, it, vi } from 'vitest'
import { QuitConfirmation } from './quitconfirmation'
import type { QuitConfirmationRequest } from '@shared/ipc'

describe('quit confirmation bridge', () => {
  it('waits for the renderer and accepts only its matching, closed-set answer', async () => {
    const bridge = new QuitConfirmation()
    const send = vi.fn<(request: QuitConfirmationRequest) => void>()
    const pending = bridge.ask(4, 2, send)
    expect(send).not.toHaveBeenCalled()
    bridge.ready(4)
    bridge.ready(4)
    expect(send).toHaveBeenCalledTimes(1)
    const request = send.mock.calls[0]![0]
    expect(request.options.actions[0]!.label).toBe('Cancel')
    expect(bridge.answer(8, request.id, 2)).toBe(false)
    expect(bridge.answer(4, request.id + 1, 2)).toBe(false)
    for (const choice of [-1, 3, 1.5, '2', null]) expect(bridge.answer(4, request.id, choice)).toBe(false)
    expect(bridge.answer(4, request.id, 2)).toBe(true)
    expect(await pending).toBe(2)
    expect(bridge.answer(4, request.id, 2)).toBe(false)
  })
  it('cancels on renderer loss and waits for readiness again', async () => {
    const bridge = new QuitConfirmation()
    const send = vi.fn<(request: QuitConfirmationRequest) => void>()
    bridge.ready(4)
    const pending = bridge.ask(4, 1, send)
    expect(await bridge.ask(4, 1, send)).toBe(0)
    bridge.forget(4)
    expect(await pending).toBe(0)
    const next = bridge.ask(4, 1, send)
    expect(send).toHaveBeenCalledTimes(1)
    bridge.ready(4)
    expect(send).toHaveBeenCalledTimes(2)
    bridge.answer(4, send.mock.calls[1]![0].id, 1)
    expect(await next).toBe(1)
  })
})
