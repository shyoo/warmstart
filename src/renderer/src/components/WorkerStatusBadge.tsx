import { STATUS_GLYPH, type WorkerStatus } from '@shared/workerstatus'
import { age } from '../lib/format'

/**
 * A worker's status: a coloured glyph, and — where there is room — its word and age (t961).
 *
 * ⭐ `compact` is the fleet strip, which asked for a mark and not a sentence: the glyph alone, with the
 * word, the age and the evidence on its tooltip. Settings > Workers has the room to print all three.
 *
 * ⚠️ Colour is never the only carrier. Each status has its own glyph (`STATUS_GLYPH`), so `ready` and
 * `expired` differ in shape as well as in green and red.
 */
export function WorkerStatusBadge({
  status,
  now,
  compact = false
}: {
  status: WorkerStatus
  now: number
  compact?: boolean
}): React.JSX.Element {
  const when = status.since !== null ? age(Math.max(0, now - status.since)) : null
  const heading = when ? `${status.label} · ${when}` : status.label
  return (
    <span
      className={`wstatus wstatus--${status.tone} wstatus--${status.kind}${compact ? ' wstatus--compact' : ''}`}
      title={`${heading}\n${status.title}`}
      aria-label={`Status: ${heading}`}
      role="img"
    >
      <span className="wstatus-glyph" aria-hidden>
        {STATUS_GLYPH[status.kind]}
      </span>
      {!compact && <span className="wstatus-label">{status.label}</span>}
      {!compact && when && <span className="wstatus-age">{when}</span>}
    </span>
  )
}
