import { describe, expect, it } from 'vitest'
import { routeFromHash } from './app.js'
import { pairCodeFromHash } from './screens/Pair.js'

describe('hash routes', () => {
  it('maps every screen and falls back to attention', () => {
    expect(routeFromHash('#/')).toEqual({ name: 'attention' })
    expect(routeFromHash('#/quota')).toEqual({ name: 'quota' })
    expect(routeFromHash('#/tasks')).toEqual({ name: 'tasks' })
    expect(routeFromHash('#/new')).toEqual({ name: 'new' })
    expect(routeFromHash('#/pair?code=ABC')).toEqual({ name: 'pair' })
    expect(routeFromHash('#/task/abc123')).toEqual({ name: 'task', id: 'abc123' })
    expect(routeFromHash('#/nope')).toEqual({ name: 'attention' })
    expect(routeFromHash('')).toEqual({ name: 'attention' })
  })

  it('reads the pairing code off the pair route and nothing else', () => {
    expect(pairCodeFromHash('#/pair?code=ABC123')).toBe('ABC123')
    expect(pairCodeFromHash('#/pair')).toBeNull()
    expect(pairCodeFromHash('#/')).toBeNull()
  })
})
