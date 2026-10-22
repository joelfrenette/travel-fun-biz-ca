// Offline check: Posts menu phase 2 (the Guides and Trips pages). No database, no network.
// Run: pnpm dlx tsx scripts/check-posts-menu-2.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GUESSED_PUBLISH_MESSAGE, GUIDE_EXCLUDED_KEY, TOGGLE_KEYS, addExcluded, distinctTripValues, filterTripsExtra, guideExcludeKey, guidePublishBlock, guideTotals,
  hasGuessedNameNote, isExactTrue, isHeldGuide, matchesGuideFlag, parseExcludedList, parseGuideFlag, parseToggleRequest, tripTotals, EMPTY_TRIP_FILTER,
} from '../lib/posts-menu-2'
import { GUESSED_PROPERTY_NOTE, isGuessedPropertyNote } from '../lib/guide-run'
import { SAFE_PAGE_NOTE, isSafePageNote } from '../lib/guides'
import { DEFAULT_QUERY, parseListQuery, queryGuideRows, type GuideListRow } from '../lib/guide-list'
import { GUIDE_CATCHUP_KEY } from '../lib/guide-distribution'
import { TRIP_SOCIAL_KEY, TRIP_ENROLMENTS_PER_WEEK, TRIP_HOLD_HOURS, parseTripSocial } from '../lib/trip-social'
import { PROMOTION_GAP_DAYS } from '../lib/promotion'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// --- the two switches: only the exact text 'true' is on ---
expect('only exact "true" is on', isExactTrue('true') && !isExactTrue('TRUE') && !isExactTrue('True') && !isExactTrue('on') && !isExactTrue('1') && !isExactTrue('yes') && !isExactTrue('') && !isExactTrue(null) && !isExactTrue(undefined))
expect('same rule as the trip pipeline parser', ['true', 'TRUE', 'on', '1', '', null, undefined, 'false'].every((v) => isExactTrue(v as string | null | undefined) === parseTripSocial(v as string | null | undefined)))
expect('the toggle keys are the real pipeline keys', TOGGLE_KEYS.includes(GUIDE_CATCHUP_KEY as never) && TOGGLE_KEYS.includes(TRIP_SOCIAL_KEY as never) && TOGGLE_KEYS.includes('news_social_posts' as never) && TOGGLE_KEYS.length === 3)
const ok1 = parseToggleRequest({ setting: 'trip_social_posts', enabled: true })
const ok2 = parseToggleRequest({ setting: 'guide_catchup_posts', enabled: false })
expect('a real boolean stores the exact text true or false', ok1.ok && ok1.value === 'true' && ok2.ok && ok2.value === 'false')
for (const [label, body] of [
  ['the string "true"', { setting: 'trip_social_posts', enabled: 'true' }],
  ['the number 1', { setting: 'trip_social_posts', enabled: 1 }],
  ['a missing value', { setting: 'trip_social_posts' }],
  ['null', { setting: 'trip_social_posts', enabled: null }],
  ['an unknown setting', { setting: 'autoblog_mode', enabled: true }],
  ['a missing setting', { enabled: true }],
  ['a non-object body', 'true'],
  ['no body', null],
] as [string, unknown][]) {
  expect(`toggle refuses ${label}`, parseToggleRequest(body).ok === false)
}

// --- do-not-recreate list ---
expect('exclude key is kind:slug', guideExcludeKey('hotels', 'sandals-royal') === 'hotels:sandals-royal')
const first = addExcluded(null, 'hotels', 'sandals-royal')
expect('adding to an empty list stores one key', first.ok && first.added && JSON.stringify(parseExcludedList(first.ok ? first.value : '')) === JSON.stringify(['hotels:sandals-royal']))
const again = first.ok ? addExcluded(first.value, 'hotels', 'sandals-royal') : first
expect('adding the same key twice keeps one copy', again.ok && !again.added && parseExcludedList(again.ok ? again.value : '').length === 1)
const second = first.ok ? addExcluded(first.value, 'ships', 'a-ship') : first
expect('a second key is appended, the first is kept', second.ok && JSON.stringify(parseExcludedList(second.ok ? second.value : '')) === JSON.stringify(['hotels:sandals-royal', 'ships:a-ship']))
expect('existing entries survive, even odd ones', (() => { const r = addExcluded(JSON.stringify(['legacy', 'hotels:x']), 'ships', 'y'); return r.ok && parseExcludedList(r.value).join('|') === 'legacy|hotels:x|ships:y' })())
expect('bad JSON or a non-array reads as empty and is replaced safely', parseExcludedList('{oops').length === 0 && parseExcludedList('{"a":1}').length === 0 && addExcluded('{oops', 'hotels', 'a').ok)
expect('a key that is not kind:slug is refused', !addExcluded(null, 'Hotels', 'a b').ok && !addExcluded(null, '', 'x').ok && !addExcluded(null, 'hotels', '').ok)
expect('the list key matches the one listGuideCandidates reads', GUIDE_EXCLUDED_KEY === 'guide_excluded' && /eq\('key', 'guide_excluded'\)/.test(read('lib/guides.ts')))

// --- the delete route: exclusion first, restored if the delete fails ---
const del = read('app/api/admin/guides/[id]/route.ts')
const delBody = del.slice(del.indexOf('export async function DELETE'))
expect('delete adds the exclusion before deleting, only when asked', delBody.indexOf('addExcluded') > 0 && delBody.indexOf('addExcluded') < delBody.indexOf('deleteGuide(') && /body\.doNotRecreate === true/.test(delBody))
expect('delete puts the list back if the delete fails', /if \(restore !== undefined\) await setSetting\(admin, GUIDE_EXCLUDED_KEY, restore/.test(delBody))
expect('delete refuses to go on if the list cannot be read or saved', /nothing was deleted/.test(delBody) && (delBody.match(/nothing was deleted/g) ?? []).length >= 2)

// --- guessed-name publish is blocked ---
expect('the guessed wording matches the pipeline note', hasGuessedNameNote(GUESSED_PROPERTY_NOTE) && isGuessedPropertyNote(GUESSED_PROPERTY_NOTE))
expect('a draft with the guessed note cannot be published', guidePublishBlock({ status: 'draft', quality_notes: GUESSED_PROPERTY_NOTE }) === GUESSED_PUBLISH_MESSAGE)
expect('the note joined with other reasons still blocks', guidePublishBlock({ status: 'draft', quality_notes: `a price was not found; ${GUESSED_PROPERTY_NOTE}` }) !== null)
expect('other drafts and live pages are not blocked', guidePublishBlock({ status: 'draft', quality_notes: null }) === null && guidePublishBlock({ status: 'draft', quality_notes: 'a number was not found' }) === null && guidePublishBlock({ status: 'published', quality_notes: GUESSED_PROPERTY_NOTE }) === null)
expect('the publish route checks it on the server, before it publishes', (() => { const i = del.indexOf('guidePublishBlock(current)'); return i > 0 && i < del.indexOf('setGuideStatus(getSupabaseAdmin()') && /status: 409/.test(del.slice(i, i + 200)) })())
expect('the list page disables the Publish button for it', /guidePublishBlock\(r\)/.test(read('app/admin/guides/page.tsx')) && /disabled=\{!!busy \|\| !!publishBlock\}/.test(read('app/admin/guides/page.tsx')))
expect('the heal route never publishes a guessed page by itself (it uses the same healGuideRow)', /healGuideRow\(/.test(read('app/api/admin/guides/[id]/heal/route.ts')))

// --- guides list: filters and counts ---
const GUIDE_ROWS = [
  { status: 'published', source: 'ai', review_state: null, quality_notes: null },
  { status: 'published', source: 'ai', review_state: null, quality_notes: SAFE_PAGE_NOTE },
  { status: 'draft', source: 'ai', review_state: null, quality_notes: 'held for review (guides_publish_mode=draft)' },
  { status: 'draft', source: 'ai', review_state: null, quality_notes: GUESSED_PROPERTY_NOTE },
  { status: 'draft', source: 'ai', review_state: 'rejected', quality_notes: 'a number was not found' },
  { status: 'draft', source: 'manual', review_state: null, quality_notes: null },
]
const t = guideTotals(GUIDE_ROWS)
expect('header totals: total, live, drafts, review, rejected, held, safe', t.total === 6 && t.live === 2 && t.drafts === 4 && t.review === 2 && t.rejected === 1 && t.held === 2 && t.safe === 1, JSON.stringify(t))
expect('safe-page text agrees with lib/guides', GUIDE_ROWS.every((r) => (r.quality_notes?.trim().startsWith('safe-page:') ?? false) === isSafePageNote(r.quality_notes)))
expect('the review-mode note alone is not "held"', !isHeldGuide({ status: 'draft', quality_notes: 'held for review (guides_publish_mode=draft)' }) && isHeldGuide({ status: 'draft', quality_notes: GUESSED_PROPERTY_NOTE }))
expect('flag filter: safe, held, guessed', matchesGuideFlag(GUIDE_ROWS[1], 'safe') && !matchesGuideFlag(GUIDE_ROWS[0], 'safe') && matchesGuideFlag(GUIDE_ROWS[4], 'held') && matchesGuideFlag(GUIDE_ROWS[3], 'guessed') && !matchesGuideFlag(GUIDE_ROWS[4], 'guessed') && matchesGuideFlag(GUIDE_ROWS[0], ''))
expect('an unknown flag falls back to no filter', parseGuideFlag('nonsense') === '' && parseGuideFlag('safe') === 'safe' && parseGuideFlag(null) === '')

const mk = (o: Partial<GuideListRow> & { slug: string }): GuideListRow => ({ id: o.slug, kind: 'hotels', name: o.slug, parent_slug: null, scope: null, status: 'draft', source: 'ai', review_state: null, quality_notes: null, updated_at: '2026-10-01T00:00:00Z', words: 100, score: null, inbound: 0, clicks: null, path: `/hotels/${o.slug}`, primary_keyword: null, ...o })
const list: GuideListRow[] = [
  mk({ slug: 'a', status: 'published', quality_notes: SAFE_PAGE_NOTE, parent_slug: 'cancun' }),
  mk({ slug: 'b', quality_notes: GUESSED_PROPERTY_NOTE, parent_slug: 'cancun' }),
  mk({ slug: 'c', status: 'published', parent_slug: 'fiji' }),
]
const params = (o: Record<string, string>) => parseListQuery({ get: (k: string) => o[k] ?? null }, ['hotels', 'ships'])
expect('default query has no flag or parent', DEFAULT_QUERY.flag === '' && DEFAULT_QUERY.parent === '')
expect('list filters by flag', queryGuideRows(list, params({ flag: 'safe' })).rows.map((r) => r.slug).join() === 'a' && queryGuideRows(list, params({ flag: 'guessed' })).rows.map((r) => r.slug).join() === 'b')
expect('list filters by parent', queryGuideRows(list, params({ parent: 'cancun', sort: 'name', dir: 'asc' })).rows.map((r) => r.slug).join() === 'a,b' && queryGuideRows(list, params({ parent: 'fiji' })).rows.length === 1)
expect('a hand-typed parent cannot carry odd characters', params({ parent: 'Cancun; DROP' }).parent === 'cancundrop')
expect('sort by name, kind and updated still work', ['name', 'kind', 'updated'].every((s) => params({ sort: s }).sort === s))

// --- trips: filters and counts ---
const TRIPS = [
  { status: 'published', supplier: 'Sandals', country: 'Jamaica', available_from: '2026-12-01' },
  { status: 'draft', supplier: 'sandals', country: 'Mexico', available_from: '2027-02-01' },
  { status: 'archived', supplier: null, country: null, available_from: null },
  { status: 'published', supplier: 'Beaches', country: 'Jamaica', available_from: '2026-11-10' },
]
expect('trip supplier filter ignores case', filterTripsExtra(TRIPS, { ...EMPTY_TRIP_FILTER, supplier: 'SANDALS' }).length === 2)
expect('trip country filter', filterTripsExtra(TRIPS, { ...EMPTY_TRIP_FILTER, country: 'jamaica' }).length === 2)
expect('trip date range keeps only dated trips inside it', filterTripsExtra(TRIPS, { ...EMPTY_TRIP_FILTER, from: '2026-11-01', to: '2026-12-31' }).length === 2 && filterTripsExtra(TRIPS, { ...EMPTY_TRIP_FILTER, from: '2000-01-01' }).length === 3)
expect('blank filters keep everything', filterTripsExtra(TRIPS, EMPTY_TRIP_FILTER).length === 4)
expect('distinct values: one spelling each, A to Z, blanks skipped', distinctTripValues(TRIPS, 'supplier').join() === 'Beaches,Sandals' && distinctTripValues(TRIPS, 'country').join() === 'Jamaica,Mexico')
const tt = tripTotals(TRIPS, (r) => r.status === 'archived')
expect('trip totals', tt.total === 4 && tt.published === 2 && tt.drafts === 1 && tt.archived === 1 && tt.past === 1)

// --- trip caps text matches the code ---
const api = read('app/api/admin/posts/automation/route.ts')
expect('trip caps come from the real constants (30 days, 2 a week, 24h)', PROMOTION_GAP_DAYS === 30 && TRIP_ENROLMENTS_PER_WEEK === 2 && TRIP_HOLD_HOURS === 24 && /\$\{PROMOTION_GAP_DAYS\}/.test(api) && /\$\{TRIP_ENROLMENTS_PER_WEEK\}/.test(api) && /\$\{TRIP_HOLD_HOURS\}/.test(api))

// --- every handler checks isAuthorized first ---
for (const f of ['app/api/admin/posts/automation/route.ts', 'app/api/admin/guides/[id]/route.ts', 'app/api/admin/guides/[id]/heal/route.ts', 'app/api/admin/guides/list/route.ts']) {
  const s = read(f)
  const handlers = [...s.matchAll(/export async function (GET|POST|PATCH|DELETE)\(request: Request[^\n]*\) \{\r?\n\s*(.*)/g)]
  expect(`${f}: every handler's first line is the isAuthorized check`, handlers.length > 0 && handlers.every((m) => /isAuthorized\(request\)/.test(m[2])), handlers.map((m) => `${m[1]}:${m[2]}`).join(' | '))
}
expect('the automation POST validates through parseToggleRequest and stores nothing else', /parseToggleRequest\(/.test(api) && /setSetting\(getSupabaseAdmin\(\), parsed\.key, parsed\.value\)/.test(api))
expect('automation GET accepts guides and trips', /type !== 'guides' && type !== 'trips'/.test(api))
expect('Heal now is only ever a POST behind a click (no cron or GET calls it)', !/healGuideRow/.test(api) && /export async function POST/.test(read('app/api/admin/guides/[id]/heal/route.ts')) && !/export async function GET/.test(read('app/api/admin/guides/[id]/heal/route.ts')))

// --- wiring ---
const guidesPage = read('app/admin/guides/page.tsx')
expect('guides page: shared header, automation card, thumbnail, enrichment card and backfill card all present', /<PostsPageHeader/.test(guidesPage) && /<GuidesAutomationCard/.test(guidesPage) && /<PostThumb type="guide"/.test(guidesPage) && /<GuidesEnrichmentCard/.test(guidesPage) && /<GuidesBackfillCard/.test(guidesPage) && /<GuidesPanel variant="full"/.test(guidesPage))
expect('guides page: delete dialog has a do-not-recreate checkbox that starts ON', /useState\(true\)/.test(guidesPage) && /setDoNotRecreate\(true\)/.test(guidesPage) && /doNotRecreate/.test(guidesPage))
const pk = read('app/admin/packages/page.tsx')
expect('trips page: shared header, automation card and trip thumbnail', /<PostsPageHeader/.test(pk) && /<TripsAutomationCard/.test(pk) && /<PostThumb type="trip"/.test(pk))
expect('trips page keeps its existing features', ['PackageSourcesPanel', 'PastTripPanel', 'PromotePanel', 'handleBulkPublish', 'handleSync', 'AgentInvitesCard', 'UploadExcelForm', 'ScrapeUrlForm'].every((n) => pk.includes(n)))
expect('both automation cards flip a switch only through the POST route', /setting: "guide_catchup_posts"/.test(read('components/admin/guides-automation-card.tsx')) && /setting: "trip_social_posts"/.test(read('components/admin/trips-automation-card.tsx')))

// --- no em dashes in what this change adds ---
const EM = String.fromCharCode(0x2014)
for (const f of [
  'lib/posts-menu-2.ts', 'components/admin/guides-automation-card.tsx', 'components/admin/trips-automation-card.tsx', 'components/admin/posts-page-header.tsx',
  'app/api/admin/posts/automation/route.ts', 'app/api/admin/guides/[id]/heal/route.ts', 'app/api/admin/guides/[id]/route.ts', 'app/api/admin/guides/list/route.ts',
  'app/admin/guides/page.tsx', 'lib/guide-list.ts', 'scripts/check-posts-menu-2.ts',
]) expect(`no em dash in ${f}`, !read(f).includes(EM))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
