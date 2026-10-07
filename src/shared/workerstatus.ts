/**
 * One word for the state of a worker, with when it began and what it rests on (t961).
 *
 * ⛔ **Derived, never stored, and derived in one place.** Every input already lives on the worker, its
 * last reading and its sessions; a second copy of the verdict would drift from them exactly the way
 * two eligibility lists once did. Settings > Workers and the fleet strip both call this, so they cannot
 * disagree about an account.
 *
 * ⛔ **Presentation, never a gate.** `accountRefusal` in eligibility.ts decides who may be handed a
 * turn; this only says what a person should see. A status that a scheduler read would be a second
 * eligibility list.
 *
 * ⚠️ Every status carries its basis (`title`) and a time (`since`), because a belief without either
 * cannot be told from a current one. `since` is when the state began or was last confirmed — said
 * which in the title — and `null` only where there is genuinely no time to give.
 */
import type { QuotaSnapshot, Session, Worker } from './protocol.js'
import { sessionEnded } from './protocol.js'
import { isWorkerSubscriptionExpired } from './tasks.js'

export type WorkerStatusKind =
  | 'off'
  | 'expired'
  | 'signin'
  | 'held'
  | 'setup'
  | 'unavailable'
  | 'working'
  | 'ready'
  | 'unmetered'
  | 'unknown'

/** How the dot is drawn. ⚠️ Colour is never the only carrier: each kind also has its own glyph. */
export type WorkerStatusTone = 'muted' | 'bad' | 'warn' | 'live' | 'ok' | 'info'

export interface WorkerStatus {
  kind: WorkerStatusKind
  /** One or two words — the whole of what a narrow card shows beside the dot. */
  label: string
  tone: WorkerStatusTone
  /** When the state began or was last confirmed (the title says which). */
  since: number | null
  /** The evidence, as a sentence a person can check. */
  title: string
}

/** The glyph each status is drawn with, so a colour-blind reader is not left guessing. */
export const STATUS_GLYPH: Record<WorkerStatusKind, string> = {
  off: '○',
  expired: '✕',
  signin: '⚿',
  held: '!',
  setup: '◔',
  unavailable: '▲',
  working: '●',
  ready: '●',
  unmetered: '◌',
  unknown: '?'
}

/**
 * How long a provider outage is believed without fresh evidence. ⚠️ Inferred, not measured: the
 * dispatch path's own overload ladder gives up well inside this, and past it nothing has asked the
 * provider since, so the honest answer is *unknown* rather than *still down*.
 */
export const OUTAGE_BELIEVED_MS = 30 * 60 * 1000

/** What the adapter declares, which changes what an absence means. Never its name. */
export interface WorkerStatusFacts {
  /** `none`: this provider publishes no quota at all, so a missing reading is not a gap. */
  quotaProbe?: 'cli' | 'api' | 'none'
  /** `external`: nobody signs in here, so `loggedIn: false` means *unreachable*, not *signed out*. */
  loginKind?: 'cli' | 'external'
  /** Does the adapter declare an `accountCheck`, so an expired hold is re-asked on its own? */
  accountCheck?: boolean
}

type Reading = Pick<QuotaSnapshot, 'windows' | 'sampledAt' | 'error' | 'vendorSilent'>
type SessionLike = Pick<Session, 'purpose' | 'state' | 'startedAt'>

function oneLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function workerStatus(
  worker: Worker,
  quota: Reading | null,
  sessions: SessionLike[],
  now: number,
  facts: WorkerStatusFacts = {}
): WorkerStatus {
  const health = worker.health?.state === 'suspect' ? worker.health : null
  const identity = worker.identity

  if (!worker.enabled) {
    return {
      kind: 'off',
      label: 'off',
      tone: 'muted',
      since: null,
      title: 'Turned off here: held out of dispatch and never asked for judgment. Its quota is still read.'
    }
  }

  if (isWorkerSubscriptionExpired(worker)) {
    const since = health?.since ?? identity?.checkedAt ?? null
    const confirmed = health?.checkedAt && health.checkedAt !== health.since ? health.checkedAt : null
    return {
      kind: 'expired',
      label: 'expired',
      tone: 'bad',
      since: confirmed ?? since,
      title:
        `The vendor will not bill this account${health?.reason ? `: ${oneLine(health.reason)}` : ''}. ` +
        (confirmed ? 'Time shown is when the vendor last refused. ' : 'Time shown is when it was first refused. ') +
        (facts.accountCheck
          ? 'Renew the subscription; the vendor is re-asked every six hours, or press Probe to ask now.'
          : 'Renew the subscription, then press Probe.')
    }
  }

  if (health?.needsReauth) {
    return {
      kind: 'signin',
      label: 'sign in',
      tone: 'bad',
      since: health.since,
      title: `The vendor rejected this account's credential: ${oneLine(health.reason)}. Sign in again.`
    }
  }

  if (identity?.loggedIn === false) {
    if (facts.loginKind === 'external') {
      return {
        kind: 'unavailable',
        label: 'unavailable',
        tone: 'warn',
        since: identity.checkedAt ?? null,
        title: `The endpoint did not answer when last checked${identity.organization ? `: ${oneLine(identity.organization)}` : ''}.`
      }
    }
    return {
      kind: 'signin',
      label: 'sign in',
      tone: 'bad',
      since: identity.checkedAt ?? null,
      title: 'Nobody is signed in to this account. Sign in from Settings > Workers.'
    }
  }

  if (health) {
    return {
      kind: 'held',
      label: 'held',
      tone: 'bad',
      since: health.since,
      title: `Held out of dispatch: a run here produced no turn — ${oneLine(health.reason)}. A turn or a reading lifts it.`
    }
  }

  if (identity?.setupComplete === false) {
    return {
      kind: 'setup',
      label: 'setup',
      tone: 'warn',
      since: identity.checkedAt ?? null,
      title: "Signed in, but the CLI's first-run screens are unfinished. Use Finish setup."
    }
  }

  const outage = worker.outage
  if (outage && now - outage.at <= OUTAGE_BELIEVED_MS) {
    return {
      kind: 'unavailable',
      label: 'unavailable',
      tone: 'warn',
      since: outage.at,
      title: `The provider's servers failed the last turn here: ${oneLine(outage.reason)}. Temporary; work retries on its own.`
    }
  }

  // ⚠️ Not `idle`: a warm session whose turn ended holds a slot and runs nothing (t560, t950).
  const live = sessions.filter((s) => s.purpose === 'work' && !sessionEnded(s.state) && s.state !== 'idle')
  if (live.length > 0) {
    return {
      kind: 'working',
      label: 'working',
      tone: 'live',
      since: Math.min(...live.map((s) => s.startedAt)),
      title: `${live.length === 1 ? 'A task is' : `${live.length} tasks are`} running here now. Time shown is when the first started.`
    }
  }

  if (quota && quota.windows.length > 0 && !quota.error) {
    return {
      kind: 'ready',
      label: 'ready',
      tone: 'ok',
      since: quota.sampledAt,
      title: 'The provider published this account’s usage windows. Time shown is when they were read.'
    }
  }

  if (quota && quota.windows.length === 0 && quota.vendorSilent) {
    return {
      kind: 'unmetered',
      label: 'unmetered',
      tone: 'info',
      since: quota.sampledAt,
      title:
        'Signed in and nothing is wrong, but the provider publishes no usage for this window until a ' +
        'turn has run in it. The first task here (or a warm-up) brings the reading back.'
    }
  }

  if (facts.quotaProbe === 'none' && identity?.loggedIn === true) {
    return {
      kind: 'ready',
      label: 'ready',
      tone: 'ok',
      since: identity.checkedAt ?? null,
      title: 'Answered when last checked. This provider publishes no quota, so that is all there is to read.'
    }
  }

  if (quota?.error) {
    return {
      kind: 'unknown',
      label: 'unknown',
      tone: 'muted',
      since: quota.sampledAt,
      title: `The newest check failed: ${oneLine(quota.error)}`
    }
  }

  return {
    kind: 'unknown',
    label: 'unknown',
    tone: 'muted',
    since: quota?.sampledAt ?? null,
    title: quota ? 'Nothing usable was read.' : 'Never probed.'
  }
}
