// The Growth digest: one short, plain answer to "is the traffic engine working?". This file is PURE: it takes numbers that were
// already read (see lib/growth-digest-read.ts) and turns them into lines. No database, no network, no clock except the `now`
// it is given. Real numbers only: every source arrives as Read<T>, and a source that failed to read is printed as
// "could not be read", never as a zero and never as a guess.
//
// A note on the Google numbers: gsc_ranking_days holds a TRAILING 28-DAY total for each snapshot day (see
// lib/rankings-snapshot.ts). Summing days would count the same clicks about 28 times. So "this week against last week" here is
// the latest snapshot against the snapshot from 7 days before it, both 28-day totals. The lines say so.

export type Read<T> = { ok: true; value: T } | { ok: false; reason?: string }

export const UNREAD = 'could not be read'
export const MAX_ACTIONS = 3

export interface GscDay {
  day: string
  clicks: number
  impressions: number
  queries: number
}
export interface GscRow {
  day: string
  kind: 'query' | 'page'
  key: string
  position: number
  clicks: number
  impressions: number
}
export interface BingInput {
  /** true when BING_WEBMASTER_API_KEY is set or a snapshot exists. */
  configured: boolean
  status: 'ok' | 'unknown' | 'not_configured' | null
  crawled7d: number | null
  indexed: number | null
  asOf: string | null
}
export interface SendRow {
  at: string
  /** One network, or several joined with "/" (a carousel and a reel go out as one caption). */
  network: string
}
export interface VisitRow {
  source: string
  content: string
}
export interface AiRow {
  feature: string
  costUsd: number
}
export interface LeadRow {
  at: string
  isTest: boolean
  pkg: string | null
}
export interface SocialState {
  /** The posting networks that are connected right now (lower case). */
  platforms: string[]
}

export interface DigestInput {
  now: Date
  gscDays: Read<GscDay[]>
  /** Rows for the latest snapshot day and the one 7 days before it (only those two days). */
  gscRows: Read<GscRow[]>
  bing: Read<BingInput>
  postsWritten: Read<number>
  postsPublished: Read<number>
  newsBriefs: Read<number>
  guidesPublished: Read<number>
  guidesFlagged: Read<number>
  /** Posts saved as drafts in the last 30 days: held back by the quality gate or waiting for review. */
  postsHeld: Read<number>
  reels: Read<number>
  carousels: Read<number>
  sends: Read<SendRow[]>
  gate: Read<{ pass: number; retry: number; skip: number; deferred: number }>
  cadence: Read<{ guides: number; posts: number }>
  leads: Read<LeadRow[]>
  visits: Read<VisitRow[]>
  /** Whether visit tracking is switched on (so "no visits" can be told apart from "not recording"). */
  visitTrackingOn: Read<boolean>
  ai: Read<AiRow[]>
  social: Read<SocialState>
  /** What the Optimizer has learned so far (lib/optimizer.ts). Optional: left out, the digest has no Learning line. */
  learning?: Read<{ retired: number; winners: number }>
}

export interface DigestSection {
  title: string
  lines: string[]
}
export interface GrowthDigest {
  generatedAt: string
  sections: DigestSection[]
  /** Plain-text bars for the trends, one string per line, meant for a monospace box. */
  trends: string[]
  /** At most MAX_ACTIONS, each tied to a real number. */
  actions: string[]
}

const DAY = 86_400_000
const n0 = (n: number) => Math.round(n).toLocaleString('en-US')
const plural = (n: number, one: string, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`
const val = <T>(r: Read<T>): T | null => (r.ok ? r.value : null)
const ymdAdd = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

/** The newest snapshot day and the one about 7 days before it (the closest day on or before latest-7, at most 3 days further back). Pure. */
export function pickGscDays(days: readonly GscDay[]): { latest: GscDay | null; before: GscDay | null } {
  const sorted = [...days].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)).sort((a, b) => (a.day < b.day ? 1 : -1))
  const latest = sorted[0] ?? null
  if (!latest) return { latest: null, before: null }
  const target = ymdAdd(latest.day, -7)
  const floor = ymdAdd(latest.day, -10)
  const before = sorted.find((d) => d.day <= target && d.day >= floor) ?? null
  return { latest, before }
}

/** "up 20% from 100", "down 5% from 40", "the same as 7 days ago (30)". Pure. */
export function changeText(now: number, before: number): string {
  if (before === 0) return now === 0 ? 'no change from 0' : `up from 0`
  const pct = Math.round(((now - before) / before) * 100)
  if (pct === 0) return `the same as 7 days ago (${n0(before)})`
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% from ${n0(before)}`
}

/** A plain-text bar. The longer value fills `width` characters; a value above zero always shows at least one. Pure. */
export function textBar(value: number, max: number, width = 20): string {
  if (!(value > 0) || !(max > 0)) return ''
  return '#'.repeat(Math.max(1, Math.round((value / max) * width)))
}

/** Two bar lines (7 days ago, now) for one trend, or one "could not be read" line. Pure. */
export function trendLines(label: string, before: number | null, now: number | null): string[] {
  if (before === null || now === null) return [`${label}: ${UNREAD}`]
  const max = Math.max(before, now)
  return [label, `  7 days ago  ${textBar(before, max).padEnd(20)} ${n0(before)}`, `  now         ${textBar(now, max).padEnd(20)} ${n0(now)}`]
}

const weightedPosition = (rows: readonly GscRow[]): number | null => {
  const q = rows.filter((r) => r.kind === 'query' && r.impressions > 0 && Number.isFinite(r.position))
  const w = q.reduce((s, r) => s + r.impressions, 0)
  if (w <= 0) return null
  return q.reduce((s, r) => s + r.position * r.impressions, 0) / w
}

interface SearchFacts {
  haveLatest: boolean
  haveBefore: boolean
  imp: [number, number] | null // [before, now]
  clicks: [number, number] | null
  queries: [number, number] | null
  pages: [number, number] | null
  pos: [number, number] | null
  newQuery: string | null
  movingPage: string | null
  lines: string[]
}

function searchFacts(i: DigestInput): SearchFacts {
  const f: SearchFacts = { haveLatest: false, haveBefore: false, imp: null, clicks: null, queries: null, pages: null, pos: null, newQuery: null, movingPage: null, lines: [] }
  if (!i.gscDays.ok) {
    f.lines.push(`Google Search numbers: ${UNREAD}.`)
    return f
  }
  const { latest, before } = pickGscDays(i.gscDays.value)
  if (!latest) {
    f.lines.push('Google Search numbers: no snapshot yet. Search Console may not be connected, or the first daily snapshot has not run.')
    return f
  }
  f.haveLatest = true
  f.lines.push(`Google counts are 28-day totals from the daily snapshot, ${latest.day}${before ? ` against ${before.day}` : ''}.`)
  if (!before) {
    f.lines.push(`Now: ${plural(latest.impressions, 'impression')}, ${plural(latest.clicks, 'click')}, ${plural(latest.queries, 'search')} seen. There is no snapshot from 7 days earlier yet, so there is nothing to compare.`)
    return f
  }
  f.haveBefore = true
  f.imp = [before.impressions, latest.impressions]
  f.clicks = [before.clicks, latest.clicks]
  f.queries = [before.queries, latest.queries]
  f.lines.push(`Impressions (times Google showed us): ${n0(latest.impressions)}, ${changeText(latest.impressions, before.impressions)}.`)
  f.lines.push(`Clicks to the site from Google: ${n0(latest.clicks)}, ${changeText(latest.clicks, before.clicks)}.`)
  f.lines.push(`Searches we showed up for: ${n0(latest.queries)}, ${changeText(latest.queries, before.queries)}.`)

  if (!i.gscRows.ok) {
    f.lines.push(`Average position, pages with impressions, best new search and best page: ${UNREAD}.`)
    return f
  }
  const rowsNow = i.gscRows.value.filter((r) => r.day === latest.day)
  const rowsBefore = i.gscRows.value.filter((r) => r.day === before.day)
  if (rowsNow.length === 0 || rowsBefore.length === 0) {
    f.lines.push('Average position, pages with impressions, best new search and best page: the detail rows for one of the two days are missing.')
    return f
  }
  const pNow = weightedPosition(rowsNow)
  const pBefore = weightedPosition(rowsBefore)
  if (pNow !== null && pBefore !== null) {
    f.pos = [pBefore, pNow]
    f.lines.push(`Average position of our top searches: ${pNow.toFixed(1)} (was ${pBefore.toFixed(1)}; a lower number is better).`)
  } else f.lines.push('Average position: no search had impressions on one of the two days.')
  const pagesNow = rowsNow.filter((r) => r.kind === 'page' && r.impressions > 0).length
  const pagesBefore = rowsBefore.filter((r) => r.kind === 'page' && r.impressions > 0).length
  f.pages = [pagesBefore, pagesNow]
  f.lines.push(`Pages Google showed at least once: ${n0(pagesNow)}, ${changeText(pagesNow, pagesBefore)}.`)

  const seenBefore = new Set(rowsBefore.filter((r) => r.kind === 'query').map((r) => r.key))
  const fresh = rowsNow.filter((r) => r.kind === 'query' && r.impressions > 0 && !seenBefore.has(r.key)).sort((a, b) => b.impressions - a.impressions)[0]
  if (fresh) {
    f.newQuery = fresh.key
    f.lines.push(`Best new search: "${fresh.key}" (${plural(fresh.impressions, 'impression')}, position ${fresh.position.toFixed(1)}).`)
  } else f.lines.push('Best new search: none this week.')

  const beforePage = new Map(rowsBefore.filter((r) => r.kind === 'page').map((r) => [r.key, r]))
  const moved = rowsNow
    .filter((r) => r.kind === 'page' && r.impressions >= 5 && beforePage.has(r.key))
    .map((r) => ({ r, gain: beforePage.get(r.key)!.position - r.position, from: beforePage.get(r.key)!.position }))
    .filter((m) => m.gain >= 0.5)
    .sort((a, b) => b.gain - a.gain)[0]
  if (moved) {
    f.movingPage = moved.r.key
    f.lines.push(`Best page moving up: ${moved.r.key} (position ${moved.from.toFixed(1)} to ${moved.r.position.toFixed(1)}).`)
  } else f.lines.push('Best page moving up: none moved up by half a place or more.')
  return f
}

function bingLine(b: Read<BingInput>): string {
  if (!b.ok) return `Bing: ${UNREAD}.`
  const v = b.value
  if (!v.configured || v.status === 'not_configured' || v.status === null) return 'Bing: not connected, so no numbers.'
  if (v.status === 'unknown') return 'Bing: asked, but it gave no numbers we can read.'
  return `Bing: crawled ${v.crawled7d === null ? 'an unknown number of' : n0(v.crawled7d)} pages in 7 days, ${v.indexed === null ? 'unknown' : n0(v.indexed)} in its index${v.asOf ? ` (as of ${v.asOf})` : ''}.`
}

const NETWORKS = ['facebook', 'instagram'] as const

export function buildGrowthDigest(i: DigestInput): GrowthDigest {
  const nowMs = i.now.getTime()
  const sections: DigestSection[] = []

  // 1. Search
  const s = searchFacts(i)
  sections.push({ title: 'Search: are people finding us?', lines: [...s.lines, bingLine(i.bing)] })

  // 2. Content shipped in the last 7 days
  const c: string[] = []
  const one = (label: string, r: Read<number>) => c.push(`${label}: ${r.ok ? n0(r.value) : UNREAD}`)
  one('Blog posts written', i.postsWritten)
  one('Blog posts published', i.postsPublished)
  one('Travel news briefs published', i.newsBriefs)
  one('Guides published', i.guidesPublished)
  one('Carousels posted', i.carousels)
  one('Reels posted', i.reels)
  if (!i.sends.ok) c.push(`Social posts sent: ${UNREAD}`)
  else {
    const since = nowMs - 7 * DAY
    const by = new Map<string, number>()
    for (const e of i.sends.value) {
      if (!(Date.parse(e.at) >= since)) continue
      for (const net of e.network.split('/').map((x) => x.trim().toLowerCase()).filter(Boolean)) by.set(net, (by.get(net) ?? 0) + 1)
    }
    c.push(by.size ? `Social posts sent: ${[...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${n0(v)}`).join(', ')}` : 'Social posts sent: none in the caption log')
  }
  if (!i.gate.ok) c.push(`Skipped by the picture check: ${UNREAD}`)
  else c.push(`Skipped by the picture check: ${n0(i.gate.value.skip)} (it passed ${n0(i.gate.value.pass)}, put off ${n0(i.gate.value.deferred)} for later)`)
  if (!i.cadence.ok) c.push(`Pacing limit log: ${UNREAD}`)
  else c.push(`Pacing limit log shows ${n0(i.cadence.value.guides + i.cadence.value.posts)} automatic publishes (guides ${n0(i.cadence.value.guides)}, posts ${n0(i.cadence.value.posts)}). How many were held back by the limit is not recorded anywhere, so no number is shown.`)
  one('Guides still flagged by the quality check', i.guidesFlagged)
  one('Blog drafts held back (last 30 days)', i.postsHeld)
  if (i.learning) c.push(i.learning.ok ? `Learning: ${plural(i.learning.value.retired, 'style')} retired, ${plural(i.learning.value.winners, 'winner')}` : `Learning: ${UNREAD}`)
  sections.push({ title: 'Content shipped in the last 7 days', lines: c })

  // 3. Money and leads
  const m: string[] = []
  let leadsNow: number | null = null
  let leadsBefore: number | null = null
  if (!i.leads.ok) m.push(`Leads: ${UNREAD}.`)
  else {
    const rows = i.leads.value
    const inWin = (r: LeadRow, from: number, to: number) => Date.parse(r.at) >= from && Date.parse(r.at) < to
    const cnt = (from: number, to: number, test: boolean) => rows.filter((r) => inWin(r, from, to) && r.isTest === test).length
    leadsNow = cnt(nowMs - 7 * DAY, nowMs + 1, false)
    leadsBefore = cnt(nowMs - 14 * DAY, nowMs - 7 * DAY, false)
    const testNow = cnt(nowMs - 7 * DAY, nowMs + 1, true)
    m.push(`Real leads: ${n0(leadsNow)}, ${changeText(leadsNow, leadsBefore)}. Test leads (not counted): ${n0(testNow)}.`)
  }
  if (!i.visits.ok) m.push(`Visits by source: ${UNREAD}.`)
  else if (i.visits.value.length === 0) {
    m.push(i.visitTrackingOn.ok && !i.visitTrackingOn.value ? 'Visits by source: visit tracking is switched off, so none are recorded.' : 'Visits by source: none recorded (only visitors who accept analytics are counted).')
  } else {
    const tally = (pick: (v: VisitRow) => string) => {
      const t = new Map<string, number>()
      for (const v of i.visits.ok ? i.visits.value : []) {
        const k = pick(v).trim()
        if (k) t.set(k, (t.get(k) ?? 0) + 1)
      }
      return [...t].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n0(n)}`).join(', ')
    }
    m.push(`Recorded visits: ${n0(i.visits.value.length)}.`)
    const src = tally((v) => v.source)
    const hook = tally((v) => v.content)
    m.push(`By source (utm_source): ${src || 'no source tags'}.`)
    m.push(`By hook or format (utm_content): ${hook || 'no content tags'}.`)
  }
  if (!i.ai.ok) m.push(`AI spend: ${UNREAD}.`)
  else {
    const by = new Map<string, number>()
    for (const r of i.ai.value) by.set(r.feature || 'other', (by.get(r.feature || 'other') ?? 0) + (Number.isFinite(r.costUsd) ? r.costUsd : 0))
    const total = [...by.values()].reduce((a, b) => a + b, 0)
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ')
    m.push(`AI spend, last 7 days (an estimate, not a bill): $${total.toFixed(2)}${top ? `. Biggest: ${top}` : ''}.`)
    const items = [val(i.postsPublished), val(i.guidesPublished)]
    if (items[0] === null || items[1] === null) m.push(`Cost per published item: ${UNREAD}.`)
    else if (items[0] + items[1] === 0) m.push('Cost per published item: nothing was published, so it is not worked out.')
    else m.push(`Cost per published item (posts and guides): $${(total / (items[0] + items[1])).toFixed(2)}.`)
  }
  sections.push({ title: 'Money and leads', lines: m })

  // Trends (plain-text bars)
  const trends: string[] = []
  trends.push(...(s.haveBefore && s.imp ? trendLines('Google impressions (28-day total)', s.imp[0], s.imp[1]) : [`Google impressions: ${i.gscDays.ok ? 'not enough history to compare yet' : UNREAD}`]))
  trends.push(...(s.haveBefore && s.clicks ? trendLines('Google clicks (28-day total)', s.clicks[0], s.clicks[1]) : [`Google clicks: ${i.gscDays.ok ? 'not enough history to compare yet' : UNREAD}`]))
  trends.push(...(s.haveBefore && s.pages ? trendLines('Pages Google showed', s.pages[0], s.pages[1]) : [`Pages Google showed: ${i.gscDays.ok && i.gscRows.ok ? 'not enough history to compare yet' : UNREAD}`]))
  trends.push(...trendLines('Real leads', leadsBefore, leadsNow))

  // 4. What to do today: at most 3, each tied to a real number, strongest first.
  const cand: string[] = []
  if (i.social.ok) {
    const have = i.social.value.platforms.map((p) => p.toLowerCase())
    if (have.length === 0) cand.push('No social account is connected (0 of 2 networks). Nothing can be posted until you connect Facebook and Instagram.')
    else {
      const missing = NETWORKS.filter((n) => !have.includes(n))
      if (missing.length) cand.push(`${missing.map((x) => x[0].toUpperCase() + x.slice(1)).join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not connected (${NETWORKS.length - missing.length} of ${NETWORKS.length} networks). Connect ${missing.length === 1 ? 'it' : 'them'} so posts go out there.`)
    }
  }
  if (s.imp && s.imp[1] < s.imp[0] && s.imp[0] > 0 && (s.imp[0] - s.imp[1]) / s.imp[0] >= 0.1) {
    const newPages = (val(i.postsPublished) ?? 0) + (val(i.guidesPublished) ?? 0)
    cand.push(
      newPages > 0
        ? `Google impressions fell to ${n0(s.imp[1])} from ${n0(s.imp[0])}. Ask Google to index the ${plural(newPages, 'new page')} from this week.`
        : `Google impressions fell to ${n0(s.imp[1])} from ${n0(s.imp[0])}, and nothing new was published this week. Publish something new.`,
    )
  }
  const held = (val(i.postsHeld) ?? 0) + (val(i.guidesFlagged) ?? 0)
  if (held > 0) cand.push(`${plural(held, 'held draft')} need${held === 1 ? 's' : ''} a look (${n0(val(i.postsHeld) ?? 0)} blog, ${n0(val(i.guidesFlagged) ?? 0)} guide). Open them and publish, fix or delete.`)
  if (leadsNow !== null && leadsBefore !== null && leadsNow === 0 && leadsBefore > 0) cand.push(`No real leads this week (${n0(leadsBefore)} the week before). Look at the form and the top landing pages.`)
  if (i.gate.ok && i.gate.value.skip >= 3) cand.push(`The picture check skipped ${n0(i.gate.value.skip)} posts this week. Look at the recent skips on Content Autopilot.`)
  if (!i.gscDays.ok) cand.push(`Google Search numbers ${UNREAD}. Check the Search Console connection.`)
  const published7 = [val(i.postsPublished), val(i.guidesPublished)]
  if (published7[0] === 0 && published7[1] === 0) cand.push('Nothing was published in the last 7 days (0 posts, 0 guides). Check that Autopilot is on.')
  const actions = cand.slice(0, MAX_ACTIONS)

  return { generatedAt: i.now.toISOString(), sections, trends, actions }
}

/** Plain text for the email and for anything else that wants text. Grade-6 words, short lines. Pure. */
export function growthDigestText(d: GrowthDigest): string {
  return [
    'GROWTH THIS WEEK',
    '',
    ...d.sections.flatMap((s) => [s.title.toUpperCase(), ...s.lines.map((l) => `- ${l}`), '']),
    'TRENDS',
    ...d.trends,
    '',
    'WHAT TO DO TODAY',
    ...(d.actions.length ? d.actions.map((a, k) => `${k + 1}. ${a}`) : ['Nothing here needs you today.']),
  ].join('\n')
}
