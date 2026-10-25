// The retry ladder for a lead that was saved here but never reached GoHighLevel (WP3, policy lead_retry). Pure: no database, no network,
// no clock of its own. Used by healLeads (lib/heal.ts, tries 1 to 3) and by the flywheel step (lib/flywheel/steps/lead-retry.ts, tries 4
// and 5, then the hand-over to a person).
//
// The state lives in the existing leads.ghl_error text, so no migration is needed:
//   "[retry 2 at 2026-10-24T15:00:00.000Z] <reason>"   two sends failed, the last at that time ("at" is absent on older rows)
//   "[gave up] <reason>"                                the ladder is spent; a person has to look
//   "[stopped] <reason>"                                a person pressed Undo; the autopilot leaves it alone

/** How old the lead must be (minutes since it was saved) before try number n+1: 5 minutes, 1 hour, 6 hours, 24 hours, 72 hours. */
export const LADDER_WAITS_MIN: readonly number[] = [5, 60, 360, 1440, 4320]
/** The most sends the ladder makes for one lead. */
export const LADDER_TRIES = LADDER_WAITS_MIN.length
/** healLeads (always on) makes tries 1 to 3; the flywheel step makes tries 4 and 5. */
export const HEAL_TRIES = 3
/** A lead older than this is no longer retried; it is handed to a person instead. */
export const LADDER_WINDOW_MS = 7 * 86_400_000

const MIN = 60_000

export interface LeadMarker {
  /** Sends already made by the ladder. */
  tries: number
  /** When the last of them happened, or null (older rows have no time). */
  lastAt: number | null
  /** Set when the ladder is over for this row. */
  finished: 'gave up' | 'stopped' | null
}

export function parseLeadMarker(error: string | null | undefined): LeadMarker {
  const text = error ?? ''
  if (/^\[gave up\]/.test(text)) return { tries: LADDER_TRIES, lastAt: null, finished: 'gave up' }
  if (/^\[stopped\]/.test(text)) return { tries: LADDER_TRIES, lastAt: null, finished: 'stopped' }
  const m = /^\[retry (\d+)(?: at ([^\]]+))?\]/.exec(text)
  if (!m) return { tries: 0, lastAt: null, finished: null }
  const at = m[2] ? Date.parse(m[2]) : NaN
  return { tries: Number(m[1]), lastAt: Number.isFinite(at) ? at : null, finished: null }
}

/** The text stored after a failed send: the marker (with the time) followed by the reason GoHighLevel gave. Never longer than 300 characters. */
export function retryMarker(tries: number, reason: string, now: Date): string {
  return `[retry ${tries} at ${now.toISOString()}] ${reason}`.slice(0, 300)
}

/** The reason without any ladder marker, for showing to a person or putting back. */
export function stripMarker(error: string | null | undefined): string {
  return (error ?? '').replace(/^\[(?:gave up|stopped)\]\s*/, '').trim()
}

/** The least time between two sends for a lead that already had `tries` sends: the gap between the two rungs, never under 5 minutes. */
export function minGapMs(tries: number): number {
  if (tries <= 0) return 0
  return Math.max(5, (LADDER_WAITS_MIN[Math.min(tries, LADDER_TRIES - 1)] ?? 0) - (LADDER_WAITS_MIN[Math.min(tries, LADDER_TRIES) - 1] ?? 0)) * MIN
}

/** True when the next send for this lead is due now: the ladder is not spent, the lead is old enough for the next rung, the last send was
 * long enough ago, and the lead is still inside the 7 day window. */
export function retryDue(marker: LeadMarker, createdAt: number, now: number): boolean {
  if (marker.finished || marker.tries >= LADDER_TRIES) return false
  const age = now - createdAt
  if (age > LADDER_WINDOW_MS) return false
  if (age < LADDER_WAITS_MIN[marker.tries] * MIN) return false
  if (marker.lastAt !== null && now - marker.lastAt < minGapMs(marker.tries)) return false
  return true
}

/** True when no further send will be made and a person must look: all five sends failed, or the lead is past the 7 day window. */
export function needsPerson(marker: LeadMarker, createdAt: number, now: number): boolean {
  if (marker.finished) return false
  return marker.tries >= LADDER_TRIES || now - createdAt > LADDER_WINDOW_MS
}
