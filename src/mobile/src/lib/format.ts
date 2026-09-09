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
