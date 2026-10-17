import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { classifyVisit, type Channel } from '@/lib/traffic-source'

// First-party visit tracking (autoblogging hub row 11). Privacy first and OFF by default.
//
// The whole thing is inert until Joel turns on the app_settings key `visit_tracking` (after his lawyer has approved the
// cookie wording). Even then, the browser only sends anything when the visitor accepted analytics and has not set
// Do Not Track or Global Privacy Control (components/visit-tracker.tsx), and this server re-checks the two headers.
//
// What is stored (one row per VISIT, table site_visits): the page path, the referrer HOST (never the full address),
// campaign tags, a random visitor id and session id, pages seen, time on site, a short browser family and the
// channel. Never an IP address, never the full user agent, never a cookie.
export const VISIT_TRACKING_KEY = 'visit_tracking'
export const VISIT_RETENTION_MONTHS = 13
/** app_settings key: the most new visit rows stored per UTC day (all visitors together). */
export const VISIT_DAILY_CAP_KEY = 'visit_tracking_daily_cap'
export const DEFAULT_DAILY_CAP = 20000
/** Per client IP: at most this many beacons a minute (every visitor behind one IP shares it). */
export const IP_RATE_LIMIT = { bucket: 'track_visit_ip', limit: 120, windowSeconds: 60 } as const
export const PURGE_BATCH = 1000
export const PURGE_MAX_BATCHES = 5
export const MAX_BODY_BYTES = 2048
export const MAX_DURATION_S = 1800
export const MAX_PAGE_VIEWS = 500
/** A visit row older than this never takes more page views or time (the browser starts a new session after 30 minutes idle). */
const SESSION_MAX_AGE_MS = 24 * 3600 * 1000
/** Per visitor id: at most this many beacons a minute. A real visitor sends a handful. */
export const RATE_LIMIT = { bucket: 'track_visit', limit: 40, windowSeconds: 60 } as const

const ID_RE = /^[a-z0-9-]{16,64}$/
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,98}[a-z0-9]$/
const CLICK_IDS = ['gclid', 'msclkid', 'fbclid', ''] as const

export async function isVisitTrackingOn(admin: SupabaseClient): Promise<boolean> {
  const { value, error } = await getSettingStrict(admin, VISIT_TRACKING_KEY)
  if (error) return false // cannot read the switch: stay off (fail closed)
  return value === 'on'
}

export async function setVisitTracking(admin: SupabaseClient, on: boolean): Promise<{ error?: string }> {
  return setSetting(admin, VISIT_TRACKING_KEY, on ? 'on' : 'off')
}

/** Do Not Track and Global Privacy Control both mean "no". */
export function isPrivacyOptOut(headers: { get(name: string): string | null }): boolean {
  return headers.get('dnt') === '1' || headers.get('sec-gpc') === '1'
}

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|curl|wget|python|requests|headless|lighthouse|pingdom|uptime|monitor|phantom|selenium|puppeteer|playwright|httpclient|okhttp|java\/|go-http|node-fetch|axios|scrapy|libwww|vercel-screenshot/i
/** Obvious bots and tools. An empty user agent counts as a bot. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  return !ua || BOT_RE.test(ua)
}

/** A short family name only. The full user agent is never kept. */
export function browserFamily(ua: string | null | undefined): string {
  const s = ua || ''
  if (/edg(e|a|ios)?\//i.test(s)) return 'Edge'
  if (/opr\/|opera/i.test(s)) return 'Opera'
  if (/samsungbrowser/i.test(s)) return 'Samsung'
  if (/firefox|fxios/i.test(s)) return 'Firefox'
  if (/chrome|crios|chromium/i.test(s)) return 'Chrome'
  if (/safari/i.test(s)) return 'Safari'
  return 'Other'
}

export interface VisitPayload {
  t: 'pv' | 'hb'
  vid: string
  sid: string
  path: string
  refHost: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  clickId: 'gclid' | 'msclkid' | 'fbclid' | ''
  hasRef: boolean
  dur: number
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '')

/** Validates and size-limits the beacon. Anything unexpected is dropped; nothing the browser claims is trusted. */
export function parseVisitBody(text: string): { ok: true; value: VisitPayload } | { ok: false; reason: string } {
  if (text.length > MAX_BODY_BYTES) return { ok: false, reason: 'too large' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not json' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' }
  const o = raw as Record<string, unknown>
  if (o.t !== 'pv' && o.t !== 'hb') return { ok: false, reason: 'bad type' }
  const vid = typeof o.vid === 'string' ? o.vid.toLowerCase() : ''
  const sid = typeof o.sid === 'string' ? o.sid.toLowerCase() : ''
  if (!ID_RE.test(vid) || !ID_RE.test(sid)) return { ok: false, reason: 'bad id' }
  let path = clean(o.path, 300).split(/[?#]/)[0].replace(/\/+$/, '')
  if (path === '') path = '/'
  if (!path.startsWith('/') || path.startsWith('//')) return { ok: false, reason: 'bad path' }
  const refHostRaw = clean(o.ref_host, 100).toLowerCase()
  const refHost = refHostRaw && HOST_RE.test(refHostRaw) ? refHostRaw : ''
  const clickId = (CLICK_IDS as readonly string[]).includes(o.click_id as string) ? (o.click_id as VisitPayload['clickId']) : ''
  const dur = Number.isFinite(o.dur) ? Math.max(0, Math.min(MAX_DURATION_S, Math.floor(o.dur as number))) : 0
  return {
    ok: true,
    value: {
      t: o.t,
      vid,
      sid,
      path,
      refHost,
      utmSource: clean(o.utm_source, 100),
      utmMedium: clean(o.utm_medium, 100),
      utmCampaign: clean(o.utm_campaign, 100),
      utmContent: clean(o.utm_content, 100),
      clickId,
      hasRef: o.has_ref === true,
      dur,
    },
  }
}

/** /admin and /api are never tracked. */
export function isTrackablePath(path: string): boolean {
  return !/^\/(admin|api)(\/|$)/i.test(path)
}

export interface Touch {
  channel: string
  source: string
}

/** First and last touch for a NEW visit. First touch = the visitor's very first visit, carried forward and never overwritten.
 * Last touch = this visit's channel unless it is direct, in which case the last non-direct touch is carried forward. */
export function touchesForNewVisit(prev: { first: Touch | null; last: Touch | null } | null, now: Touch): { first: Touch; last: Touch } {
  const first = prev?.first ?? now
  const last = now.channel !== 'direct' ? now : prev?.last && prev.last.channel !== 'direct' ? prev.last : now
  return { first, last }
}

/** Last touch after another page view in the same visit: only a non-direct arrival moves it. */
export function lastTouchAfterPageView(current: Touch | null, now: Touch): Touch {
  return now.channel !== 'direct' || !current ? now : current
}

export interface VisitResult {
  status: 202 | 204 | 400 | 429
  outcome: 'stored' | 'updated' | 'ignored' | 'off' | 'opt-out' | 'bot' | 'invalid' | 'rate-limited' | 'not-set-up' | 'error'
}

const result = (status: VisitResult['status'], outcome: VisitResult['outcome']): VisitResult => ({ status, outcome })
const missingColumn = (m: string | undefined) => !!m && /column .* does not exist|could not find the .* column|schema cache|relation .* does not exist/i.test(m)

interface ExistingRow {
  id: string
  created_at: string
  page_views: number | null
  duration_s: number | null
  last_touch_channel: string | null
  last_touch_source: string | null
}

/** Everything the /api/track/visit route does, as one function so the offline check can drive it. */
export async function handleVisit(args: {
  admin: SupabaseClient
  headers: { get(name: string): string | null }
  bodyText: string
  /** true when this visitor id is still under the rate limit */
  limiter: (visitorId: string) => Promise<boolean>
  /** true when this client IP is still under its per-IP limit (the route supplies it). */
  ipLimiter?: () => Promise<boolean>
  siteHost: string
  now?: number
}): Promise<VisitResult> {
  const { admin, headers } = args
  const now = args.now ?? Date.now()
  try {
    if (isPrivacyOptOut(headers)) return result(204, 'opt-out')
    if (!(await isVisitTrackingOn(admin))) return result(204, 'off')
    if (isBotUserAgent(headers.get('user-agent'))) return result(204, 'bot')
    // Same-origin only: a matching Origin, or (no Origin) Sec-Fetch-Site: same-origin. Anything else stores nothing.
    const origin = headers.get('origin')
    if (origin) {
      let oh = ''
      try {
        oh = new URL(origin).hostname.toLowerCase().replace(/^www\./, '')
      } catch {
        oh = ''
      }
      const mine = args.siteHost.toLowerCase().replace(/^www\./, '')
      const reqHost = (headers.get('host') || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '')
      if (oh !== mine && oh !== reqHost) return result(204, 'ignored')
    } else if ((headers.get('sec-fetch-site') || '').toLowerCase() !== 'same-origin') {
      return result(204, 'ignored')
    }
    const parsed = parseVisitBody(args.bodyText)
    if (!parsed.ok) return result(400, 'invalid')
    const p = parsed.value
    if (!isTrackablePath(p.path)) return result(204, 'ignored')
    // Visitor ids are chosen by the sender, so a per-IP limit comes first and the per-visitor one second.
    if (args.ipLimiter && !(await args.ipLimiter())) return result(429, 'rate-limited')
    if (!(await args.limiter(p.vid))) return result(429, 'rate-limited')

    const existing = await findSession(admin, p.sid)
    if (existing.error) return missingColumn(existing.error) ? result(204, 'not-set-up') : result(204, 'error')
    const row = existing.row
    if (row && now - new Date(row.created_at).getTime() > SESSION_MAX_AGE_MS) return result(204, 'ignored')

    if (p.t === 'hb') {
      if (!row) return result(204, 'ignored')
      const elapsed = Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 1000)) + 5
      const dur = Math.min(p.dur, MAX_DURATION_S, elapsed)
      if (dur <= (row.duration_s ?? 0)) return result(204, 'ignored')
      const { error } = await admin.from('site_visits').update({ duration_s: dur, updated_at: new Date(now).toISOString() }).eq('id', row.id)
      return error ? result(204, 'error') : result(202, 'updated')
    }

    const cls = classifyVisit({
      referrer: p.refHost ? `https://${p.refHost}` : null,
      utmSource: p.utmSource,
      utmMedium: p.utmMedium,
      clickId: p.clickId,
      hasRef: p.hasRef,
      siteHost: args.siteHost,
    })
    const touch: Touch = { channel: cls.channel as Channel, source: cls.source }
    if (row) return await addPageView(admin, row, p, touch, now)

    // Global daily insert cap: over it (or counter unreadable) stores nothing.
    if (!(await underDailyCap(admin, now))) return result(204, 'ignored')

    // A new visit: carry the visitor's first touch and last non-direct touch forward from their previous visit.
    const prevRes = await admin
      .from('site_visits')
      .select('first_touch_channel, first_touch_source, last_touch_channel, last_touch_source')
      .eq('visitor_id', p.vid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (prevRes.error && missingColumn(prevRes.error.message)) return result(204, 'not-set-up')
    const pr = (prevRes.data ?? null) as { first_touch_channel: string | null; first_touch_source: string | null; last_touch_channel: string | null; last_touch_source: string | null } | null
    const prev = pr
      ? {
          first: pr.first_touch_channel ? { channel: pr.first_touch_channel, source: pr.first_touch_source ?? '' } : null,
          last: pr.last_touch_channel ? { channel: pr.last_touch_channel, source: pr.last_touch_source ?? '' } : null,
        }
      : null
    const t = touchesForNewVisit(prev, touch)
    const nowIso = new Date(now).toISOString()
    const { error } = await admin.from('site_visits').insert({
      channel: cls.channel,
      source: cls.source,
      medium: p.utmMedium.toLowerCase(),
      campaign: p.utmCampaign,
      content: p.utmContent,
      landing_path: p.path,
      referrer_host: cls.referrerHost,
      visitor_id: p.vid,
      session_id: p.sid,
      first_touch_channel: t.first.channel,
      first_touch_source: t.first.source,
      last_touch_channel: t.last.channel,
      last_touch_source: t.last.source,
      page_views: 1,
      last_path: p.path,
      duration_s: 0,
      browser: browserFamily(headers.get('user-agent')),
      created_at: nowIso,
      updated_at: nowIso,
    })
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        // two beacons raced to open the same visit: count this one as a page view of it
        const again = await findSession(admin, p.sid)
        if (again.row) return await addPageView(admin, again.row, p, touch, now)
        return result(204, 'ignored')
      }
      return missingColumn(error.message) ? result(204, 'not-set-up') : result(204, 'error')
    }
    return result(202, 'stored')
  } catch {
    return result(204, 'error') // tracking must never surface an error to a visitor
  }
}

/** True while today's (UTC) new-visit rows are under the cap. An unreadable setting or counter answers false (fail closed). */
export async function underDailyCap(admin: SupabaseClient, now: number): Promise<boolean> {
  try {
    const { value, error } = await getSettingStrict(admin, VISIT_DAILY_CAP_KEY)
    if (error) return false
    const n = Number(value)
    const cap = value != null && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_CAP
    const dayStart = new Date(now)
    dayStart.setUTCHours(0, 0, 0, 0)
    const res = await admin.from('site_visits').select('id', { count: 'exact', head: true }).gte('created_at', dayStart.toISOString())
    if (res.error || res.count == null) return false
    return res.count < cap
  } catch {
    return false
  }
}

async function findSession(admin: SupabaseClient, sid: string): Promise<{ row: ExistingRow | null; error?: string }> {
  const { data, error } = await admin
    .from('site_visits')
    .select('id, created_at, page_views, duration_s, last_touch_channel, last_touch_source')
    .eq('session_id', sid)
    .maybeSingle()
  if (error) return { row: null, error: error.message }
  return { row: (data ?? null) as ExistingRow | null }
}

async function addPageView(admin: SupabaseClient, row: ExistingRow, p: VisitPayload, touch: Touch, now: number): Promise<VisitResult> {
  const views = row.page_views ?? 1
  if (views >= MAX_PAGE_VIEWS) return result(204, 'ignored')
  const current = row.last_touch_channel ? { channel: row.last_touch_channel, source: row.last_touch_source ?? '' } : null
  const last = lastTouchAfterPageView(current, touch)
  const { error } = await admin
    .from('site_visits')
    .update({ page_views: views + 1, last_path: p.path, last_touch_channel: last.channel, last_touch_source: last.source, updated_at: new Date(now).toISOString() })
    .eq('id', row.id)
  return error ? result(204, 'error') : result(202, 'updated')
}

/** The date 13 months before `now`. */
export function purgeCutoff(now: number): Date {
  const d = new Date(now)
  d.setUTCMonth(d.getUTCMonth() - VISIT_RETENTION_MONTHS)
  return d
}

/** Deletes visits older than 13 months, in capped batches. Fails closed: if a read or delete fails it stops and deletes nothing more. */
export async function purgeOldVisits(admin: SupabaseClient, now = Date.now(), opts: { batch?: number; maxBatches?: number } = {}): Promise<{ deleted: number; error?: string }> {
  const batch = Math.max(1, Math.min(opts.batch ?? PURGE_BATCH, PURGE_BATCH))
  const maxBatches = Math.max(1, Math.min(opts.maxBatches ?? PURGE_MAX_BATCHES, PURGE_MAX_BATCHES))
  const cutoff = purgeCutoff(now).toISOString()
  let deleted = 0
  for (let i = 0; i < maxBatches; i++) {
    const { data, error } = await admin.from('site_visits').select('id').lt('created_at', cutoff).order('created_at', { ascending: true }).limit(batch)
    if (error) return { deleted, error: error.message }
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id)
    if (!ids.length) break
    const del = await admin.from('site_visits').delete().in('id', ids)
    if (del.error) return { deleted, error: del.error.message }
    deleted += ids.length
    if (ids.length < batch) break
  }
  return { deleted }
}

/** Deletes admin sign-in log rows (auth_events) older than 13 months, in capped batches. Same fail-closed rules as the visit purge. */
export async function purgeOldAuthEvents(admin: SupabaseClient, now = Date.now(), opts: { batch?: number; maxBatches?: number } = {}): Promise<{ deleted: number; error?: string }> {
  const batch = Math.max(1, Math.min(opts.batch ?? PURGE_BATCH, PURGE_BATCH))
  const maxBatches = Math.max(1, Math.min(opts.maxBatches ?? PURGE_MAX_BATCHES, PURGE_MAX_BATCHES))
  const cutoff = purgeCutoff(now).toISOString()
  let deleted = 0
  try {
    for (let i = 0; i < maxBatches; i++) {
      const { data, error } = await admin.from('auth_events').select('id').lt('ts', cutoff).order('ts', { ascending: true }).limit(batch)
      if (error) return { deleted, error: error.message }
      const ids = ((data ?? []) as { id: string }[]).map((r) => r.id)
      if (!ids.length) break
      const del = await admin.from('auth_events').delete().in('id', ids)
      if (del.error) return { deleted, error: del.error.message }
      deleted += ids.length
      if (ids.length < batch) break
    }
  } catch (e) {
    return { deleted, error: e instanceof Error ? e.message : 'unknown error' }
  }
  return { deleted }
}

/** Housekeeping step: once a day (atomic claim in app_settings, no new cron). Never throws. Returns a note, or null when already done today. */
export async function runVisitPurgeIfDue(admin: SupabaseClient, now = Date.now()): Promise<string | null> {
  const day = new Date(now).toISOString().slice(0, 10)
  const claimKey = `site_visits_purge_day:${day}`
  try {
    const { error: claimErr } = await admin.from('app_settings').insert({ key: claimKey, value: new Date(now).toISOString() })
    if (claimErr) return (claimErr as { code?: string }).code === '23505' ? null : `could not claim today's visit purge: ${claimErr.message}`
  } catch (e) {
    return `could not claim today's visit purge: ${e instanceof Error ? e.message : 'unknown error'}`
  }
  const r = await purgeOldVisits(admin, now)
  const a = await purgeOldAuthEvents(admin, now)
  const notes: string[] = []
  if (r.error) notes.push(`visit purge stopped (${r.error.slice(0, 120)}) after deleting ${r.deleted}`)
  else if (r.deleted) notes.push(`deleted ${r.deleted} visit${r.deleted === 1 ? '' : 's'} older than ${VISIT_RETENTION_MONTHS} months`)
  if (a.error) notes.push(`sign-in log purge stopped (${a.error.slice(0, 120)}) after deleting ${a.deleted}`)
  else if (a.deleted) notes.push(`deleted ${a.deleted} sign-in log row${a.deleted === 1 ? '' : 's'} older than ${VISIT_RETENTION_MONTHS} months`)
  return notes.length ? notes.join('; ') : null
}
