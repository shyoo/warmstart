import { describe, expect, it } from 'vitest'
import type { TargetSummary, TargetsState } from '@shared/ipc'
import { activeSummary, notificationTitle, targetOptionLabel } from './target'

const local: TargetSummary = { id: 'local', label: 'This computer', kind: 'local', url: null, state: 'connected', message: null, remoteAppVersion: null, rpcVersion: null, remoteNeedsUpgrade: false, pairedAt: null }
const desk: TargetSummary = { ...local, id: 'r1', label: 'desk', kind: 'remote', url: 'https://desk.ts.net:8787', state: 'connected', pairedAt: 1 }

describe('target labels', () => {
  it('says why the selected remote is not simply reachable, and nothing about an idle one', () => {
    expect(targetOptionLabel(desk, true)).toBe('desk')
    expect(targetOptionLabel({ ...desk, remoteNeedsUpgrade: true }, true)).toBe('desk (needs upgrade)')
    expect(targetOptionLabel({ ...desk, state: 'error' }, true)).toBe('desk (unreachable)')
    expect(targetOptionLabel({ ...desk, state: 'refused' }, true)).toBe('desk (refused)')
    expect(targetOptionLabel({ ...desk, state: 'disconnected' }, false)).toBe('desk')
  })

  it('names the computer on a notification only when there is more than one', () => {
    const alone: TargetsState = { active: 'local', targets: [local], canStoreCredentials: true }
    const paired: TargetsState = { active: 'r1', targets: [local, desk], canStoreCredentials: true }
    expect(notificationTitle('Task failed', { targetId: 'local', label: 'This computer' }, alone)).toBe('Task failed')
    expect(notificationTitle('Task failed', { targetId: 'local', label: 'This computer' }, paired)).toBe('Task failed · This computer')
    expect(notificationTitle('Task failed', { targetId: 'r1', label: 'desk' }, paired)).toBe('Task failed · desk')
    expect(notificationTitle('Task failed', { targetId: 'local', label: 'This computer' }, { ...paired, active: 'local' })).toBe('Task failed')
    expect(activeSummary(paired).label).toBe('desk')
  })
})
