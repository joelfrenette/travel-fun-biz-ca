// Offline check for WP8 (lib/conversion-rank.ts, lib/flywheel/steps/promote-pick.ts and the three ordering functions it feeds):
// the bounded conversion tie-break, the happy path, the daily cap, the kill switch, dry run, error isolation and Undo.
// In-memory fakes only: no network, no real database, no model call.
// Run: pnpm dlx tsx scripts/check-promote-pick.ts   (exits 1 on any failed expectation)
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { DECISIONS_KEY, parseDecisions, policyKey, undoAutoDecision, POLICY_CAPS } from '../lib/auto-decisions'
import { rankByGsc } from '../lib/blog-topics'
import { buildSignal, destinationTier, EMPTY_SIGNAL, MAX_TIER, setCachedSignal, tierOf, topicTier } from '../lib/conversion-rank'
import { runFlywheelSteps } from '../lib/flywheel/registry'
import { promotePickStep, runPromotePick, undoPromotePick, type PromotePickDeps } from '../lib/flywheel/steps/promote-pick'
import type { FlywheelContext } from '../lib/flywheel/types'
import { orderPlannedPlaces, PLANNED_PLACES } from '../lib/guide-plan'
import { orderTripsByConversion, type PromotionPackage } from '../lib/promotion'
import type { TripLedgerRow, TripSocialPackage } from '../lib/trip-social'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

type Row = Record<string, unknown>
/** A tiny fake of app_settings and post_distribution with the chained calls these files use. */
function fakeAdmin(seed: Record<string, string> = {}, ledger: Row[] = []): { admin: SupabaseClient; store: Map<string, string>; ledger: Row[] } {
  const store = new Map<string, string>(Object.entries(seed))
  const query = (table: string, rows: Row[], op: 'select' | 'update' | 'delete', patch?: Row) => {
    const filters: ((r: Row) => boolean)[] = []
    const q: Record<string, unknown> = {
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
      maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (op === 'update') for (const r of hit) Object.assign(r, patch)
        if (op === 'delete') for (const r of hit) rows.splice(rows.indexOf(r), 1)
        resolve({ data: hit, error: null })
      },
    }
    void table
    return q
  }
  const admin = {
    from(table: string) {
      if (table === 'app_settings') {
        return {
          select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }) }) }),
          upsert: async (row: { key: string; value: string }) => (store.set(row.key, row.value), { error: null }),
        }
      }
      if (table === 'post_distribution') {
        return {
          select: () => query(table, ledger, 'select'),
          update: (patch: Row) => query(table, ledger, 'update', patch),
          delete: () => query(table, ledger, 'delete'),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as unknown as SupabaseClient
  return { admin, store, ledger }
}

const NOW = new Date('2026-10-24T15:00:00.000Z')
const ON = { trip_social_posts: 'true', distribution_mode: 'auto' }
const trip = (slug: string, over: Partial<TripSocialPackage> = {}): TripSocialPackage => ({ slug, name: `Trip ${slug}`, status: 'published', price_display: 'From $2,499', available_from: '2027-03-01', available_to: '2027-03-10', created_at: '2026-01-01T00:00:00Z', ...over })
const hotSignal = (slug: string) => buildSignal({ leads: [{ page_path: `/packages/${slug}`, status: 'new' }, { page_path: `/packages/${slug}`, status: 'booked' }], orders: [], packages: [{ slug, destination: 'Italy' }] })

interface Fake {
  trips: TripSocialPackage[]
  ledger: TripLedgerRow[]
  week: number | null
  signal: ConversionSignal2
  enrolled: string[]
  enrolState: 'queued' | 'held' | 'waiting'
  throwOnEnrol?: boolean
}
type ConversionSignal2 = ReturnType<typeof buildSignal>
function deps(f: Fake): PromotePickDeps {
  return {
    loadTrips: async () => f.trips,
    loadLedger: async () => f.ledger,
    countWeek: async () => f.week,
    loadSignal: async () => f.signal,
    enrol: async (_a, pkg: Pick<PromotionPackage, 'slug' | 'name' | 'status' | 'available_to' | 'recap_mode'>) => {
      if (f.throwOnEnrol) throw new Error('boom')
      f.enrolled.push(pkg.slug)
      return { slug: `package-${pkg.slug}`, path: `/packages/${pkg.slug}`, state: f.enrolState, note: f.enrolState === 'waiting' ? 'used today' : 'ok' }
    },
  }
}
const ctx = (admin: SupabaseClient, over: Partial<FlywheelContext> = {}): FlywheelContext => ({ admin, now: NOW, startedAt: 0, budgetMs: 200_000, dryRun: false, remainingMs: () => 200_000, room: 1, ...over })
const fresh = (over: Partial<Fake> = {}): Fake => ({ trips: [trip('a-plain'), trip('b-hot')], ledger: [], week: 0, signal: hotSignal('b-hot'), enrolled: [], enrolState: 'queued', ...over })

async function main(): Promise<void> {
  // ---- pure scoring ------------------------------------------------------------------------------------------------
  check('tier: under the noise floor is 0', tierOf(2) === 0 && tierOf(0) === 0)
  check('tier: at the floor is 1, and it never passes the maximum', tierOf(3) === 1 && tierOf(6) === 2 && tierOf(9999) === MAX_TIER)
  const sig = buildSignal({
    leads: [
      { page_path: '/packages/italy-trip', status: 'new' },
      { page_path: 'https://x.ca/packages/italy-trip/?utm=1', status: 'booked' },
      { page_path: '/packages/italy-trip', status: 'lost' },
      { page_path: '/packages/other', status: 'new' },
      { page_path: null, status: 'booked' },
    ],
    orders: [{ package_slug: 'italy-trip' }, { package_slug: null }],
    packages: [{ slug: 'italy-trip', destination: 'Italy' }, { slug: 'other', destination: 'Peru' }],
  })
  check('signal: leads 1, booked 3, lost 0, paid order 5 (1 + 3 + 0 + 5 = 9)', sig.byPath['/packages/italy-trip'] === 9, JSON.stringify(sig.byPath))
  check('signal: a single plain lead stays under the floor', tierOf(sig.byPath['/packages/other']) === 0)
  check('signal: destinations are summed from their trips', sig.byDestination['italy'] === 9 && tierOf(sig.byDestination['peru'] ?? 0) === 0)
  check('empty signal changes nothing', topicTier(EMPTY_SIGNAL, { keyword: 'italy tours' }) === 0 && destinationTier(EMPTY_SIGNAL, ['italy']) === 0)
  check('topic tier follows a destination named in the keyword set', topicTier(sig, { keyword: 'best time to visit italy', keywords: [] }) === 3 && topicTier(sig, { keyword: 'greece tours' }) === 0)
  check('topic tier matches whole words only', topicTier(sig, { keyword: 'vitality retreat' }) === 0)

  // ---- topic ordering: tie-break only, never across Search Console groups --------------------------------------------------
  const ideas = [{ keyword: 'greece tours' }, { keyword: 'italy tours' }, { keyword: 'peru tours' }]
  check('rankByGsc: no signal, no rows: unchanged', rankByGsc(ideas, []).map((i) => i.keyword).join() === 'greece tours,italy tours,peru tours')
  check('rankByGsc: with no Search Console data the converting topic comes first', rankByGsc(ideas, [], sig)[0].keyword === 'italy tours')
  const gsc = [{ key: 'greece tours', position: 12, impressions: 50 }, { key: 'italy tours', position: 3, impressions: 900 }]
  const ranked = rankByGsc(ideas, gsc, sig).map((i) => i.keyword).join()
  check('rankByGsc: a conversion tier never lifts a topic over a better Search Console group', ranked.startsWith('greece tours'), ranked)

  // ---- guide ordering: only inside one rank, only with data ---------------------------------------------------------------
  const plain = orderPlannedPlaces(new Set(), PLANNED_PLACES, EMPTY_SIGNAL).map((p) => p.slug).join()
  check('guide order: empty signal equals the old order', orderPlannedPlaces(new Set()).map((p) => p.slug).join() === plain)
  const countries = PLANNED_PLACES.filter((p) => p.scope === 'country')
  if (countries.length >= 2) {
    const last = countries[countries.length - 1]
    const s = buildSignal({ leads: [], orders: [{ package_slug: 'p1' }, { package_slug: 'p1' }], packages: [{ slug: 'p1', destination: last.name }] })
    const order = orderPlannedPlaces(new Set(), PLANNED_PLACES, s)
    const firstNonCountry = order.findIndex((p) => p.scope !== 'country')
    check('guide order: a converting country moves up inside the country rank', order[0].slug === last.slug, order[0].slug)
    check('guide order: countries still come before cities', order.slice(0, countries.length).every((p) => p.scope === 'country') && firstNonCountry === countries.length)
  }
  setCachedSignal(EMPTY_SIGNAL)

  // ---- trip order ---------------------------------------------------------------------------------------------------
  const tripsOrdered = orderTripsByConversion([trip('a-plain'), trip('b-hot')], () => -1, hotSignal('b-hot')).map((t) => t.slug).join()
  check('trip order: a converting never-posted trip first', tripsOrdered === 'b-hot,a-plain', tripsOrdered)
  const posted = orderTripsByConversion([trip('a-plain'), trip('b-hot')], (s) => (s === 'b-hot' ? 5 : -1), hotSignal('b-hot')).map((t) => t.slug).join()
  check('trip order: a never-posted trip still beats a posted one (rotation kept)', posted === 'a-plain,b-hot', posted)
  check('trip order: no signal keeps the plain rotation', orderTripsByConversion([trip('b'), trip('a')], () => -1, EMPTY_SIGNAL).map((t) => t.slug).join() === 'a,b')

  // ---- the step: happy path ------------------------------------------------------------------------------------------------
  {
    const f = fresh()
    const { admin, store } = fakeAdmin(ON)
    const r = await runPromotePick(ctx(admin), deps(f))
    check('step: picks the converting trip and enrols exactly one', r.ran === true && r.acted === 1 && f.enrolled.join() === 'b-hot', JSON.stringify(r))
    const log = parseDecisions(store.get(DECISIONS_KEY) ?? null)
    const line = log.find((d) => d.policy === 'promote_pick')
    check('step: writes one decision line with a reason and an fw:promote_pick Undo', !!line && line.subject === 'b-hot' && line.undo?.kind === 'fw:promote_pick' && line.undo.ref === 'package-b-hot|new' && /conversion score/.test(line.reason), JSON.stringify(line))
    check('step: the log line holds no email, phone or price', !!line && !/@|\$|\d{3}[- ]\d{4}/.test(`${line.action} ${line.reason}`), line ? `${line.action} ${line.reason}` : '')
  }

  // ---- no data, switches, caps -----------------------------------------------------------------------------------------------
  {
    const f = fresh({ signal: EMPTY_SIGNAL })
    const r = await runPromotePick(ctx(fakeAdmin(ON).admin), deps(f))
    check('step: no conversion data leaves the choice to the normal rotation', r.ran === false && f.enrolled.length === 0, JSON.stringify(r))
  }
  {
    const f = fresh({ signal: buildSignal({ leads: [{ page_path: '/packages/b-hot', status: 'new' }], orders: [], packages: [] }) })
    const r = await runPromotePick(ctx(fakeAdmin(ON).admin), deps(f))
    check('step: one lone lead is under the sample floor and moves nothing', r.ran === false && f.enrolled.length === 0)
  }
  {
    const f = fresh()
    const r = await runPromotePick(ctx(fakeAdmin({ distribution_mode: 'auto' }).admin), deps(f))
    check('step: never turns trip social posts on (setting unset = off)', r.ran === false && f.enrolled.length === 0)
    const r2 = await runPromotePick(ctx(fakeAdmin({ trip_social_posts: 'true', distribution_mode: 'off' }).admin), deps(f))
    check('step: social posting off means no pick', r2.ran === false && f.enrolled.length === 0)
  }
  {
    const f = fresh({ trips: [trip('a-plain'), trip('b-hot', { status: 'draft' })] })
    const r = await runPromotePick(ctx(fakeAdmin(ON).admin), deps(f))
    check('step: a draft trip is never picked', f.enrolled.length === 0 && r.ran === false)
    const f2 = fresh({ trips: [trip('b-hot', { price_display: null, price_value: null })] })
    await runPromotePick(ctx(fakeAdmin(ON).admin), deps(f2))
    check('step: a trip with no price is never picked (nothing is invented)', f2.enrolled.length === 0)
  }
  {
    const f = fresh({ ledger: [{ slug: 'package-b-hot', stage: 'done', created_at: '2026-10-20T00:00:00Z' }] })
    await runPromotePick(ctx(fakeAdmin(ON).admin), deps(f))
    check('step: the 30-day rule per trip is respected', f.enrolled.length === 0)
  }
  {
    const f = fresh({ week: 2 })
    const r = await runPromotePick(ctx(fakeAdmin(ON).admin), deps(f))
    check('step: the weekly trip-post limit is respected', r.ran === false && f.enrolled.length === 0)
    const f2 = fresh({ week: null })
    await runPromotePick(ctx(fakeAdmin(ON).admin), deps(f2))
    check('step: an unreadable weekly count fails closed', f2.enrolled.length === 0)
  }
  {
    const f = fresh({ enrolState: 'waiting' })
    const { admin, store } = fakeAdmin(ON)
    const r = await runPromotePick(ctx(admin), deps(f))
    check('step: when the one-a-day enrolment is already used nothing is logged', r.ran === false && !store.get(DECISIONS_KEY))
  }
  {
    const f = fresh()
    const r = await runPromotePick(ctx(fakeAdmin(ON).admin, { room: 0 }), deps(f))
    check('step: no room left today means no action', r.ran === false && f.enrolled.length === 0)
  }
  {
    const f = fresh()
    const r = await runPromotePick(ctx(fakeAdmin({ ...ON, [AUTOMATION_PAUSED_KEY]: 'true' }).admin), deps(f))
    check('step: pause-all stops it', r.ran === false && f.enrolled.length === 0, JSON.stringify(r))
  }
  {
    const f = fresh()
    const r = await runPromotePick(ctx(fakeAdmin(ON).admin, { dryRun: true }), deps(f))
    check('step: dry run writes and enrols nothing', r.ran === false && f.enrolled.length === 0)
  }

  // ---- through the registry runner: cap, kill switch, switch, error isolation ---------------------------------------------------------
  const wrapped = (f: Fake) => ({ ...promotePickStep, run: (c: FlywheelContext) => runPromotePick(c, deps(f)) })
  check('policy: the daily cap is 1', POLICY_CAPS.promote_pick === 1)
  {
    const f = fresh()
    const { admin } = fakeAdmin(ON)
    const run = (n: number) => runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [wrapped(n === 0 ? f : f)])
    const r1 = await run(0)
    const r2 = await run(1)
    check('registry: first pass acts, second pass the same day is stopped by the cap', r1.outcomes[0].status === 'ran' && r2.outcomes[0].status === 'skipped' && f.enrolled.length === 1, JSON.stringify([r1.outcomes[0], r2.outcomes[0]]))
  }
  {
    const f = fresh()
    const { admin } = fakeAdmin({ ...ON, [policyKey('promote_pick')]: 'off' })
    const r = await runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [wrapped(f)])
    check('registry: its own switch off stops it', r.outcomes[0].status === 'skipped' && f.enrolled.length === 0)
    const { admin: a2 } = fakeAdmin({ ...ON, [AUTOMATION_PAUSED_KEY]: 'true' })
    const r2 = await runFlywheelSteps({ admin: a2, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [wrapped(f)])
    check('registry: the kill switch stops it', r2.outcomes[0].status !== 'ran' && f.enrolled.length === 0)
  }
  {
    const f = fresh({ throwOnEnrol: true })
    const { admin } = fakeAdmin(ON)
    const later = { id: 'later', policy: 'booked_sync' as const, label: 'later', order: 90, floorMs: 0, run: async () => ({ ran: true as const }) }
    const r = await runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000 }, [wrapped(f), later])
    check('registry: an error in this step is isolated and the next step still runs', r.outcomes[0].status === 'error' && r.outcomes[1].status === 'ran', JSON.stringify(r.outcomes.map((o) => o.status)))
  }
  {
    const f = fresh()
    const { admin, store } = fakeAdmin(ON)
    const r = await runFlywheelSteps({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, dryRun: true }, [wrapped(f)])
    check('registry: a dry run skips the step and logs nothing', r.outcomes[0].status === 'skipped' && f.enrolled.length === 0 && !store.get(DECISIONS_KEY))
  }

  // ---- Undo -------------------------------------------------------------------------------------------------------------------------------
  {
    const { admin } = fakeAdmin({}, [{ content_type: 'post', slug: 'package-b-hot', stage: 'held', sent_platforms: [] }])
    const u = await undoPromotePick(admin, 'package-b-hot|new')
    check('undo: a queued pick is removed from the list', u.ok === true)
    const again = await undoPromotePick(admin, 'package-b-hot|new')
    check('undo: a second undo says it is gone', again.ok === false)
  }
  {
    const { admin, ledger } = fakeAdmin({}, [{ content_type: 'post', slug: 'package-b-hot', stage: 'queued', sent_platforms: [] }])
    const u = await undoPromotePick(admin, 'package-b-hot|renewed')
    check('undo: an old finished post that was restarted goes back to finished, not deleted', u.ok === true && ledger[0]?.stage === 'done')
  }
  {
    const { admin, ledger } = fakeAdmin({}, [{ content_type: 'post', slug: 'package-b-hot', stage: 'queued', sent_platforms: ['facebook'] }])
    const u = await undoPromotePick(admin, 'package-b-hot|new')
    check('undo: a post that already reached a network is left alone', u.ok === false && ledger.length === 1)
    const bad = await undoPromotePick(admin, '../../etc|new')
    check('undo: a bad reference is refused', bad.ok === false)
  }
  {
    // End to end: the step logs, the Autopilot decisions Undo hands the ref to the step and adds the trip to the veto list.
    const f = fresh()
    const { admin, store, ledger } = fakeAdmin(ON, [{ content_type: 'post', slug: 'package-b-hot', stage: 'held', sent_platforms: [] }])
    await runPromotePick(ctx(admin), deps(f))
    const entry = parseDecisions(store.get(DECISIONS_KEY) ?? null).find((d) => d.policy === 'promote_pick')!
    const u = await undoAutoDecision(admin, entry)
    check('undo: the decisions Undo button works end to end and removes the post', u.ok === true && ledger.length === 0, JSON.stringify(u))
    const f2 = fresh()
    await runPromotePick(ctx(admin, { now: new Date(NOW.getTime() + 86_400_000) }), deps(f2))
    check('undo: the undone trip is vetoed and never picked automatically again', f2.enrolled.join() !== 'b-hot', f2.enrolled.join())
  }

  console.log(failed === 0 ? '\n0 failed' : `\n${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
