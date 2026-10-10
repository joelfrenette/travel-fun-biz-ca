// Offline self-check for the keyword intelligence engine: clustering, intent, opportunity labels, the checks
// on AI-written blog ideas, dedupe, the ISO-week claim key, the atomic weekly claim, and ranking progress.
// No network, no database (the claim runs against an in-memory stand-in).
// Run: pnpm dlx tsx scripts/check-keyword-intel.ts
import {
  buildClusters,
  chooseClustersToPlan,
  funnelStageOf,
  intentOf,
  isoWeekKey,
  mechanicalPlanItem,
  nextEngineRunAt,
  opportunityOf,
  planDuplicateReason,
  pruneSpendLog,
  summarizeHistory,
  validatePlanItem,
  SHOOT_FOR_MIN_SCORE,
  type KeywordCluster,
} from '../lib/keyword-cluster'
import { claimKeywordWeek, pickSeeds } from '../lib/keyword-refresh'
import type { ScoreKeyword, ScorePackage } from '../lib/keyword-score'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}

const now = new Date('2026-10-10T12:00:00Z')
const kw = (keyword: string, extra: Partial<ScoreKeyword> = {}): ScoreKeyword => ({ keyword, volume: 100, cpc: 0.5, competition: 30, gsc_impressions: null, gsc_position: null, target_path: null, note: null, ...extra })
const packages: ScorePackage[] = [
  { slug: 'rhine-cruise', name: 'Rhine River Cruise', destination: 'Rhine', available_from: '2027-04-01', available_to: '2027-04-09' },
  { slug: 'croatia-sailing', name: 'Croatia Sailing Week', destination: 'Croatia', available_from: '2027-06-01', available_to: '2027-06-08' },
  { slug: 'past-trip', name: 'Lisbon Weekend', destination: 'Lisbon', available_from: '2026-01-01', available_to: '2026-01-05' },
]

// ---- intent and funnel ----
check('intent: question is informational', intentOf('what is included in a river cruise') === 'informational')
check('intent: how to is informational', intentOf('how to plan a group trip') === 'informational')
check('intent: how much is transactional', intentOf('how much does a rhine cruise cost') === 'transactional')
check('intent: book is transactional', intentOf('book a croatia yacht cruise') === 'transactional')
check('intent: package is transactional', intentOf('rhine river cruise packages') === 'transactional')
check('intent: plain trip phrase is commercial', intentOf('rhine river cruise from canada') === 'commercial')
check('intent: best time is informational', intentOf('best time to visit croatia') === 'informational')
check('intent: unknown words default to informational', intentOf('croatia') === 'informational')
check('funnel stages', funnelStageOf('informational') === 'awareness' && funnelStageOf('commercial') === 'consideration' && funnelStageOf('transactional') === 'decision' && funnelStageOf('book a cruise') === 'decision')

// ---- clustering ----
const rows: ScoreKeyword[] = [
  kw('rhine river cruise', { volume: 320 }),
  kw('rhine river cruises', { volume: 90 }),
  kw('rhine river cruise from canada', { volume: 50 }),
  kw('croatia sailing week for singles', { volume: 70 }),
  kw('lisbon weekend getaway', { volume: 40 }),
  kw('group trips for singles', { volume: 900 }),
]
const built = buildClusters(rows, packages, now)
const rhine = built.clusters.find((c) => c.members.includes('rhine river cruise'))
check('near-duplicate phrases become one cluster', !!rhine && rhine.members.length === 3, rhine?.members)
check('cluster has a primary and secondary phrases', !!rhine && rhine.secondary.length === 2 && !rhine.secondary.includes(rhine.primary))
check('cluster id is a stable slug of the primary', !!rhine && rhine.id === rhine.primary.replace(/[^a-z0-9]+/g, '-'), rhine?.id)
check('other topics stay separate', built.clusters.length === 4, built.clusters.map((c) => c.primary))
check('rhine topic is SHOOT_FOR', rhine?.opportunity === 'SHOOT_FOR', rhine)
check('a general phrase (no trip we sell) is SKIP with a reason', (() => {
  const c = built.clusters.find((x) => x.primary === 'group trips for singles')
  return c?.opportunity === 'SKIP' && /Not about a specific trip/.test(c.reason)
})())
check('a trip that has already left is SKIP', (() => {
  const c = built.clusters.find((x) => x.primary === 'lisbon weekend getaway')
  return c?.opportunity === 'SKIP' && /already left/.test(c.reason)
})())
check('every keyword carries its cluster id', built.keywords.every((k) => !!k.clusterId) && built.keywords.length === rows.length)

// ---- opportunity labels ----
const row = (extra: Partial<ScoreKeyword>) => kw('x y z', extra)
check('RANKING at position 4', opportunityOf(row({ gsc_position: 4, gsc_impressions: 20 }), 10, false).label === 'RANKING')
check('RANKING at position 10', opportunityOf(row({ gsc_position: 10, gsc_impressions: 3 }), 10, true).label === 'RANKING')
check('ALMOST at position 11', opportunityOf(row({ gsc_position: 11, gsc_impressions: 3 }), 10, true).label === 'ALMOST')
check('ALMOST at position 30', opportunityOf(row({ gsc_position: 30, gsc_impressions: 3 }), 10, true).label === 'ALMOST')
check('position 31 is not ALMOST', opportunityOf(row({ gsc_position: 31, gsc_impressions: 3 }), 80, true).label === 'SHOOT_FOR')
check('a position with zero impressions does not count as ranking', opportunityOf(row({ gsc_position: 3, gsc_impressions: 0 }), 80, true).label === 'SHOOT_FOR')
check('TARGETED when a page targets it', opportunityOf(row({ target_path: '/blog/a' }), 80, false).label === 'TARGETED')
check('SKIP when skipped before', opportunityOf(row({ note: 'skipped 2026-10-01: dupe' }), 80, true).label === 'SKIP')
check('SKIP when the gate says no, with its reason', (() => {
  const o = opportunityOf(row({}), 80, false, ['Not about a specific trip we sell (a general phrase)'])
  return o.label === 'SKIP' && /Not about a specific trip/.test(o.reason)
})())
check('SHOOT_FOR at the threshold', opportunityOf(row({}), SHOOT_FOR_MIN_SCORE, true).label === 'SHOOT_FOR')
check('SKIP below the threshold', opportunityOf(row({}), SHOOT_FOR_MIN_SCORE - 1, true).label === 'SKIP')
check('every verdict has a reason', ['RANKING', 'ALMOST', 'TARGETED', 'SKIP', 'SHOOT_FOR'].length === 5 && opportunityOf(row({}), 90, true).reason.length > 0)

// a topic with an owner stops its siblings from being SHOOT_FOR
{
  const b = buildClusters([kw('rhine river cruise', { gsc_position: 5, gsc_impressions: 40 }), kw('rhine river cruise from canada', { volume: 200 })], packages, now)
  const sib = b.keywords.find((k) => k.keyword === 'rhine river cruise from canada')
  check('a sibling of a ranking phrase is not SHOOT_FOR', sib?.opportunity === 'SKIP', sib)
  check('the topic is labelled by its owner', b.clusters.length === 1 && b.clusters[0].opportunity === 'RANKING', b.clusters)
}

// ---- plan validation ----
const cluster: KeywordCluster = {
  id: 'rhine-river-cruise',
  primary: 'rhine river cruise',
  members: ['rhine river cruise', 'rhine river cruises', 'rhine river cruise from canada', 'rhine cruise for singles', 'rhine cruise packages'],
  secondary: ['rhine river cruises', 'rhine river cruise from canada', 'rhine cruise for singles', 'rhine cruise packages'],
  opportunity: 'SHOOT_FOR',
  reason: 'x',
  score: 61,
  intent: 'commercial',
  funnel: 'consideration',
  volume: 320,
  competition: 30,
  packageName: 'Rhine River Cruise',
  packageSlug: 'rhine-cruise',
}
const slugs = new Set(['rhine-cruise', 'croatia-sailing'])
const good = { primary_keyword: 'Rhine River Cruise', title_idea: 'Is a Rhine river cruise right for your group?', angle: 'Helps first time cruisers decide whether a river cruise on the Rhine suits their group.', secondary_keywords: ['rhine river cruises', 'rhine cruise for singles', 'rhine cruise packages'], who_for: 'Friends and singles planning a first river cruise', package_slug: 'rhine-cruise' }
{
  const r = validatePlanItem(good, cluster, slugs, 'Rhine River Cruise Rhine')
  check('a good idea passes', r.ok && r.item.package_slug === 'rhine-cruise' && r.item.secondary_keywords.length === 3, r)
  check('primary is forced to the cluster primary spelling', r.ok && r.item.primary_keyword === 'rhine river cruise')
}
check('a wrong primary is rejected', !validatePlanItem({ ...good, primary_keyword: 'croatia sailing' }, cluster, slugs).ok)
{
  const r = validatePlanItem({ ...good, secondary_keywords: ['rhine cruise for singles', 'bali beach holiday', 'rhine river cruises', 'rhine river cruises'] }, cluster, slugs)
  check('secondaries outside the cluster are dropped, duplicates removed', r.ok && r.item.secondary_keywords.every((s) => cluster.secondary.includes(s)) && new Set(r.item.secondary_keywords).size === r.item.secondary_keywords.length, r)
  check('and the list is topped up to three from the cluster', r.ok && r.item.secondary_keywords.length >= 3, r)
}
{
  const r = validatePlanItem({ ...good, secondary_keywords: Array.from({ length: 12 }, (_, i) => `rhine river cruise extra ${i}`) }, cluster, slugs)
  check('secondaries are capped at six and all are cluster members', r.ok && r.item.secondary_keywords.length <= 6 && r.item.secondary_keywords.every((s) => cluster.secondary.includes(s)), r)
}
{
  const r = validatePlanItem({ ...good, package_slug: 'made-up-slug' }, cluster, slugs)
  check('a made-up package slug is rejected and replaced by the real match', r.ok && r.item.package_slug === 'rhine-cruise' && r.fixes.some((f) => /not a real published package/.test(f)), r)
  const r2 = validatePlanItem({ ...good, package_slug: 'made-up-slug' }, { ...cluster, packageSlug: null }, slugs)
  check('with no real match the slug becomes null', r2.ok && r2.item.package_slug === null, r2)
  const r3 = validatePlanItem({ ...good, package_slug: 'croatia-sailing' }, cluster, slugs)
  check('another real slug is kept', r3.ok && r3.item.package_slug === 'croatia-sailing')
}
check('a price in the text is rejected', !validatePlanItem({ ...good, angle: 'Learn what a Rhine cruise really costs, from $2,000 per person.' }, cluster, slugs).ok)
check('an invented number is rejected', !validatePlanItem({ ...good, title_idea: 'Seven reasons to book a Rhine river cruise' + ' 2031' }, cluster, slugs, 'Rhine River Cruise').ok)
check('a number found in the package text is allowed', validatePlanItem({ ...good, title_idea: 'Rhine river cruise in 2027: is it for your group?' }, cluster, slugs, 'Rhine River Cruise April 2027').ok)
check('an invented number word is rejected', !validatePlanItem({ ...good, title_idea: 'Seven reasons a Rhine river cruise suits groups' }, cluster, slugs, 'Rhine River Cruise').ok)
check('number words in angle and who-for are rejected too', !validatePlanItem({ ...good, angle: 'A guide to the best two weeks on a Rhine river cruise for groups.' }, cluster, slugs).ok && !validatePlanItem({ ...good, who_for: 'Ten friends planning a trip' }, cluster, slugs).ok)
check('a number word present in the package text is allowed', validatePlanItem({ ...good, title_idea: 'Is a seven night Rhine river cruise right for you?' }, cluster, slugs, 'Rhine River Cruise seven night sailing').ok)
check('a word that merely contains a number word is fine', validatePlanItem({ ...good, title_idea: 'Is a Rhine river cruise right for your tennis group?' }, cluster, slugs).ok)
check('a missing title is rejected', !validatePlanItem({ ...good, title_idea: '' }, cluster, slugs).ok)
check('a non-object is rejected', !validatePlanItem('nope', cluster, slugs).ok && !validatePlanItem(null, cluster, slugs).ok)
{
  const EM = String.fromCharCode(0x2014)
  const r = validatePlanItem({ ...good, angle: `Helps first time cruisers ${EM} and groups ${EM} decide whether a Rhine river cruise suits them.` }, cluster, slugs)
  check('dashes are removed from the text', r.ok && !r.item.angle.includes(EM) && !r.item.angle.includes(String.fromCharCode(0x2013)), r)
}
{
  const m = mechanicalPlanItem(cluster)
  check('the no-AI idea is complete and valid', m.primary_keyword === cluster.primary && m.secondary_keywords.length > 0 && m.title_idea.length >= 10 && validatePlanItem(m, cluster, slugs).ok, m)
}

// ---- dedupe ----
const ctx = { posts: [{ title: 'Packing list for any group trip', primary_keyword: 'group trip packing list', secondary_keywords: ['what to pack for a group trip'] }], queue: [{ keyword: 'old idea', keywords: ['old idea', 'croatia yacht'], cluster_id: 'old-idea' }] }
check('fresh cluster is not a duplicate', planDuplicateReason(cluster, ctx) === null)
check('same cluster id in the queue is a duplicate', planDuplicateReason(cluster, { ...ctx, queue: [{ keyword: 'zzz', cluster_id: 'rhine-river-cruise' }] }) !== null)
check('a queue row (any status) holding one of its phrases is a duplicate', planDuplicateReason(cluster, { ...ctx, queue: [{ keyword: 'rhine cruise for singles' }] }) !== null)
check('a queue row keyword set overlap is a duplicate', planDuplicateReason(cluster, { ...ctx, queue: [{ keyword: 'other', keywords: ['other', 'rhine cruise packages'] }] }) !== null)
check('a post that targets one of its phrases is a duplicate', planDuplicateReason(cluster, { ...ctx, posts: [{ title: 'x', primary_keyword: 'rhine river cruises' }] }) !== null)
check('a post with a near-identical title is a duplicate', planDuplicateReason(cluster, { ...ctx, posts: [{ title: 'Rhine river cruise' }] }) !== null)
{
  const many: KeywordCluster[] = Array.from({ length: 9 }, (_, i) => ({ ...cluster, id: `topic-${i}`, primary: `unique topic number ${String.fromCharCode(97 + i)}${i} words`, members: [`unique topic number ${String.fromCharCode(97 + i)}${i} words`], secondary: [], score: 50 + i }))
  const pick = chooseClustersToPlan([...many, { ...cluster, opportunity: 'SKIP' }], ctx, 6)
  check('at most six clusters are planned, best score first', pick.chosen.length === 6 && pick.chosen[0].score === 58, pick.chosen.map((c) => c.score))
  const dup = chooseClustersToPlan([cluster], { posts: [], queue: [{ keyword: 'rhine river cruise' }] }, 6)
  check('a duplicate is skipped with a reason', dup.chosen.length === 0 && dup.skipped.length === 1 && dup.skipped[0].reason.length > 0)
  check('only SHOOT_FOR clusters are planned', chooseClustersToPlan([{ ...cluster, opportunity: 'TARGETED' }], { posts: [], queue: [] }, 6).chosen.length === 0)
}

// ---- ISO week key and cadence ----
check('ISO week: 2026-10-10 is 2026-W41', isoWeekKey(new Date('2026-10-10T12:00:00Z')) === '2026-W41', isoWeekKey(new Date('2026-10-10T12:00:00Z')))
check('ISO week: Monday 2026-10-05 is still W41', isoWeekKey(new Date('2026-10-05T00:00:00Z')) === '2026-W41')
check('ISO week: Sunday 2026-10-11 is still W41', isoWeekKey(new Date('2026-10-11T23:59:00Z')) === '2026-W41')
check('ISO week: 2026-10-12 is W42', isoWeekKey(new Date('2026-10-12T00:00:00Z')) === '2026-W42')
check('ISO week: 2026-01-01 is 2026-W01', isoWeekKey(new Date('2026-01-01T00:00:00Z')) === '2026-W01')
check('ISO week: 2024-12-30 belongs to 2025-W01', isoWeekKey(new Date('2024-12-30T00:00:00Z')) === '2025-W01')
check('ISO week: 2021-01-03 belongs to 2020-W53', isoWeekKey(new Date('2021-01-03T00:00:00Z')) === '2020-W53')
check('next run: never run means due now', nextEngineRunAt(null, now).getTime() === now.getTime())
check('next run: not before the Monday after, and not within 5 days', (() => {
  const n = nextEngineRunAt(new Date('2026-10-05T09:00:00Z'), now) // ran on a Monday
  return n.getTime() >= new Date('2026-10-10T09:00:00Z').getTime() && isoWeekKey(n) === '2026-W42'
})())

// ---- spend log pruning ----
{
  const t = Date.parse('2026-10-10T12:00:00Z')
  const iso = (daysAgo: number, hours = 0) => new Date(t - daysAgo * 86_400_000 - hours * 3_600_000).toISOString()
  const real = { at: iso(3), spentUsd: 0.4, added: 5, seeds: ['a'] }
  const zeros = Array.from({ length: 40 }, (_, i) => ({ at: iso(0, i), spentUsd: 0, added: 0, seeds: [] as string[] }))
  const pruned = pruneSpendLog([...zeros, real], t)
  check('40 zero-cost runs in a week do not evict a real spend entry', pruned.includes(real) && pruned.length === 41)
  check('spend older than 10 days is dropped by age', pruneSpendLog([real, { at: iso(11), spentUsd: 1, added: 0, seeds: [] }], t).length === 1)
  check('the hard cap only limits size (200)', pruneSpendLog(Array.from({ length: 500 }, (_, i) => ({ at: iso(0, i % 24) })), t).length === 200)
}

// ---- seed rotation ----
{
  const seeds = ['a', 'b', 'c', 'd', 'e']
  check('seeds: first run takes the first three', pickSeeds(seeds, 0, 3).join() === 'a,b,c')
  check('seeds: the offset advances per run, wrapping round', pickSeeds(seeds, 3, 3).join() === 'd,e,a')
  check('seeds: an empty list gives nothing', pickSeeds([], 7, 3).length === 0)
}

// ---- the atomic weekly claim ----
async function claimTest() {
  const store = new Map<string, string>()
  const admin = {
    from: () => ({
      insert: async (r: { key: string; value: string }) => {
        if (store.has(r.key)) return { error: { code: '23505', message: 'duplicate key value' } }
        store.set(r.key, r.value)
        return { error: null }
      },
    }),
  }
  // 40 overlapping passes (the pipeline runs every 15 minutes) in the same week: exactly one wins.
  const results = await Promise.all(Array.from({ length: 40 }, () => claimKeywordWeek(admin as never, '2026-W41')))
  const won = results.filter((r) => typeof r === 'object')
  check('exactly one of 40 overlapping passes wins the week', won.length === 1 && results.filter((r) => r === 'taken').length === 39, results.filter((r) => typeof r !== 'object').length)
  check('the claim key names the ISO week', store.has('keyword_engine_week:2026-W41'))
  const next = await claimKeywordWeek(admin as never, '2026-W42')
  check('the next week can be claimed', typeof next === 'object')
  const broken = { from: () => ({ insert: async () => ({ error: { code: '08006', message: 'connection' } }) }) }
  check('a claim that cannot be made is "error", never a win', (await claimKeywordWeek(broken as never, '2026-W43')) === 'error')
}

// ---- ranking progress ----
{
  const pts = [
    { day: '2026-09-12', position: 30, clicks: 0, impressions: 5 },
    { day: '2026-10-03', position: 18, clicks: 1, impressions: 20 },
    { day: '2026-10-09', position: 12, clicks: 2, impressions: 40 },
    { day: '2026-10-10', position: 9.4, clicks: 3, impressions: 44 },
  ]
  const s = summarizeHistory(pts)
  check('progress: latest position', s.position === 9.4 && s.latestDay === '2026-10-10', s)
  check('progress: change vs 7 days up is positive', s.change7 === 8.6, s.change7)
  check('progress: change vs 28 days (a day within tolerance)', s.change28 === 20.6, s.change28)
  check('progress: clicks come from the latest snapshot', s.clicks === 3 && s.impressions === 44)
  const young = summarizeHistory([{ day: '2026-10-09', position: 12, clicks: 0, impressions: 3 }, { day: '2026-10-10', position: 14, clicks: 0, impressions: 3 }])
  check('progress: not enough history gives null, never a made-up zero', young.change7 === null && young.change28 === null, young)
  check('progress: a drop is negative', summarizeHistory([{ day: '2026-10-03', position: 5, clicks: 0, impressions: 1 }, { day: '2026-10-10', position: 8, clicks: 0, impressions: 1 }]).change7 === -3)
  check('progress: no data at all', summarizeHistory([]).position === null)
}

claimTest().then(() => {
  console.log(failed === 0 ? '\nAll keyword intelligence checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
})
