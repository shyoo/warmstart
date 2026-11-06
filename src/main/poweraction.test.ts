import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../shared/tasks.js'
import type { Session } from '../shared/protocol.js'
import { hasActiveWork, parsePowerProbe, POWER_GRACE_MS, PowerActionController, powerCommand, powerFailure } from './poweraction.js'

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
    // ERROR_MACHINE_LOCKED (1271): an unattended shutdown must also work at the lock screen.
    expect(powerCommand('win32', 'shutdown')).toEqual({ file: 'shutdown.exe', args: ['/s', '/f', '/t', '0'] })
    // shutdown /h exits 0 when hibernation is disabled, so hibernate checks powrprof itself (t1186).
    const hibernate = powerCommand('win32', 'hibernate')
    expect(hibernate?.file).toBe('powershell.exe')
    expect(hibernate?.args.join(' ')).toContain('IsPwrHibernateAllowed()) {')
    expect(hibernate?.args.join(' ')).toContain('SetSuspendState($true')
    const sleep = powerCommand('win32', 'sleep')?.args.join(' ')
    expect(sleep).toContain('IsPwrSuspendAllowed()) {')
    expect(sleep).toContain('SetSuspendState($false')
    expect(powerCommand('darwin', 'hibernate')).toBeNull()
    expect(powerCommand('linux', 'sleep')).toEqual({ file: 'systemctl', args: ['suspend'] })
  })

  it('names the action and what Windows said, including a refusal that exits 0', () => {
    expect(powerFailure('shutdown', 'shutdown.exe', 0, '')).toBeNull()
    expect(powerFailure('hibernate', 'shutdown.exe', 0,
      'Hibernation is not enabled on this system. You must enable hibernation in order to use the -h option.(126)'))
      .toBe('Hibernate failed: Hibernation is not enabled on this system. You must enable hibernation in order to use the -h option.(126)')
    expect(powerFailure('shutdown', 'shutdown.exe', 1190, 'A system shutdown has already been scheduled.(1190)\r\n'))
      .toBe('Shut down failed: A system shutdown has already been scheduled.(1190)')
    expect(powerFailure('sleep', 'systemctl', 1, '')).toBe('Sleep failed: systemctl exited with code 1')
  })

  it('offers only what the computer says it can do', () => {
    expect(parsePowerProbe('sleep=True hibernate=False')).toEqual(['shutdown', 'sleep'])
    expect(parsePowerProbe('sleep=False hibernate=True')).toEqual(['shutdown', 'hibernate'])
    expect(parsePowerProbe('Add-Type : error')).toBeNull()
    const changed = vi.fn()
    const controller = new PowerActionController('win32', async () => true, async () => {}, changed)
    controller.restrict(['shutdown', 'sleep'])
    expect(controller.state().available).toEqual(['shutdown', 'sleep'])
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ available: ['shutdown', 'sleep'] }))
    return expect(controller.arm('hibernate')).rejects.toThrow('unavailable')
  })

  it('never widens the platform list', () => {
    const controller = new PowerActionController('darwin', async () => true, async () => {}, () => {})
    controller.restrict(['shutdown', 'sleep', 'hibernate'])
    expect(controller.state().available).toEqual(['shutdown', 'sleep'])
  })
})
