// Offline self-check for automatic trip social posts (lib/trip-social.ts): the setting gate, price and date blockers,
// the picker, the 24 hour hold and auto-release, the weekly and daily caps, and a source scan for phones and long dashes.
// An in-memory fake of the Supabase client stands in for the database. No network.
// Run: pnpm dlx tsx scripts/check-trip-social.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hasTripDates,
  hasTripPrice,
  isReleasableTripRow,
  parseTripSocial,
  pickTripToPost,
  releaseHeldTrips,
  runTripSocialEnrol,
  tripBlockers,
  TRIP_ENROLMENTS_PER_WEEK,
  TRIP_HOLD_HOURS,
  type TripSocialPackage,
} from '../lib/trip-social'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

type Row = Record<string, unknown>
interface Db {
  tables: Record<string, Row[]>
}
function fakeAdmin(db: Db): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: Row = {}
    let opts: { count?: string; head?: boolean } | undefined
    let max = Infinity
    const rows = () => (db.tables[table] ??= [])
    const run = () => {
      if (mode === 'insert') {
        rows().push({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempts: 0, sent_platforms: [], ...payload })
        return { data: null, error: null, count: null }
      }
      if (mode === 'upsert') {
        const existing = rows().find((r) => r.key === payload.key)
        if (existing) Object.assign(existing, payload)
        else rows().push({ ...payload })
        return { data: null, error: null, count: null }
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (mode === 'update') {
        for (const r of hit) Object.assign(r, payload)
        return { data: hit, error: null, count: hit.length }
      }
      if (mode === 'delete') {
        db.tables[table] = rows().filter((r) => !hit.includes(r))
        return { data: null, error: null, count: null }
      }
      if (opts?.head) return { data: null, error: null, count: hit.length }
      return { data: hit.slice(0, max), error: null, count: hit.length }
    }
    const q: Record<string, unknown> = {
      select: (_cols?: string, o?: { count?: string; head?: boolean }) => {
        if (o) opts = o
        return q
      },
      insert: (row: Row) => ((mode = 'insert'), (payload = row), q),
      update: (row: Row) => ((mode = 'update'), (payload = row), q),
      upsert: (row: Row) => ((mode = 'upsert'), (payload = row), q),
      delete: () => ((mode = 'delete'), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
      lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      like: (c: string, pat: string) => {
        const re = new RegExp(`^${pat.replace(/%/g, '.*')}$`)
        filters.push((r) => re.test(String(r[c] ?? '')))
        return q
      },
      not: (c: string, op: string, v: unknown) => {
        if (op === 'is' && v === null) filters.push((r) => r[c] != null)
        return q
      },
      order: () => q,
      limit: (n: number) => ((max = n), q),
      maybeSingle: () => Promise.resolve({ ...run(), data: (run().data as Row[] | null)?.[0] ?? null }),
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

const NOW = new Date('2026-10-21T12:00:00.000Z')
const trip = (slug: string, extra: Partial<TripSocialPackage> = {}): TripSocialPackage & Row => ({
  slug,
  name: `Trip ${slug}`,
  status: 'published',
  price_display: 'From $2,499',
  price_value: 2499,
  available_from: '2027-03-01',
  available_to: '2027-03-08',
  departure_dates: null,
  recap_mode: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...extra,
})
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

// ---- setting: exact 'true' only ----
check("only the exact text 'true' turns it on", parseTripSocial('true') && !parseTripSocial('TRUE') && !parseTripSocial('on') && !parseTripSocial('1') && !parseTripSocial('') && !parseTripSocial(null) && !parseTripSocial(undefined))

// ---- price and dates ----
check('a numeric price counts', hasTripPrice({ price_value: 1999, price_display: '' }))
check('price text with a digit counts', hasTripPrice({ price_value: null, price_display: 'From $2,499' }))
check('no price, empty text and "on request" do not count', !hasTripPrice({ price_value: null, price_display: '' }) && !hasTripPrice({ price_value: 0, price_display: 'Price on request' }) && !hasTripPrice({}))
check('a date window counts', hasTripDates({ available_from: '2027-01-01' }))
check('departure dates count', hasTripDates({ departure_dates: ['2027-02-01'] }))
check('no dates does not count', !hasTripDates({ available_from: null, available_to: null, departure_dates: [] }) && !hasTripDates({ departure_dates: ['  '] }))
check('a complete live trip has no blockers', tripBlockers(trip('a'), '2026-10-21').length === 0)
check('missing price is a blocker', tripBlockers(trip('a', { price_value: null, price_display: '' }), '2026-10-21').some((b) => /price/.test(b)))
check('missing dates is a blocker', tripBlockers(trip('a', { available_from: null, available_to: null }), '2026-10-21').some((b) => /dates/.test(b)))
check('a draft is a blocker', tripBlockers(trip('a', { status: 'draft' }), '2026-10-21').length > 0)
check('a past trip is a blocker', tripBlockers(trip('a', { available_to: '2026-01-01' }), '2026-10-21').length > 0)

// ---- picker ----
check('picks nothing from an empty list', pickTripToPost([], [], NOW) === null)
check('skips trips with no price or no dates', pickTripToPost([trip('a', { price_value: null, price_display: null }), trip('b', { available_from: null, available_to: null })], [], NOW) === null)
check('never-posted comes before posted', pickTripToPost([trip('old'), trip('new')], [{ slug: 'package-old', stage: 'done', created_at: daysAgo(40) }], NOW)?.slug === 'new')
check('a trip posted 10 days ago is not picked (30 day rule)', pickTripToPost([trip('a')], [{ slug: 'package-a', stage: 'done', created_at: daysAgo(10) }], NOW) === null)
check('a trip posted 31 days ago is picked again', pickTripToPost([trip('a')], [{ slug: 'package-a', stage: 'done', created_at: daysAgo(31) }], NOW)?.slug === 'a')
check('an old row that is not done (held or queued) blocks a second post', pickTripToPost([trip('a')], [{ slug: 'package-a', stage: 'held', created_at: daysAgo(60) }], NOW) === null)
check('the pick is stable: older trip first, then slug', pickTripToPost([trip('z', { created_at: '2026-03-01T00:00:00.000Z' }), trip('y', { created_at: '2026-02-01T00:00:00.000Z' })], [], NOW)?.slug === 'y')

// ---- release rule ----
check('a fresh Auto-hold row is not releasable', !isReleasableTripRow({ last_error: 'Auto-hold: x', created_at: daysAgo(0.5) }, NOW))
check('an Auto-hold row past the hold is releasable', isReleasableTripRow({ last_error: 'Auto-hold: x', created_at: daysAgo(1.1) }, NOW))
check('a row held by hand (no note) is never auto-released', !isReleasableTripRow({ last_error: null, created_at: daysAgo(30) }, NOW))
check('the hold is 24 hours', TRIP_HOLD_HOURS === 24)

async function main() {
  const setting = (db: Db, v: string | null) => {
    db.tables.app_settings = [{ key: 'distribution_mode', value: 'auto' }, ...(v === null ? [] : [{ key: 'trip_social_posts', value: v }])]
  }
  const ledger = (db: Db) => (db.tables.post_distribution ?? []).filter((r) => String(r.slug).startsWith('package-'))

  // setting off or unset: nothing is enrolled
  for (const v of [null, 'false', 'on', 'TRUE']) {
    const db: Db = { tables: { travel_packages: [trip('a')], post_distribution: [] } }
    setting(db, v)
    const note = await runTripSocialEnrol(fakeAdmin(db), 'auto', NOW)
    check(`setting ${JSON.stringify(v)} enrols nothing`, note === '' && ledger(db).length === 0)
  }

  // on + auto: one trip enrolled held with an Auto-hold note, not queued
  {
    const db: Db = { tables: { travel_packages: [trip('a'), trip('b')], post_distribution: [] } }
    setting(db, 'true')
    const note = await runTripSocialEnrol(fakeAdmin(db), 'auto', NOW)
    const rows = ledger(db)
    check('on in auto mode enrols exactly one trip', rows.length === 1 && note.startsWith('trip post enrolled'))
    check('it is held (not queued) with the Auto-hold note', rows[0]?.stage === 'held' && String(rows[0]?.last_error).startsWith('Auto-hold:'))
    check('its path is the trip page', rows[0]?.path === '/packages/a')
    // the per-day limit (shared with manual promotion) stops a second one the same day
    const again = await runTripSocialEnrol(fakeAdmin(db), 'auto', NOW)
    check('a second pass the same day enrols nothing more', again === '' && ledger(db).length === 1)
  }

  // trips with no price or dates are never enrolled
  {
    const db: Db = { tables: { travel_packages: [trip('a', { price_value: null, price_display: '' }), trip('b', { available_from: null, available_to: null })], post_distribution: [] } }
    setting(db, 'true')
    check('incomplete trips are never enrolled', (await runTripSocialEnrol(fakeAdmin(db), 'auto', NOW)) === '' && ledger(db).length === 0)
  }

  // weekly cap
  {
    const recent = Array.from({ length: TRIP_ENROLMENTS_PER_WEEK }, (_, i) => ({ slug: `package-x${i}`, path: `/packages/x${i}`, stage: 'done', created_at: daysAgo(2 + i), updated_at: daysAgo(2 + i), content_type: 'post' }))
    const db: Db = { tables: { travel_packages: [trip('a')], post_distribution: recent } }
    setting(db, 'true')
    check('the weekly cap stops a new enrolment', (await runTripSocialEnrol(fakeAdmin(db), 'auto', NOW)) === '' && ledger(db).length === TRIP_ENROLMENTS_PER_WEEK)
  }

  // prepare mode: held, no note (a human releases it)
  {
    const db: Db = { tables: { travel_packages: [trip('a')], post_distribution: [] } }
    setting(db, 'true')
    db.tables.app_settings[0].value = 'prepare'
    await runTripSocialEnrol(fakeAdmin(db), 'prepare', NOW)
    const r = ledger(db)[0]
    check('prepare mode holds the row with no auto-release note', r?.stage === 'held' && !r?.last_error)
  }

  // mode off: nothing
  {
    const db: Db = { tables: { travel_packages: [trip('a')], post_distribution: [] } }
    setting(db, 'true')
    check('mode off enrols nothing', (await runTripSocialEnrol(fakeAdmin(db), 'off', NOW)) === '' && ledger(db).length === 0)
  }

  // release
  const held = (slug: string, created: string, err: string | null = 'Auto-hold: x') => ({ content_type: 'post', slug: `package-${slug}`, path: `/packages/${slug}`, stage: 'held', created_at: created, updated_at: created, last_error: err })
  {
    const db: Db = { tables: { travel_packages: [trip('a')], post_distribution: [held('a', daysAgo(0.5))] } }
    setting(db, 'true')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'auto', now: NOW })
    check('a row inside the 24 hour hold is not released', r.released === 0 && ledger(db)[0].stage === 'held')
  }
  {
    const db: Db = { tables: { travel_packages: [trip('a', { short_description: 'A week in the sun.', meta_description: 'A week of sun and sea on a hosted group trip.' })], post_distribution: [held('a', daysAgo(1.5))] } }
    setting(db, 'true')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'auto', now: NOW })
    check('a row past the hold with a complete live trip is released to queued', r.released === 1 && ledger(db)[0].stage === 'queued' && ledger(db)[0].last_error === null)
  }
  {
    const db: Db = { tables: { travel_packages: [trip('a', { price_value: null, price_display: '', meta_description: 'A week of sun and sea.' })], post_distribution: [held('a', daysAgo(2))] } }
    setting(db, 'true')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'auto', now: NOW })
    check('a price removed during the hold blocks the release', r.released === 0 && r.stillHeld === 1 && ledger(db)[0].stage === 'held' && /price/.test(String(ledger(db)[0].last_error)))
  }
  {
    const db: Db = { tables: { travel_packages: [trip('a', { meta_description: 'The award-winning trip ever.' })], post_distribution: [held('a', daysAgo(2))] } }
    setting(db, 'true')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'auto', now: NOW })
    check('a caption with a superlative stays held', r.released === 0 && ledger(db)[0].stage === 'held')
  }
  {
    const db: Db = { tables: { travel_packages: [trip('a', { meta_description: 'A week of sun and sea.' })], post_distribution: [held('a', daysAgo(2), null)] } }
    setting(db, 'true')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'auto', now: NOW })
    check('a row held by hand is left alone', r.released === 0 && ledger(db)[0].stage === 'held')
  }
  {
    const db: Db = { tables: { travel_packages: [trip('a', { meta_description: 'A week of sun and sea.' })], post_distribution: [held('a', daysAgo(2))] } }
    setting(db, 'true')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'prepare', now: NOW })
    check('prepare mode never auto-releases', r.released === 0 && ledger(db)[0].stage === 'held')
  }
  {
    const db: Db = { tables: { travel_packages: [trip('a', { meta_description: 'A week of sun and sea.' })], post_distribution: [held('a', daysAgo(2))] } }
    setting(db, 'false')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'auto', now: NOW })
    check('setting off never releases', r.released === 0 && ledger(db)[0].stage === 'held')
  }
  {
    const doneToday = { content_type: 'post', slug: 'package-z', path: '/packages/z', stage: 'done', created_at: daysAgo(3), updated_at: NOW.toISOString(), last_error: null }
    const db: Db = { tables: { travel_packages: [trip('a', { meta_description: 'A week of sun and sea.' })], post_distribution: [held('a', daysAgo(2)), doneToday] } }
    setting(db, 'true')
    const r = await releaseHeldTrips(fakeAdmin(db), { mode: 'auto', now: NOW })
    check('the daily limit stops a release when a trip post already went today', r.released === 0)
  }

  // ---- source scan: no phone numbers, no long dashes, wired into the posting pass ----
  const src = readFileSync(join(__dirname, '..', 'lib', 'trip-social.ts'), 'utf8')
  const dash = String.fromCharCode(8212)
  check('trip-social.ts has no long dash', !src.includes(dash) && !src.includes(String.fromCharCode(8211)))
  check('trip-social.ts has no phone-like number', !/\+?\d[\d\s().-]{8,}\d/.test(src.replace(/\d{4}-\d{2}-\d{2}/g, '')))
  const dist = readFileSync(join(__dirname, '..', 'lib', 'distribution.ts'), 'utf8')
  check('the posting pass calls the trip release and enrol steps', /releaseHeldTrips\(admin/.test(dist) && /runTripSocialEnrol\(admin/.test(dist))
  const card = readFileSync(join(__dirname, '..', 'components', 'admin', 'posting-card.tsx'), 'utf8')
  check('the admin card has the toggle, with no long dash in its copy', card.includes('tripSocialPosts') && !/Post about our trips[^\n]*—/.test(card))

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
}
main()
