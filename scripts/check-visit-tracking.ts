// Offline checks for first-party visit tracking (autoblogging row 11). Run: pnpm dlx tsx scripts/check-visit-tracking.ts
// No network and no database: scripts/fake-admin.ts stands in for Supabase.
import { readFileSync } from 'node:fs'
import { fakeAdmin, type Db } from './fake-admin'
import {
  browserFamily,
  handleVisit,
  isBotUserAgent,
  isPrivacyOptOut,
  lastTouchAfterPageView,
  parseVisitBody,
  purgeCutoff,
  purgeOldVisits,
  runVisitPurgeIfDue,
  purgeOldAuthEvents,
  VISIT_DAILY_CAP_KEY,
  touchesForNewVisit,
  VISIT_TRACKING_KEY,
} from '../lib/visit-tracking'
import { getFunnel, visitsStage } from '../lib/funnel'
import { snapshotContentPerformance } from '../lib/content-performance'

delete process.env.GA4_PROPERTY_ID
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const SITE = 'travelfunbiz.ca'
const VID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb'
const SID = 'cccccccc-1111-4222-8333-dddddddddddd'
const hdrs = (o: Record<string, string> = {}) => {
  const m = new Map(Object.entries({ 'user-agent': UA, 'sec-fetch-site': 'same-origin', ...o }).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (k: string) => m.get(k.toLowerCase()) ?? null }
}
const body = (o: Record<string, unknown> = {}) => JSON.stringify({ t: 'pv', vid: VID, sid: SID, path: '/blog/rome', ref_host: '', ...o })
const mk = (on: boolean): Db => ({ tables: { app_settings: on ? [{ key: VISIT_TRACKING_KEY, value: 'on' }] : [], site_visits: [] } })
const go = (db: Db, over: { headers?: ReturnType<typeof hdrs>; bodyText?: string; now?: number; limiter?: (v: string) => Promise<boolean>; ipLimiter?: () => Promise<boolean> } = {}) =>
  handleVisit({ admin: fakeAdmin(db), headers: over.headers ?? hdrs(), bodyText: over.bodyText ?? body(), siteHost: SITE, limiter: over.limiter ?? (async () => true), ipLimiter: over.ipLimiter, now: over.now })

async function main() {
  // ---- off by default ----
  {
    const db = mk(false)
    const r = await go(db)
    check('off by default: 204 and nothing stored', r.status === 204 && r.outcome === 'off' && db.tables.site_visits.length === 0, JSON.stringify(r))
    const db2: Db = { tables: { app_settings: [{ key: VISIT_TRACKING_KEY, value: 'maybe' }], site_visits: [] } }
    check('any value other than "on" stays off', (await go(db2)).outcome === 'off')
    const db3: Db = { tables: { app_settings: [{ key: VISIT_TRACKING_KEY, value: 'on' }], site_visits: [] } }
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) } as never
    const r2 = await handleVisit({ admin: broken, headers: hdrs(), bodyText: body(), siteHost: SITE, limiter: async () => true })
    check('cannot read the switch: fail closed (off)', r2.outcome === 'off' && db3.tables.site_visits.length === 0)
    check('the admin switch defaults to off in the UI and API', /useState\(false\)/.test(src('app/admin/system-health/page.tsx')) && /Turn this on only after your lawyer has approved the cookie wording|only after your lawyer has approved the cookie wording/.test(src('app/admin/system-health/page.tsx')))
  }

  // ---- consent required (client) ----
  {
    const c = src('components/visit-tracker.tsx')
    check('client: requires analytics consent before any beacon', /if \(!analytics \|\| !pathname/.test(c) && /useConsent\(\)/.test(c))
    check('client: withdrawn or declined consent erases the random ids', /if \(!analytics\) forgetEverything\(\)/.test(c))
    check('client: never runs on /admin or /api and skips the owner browser', /admin\|api/.test(c) && /isInternalBrowser\(\)/.test(c))
    check('client: DNT and GPC count as no', /doNotTrack/.test(c) && /globalPrivacyControl/.test(c))
    check('client: heartbeat every 30 s, up to 30 minutes, visibility based', /HEARTBEAT_MS = 30 \* 1000/.test(c) && /MAX_ACTIVE_S = 30 \* 60/.test(c) && /visibilityState/.test(c))
    check('client: no cookies, no fingerprinting APIs', !/document\.cookie/.test(c) && !/canvas|AudioContext|getClientRects|navigator\.plugins|userAgent/.test(c))
    check('client: sends the referrer HOST only, never the full address', /new URL\(document\.referrer\)\.hostname/.test(c) && !/referrer:\s*document\.referrer/.test(c))
    check('client: rendered in the root layout', /<VisitTracker \/>/.test(src('app/layout.tsx')))
  }

  // ---- DNT / GPC (server) ----
  {
    const db = mk(true)
    check('DNT: 1 header respected', (await go(db, { headers: hdrs({ DNT: '1' }) })).outcome === 'opt-out')
    check('Sec-GPC: 1 header respected', (await go(db, { headers: hdrs({ 'Sec-GPC': '1' }) })).outcome === 'opt-out')
    check('opt-out stores nothing', db.tables.site_visits.length === 0)
    check('isPrivacyOptOut false without the headers', !isPrivacyOptOut(hdrs()))
  }

  // ---- payload limits ----
  {
    const db = mk(true)
    check('oversized body rejected', (await go(db, { bodyText: JSON.stringify({ t: 'pv', vid: VID, sid: SID, path: '/', pad: 'x'.repeat(3000) }) })).status === 400)
    check('not json rejected', (await go(db, { bodyText: 'nope' })).status === 400)
    check('bad visitor id rejected', (await go(db, { bodyText: body({ vid: 'short' }) })).status === 400)
    check('bad type rejected', (await go(db, { bodyText: body({ t: 'x' }) })).status === 400)
    check('path must start with a slash', (await go(db, { bodyText: body({ path: 'evil.com' }) })).status === 400)
    check('protocol-relative path rejected', (await go(db, { bodyText: body({ path: '//evil.com/x' }) })).status === 400)
    check('/admin and /api paths are never stored', (await go(db, { bodyText: body({ path: '/admin/leads' }) })).outcome === 'ignored' && (await go(db, { bodyText: body({ path: '/api/x' }) })).outcome === 'ignored')
    check('nothing stored by rejected payloads', db.tables.site_visits.length === 0)
    const p = parseVisitBody(JSON.stringify({ t: 'pv', vid: VID, sid: SID, path: '/blog/x/?a=1#h', utm_source: 'y'.repeat(500), ref_host: 'Not A Host!', dur: 99999, extra: 'ignored' }))
    check('query and hash stripped from the path, trailing slash dropped', p.ok && p.value.path === '/blog/x')
    check('utm values cut to 100 characters', p.ok && p.value.utmSource.length === 100)
    check('a bad referrer host becomes empty', p.ok && p.value.refHost === '')
    check('duration clamped to 30 minutes', p.ok && p.value.dur === 1800)
    check('unknown fields are dropped', p.ok && !('extra' in p.value))
    const lim = await go(mk(true), { limiter: async () => false })
    check('rate limit answers 429 and stores nothing', lim.status === 429)
    check('route uses the existing rate-limit helper per visitor id', /allowKey\(RATE_LIMIT\.bucket, vid/.test(src('app/api/track/visit/route.ts')))
    const foreign = await go(mk(true), { headers: hdrs({ Origin: 'https://evil.example' }) })
    check('a beacon from another website is ignored', foreign.outcome === 'ignored')

    // same-origin proof is required: a matching Origin, or Sec-Fetch-Site: same-origin when there is no Origin
    const bare = mk(true)
    const noProof = await go(bare, { headers: hdrs({ 'sec-fetch-site': 'none' }) })
    check('no Origin and no same-origin Sec-Fetch-Site: 204, nothing stored', noProof.status === 204 && noProof.outcome === 'ignored' && bare.tables.site_visits.length === 0, JSON.stringify(noProof))
    const crossSite = mk(true)
    const cs = await go(crossSite, { headers: hdrs({ 'sec-fetch-site': 'cross-site' }) })
    check('Sec-Fetch-Site: cross-site is ignored', cs.outcome === 'ignored' && crossSite.tables.site_visits.length === 0)
    const withOrigin = mk(true)
    const wo = await go(withOrigin, { headers: hdrs({ Origin: 'https://www.travelfunbiz.ca', 'sec-fetch-site': '' }) })
    check('a matching Origin is accepted', wo.outcome === 'stored' && withOrigin.tables.site_visits.length === 1, JSON.stringify(wo))
    const sfsOnly = mk(true)
    const so = await go(sfsOnly, { headers: hdrs({ 'sec-fetch-site': 'same-origin' }) })
    check('Sec-Fetch-Site: same-origin without an Origin is accepted', so.outcome === 'stored')

    // per-IP limit (visitor ids are chosen by the sender, so they cannot be the only key)
    const ipDb = mk(true)
    const ip = await go(ipDb, { ipLimiter: async () => false })
    check('per-IP limit answers 429 and stores nothing, even with a fresh visitor id', ip.status === 429 && ipDb.tables.site_visits.length === 0)
    check('route applies the per-IP limit with the existing helper', /allowRequest\(request, IP_RATE_LIMIT\.bucket, IP_RATE_LIMIT\.limit, IP_RATE_LIMIT\.windowSeconds\)/.test(src('app/api/track/visit/route.ts')) && /track_visit_ip', limit: 120, windowSeconds: 60/.test(src('lib/visit-tracking.ts')))
  }

  // ---- bots ----
  {
    const db = mk(true)
    for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'curl/8.4.0', 'Mozilla/5.0 HeadlessChrome/120', '', 'python-requests/2.31', 'facebookexternalhit/1.1']) {
      const r = await go(db, { headers: hdrs({ 'user-agent': ua }) })
      check(`bot filtered: "${ua.slice(0, 24)}"`, r.outcome === 'bot')
    }
    check('bots store nothing', db.tables.site_visits.length === 0)
    check('a real browser is not a bot', !isBotUserAgent(UA))
  }

  // ---- stored row: no IP, no full UA, channel recomputed server side ----
  {
    const db = mk(true)
    const r = await go(db, {
      headers: hdrs({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' }),
      bodyText: body({ ref_host: 'www.google.com', channel: 'paid_social', ip: '1.2.3.4', ua: 'full ua', utm_campaign: 'rome' }),
    })
    const row = db.tables.site_visits[0]
    check('first beacon stores one row', r.status === 202 && r.outcome === 'stored' && db.tables.site_visits.length === 1)
    const dump = JSON.stringify(row)
    check('no IP anywhere in the row', !/203\.0\.113|1\.2\.3\.4/.test(dump))
    check('no full user agent in the row', !dump.includes('Mozilla') && !dump.includes('AppleWebKit') && !dump.includes('full ua') && row.browser === 'Chrome')
    check('channel recomputed on the server, not trusted from the browser', row.channel === 'search' && row.source === 'google')
    check('referrer stored as host only', row.referrer_host === 'google.com')
    check('row carries random ids, path and campaign', row.visitor_id === VID && row.session_id === SID && row.landing_path === '/blog/rome' && row.campaign === 'rome')
    const colsUsed = src('lib/visit-tracking.ts')
    check('code never reads the IP or stores the user agent', !/x-forwarded-for|clientIp|x-real-ip/i.test(colsUsed) && !/user_agent|userAgent:/.test(colsUsed))
    check('route sets no cookie', !/set-cookie|cookies\(/i.test(src('app/api/track/visit/route.ts')))
  }

  // ---- last-touch logic ----
  {
    const g = { channel: 'search', source: 'google' }
    const f = { channel: 'social', source: 'facebook' }
    const d = { channel: 'direct', source: 'direct' }
    const first = touchesForNewVisit(null, g)
    check('new visitor: first and last touch are this visit', first.first.channel === 'search' && first.last.channel === 'search')
    const second = touchesForNewVisit({ first: first.first, last: first.last }, d)
    check('direct return visit keeps the last non-direct touch', second.last.channel === 'search' && second.first.channel === 'search')
    const third = touchesForNewVisit({ first: first.first, last: first.last }, f)
    check('later non-direct visit becomes last touch, first touch never overwritten', third.last.channel === 'social' && third.first.channel === 'search')
    check('a direct page view does not overwrite the last touch', lastTouchAfterPageView(f, d).channel === 'social')
    check('a non-direct page view moves the last touch', lastTouchAfterPageView(d, g).channel === 'search')

    // end to end across two visits of the same visitor
    const db = mk(true)
    await go(db, { bodyText: body({ ref_host: 'l.facebook.com' }), now: Date.parse('2026-10-01T10:00:00Z') })
    await go(db, { bodyText: body({ sid: 'eeeeeeee-1111-4222-8333-ffffffffffff', ref_host: '' }), now: Date.parse('2026-10-05T10:00:00Z') })
    const [v1, v2] = db.tables.site_visits
    check('visit 1 classified social', v1.channel === 'social' && v1.last_touch_channel === 'social')
    check('visit 2 is direct but carries last non-direct touch', v2.channel === 'direct' && v2.last_touch_channel === 'social' && v2.first_touch_channel === 'social')
    // second page view in a visit, arriving from a campaign link
    const pv = await go(db, { bodyText: body({ sid: SID, path: '/destinations', utm_medium: 'email', utm_source: 'news' }), now: Date.parse('2026-10-01T10:05:00Z') })
    check('second page view updates the same visit (no new row)', pv.outcome === 'updated' && db.tables.site_visits.length === 2 && v1.page_views === 2 && v1.last_path === '/destinations')
    check('non-direct page view moves last touch to email', v1.last_touch_channel === 'email' && v1.channel === 'social')
  }

  // ---- heartbeat ----
  {
    const db = mk(true)
    const t0 = Date.parse('2026-10-01T10:00:00Z')
    await go(db, { now: t0 })
    const hb = (dur: number, at: number) => go(db, { bodyText: JSON.stringify({ t: 'hb', vid: VID, sid: SID, path: '/blog/rome', dur }), now: at })
    await hb(30, t0 + 32_000)
    check('heartbeat records time on page', db.tables.site_visits[0].duration_s === 30)
    await hb(20, t0 + 40_000)
    check('time never goes backwards', db.tables.site_visits[0].duration_s === 30)
    await hb(1800, t0 + 60_000)
    check('time cannot exceed real elapsed time', (db.tables.site_visits[0].duration_s as number) <= 65, String(db.tables.site_visits[0].duration_s))
    const orphan = await go(db, { bodyText: JSON.stringify({ t: 'hb', vid: VID, sid: 'ffffffff-1111-4222-8333-ffffffffffff', path: '/', dur: 5 }) })
    check('heartbeat with no visit is ignored (never creates a row)', orphan.outcome === 'ignored' && db.tables.site_visits.length === 1)
    const old = await go(db, { bodyText: body(), now: t0 + 25 * 3600 * 1000 })
    check('a visit older than 24 hours takes no more page views', old.outcome === 'ignored' && db.tables.site_visits[0].page_views === 1)
  }

  // ---- global daily insert cap ----
  {
    const now = Date.parse('2026-10-17T12:00:00Z')
    const today = Array.from({ length: 3 }, (_, i) => ({ id: 't' + i, session_id: 's' + i, created_at: '2026-10-17T01:00:00.000Z' }))
    const yesterday = [{ id: 'y1', session_id: 'sy', created_at: '2026-10-16T23:00:00.000Z' }]
    const capped: Db = { tables: { app_settings: [{ key: VISIT_TRACKING_KEY, value: 'on' }, { key: VISIT_DAILY_CAP_KEY, value: '3' }], site_visits: [...today, ...yesterday] } }
    const over = await go(capped, { now })
    check('daily cap: at the cap a new visit answers 204 and stores nothing', over.status === 204 && capped.tables.site_visits.length === 4, JSON.stringify(over))
    const roomy: Db = { tables: { app_settings: [{ key: VISIT_TRACKING_KEY, value: 'on' }, { key: VISIT_DAILY_CAP_KEY, value: '4' }], site_visits: [...today, ...yesterday] } }
    const ok = await go(roomy, { now })
    check('daily cap: yesterday does not count, under the cap it stores', ok.outcome === 'stored' && roomy.tables.site_visits.length === 5, JSON.stringify(ok))
    const dflt = mk(true)
    check('daily cap: the default is 20000', (await go(dflt, { now })).outcome === 'stored' && /DEFAULT_DAILY_CAP = 20000/.test(src('lib/visit-tracking.ts')))
    const broken = mk(true)
    const real = fakeAdmin(broken)
    const failCount = {
      from: (t: string) => {
        const q = real.from(t) as unknown as Record<string, unknown>
        if (t !== 'site_visits') return q
        return { ...q, select: (cols: string, o?: { head?: boolean }) => (o?.head ? { gte: () => Promise.resolve({ data: null, error: { message: 'boom' }, count: null }) } : (q.select as (c: string, o?: unknown) => unknown)(cols, o)) }
      },
    } as never
    const fc = await handleVisit({ admin: failCount, headers: hdrs(), bodyText: body(), siteHost: SITE, limiter: async () => true, now })
    check('daily cap: an unreadable counter fails closed (204, nothing stored)', fc.status === 204 && broken.tables.site_visits.length === 0, JSON.stringify(fc))
  }

  // ---- purge ----
  {
    const now = Date.parse('2026-10-17T12:00:00Z')
    const cut = purgeCutoff(now).toISOString().slice(0, 10)
    check('retention cutoff is 13 months back', cut === '2025-09-17', cut)
    const old = Array.from({ length: 25 }, (_, i) => ({ id: `old${i}`, created_at: `2025-0${(i % 8) + 1}-10T00:00:00.000Z` }))
    const fresh = [{ id: 'new1', created_at: '2026-10-01T00:00:00.000Z' }, { id: 'new2', created_at: '2025-10-20T00:00:00.000Z' }]
    const db: Db = { tables: { app_settings: [], site_visits: [...old, ...fresh] } }
    const r1 = await purgeOldVisits(fakeAdmin(db), now, { batch: 10, maxBatches: 2 })
    check('purge deletes a capped batch (10 x 2 = 20 of 25)', r1.deleted === 20 && db.tables.site_visits.length === 7, JSON.stringify(r1))
    const r2 = await purgeOldVisits(fakeAdmin(db), now, { batch: 10, maxBatches: 2 })
    check('next run finishes the rest and keeps recent rows', r2.deleted === 5 && db.tables.site_visits.length === 2 && db.tables.site_visits.every((r) => String(r.id).startsWith('new')))
    const failing: Db = { tables: { app_settings: [], site_visits: [...old] }, failWrites: { site_visits: 'permission denied' } }
    const r3 = await purgeOldVisits(fakeAdmin(failing), now)
    check('purge fails closed on a delete error (reports it, deletes nothing)', !!r3.error && r3.deleted === 0 && failing.tables.site_visits.length === 25)
    const daily: Db = { tables: { app_settings: [], site_visits: [...old] } }
    const n1 = await runVisitPurgeIfDue(fakeAdmin(daily), now)
    const n2 = await runVisitPurgeIfDue(fakeAdmin(daily), now)
    check('daily purge runs once per day (claim)', /deleted 25/.test(String(n1)) && n2 === null, `${n1} | ${n2}`)
    const authDb: Db = { tables: { app_settings: [], site_visits: [], auth_events: [{ id: 1, ts: '2025-01-01T00:00:00.000Z', kind: 'login_ok' }, { id: 2, ts: '2026-10-01T00:00:00.000Z', kind: 'login_ok' }] } }
    const ra = await purgeOldAuthEvents(fakeAdmin(authDb), now)
    check('auth_events older than 13 months are purged, recent ones kept', ra.deleted === 1 && authDb.tables.auth_events.length === 1 && authDb.tables.auth_events[0].id === 2, JSON.stringify(ra))
    const authDaily: Db = { tables: { app_settings: [], site_visits: [], auth_events: [{ id: 1, ts: '2025-01-01T00:00:00.000Z', kind: 'login_fail' }] } }
    const nd = await runVisitPurgeIfDue(fakeAdmin(authDaily), now)
    check('the daily purge step also purges the sign-in log (same step, no new cron)', /sign-in log/.test(String(nd)) && authDaily.tables.auth_events.length === 0, String(nd))
    const authBig: Db = { tables: { app_settings: [], auth_events: Array.from({ length: 7000 }, (_, i) => ({ id: i, ts: '2024-01-01T00:00:00.000Z', kind: 'login_ok' })) } }
    const rab = await purgeOldAuthEvents(fakeAdmin(authBig), now, { batch: 999999, maxBatches: 999 })
    check('auth_events purge is batch-capped (1000 x 5)', rab.deleted === 5000 && authBig.tables.auth_events.length === 2000)
    const big: Db = { tables: { app_settings: [], site_visits: Array.from({ length: 7000 }, (_, i) => ({ id: `o${i}`, created_at: '2024-01-01T00:00:00.000Z' })) } }
    const rb = await purgeOldVisits(fakeAdmin(big), now, { batch: 999999, maxBatches: 999 })
    check('batch size and batch count are hard-capped (1000 x 5)', rb.deleted === 5000 && big.tables.site_visits.length === 2000, JSON.stringify(rb))
    const pipe = src('lib/pipeline.ts')
    check('purge runs inside the existing pipeline housekeeping, no new cron', /runVisitPurgeIfDue\(admin\)/.test(pipe) && !/visit/i.test(src('vercel.json')))
  }

  // ---- funnel and content performance fall back honestly ----
  {
    check('visitsStage: off and no GA4 = not tracked, count 0', ((s) => !s.tracked && s.count === 0 && /switched off/.test(s.note))(visitsStage({ trackingOn: false, firstPartyCount: 0, ga4Sessions: null })))
    check('visitsStage: off ignores leftover rows', ((s) => !s.tracked)(visitsStage({ trackingOn: false, firstPartyCount: 99, ga4Sessions: null })))
    check('visitsStage: on with rows uses them', ((s) => s.tracked && s.count === 42)(visitsStage({ trackingOn: true, firstPartyCount: 42, ga4Sessions: 500 })))
    check('visitsStage: off falls back to GA4', ((s) => s.tracked && s.count === 500 && /GA4/.test(s.note))(visitsStage({ trackingOn: false, firstPartyCount: 0, ga4Sessions: 500 })))
    check('visitsStage: on but empty falls back to GA4 honestly', ((s) => s.tracked && s.count === 500 && /no visits yet/.test(s.note))(visitsStage({ trackingOn: true, firstPartyCount: 0, ga4Sessions: 500 })))
    check('visitsStage: on but empty with no GA4 is not tracked', ((s) => !s.tracked && s.count === 0)(visitsStage({ trackingOn: true, firstPartyCount: 0, ga4Sessions: null })))

    const rows = [
      { channel: 'search', created_at: new Date().toISOString() },
      { channel: 'search', created_at: new Date().toISOString() },
      { channel: 'social', created_at: new Date().toISOString() },
    ]
    const common = { gsc_ranking_days: [], leads: [], orders: [] }
    const off = await getFunnel(fakeAdmin({ tables: { ...common, app_settings: [], site_visits: rows } }))
    const vOff = off.stages.find((s) => s.key === 'visits')!
    check('funnel, tracking off: honest "not tracked", rows not shown', !vOff.tracked && vOff.count === 0 && off.visitsByChannel.length === 0)
    const on = await getFunnel(fakeAdmin({ tables: { ...common, app_settings: [{ key: VISIT_TRACKING_KEY, value: 'on' }], site_visits: rows } }))
    const vOn = on.stages.find((s) => s.key === 'visits')!
    check('funnel, tracking on: counts first-party visits and channels', vOn.tracked && vOn.count === 3 && on.visitsByChannel[0].channel === 'search' && on.visitsByChannel[0].count === 2)
    const onEmpty = await getFunnel(fakeAdmin({ tables: { ...common, app_settings: [{ key: VISIT_TRACKING_KEY, value: 'on' }], site_visits: [] } }))
    check('funnel, tracking on but no rows and no GA4: not tracked, never invented', !onEmpty.stages.find((s) => s.key === 'visits')!.tracked)

    const perfDb = (setting: boolean): Db => ({
      tables: {
        app_settings: setting ? [{ key: VISIT_TRACKING_KEY, value: 'on' }] : [],
        site_visits: [
          { landing_path: '/blog/rome', created_at: new Date().toISOString() },
          { landing_path: '/blog/rome', created_at: new Date().toISOString() },
          { landing_path: '/admin/x', created_at: new Date().toISOString() },
        ],
        post_distribution: [], content_pipeline: [], leads: [], posts: [{ slug: 'rome', title: 'Rome', status: 'published' }], content_performance: [],
      },
    })
    const dOff = perfDb(false)
    await snapshotContentPerformance(fakeAdmin(dOff))
    check('content_performance.visits stays null when tracking is off (no GA4)', (dOff.tables.content_performance ?? []).length > 0 && dOff.tables.content_performance.every((r) => r.visits === null))
    const dOn = perfDb(true)
    await snapshotContentPerformance(fakeAdmin(dOn))
    const rome = (dOn.tables.content_performance ?? []).find((r) => r.path === '/blog/rome')
    check('content_performance.visits counts own visits per landing page when on', rome?.visits === 2, JSON.stringify(rome))
    check('/admin landings never counted', !(dOn.tables.content_performance ?? []).some((r) => String(r.path).startsWith('/admin')))
  }

  // ---- misc ----
  check('browser family only', browserFamily(UA) === 'Chrome' && browserFamily('Mozilla/5.0 (iPhone) AppleWebKit Version/17 Mobile Safari/604') === 'Safari' && browserFamily('x') === 'Other')
  check('migration 0046 is additive and idempotent', ((m) => /add column if not exists/.test(m) && !/drop |delete from/i.test(m) && /create unique index if not exists/.test(m))(src('supabase/migrations/0046_site_visits_sessions.sql')))
  check('privacy draft lists what is collected, bracketed for the lawyer', ((t) => /DRAFT PARAGRAPH FOR THE LAWYER/.test(t) && /page address \(path\)/.test(t) && /random number/.test(t) && /campaign tags/.test(t) && /time you spent/.test(t))(src('docs/legal/privacy-policy-draft.md')))
  check('no em dashes in new files', ['lib/visit-tracking.ts', 'components/visit-tracker.tsx', 'app/api/track/visit/route.ts', 'app/api/admin/visit-tracking/route.ts', 'scripts/check-visit-tracking.ts', 'supabase/migrations/0046_site_visits_sessions.sql'].every((f) => !src(f).includes(String.fromCharCode(8212))))
}

main()
  .then(() => {
    console.log(failed ? `\n${failed} FAILED` : '\nall passed')
    process.exit(failed ? 1 : 0)
  })
  .catch((e) => {
    console.error('check crashed:', e)
    process.exit(1)
  })
