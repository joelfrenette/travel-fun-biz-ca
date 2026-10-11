import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { fetchSourceText } from '@/lib/package-extract'

// Weekly, free check that the supplier page behind a published trip still agrees with the trip page (growth
// loop WP11). For each published package whose booking or more-info link is a real supplier page (not the
// generic funnel root), fetch it as text and look for "cancelled", "sold out", "waitlist", "no longer
// available", or dates that do not include any month the trip page lists.
//
// It NEVER edits, unpublishes or hides a trip: it stores findings and raises a Needs attention item. What to
// do about a cancelled trip is Joel's decision.

export const SOURCE_WATCH_KEY = 'source_watch_findings'
export const SOURCE_WATCH_DISMISSED_KEY = 'source_watch_dismissed'
const WEEK_KEY_PREFIX = 'source_watch_week:'
/** Links on this host are the generic booking funnel, not a supplier page about one trip. */
const FUNNEL_HOSTS = new Set(['info.travelfunbiz.com'])
const MAX_PAGES = 12
const TIME_BUDGET_MS = 150_000
const FETCH_MARGIN_MS = 45_000

export interface SourceWatchFinding {
  slug: string
  name: string
  url: string
  kind: 'cancelled' | 'dates'
  snippet: string
  at: string
}

export interface SourceWatchState {
  checkedAt: string
  week: string
  pagesChecked: number
  pagesUnreadable: number
  findings: SourceWatchFinding[]
}

export interface WatchedPackage {
  slug: string
  name: string
  booking_url: string | null
  more_info_url: string | null
  available_from: string | null
  available_to: string | null
}

/** ISO week label such as 2026-W41, for the once-a-week claim. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The supplier page links worth fetching for a package: real pages, not the funnel root, not our own pages. */
export function watchedUrls(pkg: Pick<WatchedPackage, 'booking_url' | 'more_info_url'>): string[] {
  const out: string[] = []
  for (const raw of [pkg.booking_url, pkg.more_info_url]) {
    if (!raw) continue
    try {
      const u = new URL(raw)
      if (!/^https?:$/.test(u.protocol)) continue
      if (FUNNEL_HOSTS.has(u.hostname.toLowerCase())) continue
      if (u.pathname === '/' && !u.search && /(^|\.)travelfunbiz\.(com|ca)$/i.test(u.hostname)) continue
      if (!out.includes(u.toString())) out.push(u.toString())
    } catch {
      // not a link
    }
  }
  return out
}

const CANCEL_RE = /\b(cancell?ed|sold out|wait-?list(?:ed)?|no longer available)\b/gi
// "if the trip is cancelled", "cancelled by the traveller", fees and policies: terms of sale, not news.
const POLICY_BEFORE = /\b(if|should|in case|unless|when|policy|policies|terms|fees?|penalt\w*|refund\w*|conditions?|any)\b[^.]{0,60}$/i

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_SHORT = MONTHS.map((m) => m.slice(0, 3))
const MONTH_YEAR_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?(?:\s*(?:to|and|through|-)\s*\d{1,2}(?:st|nd|rd|th)?)?,?\s+)?(20\d{2})\b/gi

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 90)
  const end = Math.min(text.length, index + length + 90)
  return `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '...' : ''}`
}

/** Months (YYYY-MM) a trip row covers, from its first to its last date. */
export function rowMonths(from: string | null, to: string | null): string[] {
  const a = from ?? to
  const b = to ?? from
  if (!a || !b || !/^\d{4}-\d{2}/.test(a) || !/^\d{4}-\d{2}/.test(b)) return []
  const out: string[] = []
  let y = Number(a.slice(0, 4))
  let m = Number(a.slice(5, 7))
  const endY = Number(b.slice(0, 4))
  const endM = Number(b.slice(5, 7))
  for (let i = 0; i < 36 && (y < endY || (y === endY && m <= endM)); i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

/** Pure: what a supplier page's text says that disagrees with the trip. No network. */
export function scanPageText(text: string, pkg: Pick<WatchedPackage, 'available_from' | 'available_to'> & { departure_dates?: string[] | null }, today = new Date().toISOString().slice(0, 10)): { kind: 'cancelled' | 'dates'; snippet: string }[] {
  const found: { kind: 'cancelled' | 'dates'; snippet: string }[] = []

  for (const m of text.matchAll(CANCEL_RE)) {
    const before = text.slice(Math.max(0, m.index! - 70), m.index!)
    if (POLICY_BEFORE.test(before)) continue
    // "Join the waitlist" in a site menu is not news: a waitlist counts only when it is about this tour.
    if (/^wait/i.test(m[0]) && !/this tour|this trip|this departure/i.test(text.slice(Math.max(0, m.index! - 120), m.index! + m[0].length + 120))) continue
    found.push({ kind: 'cancelled', snippet: snippetAround(text, m.index!, m[0].length) })
    break // one example is enough to look
  }

  const departures = (pkg.departure_dates ?? []).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}/.test(d))
  const expected = [...new Set([...rowMonths(pkg.available_from, pkg.available_to), ...departures.map((d) => d.slice(0, 7))])]
  const lastDate = [pkg.available_to, pkg.available_from, ...departures].filter((d): d is string => !!d).sort().pop()
  if (expected.length && lastDate && lastDate >= today) {
    const mentioned = new Map<string, number>()
    for (const m of text.matchAll(MONTH_YEAR_RE)) {
      const idx = MONTH_SHORT.indexOf(m[1].toLowerCase().slice(0, 3))
      if (idx >= 0) mentioned.set(`${m[2]}-${String(idx + 1).padStart(2, '0')}`, m.index!)
    }
    if (mentioned.size > 0 && !expected.some((e) => mentioned.has(e))) {
      const first = [...mentioned.values()].sort((a, b) => a - b)[0]
      found.push({ kind: 'dates', snippet: `The trip page says ${pkg.available_from ?? '?'} to ${pkg.available_to ?? '?'}, but the supplier page mentions: ${snippetAround(text, first, 12)}` })
    }
  }
  return found
}

export async function readSourceWatch(admin: SupabaseClient): Promise<SourceWatchState | null> {
  try {
    return JSON.parse((await getSetting(admin, SOURCE_WATCH_KEY)) ?? 'null') as SourceWatchState | null
  } catch {
    return null
  }
}

async function readDismissed(admin: SupabaseClient): Promise<Record<string, string>> {
  try {
    const v = JSON.parse((await getSetting(admin, SOURCE_WATCH_DISMISSED_KEY)) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Findings that are not dismissed. A dismissal holds until the supplier page says something different. */
export async function openFindings(admin: SupabaseClient): Promise<SourceWatchFinding[]> {
  const state = await readSourceWatch(admin)
  if (!state?.findings?.length) return []
  const dismissed = await readDismissed(admin)
  return state.findings.filter((f) => dismissed[`${f.slug}|${f.kind}`] !== f.snippet)
}

/** Dismiss every current finding for one package (remembered by what the page said, so a new message returns). */
export async function dismissFindings(admin: SupabaseClient, slug: string): Promise<string | null> {
  const state = await readSourceWatch(admin)
  const dismissed = await readDismissed(admin)
  for (const f of state?.findings ?? []) if (f.slug === slug) dismissed[`${f.slug}|${f.kind}`] = f.snippet
  return (await setSetting(admin, SOURCE_WATCH_DISMISSED_KEY, JSON.stringify(dismissed))).error ?? null
}

/** The same list starting at a different trip each ISO week, so when the page limit or the time budget cuts a
 * run short, a different trip is left out each time instead of always the last one. */
export function rotateByWeek<T>(list: T[], now: Date): T[] {
  if (list.length < 2) return list
  const week = Number(isoWeek(now).split('-W')[1]) || 0
  const start = week % list.length
  return [...list.slice(start), ...list.slice(0, start)]
}

/** The check itself. Fetches each page as text (the same fetcher the importer uses), scans it, stores findings. */
export async function runSourceWatch(admin: SupabaseClient, now = new Date()): Promise<{ ok: boolean; note: string; retry?: boolean }> {
  const { data, error } = await admin.from('travel_packages').select('slug, name, booking_url, more_info_url, available_from, available_to, departure_dates').eq('status', 'published')
  if (error) return { ok: false, note: `could not read the trips: ${error.message}`, retry: true }

  const started = Date.now()
  const findings: SourceWatchFinding[] = []
  let checked = 0
  let unreadable = 0
  const seen = new Set<string>()
  const trips = rotateByWeek((data ?? []) as WatchedPackage[], now)
  for (const pkg of trips) {
    for (const url of watchedUrls(pkg)) {
      // One fetch can take up to a minute, so a new one starts only while at least FETCH_MARGIN_MS of the budget is left.
      if (checked + unreadable >= MAX_PAGES || TIME_BUDGET_MS - (Date.now() - started) < FETCH_MARGIN_MS) break
      if (seen.has(`${pkg.slug}|${url}`)) continue
      seen.add(`${pkg.slug}|${url}`)
      const page = await fetchSourceText(url)
      if (page.error) { unreadable++; continue }
      checked++
      for (const hit of scanPageText(page.text, pkg, now.toISOString().slice(0, 10))) {
        findings.push({ slug: pkg.slug, name: pkg.name, url, kind: hit.kind, snippet: hit.snippet, at: now.toISOString() })
      }
    }
  }
  const state: SourceWatchState = { checkedAt: now.toISOString(), week: isoWeek(now), pagesChecked: checked, pagesUnreadable: unreadable, findings }
  const saved = await setSetting(admin, SOURCE_WATCH_KEY, JSON.stringify(state))
  if (saved.error) return { ok: false, note: `could not save the findings: ${saved.error}` }
  return {
    ok: true,
    note: `checked ${checked} supplier page${checked === 1 ? '' : 's'}${unreadable ? ` (${unreadable} could not be read)` : ''}: ${findings.length ? `${findings.length} thing${findings.length === 1 ? '' : 's'} to look at` : 'nothing changed'}`,
  }
}

/** Called every pipeline pass: runs once per ISO week (an atomic claim, so two passes cannot both run it) and
 * once straight away on the first pass after deploy, because that week's claim does not exist yet. Returns a
 * short note, or null when it already ran this week. */
export async function runSourceWatchIfDue(admin: SupabaseClient, now = new Date()): Promise<{ ok: boolean; note: string } | null> {
  const key = `${WEEK_KEY_PREFIX}${isoWeek(now)}`
  const { error } = await admin.from('app_settings').insert({ key, value: now.toISOString() })
  if (error) return (error as { code?: string }).code === '23505' ? null : { ok: false, note: `could not claim this week's check: ${error.message}` }
  const result = await runSourceWatch(admin, now)
  if (result.retry) {
    // The trips could not even be read, so nothing was fetched: give the claim back so the next pass tries again.
    await admin.from('app_settings').delete().eq('key', key)
  } else if (!result.ok) {
    // Pages were already fetched (and possibly paid for), so the claim stays: a failed save is noted on the
    // claim itself instead of re-running every fetch on every pass.
    await admin.from('app_settings').update({ value: result.note.slice(0, 300) }).eq('key', key)
  }
  return result
}
