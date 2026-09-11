/**
 * Phone-sized formatting. Quota lines name every window with its percent and the reading's age —
 * a percentage is never shown without its age — and times read relative, because "in 4m" answers
 * the only question a quota countdown ever asks.
 */
export function relTime(at: number, now: number): string {
  const diff = at - now
  if (Math.abs(diff) < 45_000) return 'just now'
  const abs = Math.abs(diff)
  const unit =
    abs < 3_600_000
      ? `${Math.round(abs / 60_000)}m`
      : abs < 86_400_000
        ? `${Math.floor(abs / 3_600_000)}h${Math.round((abs % 3_600_000) / 60_000) === 0 ? '' : `${Math.round((abs % 3_600_000) / 60_000)}m`}`
        : `${Math.floor(abs / 86_400_000)}d`
  return diff > 0 ? `in ${unit}` : `${unit} ago`
}

/** `5h 62% · 7d 41%`, in the order the daemon sent the windows. */
export function quotaLine(windows: Array<{ label: string; percent: number }>): string {
  if (windows.length === 0) return 'no windows'
  return windows.map((w) => `${w.label} ${Math.round(w.percent)}%`).join(' · ')
}

/** `read 2m ago`, or `no reading` where the snapshot never arrived. */
export function quotaAge(sampledAt: number | null, now: number): string {
  if (sampledAt === null) return 'no reading'
  return `read ${relTime(sampledAt, now)}`
}

/** A task row is a label, never a second copy of a paragraph-sized prompt. */
export function shortTitle(summary: string | null, title: string, limit = 92): string {
  const singleLine = (summary?.trim() || title.trim()).replace(/\s+/g, ' ')
  if (singleLine.length <= limit) return singleLine
  return `${singleLine.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

export function duration(activeMs: number, activeSince: number | null, now: number): string {
  const ms = Math.max(0, activeMs + (activeSince === null ? 0 : now - activeSince))
  if (ms < 60_000) return '<1m'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)
  return `${hours}h${minutes ? ` ${minutes}m` : ''}`
}

export function price(usd: number | null | undefined, estimated = false, partial = false): string {
  if (usd === null || usd === undefined) return 'n/a'
  const value = usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`
  return `${estimated ? '~' : ''}${value}${partial ? '+' : ''}`
}

export type StatusTone = 'active' | 'human' | 'warning' | 'success' | 'danger' | 'idle'
export function statusTone(status: string): StatusTone {
  if (status === 'running' || status === 'assigned' || status === 'cancelling' || status === 'landing') return 'active'
  if (status === 'awaiting_human') return 'human'
  if (status === 'blocked' || status === 'paused_quota' || status === 'scheduled') return 'warning'
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  return 'idle'
}

export function quotaTone(percent: number): 'ok' | 'warn' | 'danger' {
  return percent >= 92 ? 'danger' : percent >= 75 ? 'warn' : 'ok'
}
