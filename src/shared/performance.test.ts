import { expect, it } from 'vitest'
import { TimingMetrics } from './performance.js'

it('bounds samples/labels, distinguishes unmeasured from zero and keeps only timing metadata', () => {
  const metrics = new TimingMetrics(3, 2)
  const finish = metrics.begin('pending')
  expect(metrics.snapshot().rows[0]).toMatchObject({ pending: 1, p95Ms: null, samples: 0 })
  finish(true, 24); finish()
  expect(metrics.snapshot().rows[0]).toMatchObject({ pending: 0, count: 1, failures: 1, bytes: 24 })
  for (const value of [0, 10, 20, 30]) metrics.record('RPC total task.page', value)
  expect(metrics.snapshot().rows.find((r) => r.label.includes('task.page'))).toMatchObject({ count: 4, samples: 3, p50Ms: 20, p95Ms: 30, maxMs: 30 })
  expect(metrics.snapshot().rows.find((r) => r.label.includes('task.page'))?.bytes).toBeNull()
  metrics.record('event task.changed', 0)
  expect(metrics.snapshot().rows).toHaveLength(2)
  expect(JSON.stringify(metrics.snapshot())).not.toMatch(/params|result|prompt|token/)
})
