export interface TimingRow {
  label: string
  count: number
  pending: number
  peakPending: number
  failures: number
  bytes: number | null
  samples: number
  lastAt: number | null
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number | null
}
export interface PerformanceSnapshot {
  generatedAt: number
  startedAt: number
  sampleLimit: number
  rows: TimingRow[]
  loopBusyPercent?: number | null
  loopSampledAt?: number | null
  openRuns?: { work: number; reviews: number } | null
}

/** Bounded timing/count/size metadata only. Percentiles use nearest rank over recent samples. */
export class TimingMetrics {
  private readonly rows = new Map<string, { count: number; pending: number; peak: number; failures: number; bytes: number; byteMeasured: boolean; lastAt: number | null; values: number[] }>()
  private readonly startedAt = Date.now()
  constructor(private readonly sampleLimit = 128, private readonly labelLimit = 512) {}

  private row(label: string) {
    const key = label.slice(0, 96)
    let row = this.rows.get(key)
    if (!row) {
      if (this.rows.size >= this.labelLimit) this.rows.delete(this.rows.keys().next().value!)
      row = { count: 0, pending: 0, peak: 0, failures: 0, bytes: 0, byteMeasured: false, lastAt: null, values: [] }
      this.rows.set(key, row)
    }
    return row
  }

  record(label: string, ms: number, bytes?: number, failed = false): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const row = this.row(label)
    row.count++; row.failures += failed ? 1 : 0
    row.lastAt = Date.now()
    if (bytes !== undefined && Number.isFinite(bytes) && bytes >= 0) { row.bytes += bytes; row.byteMeasured = true }
    row.values.push(ms)
    if (row.values.length > this.sampleLimit) row.values.shift()
  }

  begin(label: string): (failed?: boolean, bytes?: number) => void {
    const row = this.row(label)
    row.peak = Math.max(row.peak, ++row.pending)
    const start = performance.now()
    let ended = false
    return (failed = false, bytes?: number) => {
      if (ended) return
      ended = true; row.pending--
      this.record(label, performance.now() - start, bytes, failed)
    }
  }

  snapshot(): PerformanceSnapshot {
    return { generatedAt: Date.now(), startedAt: this.startedAt, sampleLimit: this.sampleLimit,
      rows: [...this.rows].map(([label, row]) => {
        const sorted = [...row.values].sort((a, b) => a - b)
        const percentile = (p: number): number | null => sorted[Math.ceil(sorted.length * p) - 1] ?? null
        return { label, count: row.count, pending: row.pending, peakPending: row.peak,
          failures: row.failures, bytes: row.byteMeasured ? row.bytes : null, samples: sorted.length, lastAt: row.lastAt,
          p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null }
      }).sort((a, b) => a.label.localeCompare(b.label)) }
  }
}
