// Offline self-check for WP16 (pages backfill, scope labels, admin list, internal links, richer template).
// No network, no database, no AI call: the "database" is a tiny in-memory fake and fetch is replaced by a counter that
// must stay at zero. Run: pnpm dlx tsx scripts/check-guide-pages.ts
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GUIDE_SCOPES, SCOPE_LABEL, groupChildren, inferScope, parentChain, parseScope, resolveParent, scopeOf, type ScopeNode } from '../lib/guide-scope'
import {
  BACKFILL_DEFAULT_BATCH,
  BACKFILL_EXTRA_PER_DAY,
  BACKFILL_HARD_MAX,
  backfillProgress,
  clampBatchCap,
  effectiveGuideCaps,
  estimateBackfill,
  looksLikeTripTitle,
  parseBackfillState,
  planBackfill,
  type BackfillState,
} from '../lib/guide-backfill'
import { bulkPublishable, inReviewQueue, parseListQuery, queryGuideRows, wordCountOf, MODE_HOLD_NOTE, type GuideListRow } from '../lib/guide-list'
import { findOrphans, inboundCounts, inboundSources, type AuditGuide, type AuditPost, type AuditTrip } from '../lib/guide-orphans'
import { validateGuideEdit } from '../lib/guide-edit'
import { buildKeyFacts, dateRangeText, itineraryStops, pickRoute, telHref, tripBullets, tripLengthBars, type TripFact } from '../lib/guide-facts'
import { heroSrcSet } from '../lib/guide-images'
import {
  GUIDE_KINDS,
  childGroups,
  guideTrail,
  isMissingScopeColumn,
  listGuideCandidates,
  pickGuidesForPackage,
  pickPostsForGuide,
  pickTopDestinationGuides,
  type GuideCandidate,
  type GuideLink,
} from '../lib/guides'
import { buildBackfillPlan, capsForCandidate, isGuessedProperty, pickNextCandidate, publishDecision, runGuidesStep } from '../lib/guide-run'
import { cruiseAndResortLinks, primaryNavLinks } from '../content/navigation'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

// Any attempt to reach the network (and so any AI call) is counted. It must stay at zero.
let networkCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  networkCalls++
  throw new Error('network is off in this check')
}) as typeof fetch
process.env.ANTHROPIC_API_KEY = 'test-key-never-used'

// ---------------------------------------------------------------------------------------------------
// A tiny in-memory stand-in for the Supabase admin client (just enough chain for the readers under test).
// ---------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>
function fakeAdmin(tables: Record<string, Row[]>) {
  const writes: { table: string; op: string }[] = []
  const admin = {
    from(table: string) {
      const filters: [string, unknown][] = []
      let single = false
      const builder: Record<string, unknown> = {}
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v))
        if (single) rows = rows.slice(0, 1)
        return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length }
      }
      const self = {
        select: () => self,
        eq: (k: string, v: unknown) => (filters.push([k, v]), self),
        order: () => self,
        in: () => self,
        gte: () => self,
        limit: () => self,
        maybeSingle: () => ((single = true), Promise.resolve(run())),
        upsert: () => (writes.push({ table, op: 'upsert' }), Promise.resolve({ error: null })),
        update: () => (writes.push({ table, op: 'update' }), self),
        insert: () => (writes.push({ table, op: 'insert' }), Promise.resolve({ error: null })),
        delete: () => (writes.push({ table, op: 'delete' }), self),
        then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
      }
      void builder
      return self
    },
  }
  return { admin: admin as never, writes }
}

// ---------------------------------------------------------------------------------------------------
// 1. Scope parsing, inference and parent chains
// ---------------------------------------------------------------------------------------------------
console.log('--- scope labels')
check('nine scopes exist', GUIDE_SCOPES.length === 9 && GUIDE_SCOPES.every((s) => !!SCOPE_LABEL[s]))
check('parseScope accepts a real scope and rejects junk', parseScope('port') === 'port' && parseScope('Port') === null && parseScope('') === null && parseScope(5) === null && parseScope(null) === null)
check('Italy is a country', inferScope('destinations', 'Italy') === 'country')
check('Caribbean is a region', inferScope('destinations', 'Caribbean') === 'region')
check('Nassau is a port', inferScope('destinations', 'Nassau') === 'port')
check('an unknown place is NOT guessed (null)', inferScope('destinations', 'Punta Cana') === null)
check('Sandals Resorts is a supplier', inferScope('resorts', 'Sandals Resorts') === 'supplier')
check('a named resort is a property', inferScope('resorts', 'Sandals Royal Bahamian') === 'property')
check('a hotel is a property', inferScope('hotels', 'Fairmont Banff Springs') === 'property')
check('a cruise line is a line', inferScope('cruise-lines', 'Celebrity Cruises') === 'line')
check('a ship is a ship, a class is a class', inferScope('ships', 'Celebrity Edge') === 'ship' && inferScope('ships', 'Edge Class') === 'class')
check('river cruises and yachts are not guessed', inferScope('river-cruises', 'Viking') === null && inferScope('yachts', 'Star Clippers') === null)
check('a stored scope wins over the inferred one', scopeOf({ kind: 'destinations', name: 'Italy', scope: 'region' }) === 'region' && scopeOf({ kind: 'destinations', name: 'Italy', scope: null }) === 'country')

const node = (kind: string, slug: string, parent: string | null, name = slug): ScopeNode => ({ kind, slug, name, parent_slug: parent })
const geo: ScopeNode[] = [node('destinations', 'italy', null), node('destinations', 'rome', 'italy'), node('destinations', 'civitavecchia', 'rome'), node('hotels', 'hotel-x', 'rome'), node('ships', 'edge', 'celebrity-cruises'), node('cruise-lines', 'celebrity-cruises', null)]
check('chain: port under city under country, outermost first', parentChain(geo[2], geo).map((n) => n.slug).join('>') === 'italy>rome')
check('chain: a hotel resolves its destination parent', parentChain(geo[3], geo).map((n) => n.slug).join('>') === 'italy>rome')
check('chain: a ship resolves its cruise line (another kind)', parentChain(geo[4], geo).map((n) => n.slug).join('>') === 'celebrity-cruises')
check('chain: a missing parent ends the chain', parentChain(node('hotels', 'h', 'nowhere'), geo).length === 0)
const loop: ScopeNode[] = [node('destinations', 'a', 'b'), node('destinations', 'b', 'a')]
check('chain: a loop cannot hang (a -> b -> a)', parentChain(loop[0], loop).length === 1)
check('chain: a page that is its own parent cannot hang', parentChain(node('destinations', 'self', 'self'), [node('destinations', 'self', 'self')]).length === 0)
const deep: ScopeNode[] = Array.from({ length: 10 }, (_, i) => node('destinations', `p${i}`, i < 9 ? `p${i + 1}` : null))
check('chain: depth is capped at four', parentChain(deep[0], deep).length === 4)
check('resolveParent prefers the same kind, then a destination', resolveParent({ kind: 'resorts', parent_slug: 'rome' }, [node('hotels', 'rome', null), node('destinations', 'rome', null)])?.kind === 'destinations')
const groups = groupChildren({ kind: 'destinations', slug: 'rome' }, [...geo, { ...node('destinations', 'trastevere', 'rome'), scope: 'city' }], (k) => k)
check('children are grouped by scope label or kind', groups.length >= 1 && groups.flatMap((g) => g.items).some((i) => i.slug === 'hotel-x'))

const link = (kind: string, slug: string, parent: string | null, name = slug, ids: string[] = []): GuideLink => ({ id: `${kind}:${slug}`, kind: kind as GuideLink['kind'], slug, name, parent_slug: parent, summary: `${name}. More text.`, related_package_ids: ids })
const links = geo.map((g) => link(g.kind, g.slug, g.parent_slug))
check('trail: parents then the page', guideTrail(links[2], links).map((s) => s.name).join('>') === 'italy>rome>civitavecchia')
check('trail: no parent gives the kind index then the page', guideTrail(link('hotels', 'solo', null), links).map((s) => s.path).join(' ') === '/hotels /hotels/solo')
check('trail: a destination with trips but no guide falls back to its destinations page', guideTrail(link('hotels', 'h2', 'cancun'), links, { slug: 'cancun', name: 'Cancun' })[0].path === '/destinations/cancun')
check('trail: a fallback for another slug is ignored', guideTrail(link('hotels', 'h3', 'other'), links, { slug: 'cancun', name: 'Cancun' })[0].path === '/hotels')
check('childGroups lists what sits under a page', childGroups(links[0], links).flatMap((g) => g.items).some((i) => i.slug === 'rome'))

// ---------------------------------------------------------------------------------------------------
// 2. Backfill planning, dry run and the batch allowance
// ---------------------------------------------------------------------------------------------------
console.log('--- backfill')
const cand = (kind: GuideCandidate['kind'], name: string, origin: GuideCandidate['origin'], extra: Partial<GuideCandidate> = {}): GuideCandidate => ({ kind, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), parent_slug: null, origin, ...extra })
const candidates: GuideCandidate[] = [
  cand('hotels', 'Fairmont Banff Springs', 'package'),
  cand('destinations', 'Italy', 'destination'),
  cand('destinations', 'Punta Cana', 'destination'),
  cand('resorts', 'Singles Getaway Resort', 'package'),
  cand('ships', 'Celebrity Edge', 'package'),
  cand('cruise-lines', 'Celebrity Cruises', 'package'),
  cand('destinations', 'Iceland', 'seed'),
  cand('resorts', 'Beach Resort', 'package'),
  cand('yachts', 'Gulet Sailing Trip', 'package'),
  cand('river-cruises', 'Viking Rhine', 'package'),
  cand('destinations', 'Italy', 'destination'),
]
const plan = planBackfill(candidates, { 'ships:celebrity-edge': { n: 2 } })
const names = plan.entries.map((e) => e.name)
check('plan keeps real destinations and package-named properties', names.includes('Italy') && names.includes('Punta Cana') && names.includes('Fairmont Banff Springs') && names.includes('Celebrity Cruises') && names.includes('Viking Rhine'))
check('plan leaves out the curated seed names (that is the long tail)', !names.includes('Iceland'))
check('plan leaves out a trip title that only looks like a resort', !names.includes('Singles Getaway Resort') && plan.skipped.some((s) => s.name === 'Singles Getaway Resort' && /trip/i.test(s.reason)))
check('plan leaves out a name with nothing distinctive ("Beach Resort")', !names.includes('Beach Resort'))
check('plan leaves out "Gulet Sailing Trip" (trip word)', !names.includes('Gulet Sailing Trip'))
check('plan skips a name that already failed twice, and says why', !names.includes('Celebrity Edge') && plan.skipped.some((s) => s.name === 'Celebrity Edge' && /failed 2 times/.test(s.reason)))
check('plan has each page once', new Set(plan.entries.map((e) => `${e.kind}:${e.slug}`)).size === plan.entries.length)
check('plan order: destinations first, then cruise lines', plan.entries[0].kind === 'destinations' && plan.entries.findIndex((e) => e.kind === 'cruise-lines') > plan.entries.findIndex((e) => e.kind === 'destinations'))
check('plan counts the named-business pages', plan.namedCount === plan.entries.filter((e) => e.kind !== 'destinations').length && plan.namedCount >= 3)
check('plan sets scope where it can be told', plan.entries.find((e) => e.name === 'Italy')?.scope === 'country' && plan.entries.find((e) => e.name === 'Punta Cana')?.scope === null)
check('looksLikeTripTitle: real names pass', !looksLikeTripTitle('Sandals Royal Bahamian') && !looksLikeTripTitle('Viking Rhine'))

const est10 = estimateBackfill(10)
check('estimate is a range from per-call numbers', est10.callsMin === 20 && est10.callsMax === 40 && est10.usdMin === 1 && est10.usdMax === 2)
check('estimate for zero or junk is zero', estimateBackfill(0).usdMax === 0 && estimateBackfill(-4).guides === 0)
check('batch cap: default, clamp low, clamp high, never uncapped', clampBatchCap(undefined, 100) === BACKFILL_DEFAULT_BATCH && clampBatchCap(0, 100) === 1 && clampBatchCap(9999, 100) === BACKFILL_HARD_MAX && clampBatchCap(Infinity, 100) === BACKFILL_DEFAULT_BATCH && clampBatchCap('abc', 100) === BACKFILL_DEFAULT_BATCH)
check('batch cap never exceeds the planned pages; none planned gives 0', clampBatchCap(30, 7) === 7 && clampBatchCap(5, 0) === 0)

const state: BackfillState = { started_at: '2026-10-12T00:00:00.000Z', batch_cap: 2, cancelled_at: null, entries: plan.entries }
check('state round trip', JSON.stringify(parseBackfillState(JSON.stringify(state))?.entries.length) === JSON.stringify(plan.entries.length))
check('state: garbage, empty, bad cap and bad date are all null', parseBackfillState('not json') === null && parseBackfillState(null) === null && parseBackfillState(JSON.stringify({ ...state, batch_cap: 500 })) === null && parseBackfillState(JSON.stringify({ ...state, started_at: 'yesterday' })) === null)
check('state: entries with a bad kind are dropped', parseBackfillState(JSON.stringify({ ...state, entries: [{ kind: 'bogus', slug: 'x', name: 'X' }, ...state.entries] }))?.entries.length === plan.entries.length)
const g = (kind: string, slug: string, created: string) => ({ kind, slug, created_at: created })
const none = backfillProgress(state, [])
check('progress: nothing written, whole batch left', none.written === 0 && none.remainingBatch === 2 && none.bursting && none.waiting === plan.entries.length)
const one = backfillProgress(state, [g('destinations', 'italy', '2026-10-12T05:00:00.000Z')])
check('progress: one written, one left in the batch', one.written === 1 && one.remainingBatch === 1)
const done = backfillProgress(state, [g('destinations', 'italy', '2026-10-12T05:00:00.000Z'), g('destinations', 'punta-cana', '2026-10-12T06:00:00.000Z')])
check('progress: batch used up, allowance ends', done.written === 2 && done.remainingBatch === 0 && !done.bursting && done.waiting === plan.entries.length - 2)
check('progress: a page written before the start does not count against the batch', backfillProgress(state, [g('destinations', 'italy', '2026-10-01T00:00:00.000Z')]).written === 0)
check('progress: cancelled gives no allowance', backfillProgress({ ...state, cancelled_at: '2026-10-12T07:00:00.000Z' }, []).remainingBatch === 0)
check('progress: no state, no allowance', !backfillProgress(null, []).bursting)
check('caps: allowance is added while the batch runs', effectiveGuideCaps({ perDay: 1, perWeek: 5 }, none, 2).perDay === 1 + BACKFILL_EXTRA_PER_DAY && effectiveGuideCaps({ perDay: 1, perWeek: 5 }, none, 2).perWeek === 7)
check('caps: back to normal when the batch is used up', effectiveGuideCaps({ perDay: 1, perWeek: 5 }, done, 2).perDay === 1 && effectiveGuideCaps({ perDay: 1, perWeek: 5 }, done, 2).perWeek === 5)
check('caps: a switched-off step stays off', effectiveGuideCaps({ perDay: 0, perWeek: 5 }, none, 2).perDay === 0 && effectiveGuideCaps({ perDay: 1, perWeek: 0 }, none, 2).perWeek === 0)
check('caps: the allowance can never pass 5 a day with the default cap', effectiveGuideCaps({ perDay: 1, perWeek: 5 }, none, 40).perDay <= 5)

// The DRY RUN: real code path with a fake database, the network switched off and an AI key present.
async function dryRun() {
  const trips: Row[] = [
    { name: 'Fairmont Banff Springs Weekend', destination: 'Banff', category: 'Adventure', status: 'published' },
    { name: 'Rome Escape', destination: 'Rome', category: 'Cultural', status: 'published' },
    { name: 'Celebrity Cruises Caribbean', destination: 'Caribbean', category: 'Cruise', status: 'published' },
  ]
  const { admin, writes } = fakeAdmin({ travel_packages: trips, guides: [], app_settings: [] })
  const before = networkCalls
  const dry = await buildBackfillPlan(admin)
  check('dry run lists the destinations the trips go to', dry.entries.some((e) => e.slug === 'rome') && dry.entries.some((e) => e.slug === 'banff'))
  check('dry run lists a property the trip names', dry.entries.some((e) => e.kind === 'cruise-lines' || e.kind === 'hotels'))
  check('dry run made no AI or network call', networkCalls === before && networkCalls === 0)
  check('dry run wrote nothing', writes.length === 0)
  check('dry run gives a cost estimate for the list', estimateBackfill(dry.entries.length).usdMax > 0)

  // Candidates carry the backfill flag once a state is stored, and the pipeline picks them before the rotation.
  const stored = JSON.stringify({ ...state, entries: dry.entries, batch_cap: 2 })
  const { admin: admin2 } = fakeAdmin({ travel_packages: trips, guides: [], app_settings: [{ key: 'guide_backfill', value: stored }] })
  const cands = await listGuideCandidates(admin2)
  check('listed pages are flagged backfill', cands.filter((c) => c.backfill).length === dry.entries.length)
  check('a flagged package-named page is NOT a priority page (the WP15 rule is separate)', cands.filter((c) => c.backfill).every((c) => !c.priority))
  const next = await pickNextCandidate(admin2, cands)
  check('the next page is a backfill page, destinations first', !!next && !!next.backfill && next.kind === 'destinations')
  const unflagged = await pickNextCandidate(admin2, cands.map((c) => ({ ...c, backfill: false })))
  check('without the flag a package-named page is still never picked by the pipeline', !!unflagged && !(unflagged.origin === 'package' && !unflagged.priority))
  // A cancelled backfill flags nothing.
  const { admin: admin3 } = fakeAdmin({ travel_packages: trips, guides: [], app_settings: [{ key: 'guide_backfill', value: JSON.stringify({ ...state, entries: dry.entries, cancelled_at: '2026-10-12T08:00:00.000Z' }) }] })
  check('a cancelled backfill flags nothing', (await listGuideCandidates(admin3)).every((c) => !c.backfill))
  // A written page is not offered again.
  const { admin: admin4 } = fakeAdmin({ travel_packages: trips, guides: [{ kind: 'destinations', slug: 'rome' }], app_settings: [{ key: 'guide_backfill', value: stored }] })
  check('an already written page is not a candidate again', !(await listGuideCandidates(admin4)).some((c) => c.kind === 'destinations' && c.slug === 'rome'))
  // The pipeline step with the daily cap at zero spends nothing and stays silent.
  const { admin: admin5 } = fakeAdmin({ travel_packages: trips, guides: [], app_settings: [{ key: 'guides_per_day', value: '0' }, { key: 'guide_backfill', value: stored }] })
  const stepOff = await runGuidesStep(admin5)
  check('a switched-off guides step ignores the backfill allowance', stepOff.ok && /switched off/.test(stepOff.note) && networkCalls === 0)
}

// ---------------------------------------------------------------------------------------------------
// 3. Review queue and publish decisions
// ---------------------------------------------------------------------------------------------------
console.log('--- review queue')
for (const kind of ['hotels', 'resorts', 'ships', 'cruise-lines'] as const) {
  check(`${kind}: clean gate in publish mode goes live`, publishDecision(kind, 'publish', 'pipeline', []).publish === true)
  check(`${kind}: a blocker keeps it a draft with the reason`, !publishDecision(kind, 'publish', 'pipeline', ['superlative']).publish && /superlative/.test(publishDecision(kind, 'publish', 'pipeline', ['superlative']).note ?? ''))
  check(`${kind}: review mode holds a clean page with the mode note`, publishDecision(kind, 'draft', 'pipeline', []).note === MODE_HOLD_NOTE)
}
check('WP15 rule stays: package origin + priority is a guessed property', isGuessedProperty({ origin: 'package', priority: true }))
check('WP15 rule stays: a priority destination is not', !isGuessedProperty({ origin: 'destination', priority: true }))
check('M1: a backfilled package-named page is a guessed property (always a draft)', isGuessedProperty({ origin: 'package', priority: false, backfill: true }))
check('M1: a plain package-named page and a backfilled destination are not flagged here', !isGuessedProperty({ origin: 'package', priority: false }) && !isGuessedProperty({ origin: 'destination', backfill: true }))
check('M2: the allowance applies only to a backfill page', capsForCandidate({ perDay: 1, perWeek: 5 }, { backfill: true }, { state: { batch_cap: 5 }, progress: { remainingBatch: 5 } }).perDay === 5
  && capsForCandidate({ perDay: 1, perWeek: 5 }, { backfill: false }, { state: { batch_cap: 5 }, progress: { remainingBatch: 5 } }).perDay === 1
  && capsForCandidate({ perDay: 1, perWeek: 5 }, { backfill: undefined }, { state: { batch_cap: 5 }, progress: { remainingBatch: 5 } }).perWeek === 5
  && capsForCandidate({ perDay: 1, perWeek: 5 }, null, { state: { batch_cap: 5 }, progress: { remainingBatch: 5 } }).perDay === 1
  && capsForCandidate({ perDay: 1, perWeek: 5 }, { backfill: true }, null).perDay === 1)
{
  const st: BackfillState = { started_at: '2026-10-12T00:00:00.000Z', batch_cap: 5, cancelled_at: null, entries: plan.entries.slice(0, 3) }
  const failedKey = `${st.entries[0].kind}:${st.entries[0].slug}`
  check('M2: waiting counts only pages that can still be written (a twice-failed page does not keep the allowance alive)',
    backfillProgress(st, [], {}).waiting === 3 && backfillProgress(st, [], { [failedKey]: { n: 2 } }).waiting === 2 && backfillProgress({ ...st, entries: [st.entries[0]] }, [], { [failedKey]: { n: 2 } }).remainingBatch === 0)
}

const lr = (id: string, extra: Partial<GuideListRow> = {}): GuideListRow => ({ id, kind: 'hotels', slug: id, name: id, parent_slug: null, scope: null, status: 'draft', source: 'ai', review_state: null, quality_notes: null, updated_at: '2026-10-10T00:00:00Z', words: 1200, score: 80, inbound: 1, clicks: null, path: `/hotels/${id}`, primary_keyword: null, ...extra })
check('review queue: an AI draft nobody rejected', inReviewQueue(lr('a')))
check('review queue: rejected drafts, live pages and manual drafts are not in it', !inReviewQueue(lr('a', { review_state: 'rejected' })) && !inReviewQueue(lr('a', { status: 'published' })) && !inReviewQueue(lr('a', { source: 'manual' })))
const dd = { kind: 'destinations' }
const bp = bulkPublishable([lr('clean', { ...dd, quality_notes: null }), lr('modehold', { ...dd, quality_notes: MODE_HOLD_NOTE }), lr('held', { ...dd, quality_notes: 'number not in the grounding: 7' }), lr('guess', { ...dd, quality_notes: `${MODE_HOLD_NOTE}; held for review: this name was taken from a trip title` }), lr('rej', { ...dd, review_state: 'rejected' }), lr('live', { ...dd, status: 'published' })])
check('bulk publish takes clean destination drafts and mode-held ones', bp.ok.join() === 'clean,modehold')
check('bulk publish skips held-back, guessed, rejected and live pages with a reason', bp.skipped.length === 4 && bp.skipped.every((s) => s.reason.length > 0))
const named = bulkPublishable(['hotels', 'resorts', 'ships', 'cruise-lines', 'river-cruises', 'yachts'].map((k) => lr(`n-${k}`, { kind: k, quality_notes: MODE_HOLD_NOTE })).concat([lr('n-clean', { kind: 'hotels', quality_notes: null })]))
check('M1: bulk publish never publishes a page that names a business, even with only the mode note or no note', named.ok.length === 0 && named.skipped.length === 7 && named.skipped.every((s) => /names a business/.test(s.reason)))

// ---------------------------------------------------------------------------------------------------
// 4. Orphan audit
// ---------------------------------------------------------------------------------------------------
console.log('--- orphans')
const ag = (kind: AuditGuide['kind'], slug: string, parent: string | null, body = 'text', ids: string[] = [], name = slug): AuditGuide => ({ id: `${kind}:${slug}`, kind, slug, name, parent_slug: parent, related_package_ids: ids, summary: `${name} is a place.`, body })
const auditGuides: AuditGuide[] = [
  ag('destinations', 'italy', null, 'See [Rome](/destinations/rome).', [], 'Italy'),
  ag('destinations', 'rome', 'italy', 'text', [], 'Rome'),
  ag('ships', 'lonely-ship', null, 'text', [], 'Lonely Ship'),
  ag('yachts', 'story-yacht', null, 'text', [], 'Story Yacht'),
  ag('hotels', 'linked-hotel', null, 'text', [], 'Linked Hotel'),
]
const auditPosts: AuditPost[] = [
  { slug: 'p1', title: 'A week on the Story Yacht', tags: [], related_package_id: null, body: 'no links here' },
  { slug: 'p2', title: 'Other', tags: [], related_package_id: null, body: 'Read about the [hotel](/hotels/linked-hotel).' },
]
const auditTrips: AuditTrip[] = []
const orphans = findOrphans(auditGuides, auditPosts, auditTrips)
const orphanSlugs = orphans.map((o) => o.slug)
check('orphan: with other pages around, every page gets a link (related guides now cross kinds)', orphanSlugs.length === 0)
const soloOrphans = findOrphans([ag('ships', 'only-ship', null, 'text', [], 'Only Ship')], [], [])
check('orphan: a page with no other page anywhere to link it is found', soloOrphans.map((o) => o.slug).join() === 'only-ship')
const propOnly = [ag('ships', 's1', null, 'text', [], 'S1'), ag('hotels', 'h1', null, 'text', [], 'H1'), ag('resorts', 'r1', null, 'text', [], 'R1'), ag('cruise-lines', 'c1', null, 'text', [], 'C1'), ag('river-cruises', 'v1', null, 'text', [], 'V1')]
check('orphan: five stand-alone property pages (nothing else) all link to each other, none is an orphan', findOrphans(propOnly, [], []).length === 0)
check('orphan: a markdown link from a post counts', !orphanSlugs.includes('linked-hotel'))
check('orphan: a post whose title names the page counts', !orphanSlugs.includes('story-yacht'))
const counts = inboundCounts(auditGuides, auditPosts, auditTrips)
check('inbound counts: every page has at least 1, a lone page has 0', (counts.get('ships:lonely-ship') ?? 0) >= 1 && (counts.get('hotels:linked-hotel') ?? 0) >= 1 && (counts.get('yachts:story-yacht') ?? 0) >= 1 && inboundCounts([ag('ships', 'only-ship', null, 'text', [], 'Only Ship')], [], []).get('ships:only-ship') === 0)
const pairSources = inboundSources([ag('cruise-lines', 'line-x', null), ag('ships', 'ship-y', 'line-x')], [], [])
check('orphan: a parent lists its child and a child links up to its parent', (pairSources.get('ships:ship-y') ?? []).some((s) => s.startsWith('parent:')) && (pairSources.get('cruise-lines:line-x') ?? []).some((s) => s.startsWith('child:')))
check('orphan: a markdown link in another guide counts as a guide source', (inboundSources(auditGuides, [], []).get('destinations:rome') ?? []).includes('guide:destinations:italy'))
const lonely = findOrphans([ag('ships', 'only', null)], [], [])
check('orphan: a site with one page and no links reports it, with its path', lonely.length === 1 && lonely[0].path === '/ships/only')
check('orphan: a trip description that links to a page counts', findOrphans([ag('hotels', 'by-trip', null)], [], [{ id: 't', slug: 't', destination: null, full_description: 'Stay at [it](/hotels/by-trip).' }]).length === 0)
check('orphan: a self link does not count', findOrphans([ag('hotels', 'selfie', null, 'see [me](/hotels/selfie)')], [], []).length === 1)
check('orphan: related guides count (same kind sibling lists it)', findOrphans([ag('hotels', 'one', null), ag('hotels', 'two', null)], [], []).length === 0)
check('orphan: a home-page top destination counts', findOrphans([ag('destinations', 'alone', null)], [], []).length === 0)
check('orphan: a destination with no trips is still ranked for the home page', pickTopDestinationGuides([link('destinations', 'a', null), link('destinations', 'b', null, 'b', ['t1', 't2']), link('hotels', 'h', null)], 6).map((x) => x.slug).join() === 'b,a')
check('top destinations: limit is respected', pickTopDestinationGuides(Array.from({ length: 9 }, (_, i) => link('destinations', `d${i}`, null)), 6).length === 6)

// ---------------------------------------------------------------------------------------------------
// 5. List: search, sort, filter, pages
// ---------------------------------------------------------------------------------------------------
console.log('--- admin list')
const rowsList: GuideListRow[] = [
  lr('cozumel', { kind: 'destinations', name: 'Cozumel', scope: 'port', status: 'published', updated_at: '2026-10-11T00:00:00Z', words: 1500, score: 90, inbound: 3, clicks: 12 }),
  lr('italy', { kind: 'destinations', name: 'Italy', status: 'published', updated_at: '2026-10-12T00:00:00Z', words: 1800, score: 70, inbound: 0, clicks: null }),
  lr('celebrity-edge', { kind: 'ships', name: 'Celebrity Edge', status: 'draft', updated_at: '2026-10-09T00:00:00Z', words: 1300, score: null, inbound: 0 }),
  lr('sandals-resorts', { kind: 'resorts', name: 'Sandals Resorts', status: 'draft', review_state: 'rejected', updated_at: '2026-10-08T00:00:00Z', words: 1100, score: 60, inbound: 0 }),
  lr('royal-hotel', { kind: 'hotels', name: 'Royal Hotel', status: 'published', updated_at: '2026-10-07T00:00:00Z', words: 1400, score: 75, inbound: -1, clicks: 4 }),
]
const q = (o: Record<string, string>) => parseListQuery({ get: (k: string) => o[k] ?? null }, GUIDE_KINDS)
const names2 = (r: ReturnType<typeof queryGuideRows>) => r.rows.map((x) => x.name).join(',')
check('query: junk becomes defaults', q({ sort: 'drop table', status: 'x', kind: 'nope', scope: 'zzz', page: '-5', pageSize: '7' }).sort === 'updated' && q({ page: '-5' }).page === 1 && q({ pageSize: '7' }).pageSize === 50 && q({ kind: 'nope' }).kind === '')
check('query: default sort is newest first', names2(queryGuideRows(rowsList, q({}))) === 'Italy,Cozumel,Celebrity Edge,Sandals Resorts,Royal Hotel')
check('sort by name A to Z and Z to A', names2(queryGuideRows(rowsList, q({ sort: 'name' }))) === 'Celebrity Edge,Cozumel,Italy,Royal Hotel,Sandals Resorts' && names2(queryGuideRows(rowsList, q({ sort: 'name', dir: 'desc' }))) === 'Sandals Resorts,Royal Hotel,Italy,Cozumel,Celebrity Edge')
check('sort by words, biggest first', queryGuideRows(rowsList, q({ sort: 'words' })).rows[0].name === 'Italy')
check('sort by score keeps unscored pages last in both directions', queryGuideRows(rowsList, q({ sort: 'score' })).rows.at(-1)?.name === 'Celebrity Edge' && queryGuideRows(rowsList, q({ sort: 'score', dir: 'asc' })).rows.at(-1)?.name === 'Celebrity Edge')
check('sort by clicks keeps pages with none last', queryGuideRows(rowsList, q({ sort: 'clicks' })).rows[0].name === 'Cozumel')
check('search matches name, address words, kind and scope', names2(queryGuideRows(rowsList, q({ q: 'cozumel' }))) === 'Cozumel' && names2(queryGuideRows(rowsList, q({ q: 'port' }))) === 'Cozumel' && queryGuideRows(rowsList, q({ q: 'ships' })).total === 1 && queryGuideRows(rowsList, q({ q: 'sandals resorts' })).total === 1)
check('search is case blind and needs every word', queryGuideRows(rowsList, q({ q: 'ROYAL hotel' })).total === 1 && queryGuideRows(rowsList, q({ q: 'royal cozumel' })).total === 0)
check('filter by kind and by scope', queryGuideRows(rowsList, q({ kind: 'destinations' })).total === 2 && queryGuideRows(rowsList, q({ scope: 'port' })).total === 1 && queryGuideRows(rowsList, q({ scope: 'country' })).rows.map((r) => r.name).join() === 'Italy')
check('filter "no scope" lists pages whose scope cannot be told', queryGuideRows(rowsList, q({ scope: 'none' })).rows.every((r) => scopeOf(r) === null))
check('filter by status: live, drafts, review queue, rejected', queryGuideRows(rowsList, q({ status: 'published' })).total === 3 && queryGuideRows(rowsList, q({ status: 'draft' })).total === 2 && queryGuideRows(rowsList, q({ status: 'review' })).rows.map((r) => r.name).join() === 'Celebrity Edge' && queryGuideRows(rowsList, q({ status: 'rejected' })).rows.map((r) => r.name).join() === 'Sandals Resorts')
check('orphan filter: live pages with 0 inbound only (unknown -1 is not an orphan)', queryGuideRows(rowsList, q({ orphans: '1' })).rows.map((r) => r.name).join() === 'Italy')
check('status chip counts ignore the status filter', queryGuideRows(rowsList, q({ status: 'draft' })).statusCounts.all === 5 && queryGuideRows(rowsList, q({ status: 'draft' })).statusCounts.published === 3)
const many: GuideListRow[] = Array.from({ length: 120 }, (_, i) => lr(`p${String(i).padStart(3, '0')}`, { name: `Page ${String(i).padStart(3, '0')}` }))
const pg2 = queryGuideRows(many, q({ sort: 'name', page: '2', pageSize: '50' }))
check('paging: 120 rows, 50 a page, page 2 starts at row 51, 3 pages', pg2.pages === 3 && pg2.rows[0].name === 'Page 050' && pg2.rows.length === 50 && pg2.total === 120)
check('paging: a page past the end shows the last page', queryGuideRows(many, q({ page: '99' })).page === 3)
check('paging: an empty list still has one page', queryGuideRows([], q({})).pages === 1)
check('word count ignores markdown marks', wordCountOf('Rome is a city.', '## Why go\n\n- one two\n- three') >= 9)

// ---------------------------------------------------------------------------------------------------
// 6. Edits
// ---------------------------------------------------------------------------------------------------
console.log('--- edits')
check('edit: scope, parent and a meta title are accepted', (() => { const r = validateGuideEdit({ scope: 'city', parent_slug: 'Italy', meta_title: 'Rome travel guide' }); return r.ok && r.patch.scope === 'city' && r.patch.parent_slug === 'italy' && r.patch.text.meta_title === 'Rome travel guide' })())
check('edit: an empty scope clears it', (() => { const r = validateGuideEdit({ scope: '' }); return r.ok && r.patch.scope === null })())
check('edit: an unknown scope is refused', !validateGuideEdit({ scope: 'planet' }).ok)
check('edit: a dash in text is refused', !validateGuideEdit({ meta_title: `Rome ${String.fromCharCode(0x2014)} guide` }).ok && !validateGuideEdit({ meta_description: 'a - b -- c'.replace(' - ', ' -- ') }).ok)
check('edit: a web address in text is refused', !validateGuideEdit({ og_description: 'see https://x.com' }).ok)
check('edit: too long and empty text are refused', !validateGuideEdit({ meta_title: 'x'.repeat(71) }).ok && !validateGuideEdit({ meta_title: '   ' }).ok)
check('edit: nothing to change is refused, junk fields are ignored', !validateGuideEdit({}).ok && !validateGuideEdit({ nonsense: 1 }).ok && !validateGuideEdit(null).ok)
check('edit: review_state only takes rejected or null', validateGuideEdit({ review_state: 'rejected' }).ok && validateGuideEdit({ review_state: null }).ok && !validateGuideEdit({ review_state: 'approved' }).ok)

// ---------------------------------------------------------------------------------------------------
// 7. Facts, diagram, chart, images, phone
// ---------------------------------------------------------------------------------------------------
console.log('--- template facts')
const trip = (o: Partial<TripFact> & { slug: string }): TripFact => ({ id: o.slug, name: o.slug, category: null, destination: null, duration_days: null, available_from: null, available_to: null, itinerary: null, ...o })
const itin = (titles: string[]) => titles.map((title, i) => ({ day: i + 1, title, description: 'x' }))
const now = new Date('2026-10-12T12:00:00')
const facts = buildKeyFacts({
  kindLabel: 'Hotel',
  scope: 'property',
  parent: { name: 'Rome', path: '/destinations/rome' },
  trips: [trip({ slug: 'rome-fall', name: 'Rome Fall Escape', category: 'Cultural', available_from: '2027-03-03', available_to: '2027-03-10' }), trip({ slug: 'old', name: 'Old Trip', category: 'Cultural', available_from: '2025-01-01', available_to: '2025-01-08' })],
  bestTime: { destination: 'Rome', path: '/best-time-to-visit/rome' },
  childCount: 0,
  now,
})
const labels = facts.map((f) => f.label)
check('facts: type, parent, trips, trip types, next trip and best time are built from stored data', ['Page type', 'Sits under', 'Trips on our site', 'Trip types', 'Next trip', 'Best time to visit'].every((l) => labels.includes(l)))
check('facts: the next trip is the upcoming one, not the past one', facts.find((f) => f.label === 'Next trip')?.value.startsWith('Rome Fall Escape') === true)
check('facts: every row names its source', facts.every((f) => ['page', 'trip', 'site'].includes(f.source)))
check('facts: no trips means no trip rows', !buildKeyFacts({ kindLabel: 'Hotel', scope: null, parent: null, trips: [], bestTime: null, childCount: 0, now }).some((f) => f.source === 'trip'))
check('facts: with nothing stored only the page type row remains', buildKeyFacts({ kindLabel: 'Hotel', scope: null, parent: null, trips: [], bestTime: null, childCount: 0, now }).length === 1)
check('facts: only past trips give no "Next trip" row', !buildKeyFacts({ kindLabel: 'Hotel', scope: null, parent: null, trips: [trip({ slug: 'p', available_from: '2025-01-01', available_to: '2025-01-08' })], bestTime: null, childCount: 0, now }).some((f) => f.label === 'Next trip'))
check('facts: a trip with no dates gives no "Next trip" row (nothing is invented)', !buildKeyFacts({ kindLabel: 'Hotel', scope: null, parent: null, trips: [trip({ slug: 'nd' })], bestTime: null, childCount: 0, now }).some((f) => f.label === 'Next trip'))
check('date range text has no dash characters', !/[–—-]/.test(dateRangeText('2027-03-03', '2027-03-10') ?? '') && dateRangeText(null, null) === null)
check('bullets: one per trip with its link', tripBullets([trip({ slug: 'a', name: 'A Trip', category: 'Cruise' })]).every((b) => b.href === '/packages/a' && b.text.includes('A Trip')))
check('itinerary stops: junk entries are ignored', itineraryStops([{ title: 'Rome', day: 1 }, null, 5, { title: '' }, { description: 'x' }, { title: 'x'.repeat(200) }]).length === 1)
check('route: needs at least three stored stops', pickRoute([trip({ slug: 'two', itinerary: itin(['A', 'B']) })]) === null && pickRoute([trip({ slug: 'none' })]) === null)
check('route: the trip with the most stops wins', pickRoute([trip({ slug: 'a', itinerary: itin(['A', 'B', 'C']) }), trip({ slug: 'b', itinerary: itin(['A', 'B', 'C', 'D']) })])?.tripSlug === 'b')
check('route: at most twelve stops are drawn', (pickRoute([trip({ slug: 'long', itinerary: itin(Array.from({ length: 20 }, (_, i) => `Stop ${i}`)) })]) as { stops: unknown[] }).stops.length === 12)
check('chart: needs two trips with a stored length', tripLengthBars([trip({ slug: 'a', duration_days: 7 })]) === null && tripLengthBars([trip({ slug: 'a', duration_days: 7 }), trip({ slug: 'b' })]) === null && tripLengthBars([trip({ slug: 'a', duration_days: 7 }), trip({ slug: 'b', duration_days: 10 })])?.length === 2)
check('chart: zero or negative lengths are ignored', tripLengthBars([trip({ slug: 'a', duration_days: 0 }), trip({ slug: 'b', duration_days: -3 })]) === null)
check('no map is built (no coordinates are stored anywhere)', !('map' in (facts[0] as object)) && !/leaflet|maps\.google|staticmap/i.test(readFileSync(join(process.cwd(), 'components/guide-facts.tsx'), 'utf8')))
check('phone: ten digits and 1 + ten digits give a tel link; junk gives none', telHref('(833) 878-5386') === 'tel:+18338785386' && telHref('+1 833 878 5386') === 'tel:+18338785386' && telHref('') === null && telHref('12345') === null && telHref(null) === null)
const px = 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940'
const set = heroSrcSet(px)
check('srcset: four widths for a Pexels photo, old size params replaced', !!set && set.split(', ').length === 4 && /w=480 480w/.test(set) && /w=1600 1600w/.test(set) && !/dpr=|h=650/.test(set))
check('srcset: other hosts, bad addresses and nothing give none', heroSrcSet('https://example.com/a.jpg') === null && heroSrcSet('not a url') === null && heroSrcSet(null) === null && heroSrcSet('http://images.pexels.com/a.jpg') === null)

// ---------------------------------------------------------------------------------------------------
// 8. Linking helpers
// ---------------------------------------------------------------------------------------------------
console.log('--- linking')
const posts = [
  { id: '1', slug: 'rome-trip-story', title: 'Our Rome Escape', tags: [], related_package_id: 'pkg-rome' },
  { id: '2', slug: 'celebrity-edge-tips', title: 'First time on Celebrity Edge', tags: ['cruise'], related_package_id: null },
  { id: '3', slug: 'unrelated', title: 'Packing tips', tags: [], related_package_id: null },
]
check('guide to blog: a post for one of the guide trips matches', pickPostsForGuide({ name: 'Rome', related_package_ids: ['pkg-rome'] }, posts).map((p) => p.id).join() === '1')
check('guide to blog: a post whose title holds the whole name matches', pickPostsForGuide({ name: 'Celebrity Edge', related_package_ids: [] }, posts).map((p) => p.id).join() === '2')
check('guide to blog: no match is an empty list (no fuzzy guess)', pickPostsForGuide({ name: 'Santorini', related_package_ids: [] }, posts).length === 0)
check('guide to blog: a very short name never matches by phrase', pickPostsForGuide({ name: 'Rio', related_package_ids: [] }, [{ ...posts[0], title: 'Rio trip' }]).length === 0)
const pk = [link('destinations', 'rome', null, 'Rome', ['t1']), link('hotels', 'hx', 'rome', 'Hotel X'), link('hotels', 'other', 'paris', 'Other'), link('ships', 'ship-1', null, 'Ship One', ['t2'])]
check('trip to guides: the destination page first, then pages that list the trip, then pages under the destination', pickGuidesForPackage({ id: 't2', destinationSlug: 'rome' }, pk).map((x) => x.slug).join() === 'rome,ship-1,hx')
check('trip to guides: nothing related is an empty list', pickGuidesForPackage({ id: 'zz', destinationSlug: null }, pk).length === 0)

check('header has Destinations and a Cruises & Resorts group with every index page', primaryNavLinks.some((l) => l.href === '/destinations') && (primaryNavLinks.find((l) => l.label === 'Cruises & Resorts')?.children?.length ?? 0) === cruiseAndResortLinks.length && cruiseAndResortLinks.length === 6)
check('every nav index link is a real guide kind prefix', cruiseAndResortLinks.every((l) => GUIDE_KINDS.some((k) => l.href === `/${k}`)))
check('missing-column errors are recognised, other errors are not', isMissingScopeColumn('column guides.scope does not exist') && isMissingScopeColumn("Could not find the 'review_state' column of 'guides' in the schema cache") && !isMissingScopeColumn('permission denied for table guides') && !isMissingScopeColumn(null))

// ---------------------------------------------------------------------------------------------------
// 9. House rules on the files this package touches
// ---------------------------------------------------------------------------------------------------
console.log('--- house rules')
const mine = [
  'lib/guide-scope.ts', 'lib/guide-backfill.ts', 'lib/guide-list.ts', 'lib/guide-orphans.ts', 'lib/guide-edit.ts', 'lib/guide-facts.ts', 'lib/guide-images.ts', 'lib/guides.ts', 'lib/guide-run.ts',
  'lib/guide-seeds.ts', 'components/guide-cta.tsx', 'components/guide-facts.tsx', 'components/guide-page.tsx', 'components/top-destinations.tsx', 'components/header.tsx', 'components/footer.tsx',
  'components/admin/guides-backfill.tsx', 'app/admin/guides/page.tsx', 'app/api/admin/guides/list/route.ts', 'content/navigation.ts', 'supabase/migrations/0041_guide_scope.sql',
]
const dash = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)
check('no em or en dashes in any file this package wrote', mine.every((f) => !dash.test(readFileSync(join(process.cwd(), f), 'utf8'))))
check('the phone number is read from site.phone, never typed into the CTA', (() => { const s = readFileSync(join(process.cwd(), 'components/guide-cta.tsx'), 'utf8'); return /site\.phone/.test(s) && !/833|878/.test(s) })())
check('the migration is additive, idempotent and leaves RLS alone', (() => { const s = readFileSync(join(process.cwd(), 'supabase/migrations/0041_guide_scope.sql'), 'utf8'); return /add column if not exists scope/.test(s) && /add column if not exists review_state/.test(s) && !/drop table|drop column|disable row level|create policy|alter policy/i.test(s) })())
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
check('minor: backfill-start requires expectedCount and takes an exclude list', (() => { const s = read('app/api/admin/guides/route.ts'); return /expectedCount is required|Number\(body\.expectedCount\)/.test(s) && /expected < 1/.test(s) && /body\.exclude/.test(s) })())
check('minor: the orphan link in Needs attention is honoured by the Guide Pages screen', /filter=orphans/.test(read('lib/issues.ts')) && /filter=orphans/.test(read('lib/plain-steps.ts')) && /get\("filter"\) === "orphans"/.test(read('app/admin/guides/page.tsx')) && /set\("orphans", "1"\)/.test(read('app/admin/guides/page.tsx')) && q({ orphans: '1' }).orphans === true)
check('M3: the CTA label is only "Call or text our AI agent"', (() => { const s = read('components/guide-cta.tsx'); return /Call or text our AI agent/.test(s) && !/Talk to our AI|AI agent line|AI travel agent/.test(s) })())
check('WP17: the admin nav says Guide Pages and points at /admin/guides; no separate Pages entry', (() => { const s = read('lib/admin-nav.ts'); return /title: "Guide Pages"/.test(s) && !/title: "Pages"/.test(s) && !/title: "Destinations"/.test(s) && !/href: "\/admin\/destinations"/.test(s) })())
check('WP17: /admin/destinations redirects to /admin/guides and the blurb editor is gone', (() => { const s = read('app/admin/destinations/page.tsx'); return /redirect\("\/admin\/guides"\)/.test(s) && !/Generate with AI|Textarea/.test(s) })())
check('WP17: the Guide Pages screen is one screen (backfill, panel, list) with no blurb editor card', (() => { const s = read('app/admin/guides/page.tsx'); return /GuidesBackfillCard/.test(s) && /GuidesPanel variant="full"/.test(s) && !/EmptyBlurbs|Generate with AI/.test(s) })())
check('WP17: the public destination page still shows the stored blurb, or the guide summary', (() => { const s = read('app/destinations/[slug]/page.tsx'); return /getPublicBlurb/.test(s) && /guide\.summary/.test(s) && /blurb\.blurb/.test(s) })())
check('files owned by another branch are untouched (git diff against main)', (() => {
  try {
    const base = execSync('git merge-base HEAD main', { encoding: 'utf8' }).trim()
    const changed = execSync(`git diff --name-only ${base}`, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    // The trip page left this list when the staging loop added its "Guides for this trip" block (scripts/check-package-guides.ts guards that edit). lib/site.ts left it when the guide-parity change added the pure formatDate helper (scripts/check-guide-parity.ts guards it; the phone is untouched).
    const forbidden = ['components/package-card.tsx', 'lib/trip-duration.ts', 'supabase/migrations/0040_price_on_request.sql']
    const hit = changed.filter((f) => forbidden.includes(f) || /wizard/i.test(f))
    if (hit.length) console.log('     touched:', hit.join(', '))
    return hit.length === 0
  } catch {
    return true // no git here: nothing to compare
  }
})())

void (async () => {
  await dryRun()
  globalThis.fetch = realFetch
  check('no network call was made anywhere in this check', networkCalls === 0)
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
})()
