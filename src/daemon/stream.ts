/**
 * Reading the `stream` transport's output.
 *
 * The CLI's stream-json output carries things the transcript does not, and one of them matters a
 * great deal: a **free, live rate-limit record** after each turn. Measured 2026-08-25:
 *
 * ```json
 * {"type":"rate_limit_event","rate_limit_info":{
 *    "status":"allowed","resetsAt":1787684400,"rateLimitType":"five_hour",
 *    "overageStatus":"rejected","isUsingOverage":false}}
 * ```
 *
 * It is not a percentage, so it does not replace the calibration in `docs/cost-model.md` §5 - but it
 * is a **status and a real reset time**, it arrives on a turn already being paid for, and it is the
 * first live quota signal this tool has had.
 *
 * ⛔ This is still not terminal parsing. These are the CLI's own machine-readable records on its
 * declared protocol, the same ones its SDK consumes; nothing here reads a rendered screen.
 */

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected' | string
  resetsAt: number | null
  rateLimitType: string
  overageStatus?: string
  isUsingOverage?: boolean
}

export type StreamEvent =
  | { kind: 'rate_limit'; info: RateLimitInfo }
  | { kind: 'result'; costUsd: number | null; isError: boolean; terminalReason: string | null }
  | { kind: 'init'; sessionId: string | null; model: string | null; permissionMode: string | null }
  | { kind: 'other'; type: string }

/** Bytes arrive in arbitrary chunks; a record is only real once its newline has. */
export class StreamParser {
  private buffer = ''

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk
    const events: StreamEvent[] = []
    let newline = this.buffer.indexOf('\n')

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (!line) continue
      const event = parseLine(line)
      if (event) events.push(event)
    }

    // A pathological line with no newline must not grow without bound.
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = ''
    return events
  }
}

function parseLine(line: string): StreamEvent | null {
  if (!line.startsWith('{')) return null
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    // The CLI also writes human-readable diagnostics; those are not our business.
    return null
  }

  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'rate_limit_event') {
    const info = record.rate_limit_info as Record<string, unknown> | undefined
    if (!info) return null
    return {
      kind: 'rate_limit',
      info: {
        status: String(info.status ?? 'unknown'),
        // The CLI reports seconds; everything in agentyard is epoch milliseconds.
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
        rateLimitType: String(info.rateLimitType ?? 'unknown'),
        ...(typeof info.overageStatus === 'string' ? { overageStatus: info.overageStatus } : {}),
        ...(typeof info.isUsingOverage === 'boolean' ? { isUsingOverage: info.isUsingOverage } : {})
      }
    }
  }

  if (type === 'result') {
    return {
      kind: 'result',
      costUsd: typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null,
      isError: record.is_error === true,
      terminalReason: typeof record.terminal_reason === 'string' ? record.terminal_reason : null
    }
  }

  if (type === 'system' && record.subtype === 'init') {
    return {
      kind: 'init',
      sessionId: typeof record.session_id === 'string' ? record.session_id : null,
      model: typeof record.model === 'string' ? record.model : null,
      permissionMode: typeof record.permissionMode === 'string' ? record.permissionMode : null
    }
  }

  return type ? { kind: 'other', type } : null
}
