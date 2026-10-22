import { PUBLISH_DAYS } from '@/lib/autoblog-cadence'

// Pure helpers behind the plain-English status card at the top of the "Topics & Autoblog" tab.
// No database, no AI: it only restates settings that already exist.

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The next day a scheduled run may write, counting today. daysAhead 0 means today. Null when the cadence is 0/week.
 * An out-of-table cadence behaves like the real gate (isPublishDayDue): every day. */
export function nextWriteDay(postsPerWeek: number, todayWeekday: number): { daysAhead: number; weekday: number; name: string } | null {
  const days = PUBLISH_DAYS[postsPerWeek]
  if (days && days.length === 0) return null
  for (let ahead = 0; ahead < 7; ahead++) {
    const wd = (todayWeekday + ahead) % 7
    if (!days || days.includes(wd)) return { daysAhead: ahead, weekday: wd, name: WEEKDAY_NAMES[wd] }
  }
  return null
}

export interface AutoblogPlanInput {
  mode: 'off' | 'draft' | 'publish'
  paused: boolean
  postsPerWeek: number
  todayWeekday: number
  approvedTopics: number
}

/** One or two plain sentences: what the next scheduled run will do. */
export function describeAutoblogPlan(i: AutoblogPlanInput): string {
  if (i.mode === 'off') return 'Autoblog is off, so nothing will be written until you switch the mode to Draft or Publish.'
  if (i.paused) return 'The master kill switch is on, so autoblog is paused. Your mode is kept and it resumes when the switch is turned off.'
  const next = nextWriteDay(i.postsPerWeek, i.todayWeekday)
  if (!next) return 'The cadence is 0 posts a week, so scheduled runs write nothing. The Run now button still works.'
  const when = next.daysAhead === 0 ? 'today' : next.daysAhead === 1 ? `tomorrow (${next.name})` : `on ${next.name}`
  const what = i.mode === 'draft' ? 'write one draft post (nothing goes live)' : 'write one post and publish it if it passes the quality gate'
  const topic = i.approvedTopics > 0 ? `It will use the oldest of your ${i.approvedTopics} approved topic${i.approvedTopics === 1 ? '' : 's'}.` : 'No topic is approved, so it will pick one from keyword research or an AI suggestion.'
  return `The next scheduled run is ${when}: it will ${what}. ${topic}`
}

export interface LastRun {
  at: string
  ok: boolean
  note?: string
}

/** Tolerant parse of the cron heartbeat setting. */
export function parseLastRun(raw: string | null | undefined): LastRun | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<LastRun> | null
    if (!p || typeof p.at !== 'string' || !Number.isFinite(Date.parse(p.at))) return null
    return { at: p.at, ok: p.ok !== false, ...(typeof p.note === 'string' ? { note: p.note } : {}) }
  } catch {
    return null
  }
}
