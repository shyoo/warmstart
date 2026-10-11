import { TimingMetrics } from '@shared/performance'
import { currentTargetId } from './target'

let target = ''
let metrics = new TimingMetrics()
let observing = false
export function uiTimings(): TimingMetrics {
  if (target !== currentTargetId()) { target = currentTargetId(); metrics = new TimingMetrics() }
  if (!observing && typeof PerformanceObserver !== 'undefined') {
    observing = true
    for (const type of ['longtask', 'event']) {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) metrics.record(`browser ${type}`, entry.duration)
        })
        observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
      } catch { /* Unsupported browser timing remains absent, never a zero. */ }
    }
  }
  return metrics
}
