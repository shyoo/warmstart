/**
 * Formatting for numbers that update in place.
 *
 * All of these are rendered in tabular figures (see `.num` in app.css). The unit is always shown -
 * a bare "19" next to a quota bar is the kind of thing an operator reads wrong once and distrusts
 * forever.
 */

export function countdown(target: number | null | undefined, now = Date.now()): string {
  if (!target) return '--:--'
  const left = target - now
  if (left <= 0) return '00:00'
  const totalMinutes = Math.floor(left / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}`
  const seconds = Math.floor((left % 60000) / 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** How long ago something was measured, phrased so that "old" reads as a problem. */
export function age(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '--'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function percent(n: number): string {
  return `${Math.round(n)}%`
}

/** Amber at T+45m, red at T+53m - the last moment a ~2 minute compaction still fits in the hour. */
export function cacheUrgency(expiresAt: number | null, now = Date.now()): 'ok' | 'warn' | 'danger' {
  if (!expiresAt) return 'ok'
  const left = expiresAt - now
  if (left <= 7 * 60 * 1000) return 'danger'
  if (left <= 15 * 60 * 1000) return 'warn'
  return 'ok'
}

export function quotaUrgency(percentUsed: number): 'ok' | 'warn' | 'danger' {
  if (percentUsed >= 90) return 'danger'
  if (percentUsed >= 70) return 'warn'
  return 'ok'
}
