import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../shared/tasks.js'
import type { Session } from '../shared/protocol.js'
import { hasActiveWork, POWER_GRACE_MS, PowerActionController, powerCommand } from './poweraction.js'

afterEach(() => vi.useRealTimers())

describe('one-time power action', () => {
  it('counts queued, running, landing and resource-held work but ignores human and quota holds', () => {
    const task = (status: Task['status']) => ({ status, deletedAt: null }) as Task
    for (const status of ['ready', 'blocked', 'scheduled', 'assigned', 'running', 'landing_queued', 'cancelling'] as const) {
      expect(hasActiveWork([task(status)], [])).toBe(true)
    }
    for (const status of ['draft', 'awaiting_human', 'paused_quota', 'paused_user', 'completed', 'failed', 'cancelled'] as const) {
      expect(hasActiveWork([task(status)], [])).toBe(false)
    }
    expect(hasActiveWork([{ ...task('running'), deletedAt: 1 }], [])).toBe(false)
    expect(hasActiveWork([], [{ purpose: 'work', state: 'busy' } as unknown as Session])).toBe(true)
  })

  it('arms only with work, gives a cancel window, and rechecks before execution', async () => {
    vi.useFakeTimers()
    let now = 1000
    let active = true
    const execute = vi.fn(async () => {})
    const controller = new PowerActionController('win32', async () => active, execute, () => {}, () => now)
    await controller.arm('sleep')
    active = false
    await controller.check()
    expect(controller.state().dueAt).toBe(now + POWER_GRACE_MS)
    now += POWER_GRACE_MS
    active = true
    await controller.check()
    expect(controller.state().dueAt).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    active = false
    await controller.check()
    controller.cancel()
    now += POWER_GRACE_MS
    await controller.check()
    expect(execute).not.toHaveBeenCalled()
    active = true
    await controller.arm('hibernate')
    active = false
    await controller.check()
    now += POWER_GRACE_MS
    await controller.check()
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith('hibernate')
    expect(controller.state().action).toBeNull()
    controller.dispose()
  })

  it('refuses an empty queue and does not mistake a read failure for completion', async () => {
    const controller = new PowerActionController('darwin', async () => false, async () => {}, () => {})
    await expect(controller.arm('shutdown')).rejects.toThrow('No running or queued work')
    await expect(controller.arm('hibernate')).rejects.toThrow('unavailable')
    controller.dispose()
    let fail = false
    const guarded = new PowerActionController('win32', async () => { if (fail) throw new Error('offline'); return true }, async () => {}, () => {})
    await guarded.arm('shutdown')
    fail = true
    await guarded.check()
    expect(guarded.state()).toMatchObject({ action: null, error: 'offline' })
  })

  it('does not act if work arrives during the final queue read', async () => {
    vi.useFakeTimers()
    let now = 0
    let reads = 0
    const execute = vi.fn(async () => {})
    const controller = new PowerActionController('linux', async () => {
      reads++
      return reads === 1 || reads === 4
    }, execute, () => {}, () => now)
    await controller.arm('shutdown') // work present
    await controller.check() // empty: countdown begins
    now = POWER_GRACE_MS
    await controller.check() // empty, then new work at the final read
    expect(execute).not.toHaveBeenCalled()
    expect(controller.state()).toMatchObject({ action: 'shutdown', dueAt: null })
    controller.dispose()
  })

  it('selects explicit platform actions without a shell', () => {
    expect(powerCommand('win32', 'shutdown')).toEqual({ file: 'shutdown.exe', args: ['/s', '/t', '0'] })
    expect(powerCommand('win32', 'hibernate')).toEqual({ file: 'shutdown.exe', args: ['/h'] })
    expect(powerCommand('win32', 'sleep')?.args.join(' ')).toContain('SetSuspendState($false')
    expect(powerCommand('darwin', 'hibernate')).toBeNull()
    expect(powerCommand('linux', 'sleep')).toEqual({ file: 'systemctl', args: ['suspend'] })
  })
})
