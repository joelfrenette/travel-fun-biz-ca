// Offline self-check for "Promote this package" (WP15): plan building (phrases, guides, named properties, itinerary
// places), the past-trip refusal, the 30-day cap, the idea checks (the model is never trusted), the dedupe, the social
// ledger row and its daily cap (against a small in-memory fake of the Supabase client, no network, no database), the
// guide priority list and how it changes the guide rotation. No AI call and no live data are used.
// Run: pnpm dlx tsx scripts/check-promotion.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  actionBlockedReason,
  buildIdeasPrompt,
  buildPhrases,
  isAbandonedClaim,
  isUuid,
  canPromote,
  dedupeIdeas,
  enrolPackagePost,
  IDEAS_MAX_TOKENS,
  itineraryPlaces,
  MAX_IDEAS,
  MAX_PHRASES,
  namedProperties,
  PACKAGE_ENROLMENTS_PER_DAY,
  packageFacts,
  pageCopyNote,
  planGuides,
  PROMOTION_GAP_DAYS,
  socialRowFor,
  travelMonth,
  usablePhrase,
  validatePromotionIdea,
  type PromotionPackage,
} from '../lib/promotion'
import { packageDistributionPath, packageDistributionSlug, packageSlugFromPath } from '../lib/guide-post-source'
import { parseGuidePriority, type GuideCandidate } from '../lib/guides'
import { isGuessedProperty, pickNextCandidate } from '../lib/guide-run'
import { packageWall } from '../lib/blog-topics'

let failed = 0
function check(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

// ---- a tiny fake of the parts of the Supabase client these functions use ----
type Row = Record<string, unknown>
interface Db {
  tables: Record<string, Row[]>
}
function fakeAdmin(db: Db): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: Row = {}
    let opts: { count?: string; head?: boolean } | undefined
    const rows = () => (db.tables[table] ??= [])
    const run = () => {
      if (mode === 'insert') {
        rows().push({ created_at: new Date().toISOString(), attempts: 0, sent_platforms: [], ...payload })
        return { data: null, error: null, count: null }
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (mode === 'update') {
        for (const r of hit) Object.assign(r, payload)
        return { data: null, error: null, count: null }
      }
      if (mode === 'delete') {
        db.tables[table] = rows().filter((r) => !hit.includes(r))
        return { data: null, error: null, count: null }
      }
      if (opts?.head) return { data: null, error: null, count: hit.length }
      return { data: hit, error: null, count: hit.length }
    }
    const q: Record<string, unknown> = {
      select: (_cols?: string, o?: { count?: string; head?: boolean }) => ((opts = o), q),
      insert: (row: Row) => ((mode = 'insert'), (payload = row), q),
      update: (row: Row) => ((mode = 'update'), (payload = row), q),
      delete: () => ((mode = 'delete'), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
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
      maybeSingle: () => Promise.resolve({ ...run(), data: (run().data as Row[] | null)?.[0] ?? null }),
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}
const setting = (key: string, value: string): Row => ({ key, value })

const NOW = new Date('2026-10-11T15:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const trip = (over: Partial<PromotionPackage> = {}): PromotionPackage => ({
  id: 'p1',
  slug: 'greek-isles-singles-cruise',
  name: 'Greek Isles Singles Cruise',
  destination: 'Greece',
  category: 'singles-cruise',
  short_description: 'A hosted singles cruise around the Greek islands.',
  highlights: ['Santorini', 'Mykonos'],
  keywords: ['greek islands singles trip', 'singles cruise greece'],
  itinerary: [{ title: 'Athens' }, { title: 'Santorini' }, { title: 'Mykonos' }],
  available_from: '2027-05-10',
  available_to: '2027-05-18',
  status: 'published',
  recap_mode: 'auto',
  ...over,
})

async function main() {
  // ---- the past-trip refusal ----
  check('a live trip with future dates can be promoted', canPromote(trip(), null, NOW).ok === true)
  const past = canPromote(trip({ available_to: '2026-09-01' }), null, NOW)
  check('a trip whose dates passed is refused', !past.ok && past.code === 'past')
  check('the refusal says the recap page does the promoting', !past.ok && /already happened; its recap page does the promoting/.test(past.reason))
  check('recap_mode "recap" refuses even with future dates', (canPromote(trip({ recap_mode: 'recap' }), null, NOW) as { code?: string }).code === 'past')
  check('recap_mode "live" keeps a trip with passed dates promotable', canPromote(trip({ available_to: '2026-09-01', recap_mode: 'live' }), null, NOW).ok === true)
  check('a draft trip is refused', (canPromote(trip({ status: 'draft' }), null, NOW) as { code?: string }).code === 'draft')
  check('a missing trip is refused', (canPromote(null, null, NOW) as { code?: string }).code === 'missing')

  // ---- the 30-day cap ----
  check('the gap is 30 days', PROMOTION_GAP_DAYS === 30)
  const recent = canPromote(trip(), daysAgo(10), NOW)
  check('promoted 10 days ago is refused', !recent.ok && recent.code === 'recent')
  check('the refusal says when it last ran and when it can run again', !recent.ok && /promoted on 2026-10-01/.test(recent.reason) && /again on 2026-10-31/.test(recent.reason))
  check('promoted 29 days ago is still refused', (canPromote(trip(), daysAgo(29), NOW) as { code?: string }).code === 'recent')
  check('promoted 31 days ago is allowed', canPromote(trip(), daysAgo(31), NOW).ok === true)
  check('a past trip is refused before the cap is looked at', (canPromote(trip({ available_to: '2026-09-01' }), daysAgo(1), NOW) as { code?: string }).code === 'past')

  // ---- phrases ----
  check('usablePhrase lowercases and drops symbols', usablePhrase('Greek Isles: Singles Cruise (8 Days)') === 'greek isles singles cruise 8 days')
  check('usablePhrase strips accents', usablePhrase('Café Île') === 'cafe ile')
  check('usablePhrase refuses more than 10 words', usablePhrase('one two three four five six seven eight nine ten eleven') === null)
  check('usablePhrase refuses a tiny phrase', usablePhrase('ab') === null)
  const phrases = buildPhrases(trip(), 'ca')
  check('phrases start with the trip name', phrases[0] === 'greek isles singles cruise')
  check('phrases include "<destination> group trip"', phrases.includes('greece group trip'))
  check('phrases include "<destination> <category>"', phrases.includes('greece singles cruise'))
  check('phrases include "<destination> from canada"', phrases.includes('greece from canada'))
  check('phrases include the trip\'s own keywords', phrases.includes('greek islands singles trip'))
  check('phrases are unique and within the cap', new Set(phrases).size === phrases.length && phrases.length <= MAX_PHRASES)
  check('a US site says "from the united states"', buildPhrases(trip(), 'us').includes('greece from the united states'))
  const many = buildPhrases(trip({ keywords: Array.from({ length: 20 }, (_, i) => `extra phrase ${i}`) }), 'ca')
  check('at most 5 of the trip\'s own keywords are used', many.filter((p) => p.startsWith('extra phrase')).length === 5)
  check('a trip with no destination still gets its name', buildPhrases(trip({ destination: null, category: null, keywords: [] }), 'ca').join(',') === 'greek isles singles cruise')

  // ---- named properties and guides ----
  const ship = namedProperties({ name: 'Rhine River Cruise', category: 'river-cruise', short_description: null })
  check('a river cruise name is a named river cruise', ship.length === 1 && ship[0].kind === 'river-cruises')
  check('an ordinary trip name names nothing', namedProperties(trip()).length === 0)
  const resort = namedProperties({ name: 'Cancun Girls Getaway', category: 'getaway', short_description: 'Stay at Sandals Royal Resort for the week.' })
  check('a capitalised "... Resort" in the description is a resort', resort.length === 1 && resort[0].name === 'Sandals Royal Resort' && resort[0].kind === 'resorts')
  check('a leading verb is not part of the name', namedProperties({ name: 'x trip', category: null, short_description: 'Enjoy Grand Palace Hotel on the beach.' })[0]?.name === 'Grand Palace Hotel')
  check('"Enjoy Resort" alone is not a name', namedProperties({ name: 'x trip', category: null, short_description: 'Enjoy Resort life.' }).length === 0)
  check('a lowercase "resort" names nothing', namedProperties({ name: 'x trip', category: null, short_description: 'a lovely beach resort with a pool' }).length === 0)
  const guides = planGuides({ name: 'Cancun Girls Getaway', destination: 'Cancun', category: 'getaway', short_description: 'Stay at Sandals Royal Resort for the week.' })
  check('guides: destination first, then the resort', guides.length === 2 && guides[0].kind === 'destinations' && guides[0].slug === 'cancun' && guides[1].kind === 'resorts')
  check('guides: a resort is parented to the destination page', guides[1].parent_slug === 'cancun')
  check('guides: an ordinary trip has just its destination', planGuides(trip()).length === 1)
  check('guides: no destination means no destination guide', planGuides(trip({ destination: '  ' })).length === 0)

  // ---- itinerary, month, facts ----
  check('itinerary places from an array of day objects', itineraryPlaces(trip().itinerary).join(',') === 'Athens,Santorini,Mykonos')
  check('itinerary places from an object holding days', itineraryPlaces({ days: [{ city: 'Rome' }, { name: 'Florence' }] }).join(',') === 'Rome,Florence')
  check('itinerary places from nothing is empty', itineraryPlaces(null).length === 0)
  check('travel month is read from the start date', travelMonth('2027-05-10') === 'May')
  check('travel month is null with no date', travelMonth(null) === null)
  const facts = packageFacts(trip())
  check('facts hold only real trip text', /Greek Isles/.test(facts) && /Santorini/.test(facts) && /May/.test(facts))

  // ---- the one AI call is bounded and its prompt holds only real text ----
  check('the AI call has an output budget', IDEAS_MAX_TOKENS > 0 && IDEAS_MAX_TOKENS <= 4000)
  const prompt = buildIdeasPrompt(trip(), phrases)
  check('prompt names the trip, the places and the tracked phrases', /Greek Isles Singles Cruise/.test(prompt) && /Athens; Santorini; Mykonos/.test(prompt) && /greece group trip/.test(prompt))
  const EM = String.fromCharCode(0x2014)
  const EN = String.fromCharCode(0x2013)
  check('prompt has no em or en dash', !prompt.includes(EM) && !prompt.includes(EN))
  check('prompt asks for at most MAX_IDEAS ideas', prompt.includes(`${MAX_IDEAS - 2} to ${MAX_IDEAS} blog post ideas`))

  // ---- idea validation ----
  const ctx = { phrases, facts, names: ['Greek Isles Singles Cruise', 'Greece'] }
  const good = { primary_keyword: 'greece group trip', title_idea: 'Is a group trip to Greece right for you?', angle: 'Helps a first-time traveller decide whether a hosted group trip to Greece suits them.', secondary_keywords: ['greece from canada', 'not a tracked phrase'] }
  const ok = validatePromotionIdea(good, ctx)
  check('a good idea passes', ok.ok === true)
  check('its secondary keywords keep only tracked phrases', ok.ok && ok.idea.keywords.join('|') === 'greece group trip|greece from canada')
  check('its keyword set starts with the primary', ok.ok && ok.idea.keywords[0] === ok.idea.keyword)
  const bad = (patch: Record<string, unknown>) => validatePromotionIdea({ ...good, ...patch }, ctx)
  check('a primary keyword that is not tracked is refused', !bad({ primary_keyword: 'cheap flights to athens' }).ok)
  check('a superlative is refused', !bad({ title_idea: 'The best group trip to Greece for you' }).ok)
  check('"best time" wording is allowed', bad({ title_idea: 'The best time for a group trip to Greece' }).ok === true)
  check('an invented number is refused', !bad({ angle: 'Seven things to know before a hosted group trip to Greece.' }).ok)
  check('an invented digit is refused', !bad({ angle: 'What a hosted group trip to Greece costs for 12 nights, in plain terms.' }).ok)
  check('a price is refused', !bad({ angle: 'A hosted group trip to Greece from $2,000 explained in plain terms.' }).ok)
  check('a first-person claim is refused', !bad({ angle: 'We visited Greece with a group and here is how a hosted trip works.' }).ok)
  check('an idea that does not name the trip or destination is refused', !bad({ primary_keyword: 'greek islands singles trip', title_idea: 'Is a singles holiday for you?', angle: 'Helps a solo traveller decide whether a hosted singles holiday suits them.' }).ok)
  check('a too-short title is refused', !bad({ title_idea: 'Greece' }).ok)
  check('a missing angle is refused', !bad({ angle: '' }).ok)
  const dashed = validatePromotionIdea({ ...good, title_idea: `Is a group trip to Greece right for you ${EM} or not?` }, ctx)
  check('a dash in the idea is replaced', dashed.ok && !dashed.idea.title_idea.includes(EM))
  check('a month from the trip text is allowed',validatePromotionIdea({ ...good, angle: 'Helps someone decide whether a May group trip to Greece suits them.' }, ctx).ok === true)
  check('a non-object idea is refused', !validatePromotionIdea('nope', ctx).ok)

  // ---- dedupe ----
  const ideas = [
    { keyword: 'greece group trip', keywords: ['greece group trip'], title_idea: 'Is a group trip to Greece right for you?', angle: 'a' },
    { keyword: 'greece singles cruise', keywords: ['greece singles cruise'], title_idea: 'How a singles cruise in the Greek Isles works', angle: 'b' },
    { keyword: 'greece singles cruise', keywords: ['greece singles cruise'], title_idea: 'Something else entirely about sailing alone', angle: 'c' },
  ]
  const d1 = dedupeIdeas(ideas, { posts: [], queue: [] })
  check('dedupe: a repeated keyword inside the batch is dropped', d1.kept.length === 2 && d1.dropped.length === 1)
  const d2 = dedupeIdeas(ideas, { posts: [], queue: [{ keyword: 'greece group trip' }] })
  check('dedupe: a keyword already in the queue is dropped', !d2.kept.some((i) => i.keyword === 'greece group trip'))
  const d3 = dedupeIdeas(ideas, { posts: ['Is a group trip to Greece right for you?'], queue: [] })
  check('dedupe: a title too close to an existing post is dropped', !d3.kept.some((i) => i.keyword === 'greece group trip'))
  const d4 = dedupeIdeas(ideas, { posts: [], queue: [{ keyword: 'other', keywords: ['greece singles cruise'] }] })
  check('dedupe: a keyword inside a queued idea\'s set is dropped', !d4.kept.some((i) => i.keyword === 'greece singles cruise'))

  // ---- the social ledger row ----
  check('slug is package-<slug>', packageDistributionSlug('greek-isles') === 'package-greek-isles')
  check('path is /packages/<slug>', packageDistributionPath('greek-isles') === '/packages/greek-isles')
  check('packageSlugFromPath reads a trip path', packageSlugFromPath('/packages/greek-isles') === 'greek-isles')
  check('packageSlugFromPath rejects a guide path', packageSlugFromPath('/hotels/x') === null)
  check('packageSlugFromPath rejects a nested path', packageSlugFromPath('/packages/a/b') === null)
  check('packageSlugFromPath rejects a full URL', packageSlugFromPath('https://evil.example/packages/x') === null)
  check('prepare mode holds the row', socialRowFor(trip(), 'prepare')?.stage === 'held')
  check('auto mode queues the row', socialRowFor(trip(), 'auto')?.stage === 'queued')
  check('off mode makes no row', socialRowFor(trip(), 'off') === null)
  check('the row carries the trip name, slug and path', (() => { const r = socialRowFor(trip(), 'auto'); return r?.title === 'Greek Isles Singles Cruise' && r.slug === 'package-greek-isles-singles-cruise' && r.path === '/packages/greek-isles-singles-cruise' && r.content_type === 'post' })())

  const base = (): Db => ({ tables: { app_settings: [setting('distribution_mode', 'auto')], post_distribution: [] } })
  let db = base()
  check('auto: the trip post is queued', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'queued' && db.tables.post_distribution.length === 1)
  check('the ledger row has the right slug, path and stage', db.tables.post_distribution[0].slug === 'package-greek-isles-singles-cruise' && db.tables.post_distribution[0].path === '/packages/greek-isles-singles-cruise' && db.tables.post_distribution[0].stage === 'queued')
  check('the same trip is not enrolled twice', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'skipped' && db.tables.post_distribution.length === 1)
  check('only one trip post a day across all trips', PACKAGE_ENROLMENTS_PER_DAY === 1 && (await enrolPackagePost(fakeAdmin(db), trip({ slug: 'other-trip', name: 'Other trip' }), NOW)).state === 'waiting' && db.tables.post_distribution.length === 1)
  db = base()
  db.tables.app_settings = [setting('distribution_mode', 'prepare')]
  check('prepare mode enrols the trip post as held', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'held' && db.tables.post_distribution[0]?.stage === 'held')
  db = base()
  db.tables.app_settings = [setting('distribution_mode', 'off')]
  check('off mode enrols nothing', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  db.tables.app_settings.push(setting('automation_paused', 'true'))
  check('paused automation enrols nothing', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  check('a past trip is never enrolled', (await enrolPackagePost(fakeAdmin(db), trip({ available_to: '2026-09-01' }), NOW)).state === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  check('a draft trip is never enrolled', (await enrolPackagePost(fakeAdmin(db), trip({ status: 'draft' }), NOW)).state === 'skipped' && db.tables.post_distribution.length === 0)
  db = base()
  db.tables.post_distribution.push({ content_type: 'post', slug: 'package-greek-isles-singles-cruise', path: '/packages/greek-isles-singles-cruise', stage: 'done', sent_platforms: ['facebook'], provider_request_id: 'req-1', provider_job_id: 'job-1', created_at: daysAgo(40) })
  check('a finished post over 30 days old is started again', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'queued' && db.tables.post_distribution[0].stage === 'queued' && (db.tables.post_distribution[0].sent_platforms as string[]).length === 0)
  check('starting it again clears the old provider ids', db.tables.post_distribution[0].provider_request_id === null && db.tables.post_distribution[0].provider_job_id === null)
  db = base()
  db.tables.post_distribution.push({ content_type: 'post', slug: 'package-greek-isles-singles-cruise', path: '/packages/greek-isles-singles-cruise', stage: 'done', sent_platforms: ['facebook'], created_at: daysAgo(10) })
  check('a post under 30 days old is left alone', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'skipped' && db.tables.post_distribution[0].stage === 'done')
  db = base()
  db.tables.post_distribution.push({ content_type: 'post', slug: 'guide-resorts-x', path: '/resorts/x', stage: 'queued', created_at: NOW.toISOString() })
  check('a guide post does not use up the trip post for the day', (await enrolPackagePost(fakeAdmin(db), trip(), NOW)).state === 'queued')

  // ---- compare and best-time note ----
  const cands = [
    { path: '/best-time-to-visit/greece', type: 'best-time' as const, hasRow: false },
    { path: '/compare/greece-vs-italy', type: 'compare' as const, hasRow: true },
  ]
  check('page note: best-time page in line, compare page found', /best-time page for Greece exists/.test(pageCopyNote('Greece', cands)) && /1 compare page include/.test(pageCopyNote('Greece', cands)))
  check('page note: nothing for an unknown destination', /no best-time page for Spain/.test(pageCopyNote('Spain', cands)))
  check('page note: no destination', /No destination is set/.test(pageCopyNote(null, cands)))

  // ---- the guide priority list ----
  const future = new Date(NOW.getTime() + 20 * 86_400_000).toISOString()
  const expired = new Date(NOW.getTime() - 86_400_000).toISOString()
  const stored = JSON.stringify([
    { kind: 'destinations', slug: 'greece', name: 'Greece', parent_slug: null, until: future, package_slug: 'greek-isles' },
    { kind: 'hotels', slug: 'old-hotel', name: 'Old Hotel', parent_slug: null, until: expired, package_slug: 'greek-isles' },
    { kind: 'nonsense', slug: 'x', name: 'X', until: future },
    { kind: 'ships', slug: '', name: 'No slug', until: future },
  ])
  const parsed = parseGuidePriority(stored, NOW)
  check('priority: keeps a well formed, unexpired entry', parsed.length === 1 && parsed[0].slug === 'greece')
  check('priority: drops expired and malformed entries', !parsed.some((p) => p.slug === 'old-hotel' || p.slug === 'x' || p.slug === ''))
  check('priority: a bad value is an empty list', parseGuidePriority('not json', NOW).length === 0 && parseGuidePriority(null, NOW).length === 0 && parseGuidePriority('{"a":1}', NOW).length === 0)

  // ---- how the priority changes the guide rotation ----
  const cand = (kind: GuideCandidate['kind'], slug: string, origin: GuideCandidate['origin'], priority = false): GuideCandidate => ({ kind, slug, name: slug, parent_slug: null, origin, priority })
  const guideDb = (): Db => ({ tables: { app_settings: [], guides: [] } })
  const normal = await pickNextCandidate(fakeAdmin(guideDb()), [cand('destinations', 'italy', 'destination'), cand('resorts', 'some-resort', 'package'), cand('hotels', 'seed-hotel', 'seed')])
  check('rotation: a plain package-origin name is still never picked', normal?.slug === 'italy')
  const promoted = await pickNextCandidate(fakeAdmin(guideDb()), [cand('destinations', 'italy', 'destination'), cand('resorts', 'sandals-royal', 'package', true), cand('hotels', 'seed-hotel', 'seed')])
  check('rotation: a promoted guide is picked first, even with origin "package"', promoted?.slug === 'sandals-royal')
  const promotedDest = await pickNextCandidate(fakeAdmin(guideDb()), [cand('resorts', 'sandals-royal', 'package', true), cand('destinations', 'cancun', 'destination', true)])
  check('rotation: among promoted guides the destination goes first', promotedDest?.slug === 'cancun')
  const onlyPlain = await pickNextCandidate(fakeAdmin(guideDb()), [cand('resorts', 'sandals-royal', 'package')])
  check('rotation: with no promotion a package-origin name is not picked', onlyPlain === null)
  const failedDb = guideDb()
  failedDb.tables.app_settings.push(setting('guides_compose_failures', JSON.stringify({ 'resorts:sandals-royal': { n: 2, name: 'x', kind: 'resorts', last: 'x', at: NOW.toISOString() } })))
  const skippedFailed = await pickNextCandidate(fakeAdmin(failedDb), [cand('resorts', 'sandals-royal', 'package', true), cand('destinations', 'italy', 'destination')])
  check('rotation: a promoted guide that failed twice is skipped like any other', skippedFailed?.slug === 'italy')

  // ---- QA round: wall, retry, guessed names, number words, months, proper nouns, states, claims, ids, dedupe ----
  const w = packageWall(true, NOW)
  check('wall: a promoted idea gets a 7 day window and is rescheduled, not used', w.days === 7 && w.reschedule === true && w.rescheduleTo === '2026-10-18')
  const w2 = packageWall(false, NOW)
  check('wall: every other topic keeps 30 days and no reschedule', w2.days === 30 && w2.reschedule === false)

  check('guessed names: a promoted property name is held as a draft', isGuessedProperty({ origin: 'package', priority: true }) === true)
  check('guessed names: a promoted destination is not held', isGuessedProperty({ origin: 'destination', priority: true }) === false)
  check('guessed names: an ordinary package-origin name is not touched here', isGuessedProperty({ origin: 'package' }) === false)

  for (const word of ['thirteen', 'nineteen', 'twenty', 'ninety', 'dozen', 'hundreds', 'thousands', 'million']) {
    check(`number word "${word}" is refused`, !validatePromotionIdea({ ...good, angle: `Helps a reader decide whether a group trip to Greece with ${word} others suits them.` }, ctx).ok)
  }
  check('month: a month not in the trip text is refused', !validatePromotionIdea({ ...good, angle: 'Helps a reader decide whether a hosted group trip to Greece in June suits them.' }, ctx).ok)
  check('month: the trip\'s own travel month is allowed', validatePromotionIdea({ ...good, angle: 'Helps a reader decide whether a hosted group trip to Greece in May suits them.' }, ctx).ok === true)
  check('month: "may" as a plain word is not a month', validatePromotionIdea({ ...good, angle: 'Helps a reader who may want a hosted group trip to Greece decide if it suits them.' }, ctx).ok === true)
  check('proper noun: a place not in the trip text is refused', !validatePromotionIdea({ ...good, angle: 'Helps a reader decide whether a hosted group trip to Greece and Crete suits them.' }, ctx).ok)
  check('proper noun: a place on the itinerary is allowed', validatePromotionIdea({ ...good, angle: 'Helps a reader decide whether a hosted group trip to Greece with Santorini suits them.' }, ctx).ok === true)
  check('proper noun: a sentence start is not a place name', validatePromotionIdea({ ...good, angle: 'Helps a reader decide if a hosted group trip to Greece suits them. Nothing else is assumed.' }, ctx).ok === true)

  check('state: pause is refused on a finished promotion', actionBlockedReason('pause', 'done') !== null)
  check('state: resume is refused on a finished promotion', actionBlockedReason('resume', 'done') !== null)
  check('state: retry-ideas and retry-social are refused on a finished promotion', actionBlockedReason('retry-ideas', 'done') !== null && actionBlockedReason('retry-social', 'done') !== null)
  check('state: pause works on an active promotion, resume only on a paused one', actionBlockedReason('pause', 'active') === null && actionBlockedReason('resume', 'active') !== null && actionBlockedReason('resume', 'paused') === null)
  check('state: retry-ideas needs an active promotion', actionBlockedReason('retry-ideas', 'active') === null && actionBlockedReason('retry-ideas', 'paused') !== null)
  check('state: finishing is allowed from active or paused, once', actionBlockedReason('done', 'active') === null && actionBlockedReason('done', 'paused') === null && actionBlockedReason('done', 'done') !== null)

  check('claim: an empty plan older than 10 minutes is abandoned', isAbandonedClaim({ plan: {} as never, started_at: new Date(NOW.getTime() - 11 * 60_000).toISOString() }, NOW) === true)
  check('claim: a fresh empty plan is still in progress', isAbandonedClaim({ plan: {} as never, started_at: new Date(NOW.getTime() - 2 * 60_000).toISOString() }, NOW) === false)
  check('claim: a filled plan is never abandoned', isAbandonedClaim({ plan: { version: 1 } as never, started_at: daysAgo(3) }, NOW) === false)
  check('ids: a real uuid passes, junk does not', isUuid('0b6f2c1e-8a41-4f3a-9d57-1c2e3f4a5b6c') && !isUuid('abc') && !isUuid("1'; drop table x;--"))

  const used = { keyword: 'greece group trip', keywords: ['greece group trip'], title_idea: 'Old title about something else', angle: 'old', status: 'used', package_slug: 'greek-isles-singles-cruise' }
  const dd1 = dedupeIdeas(ideas, { posts: [], queue: [used], packageSlug: 'greek-isles-singles-cruise' })
  check('dedupe: a used idea of the SAME trip does not block a new idea', dd1.kept.some((i) => i.keyword === 'greece group trip'))
  const dd2 = dedupeIdeas(ideas, { posts: [], queue: [{ ...used, package_slug: 'another-trip' }], packageSlug: 'greek-isles-singles-cruise' })
  check('dedupe: a used idea of ANOTHER trip still blocks', !dd2.kept.some((i) => i.keyword === 'greece group trip'))
  const dd3 = dedupeIdeas(ideas, { posts: [], queue: [{ ...used, status: 'approved' }], packageSlug: 'greek-isles-singles-cruise' })
  check('dedupe: an open idea of the same trip still blocks', !dd3.kept.some((i) => i.keyword === 'greece group trip'))

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
