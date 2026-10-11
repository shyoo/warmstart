import { monitorEventLoopDelay, performance as nodePerformance } from 'node:perf_hooks'
import { TimingMetrics, type PerformanceSnapshot } from '@shared/performance.js'

export const daemonTimings = new TimingMetrics()
let loopBusyPercent: number | null = null
let loopSampledAt: number | null = null
export function performanceSnapshot(): PerformanceSnapshot {
  return { ...daemonTimings.snapshot(), loopBusyPercent, loopSampledAt }
}

export function monitorPerformance(): () => void {
  const loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()
  let previous = nodePerformance.eventLoopUtilization()
  const timer = setInterval(() => {
    if (loop.count > 0) {
      daemonTimings.record('loop delay p95', loop.percentile(95) / 1e6)
      daemonTimings.record('loop delay max', loop.max / 1e6)
      loop.reset()
    }
    const current = nodePerformance.eventLoopUtilization()
    const delta = nodePerformance.eventLoopUtilization(current, previous)
    previous = current
    loopBusyPercent = delta.utilization * 100
    loopSampledAt = Date.now()
  }, 5000)
  timer.unref()
  return () => { clearInterval(timer); loop.disable() }
}
