// Offline check for the guide photo loop: query variants per kind, the accept rules (banned, wrong subject, already used, landscape, 1600px),
// honest alt text (no brand claims), which guides are flagged, the step limits (3 a day, 2 variants a day), the attempts memory, the heal
// wiring and the admin counter. The Pexels search, the address check and the AI illustration are all fakes: nothing here touches the network
// or a database.
// Run: pnpm dlx tsx scripts/check-guide-photo.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GUIDE_PHOTOS_PER_DAY,
  VARIANTS_PER_DAY,
  advanceAttempt,
  buildQueryVariants,
  chooseGuidePhoto,
  collectUsed,
  flaggedGuides,
  guideIllustrationAlt,
  guidePhotoAlt,
  guidesLeftToday,
  orderTargets,
  parseAttempts,
  photoIdOfUrl,
  placeOf,
  rejectReason,
  subjectTypeOf,
  type GuidePhotoGuide,
} from '../lib/guide-photo'
import { countGuidesNeedingPhoto, runGuidePhotoHeal, verifyImageUrl } from '../lib/guide-photo-run'
import { columnsFor } from '../lib/content-edits'
import { isBannedAlt, type PhotoCandidate } from '../lib/photo-score'
import { isGenericAlt } from '../lib/image-quality'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
delete process.env.INDEXNOW_KEY
const LONG_DASH = new RegExp(String.fromCharCode(91, 0x2013, 0x2014, 93)) // an en or em dash

const px = (id: number, w = 940, h = 650) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=${h}&w=${w}`
const cand = (id: number, alt: string | null, width = 4000, height = 2600): PhotoCandidate => ({ id, url: px(id), alt, width, height })
const noUsed = collectUsed([])

// --- variants per kind ---
const all = new Map<string, { name: string; kind: string; parentSlug: string | null }>([
  ['caribbean', { name: 'Caribbean', kind: 'destinations', parentSlug: null }],
  ['cancun', { name: 'Cancun', kind: 'destinations', parentSlug: 'mexico' }],
  ['celebrity-cruises', { name: 'Celebrity Cruises', kind: 'cruise-lines', parentSlug: null }],
])
const placeShip = placeOf({ kind: 'ships', name: 'Celebrity Edge', parentSlug: 'celebrity-cruises' }, all)
expect('a ship under a cruise line (a brand) has no place: the brand is never used as one', placeShip === '')
expect('a resort under a destination takes that destination as its place', placeOf({ kind: 'resorts', name: 'Royalton Riviera Cancun', parentSlug: 'cancun' }, all) === 'Cancun')
expect('a destination is its own place', placeOf({ kind: 'destinations', name: 'Paris', parentSlug: null }, all) === 'Paris')
expect('a river cruise guide named for a river uses it as the region; a river cruise brand does not', placeOf({ kind: 'river-cruises', name: 'Rhine River', parentSlug: null }, all) === 'Rhine River' && placeOf({ kind: 'river-cruises', name: 'AmaWaterways', parentSlug: null }, all) === '' && placeOf({ kind: 'river-cruises', name: 'Uniworld Boutique River Cruises', parentSlug: null }, all) === '')

const vShip = buildQueryVariants('ships', 'Celebrity Edge', 'Caribbean')
expect('cruise ship variants: name first, then region, then deck/sunset', vShip[0] === 'Celebrity Edge cruise ship' && vShip[1] === 'Caribbean cruise ship sea' && vShip.includes('cruise ship deck ocean sunset') && vShip.length >= 4, JSON.stringify(vShip))
const vRiver = buildQueryVariants('river-cruises', 'Rhine River', 'Rhine River')
expect('river cruise variants mention a river cruise ship and the region', vRiver.some((q) => q === 'river cruise ship Rhine River') && vRiver.every((q) => /river/.test(q)), JSON.stringify(vRiver))
const vResort = buildQueryVariants('resorts', 'Atlantis Paradise Island', 'Bahamas')
expect('resort variants: luxury resort pool <destination> first', vResort[0] === 'luxury resort pool Bahamas' && vResort.length >= 4, JSON.stringify(vResort))
expect('hotel variants name a hotel', buildQueryVariants('hotels', 'X Hotel', 'Paris')[0] === 'luxury hotel Paris')
expect('destination variants: landscape travel first', buildQueryVariants('destinations', 'Lisbon', 'Lisbon')[0] === 'Lisbon landscape travel')
expect('yacht variants start with the tall ship sailing yacht search', buildQueryVariants('yachts', 'Sea Cloud', '')[0] === 'tall ship sailing yacht')
expect('no variant list repeats a query, and an unknown kind has none', (() => { const v = buildQueryVariants('ships', 'x', ''); return new Set(v.map((q) => q.toLowerCase())).size === v.length })() && buildQueryVariants('cars', 'x', '').length === 0)
expect('every guide kind has a subject type, and nothing else', ['destinations', 'hotels', 'resorts', 'cruise-lines', 'ships', 'river-cruises', 'yachts'].every((k) => subjectTypeOf(k) !== null) && subjectTypeOf('cars') === null)

// --- accept rules ---
const ship = subjectTypeOf('ships')!
const q = 'Caribbean cruise ship sea'
expect('a good landscape cruise ship photo is accepted', rejectReason(cand(1, 'A cruise ship sailing at sea'), ship, q, noUsed) === null)
expect('a banned subject is rejected', rejectReason(cand(2, 'Laptop on a desk by the sea cruise ship'), ship, q, noUsed) === 'banned')
expect('a photo under 1600px wide is rejected', rejectReason(cand(3, 'Cruise ship at sea', 1500, 1000), ship, q, noUsed) === 'too-small')
expect('a portrait photo is rejected', rejectReason(cand(4, 'Cruise ship at sea', 1700, 2400), ship, q, noUsed) === 'not-landscape')
expect('a photo of the wrong type of subject is rejected (a described mountain for a ship)', rejectReason(cand(5, 'Snowy mountain peak at dawn'), ship, q, noUsed) === 'wrong-subject')
expect('a photo with no description is accepted on the query alone', rejectReason(cand(6, null), ship, q, noUsed) === null)
expect('a photo already used (same id, even at another address) is rejected', rejectReason(cand(7, 'Cruise ship'), ship, q, collectUsed([px(7, 1880, 1300)])) === 'already-used' && photoIdOfUrl(px(7)) === 7)
expect('a photo already used (same address, other query string) is rejected', rejectReason({ ...cand(8, 'Cruise ship'), url: 'https://cdn.example.com/a/b.jpg?x=1' }, ship, q, collectUsed(['https://cdn.example.com/a/b.jpg?x=2'])) === 'already-used')
expect('a rendered /og/ card is not counted as a used photo', collectUsed(['https://www.travelfunbiz.ca/og/blog/x']).keys.size === 0)
expect('a resort photo must look like a resort, not a ship', rejectReason(cand(9, 'Large cruise ship docked'), subjectTypeOf('resorts')!, 'luxury resort pool Cancun', noUsed) === 'wrong-subject' && rejectReason(cand(10, 'Infinity pool at a luxury resort'), subjectTypeOf('resorts')!, 'luxury resort pool Cancun', noUsed) === null)

// --- honest alt text ---
const g1: GuidePhotoGuide = { id: 'g1', kind: 'cruise-lines', slug: 'celebrity-cruises', name: 'Celebrity Cruises', parentSlug: null, hero: px(100), alt: 'Cruise ship', date: '2026-02-01' }
for (const [kind, name, place] of [['cruise-lines', 'Celebrity Cruises', ''], ['ships', 'Disney Wish', 'Bahamas'], ['resorts', 'Atlantis Paradise Island', 'Bahamas'], ['river-cruises', 'AmaWaterways', ''], ['yachts', 'Sea Cloud', ''], ['destinations', 'Cancun', 'Cancun'], ['hotels', 'Grand Hotel', 'Rome']] as const) {
  const alt = guidePhotoAlt(kind, place)
  const brand = kind === 'destinations' ? null : name
  expect(`alt text for ${kind} is descriptive, honest and not a banned subject: "${alt}"`, alt.startsWith('Illustrative stock photo: ') && !isGenericAlt(alt) && !isBannedAlt(alt) && (!brand || !alt.toLowerCase().includes(brand.toLowerCase())) && !/\b(official|actual|the real)\b/i.test(alt))
}
expect('the illustration alt says it is an illustration', guideIllustrationAlt('ships', 'Bahamas').startsWith('Illustration: '))
expect('alt text never carries a long dash', !LONG_DASH.test(guidePhotoAlt('ships', 'Bahamas')))

// --- which guides are flagged ---
const gd = (id: string, kind: string, slug: string, hero: string | null, date: string, parent: string | null = null, alt: string | null = 'Cruise ship at sea'): GuidePhotoGuide => ({ id, kind, slug, name: slug, parentSlug: parent, hero, alt, date })
const flagged = flaggedGuides(
  [gd('a', 'ships', 'old-ship', px(100), '2026-01-01'), gd('b', 'cruise-lines', 'celebrity-cruises', px(100), '2026-02-01'), gd('c', 'resorts', 'no-photo', null, '2026-03-01'), gd('d', 'yachts', 'tiny', px(300, 480, 320), '2026-03-02'), gd('e', 'hotels', 'good', px(500), '2026-03-03'), gd('f', 'ships', 'laptop', px(600), '2026-03-04', null, 'Laptop on a desk')],
  [{ url: px(500), date: '2026-04-01' }],
)
const flagSlugs = flagged.map((f) => f.guide.slug)
expect('the later duplicate is flagged, the earliest keeps the picture', flagSlugs.includes('celebrity-cruises') && !flagSlugs.includes('old-ship'))
expect('missing, tiny and wrong-subject heroes are flagged', flagSlugs.includes('no-photo') && flagSlugs.includes('tiny') && flagSlugs.includes('laptop'))
expect('a good unique hero is not flagged (a later post copy does not flag the guide)', !flagSlugs.includes('good'))
expect('a hero that is a duplicate of an EARLIER post is flagged', flaggedGuides([gd('z', 'ships', 'copy', px(900), '2026-05-01')], [{ url: px(900), date: '2026-01-01' }]).length === 1)
expect('a broken address is flagged only when it is passed in as broken', flaggedGuides([gd('z', 'ships', 'b', px(901), '2026-05-01')], []).length === 0 && flaggedGuides([gd('z', 'ships', 'b', px(901), '2026-05-01')], [], new Set([px(901)])).length === 1)

// --- choosing for one guide (fake search) ---
async function main() {
  const calls: string[] = []
  const search = async (query: string): Promise<PhotoCandidate[]> => {
    calls.push(query)
    if (/^Celebrity Cruises cruise ship$/.test(query)) return [cand(100, 'Cruise ship'), cand(101, 'Laptop with a cruise itinerary'), cand(102, 'Mountain lake', 4000, 2600)] // nothing acceptable
    const base = /resort/.test(query) ? 300 : /yacht|sail/.test(query) ? 400 : 200
    const word = /resort/.test(query) ? 'Resort pool with palm trees' : /yacht|sail/.test(query) ? 'Sailing yacht at sea' : 'A cruise ship at sea'
    return [0, 1, 2, 3, 4, 5].map((i) => cand(base + i, `${word} ${i}`))
  }
  const choice = await chooseGuidePhoto(g1, all, collectUsed([px(100)]), search, {})
  expect('chooser skips a variant with nothing acceptable and uses the next one', !!choice && choice.tried.length === 2 && choice.tried[0].query === 'Celebrity Cruises cruise ship' && choice.picks.length > 0 && choice.picks[0].query === 'cruise ship sea', JSON.stringify(choice?.tried))
  expect('the chosen photo is never the one already used', !!choice && choice.picks.every((p) => p.candidate.id !== 100))
  const limited = await chooseGuidePhoto(g1, all, noUsed, async () => [], { maxVariants: VARIANTS_PER_DAY })
  expect('with nothing found the chooser stops after the daily number of variants and says it is not exhausted yet', !!limited && limited.tried.length === VARIANTS_PER_DAY && !limited.exhausted && limited.nextIndex === VARIANTS_PER_DAY && limited.picks.length === 0)
  const tail = await chooseGuidePhoto(g1, all, noUsed, async () => [], { startIndex: VARIANTS_PER_DAY, maxVariants: VARIANTS_PER_DAY })
  expect('once the last variants are tried it is exhausted and starts over at 0', !!tail && tail.exhausted && tail.nextIndex === 0)
  const threw = await chooseGuidePhoto(g1, all, noUsed, async () => { throw new Error('boom') }, { maxVariants: 1 })
  expect('a failing search counts as nothing found and never throws', !!threw && threw.picks.length === 0)
  expect('an unknown kind is skipped', (await chooseGuidePhoto({ ...g1, kind: 'cars' }, all, noUsed, search, {})) === null)

  // --- attempts and limits ---
  expect('attempts: parse is defensive', JSON.stringify(parseAttempts('nope')) === '{}' && JSON.stringify(parseAttempts('[1]')) === '{}' && parseAttempts('{"ships/a":{"n":2,"at":"2026-01-01T00:00:00.000Z","last":"x"},"b":{"n":"x"}}')['ships/a']?.n === 2 && !('b' in parseAttempts('{"b":{"n":"x"}}')))
  const a1 = advanceAttempt(undefined, 2, 4, 'none', new Date('2026-10-01T00:00:00Z'))
  const a2 = advanceAttempt(a1, 2, 4, 'none', new Date('2026-10-02T00:00:00Z'))
  expect('attempts move to the next variants day by day and start over after the last', a1.n === 2 && a2.n === 0 && a2.at.startsWith('2026-10-02'))
  expect('the daily limit is 3 guides', GUIDE_PHOTOS_PER_DAY === 3 && guidesLeftToday(0) === 3 && guidesLeftToday(2) === 1 && guidesLeftToday(3) === 0 && guidesLeftToday(9) === 0)
  const ordered = orderTargets(
    [{ guide: gd('1', 'ships', 'a', null, '1') }, { guide: gd('2', 'ships', 'b', null, '2') }, { guide: gd('3', 'ships', 'c', null, '3') }],
    { 'ships/a': { n: 0, at: '2026-10-02T00:00:00Z', last: '' }, 'ships/c': { n: 0, at: '2026-10-01T00:00:00Z', last: '' } },
  )
  expect('guides never tried go first, then the one tried longest ago', ordered.map((t) => t.guide.slug).join(',') === 'b,c,a')

  // --- the address check ---
  const resp = (status: number, type: string) => async () => new Response(null, { status, headers: { 'content-type': type } })
  expect('a 200 image address passes the check', await verifyImageUrl('https://x.test/a.jpg', resp(200, 'image/jpeg')))
  expect('a 404 or a non-image address fails the check', !(await verifyImageUrl('https://x.test/a.jpg', resp(404, 'image/jpeg'))) && !(await verifyImageUrl('https://x.test/a.jpg', resp(200, 'text/html'))))
  expect('a network error fails the check and never throws', !(await verifyImageUrl('https://x.test/a.jpg', async () => { throw new Error('down') })))

  // --- the whole run against an in-memory database ---
  const db = makeDb()
  const admin = fakeAdmin(db)
  const okFetch = (async (_u: string, init?: RequestInit) => new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' }, ...(init?.method ? {} : {}) })) as unknown as typeof fetch
  const before = JSON.stringify(db.guides)
  const dry = await runGuidePhotoHeal(admin, { apply: false, search, fetchImpl: okFetch, pexelsConfigured: true, ai: { on: false, make: async () => null } })
  expect('dry run flags the duplicate, the missing, the tiny and the wrong-subject guides (and not the good one)', dry.flagged === 5 && !dry.results.some((r) => r.slug === 'good-one'), `flagged ${dry.flagged}: ${dry.results.map((r) => r.slug)}`)
  expect('dry run prints a chosen photo and an honest alt for each guide, and writes nothing', dry.results.every((r) => r.outcome === 'dry' && !!r.url && !!r.alt && r.alt.startsWith('Illustrative stock photo: ')) && JSON.stringify(db.guides) === before && db.content_edits.length === 0 && db.app_settings.length === 0)
  expect('dry run gives every guide a DIFFERENT photo', new Set(dry.results.map((r) => photoIdOfUrl(r.url))).size === dry.results.length)
  expect('dry run never picks a photo another guide or post uses', dry.results.every((r) => !['100', '500'].includes(String(photoIdOfUrl(r.url)))))
  const only = await runGuidePhotoHeal(admin, { apply: false, only: 'hotels/good-one', search, fetchImpl: okFetch, pexelsConfigured: true, ai: { on: false, make: async () => null } })
  expect('--only on a guide with a good photo leaves it alone and says so', only.results.length === 0 && /left alone/.test(only.note))

  const daily = await runGuidePhotoHeal(admin, { apply: true, daily: true, search, fetchImpl: okFetch, pexelsConfigured: true, ai: { on: false, make: async () => null }, now: new Date('2026-10-12T15:00:00Z') })
  const changed = db.guides.filter((g: Row) => g.hero_image_url !== before0.get(g.id as string))
  expect('the daily run changes at most 3 guides', daily.results.length === 3 && daily.fixed === 3 && changed.length === 3, `fixed ${daily.fixed}, changed ${changed.length}`)
  expect('every change is logged first (2 audit rows each, with before and after), and the good guide is untouched', db.content_edits.length === 6 && db.content_edits.every((e: Row) => e.content_type === 'guide' && e.published_after === true && typeof e.after === 'string' && e.after !== '') && db.guides.find((g: Row) => g.slug === 'good-one')?.hero_image_url === px(500))
  expect('the audit rows hold the old photo so Undo can put it back', db.content_edits.some((e: Row) => e.field === 'hero_image_url' && e.before === px(100)))
  expect('the saved photos are all new and all different from every other stored picture', new Set(changed.map((g: Row) => photoIdOfUrl(g.hero_image_url as string))).size === 3 && changed.every((g: Row) => ![100, 500, 300].includes(photoIdOfUrl(g.hero_image_url as string) as number)))
  const again = await runGuidePhotoHeal(admin, { apply: true, daily: true, search, fetchImpl: okFetch, pexelsConfigured: true, ai: { on: false, make: async () => null }, now: new Date('2026-10-12T20:00:00Z') })
  expect('a second run the same day does nothing more (3 a day)', again.results.length === 0 && again.fixed === 0 && /limit of 3/.test(again.note))
  const next = await runGuidePhotoHeal(admin, { apply: true, daily: true, search, fetchImpl: okFetch, pexelsConfigured: true, ai: { on: false, make: async () => null }, now: new Date('2026-10-13T15:00:00Z') })
  expect('the next day does the remaining guides, never the ones already fixed', next.results.length === 2 && next.fixed === 2 && next.results.every((r) => !changed.some((g: Row) => g.slug === r.slug)), JSON.stringify(next.results.map((r) => [r.slug, r.outcome])))

  // a photo whose address does not answer is never saved
  const db2 = makeDb()
  const dead = (async () => new Response(null, { status: 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  const r2 = await runGuidePhotoHeal(fakeAdmin(db2), { apply: true, daily: true, search, fetchImpl: dead, pexelsConfigured: true, ai: { on: false, make: async () => null }, now: new Date('2026-10-12T15:00:00Z') })
  expect('a photo whose address does not return an image is never saved, the guide stays flagged', r2.fixed === 0 && db2.content_edits.length === 0 && JSON.stringify(db2.guides) === JSON.stringify(makeDb().guides) && r2.results.every((r) => r.outcome === 'none'))
  const att = parseAttempts(db2.app_settings.find((s: Row) => s.key === 'guide_photo_attempts')?.value as string)
  expect('the attempts memory records the next variant to try', Object.keys(att).length === 3 && Object.values(att).every((a) => a.n >= 1))

  // nothing acceptable: left flagged, AI off => no illustration
  const db3 = makeDb()
  let made = 0
  const ai = { on: false, make: async () => { made++; return 'https://x.test/ai.png' } }
  const r3 = await runGuidePhotoHeal(fakeAdmin(db3), { apply: true, daily: false, search: async () => [], fetchImpl: okFetch, pexelsConfigured: true, ai, now: new Date('2026-10-12T15:00:00Z') })
  expect('nothing from Pexels and the AI switch off: nothing changes and no illustration is made', r3.fixed === 0 && made === 0 && db3.content_edits.length === 0)
  const aiOn = { on: true, make: async () => { made++; return 'https://x.test/ai.png' } }
  const r4dry = await runGuidePhotoHeal(fakeAdmin(makeDb()), { apply: false, search: async () => [], fetchImpl: okFetch, pexelsConfigured: true, ai: aiOn })
  expect('a dry run never calls the AI illustration (it only says it would)', made === 0 && r4dry.results.every((r) => r.outcome === 'would-illustrate'))
  const db5 = makeDb()
  const r5 = await runGuidePhotoHeal(fakeAdmin(db5), { apply: true, daily: false, limit: 1, search: async () => [], fetchImpl: okFetch, pexelsConfigured: true, ai: aiOn })
  expect('with the AI switch on and every search variant failed, one illustration is used with an honest alt', r5.fixed === 1 && made === 1 && db5.guides.some((g: Row) => g.hero_image_url === 'https://x.test/ai.png' && String(g.hero_alt).startsWith('Illustration: ')) && db5.content_edits.some((e: Row) => e.method === 'generate'))
  const dayOne = await runGuidePhotoHeal(fakeAdmin(makeDb()), { apply: true, daily: true, search: async () => [], fetchImpl: okFetch, pexelsConfigured: true, ai: aiOn, now: new Date('2026-10-12T15:00:00Z') })
  expect('in the daily heal the AI illustration waits until every search variant has failed (not on day one)', dayOne.fixed === 0 && made === 1)

  // the audit log cannot be written (migration 0052 missing): nothing is changed
  const db6 = makeDb()
  const r6 = await runGuidePhotoHeal(fakeAdmin(db6, { failEdits: true }), { apply: true, search, fetchImpl: okFetch, pexelsConfigured: true, ai: { on: false, make: async () => null }, limit: 2 })
  expect('no audit row, no edit: a failing log leaves every hero as it was and points at the migration', r6.fixed === 0 && JSON.stringify(db6.guides) === JSON.stringify(makeDb().guides) && r6.problems.some((p) => /0052/.test(p)), JSON.stringify(r6.problems))
  const notConfigured = await runGuidePhotoHeal(fakeAdmin(makeDb()), { apply: false, search, pexelsConfigured: false, ai: { on: false, make: async () => null } })
  expect('without a Pexels key and without the AI switch nothing is attempted', !notConfigured.tried && /PEXELS_API_KEY/.test(notConfigured.note))

  // the counter
  expect('the admin counter counts the flagged published guides', (await countGuidesNeedingPhoto(fakeAdmin(makeDb()))) === 5)
  expect('the admin counter says null (could not be read) when a read fails', (await countGuidesNeedingPhoto(fakeAdmin(makeDb(), { failReads: true }))) === null)

  // revert support
  expect('undo puts a missing hero back as empty, not as an empty string', JSON.stringify(columnsFor('guide', 'hero_image_url', '')) === '{"hero_image_url":null}' && JSON.stringify(columnsFor('guide', 'hero_alt', 'Old alt')) === '{"hero_alt":"Old alt"}' && columnsFor('post', 'hero_image_url', 'x') === null)

  // --- wiring ---
  const heal = read('lib/content-heal-run.ts')
  expect('the daily heal step calls the guide photo loop', /import \{ runGuidePhotoHealDaily \} from '@\/lib\/guide-photo-run'/.test(heal) && /await runGuidePhotoHealDaily\(admin/.test(heal))
  expect('no new cron was added', !/guide-photo/.test(read('vercel.json')))
  const route = read('app/api/admin/posts/automation/route.ts')
  const card = read('components/admin/guides-automation-card.tsx')
  expect('the Guides Automation card shows the count, with "could not be read" on failure', /photosNeeded: photoCount/.test(route) && /Guides with duplicate or missing photos: \{typeof data\.photosNeeded === "number" \? data\.photosNeeded : "could not be read"\}/.test(card))
  expect('the migration widens the audit field check for hero edits', /hero_image_url/.test(read('supabase/migrations/0052_content_edits_hero.sql')) && /hero_alt/.test(read('supabase/migrations/0052_content_edits_hero.sql')))
  const script = read('scripts/heal-guide-photos.ts')
  expect('the script is a dry run unless --yes is given, and supports --limit and --only', /const apply = process\.argv\.includes\('--yes'\)/.test(script) && /argValue\('limit'\)/.test(script) && /argValue\('only'\)/.test(script) && /DRY RUN/.test(script))
  expect('the AI switch is only ever read, never written, by the guide photo loop', !/setAutoblogAiImageFallback/.test(read('lib/guide-photo-run.ts')) && !/setSetting\(admin, 'autoblog_ai_image_fallback'/.test(read('lib/guide-photo-run.ts')))
  for (const f of ['lib/guide-photo.ts', 'lib/guide-photo-run.ts', 'scripts/heal-guide-photos.ts', 'scripts/check-guide-photo.ts', 'supabase/migrations/0052_content_edits_hero.sql']) {
    expect(`${f} has no long dashes`, !LONG_DASH.test(read(f)))
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll guide photo checks passed')
  process.exit(failures ? 1 : 0)
}

// ---- a tiny in-memory database, just enough for the run ----
type Row = Record<string, unknown>
const before0 = new Map<string, string | null>()
function makeDb() {
  const guides: Row[] = [
    { id: 'a', kind: 'ships', slug: 'old-ship', name: 'Old Ship', parent_slug: null, hero_image_url: px(100), hero_alt: 'Cruise ship at sea', created_at: '2026-01-01', status: 'published' },
    { id: 'b', kind: 'cruise-lines', slug: 'celebrity-cruises', name: 'Celebrity Cruises', parent_slug: null, hero_image_url: px(100), hero_alt: 'Cruise ship at sea', created_at: '2026-02-01', status: 'published' },
    { id: 'c', kind: 'resorts', slug: 'royalton', name: 'Royalton Riviera Cancun', parent_slug: 'cancun', hero_image_url: null, hero_alt: null, created_at: '2026-03-01', status: 'published' },
    { id: 'd', kind: 'yachts', slug: 'sea-cloud', name: 'Sea Cloud', parent_slug: null, hero_image_url: px(300, 480, 320), hero_alt: 'Sailing yacht', created_at: '2026-03-02', status: 'published' },
    { id: 'e', kind: 'hotels', slug: 'good-one', name: 'Good Hotel', parent_slug: 'cancun', hero_image_url: px(500), hero_alt: 'Hotel exterior at dusk', created_at: '2026-03-03', status: 'published' },
    { id: 'f', kind: 'ships', slug: 'laptop-ship', name: 'Laptop Ship', parent_slug: null, hero_image_url: px(600), hero_alt: 'Laptop on a desk', created_at: '2026-03-04', status: 'published' },
    { id: 'g', kind: 'yachts', slug: 'no-photo-yacht', name: 'No Photo Yacht', parent_slug: null, hero_image_url: null, hero_alt: null, created_at: '2026-03-05', status: 'published' },
    { id: 'h', kind: 'destinations', slug: 'cancun', name: 'Cancun', parent_slug: null, hero_image_url: px(700), hero_alt: 'Cancun beach', created_at: '2026-01-02', status: 'published' },
    { id: 'i', kind: 'ships', slug: 'draft-ship', name: 'Draft Ship', parent_slug: null, hero_image_url: null, hero_alt: null, created_at: '2026-03-06', status: 'draft' },
  ]
  for (const g of guides) before0.set(g.id as string, g.hero_image_url as string | null)
  const posts: Row[] = [{ cover_image_url: px(500), alt_text: 'Hotel', publish_date: '2026-04-01', created_at: '2026-04-01', status: 'published' }]
  return { guides, posts, content_edits: [] as Row[], app_settings: [] as Row[] }
}

function fakeAdmin(db: ReturnType<typeof makeDb>, f: { failEdits?: boolean; failReads?: boolean } = {}) {
  let seq = 0
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: unknown
    let lim = Infinity
    let returning = false
    const rows = () => ((db as unknown as Record<string, Row[]>)[table] ?? [])
    const run = (): { data: unknown; error: { message: string; code?: string } | null } => {
      if (f.failReads && op === 'select' && (table === 'guides' || table === 'posts')) return { data: null, error: { message: 'read failed' } }
      const list = rows()
      const hit = list.filter((r) => filters.every((fn) => fn(r)))
      if (op === 'select') return { data: hit.slice(0, lim), error: null }
      if (op === 'insert') {
        if (table === 'content_edits' && f.failEdits) return { data: null, error: { message: 'new row for relation "content_edits" violates check constraint "content_edits_field_check"' } }
        const add = (Array.isArray(payload) ? payload : [payload]) as Row[]
        const made = add.map((r) => ({ id: `e${++seq}`, reverted_at: null, ...r }))
        list.push(...made)
        return { data: returning ? made.map((m) => ({ id: m.id })) : null, error: null }
      }
      if (op === 'update') {
        for (const r of hit) Object.assign(r, payload as Row)
        return { data: null, error: null }
      }
      if (op === 'upsert') {
        const row = payload as Row
        const existing = list.find((r) => r.key === row.key)
        if (existing) Object.assign(existing, row)
        else list.push({ ...row })
        return { data: null, error: null }
      }
      for (const r of hit) list.splice(list.indexOf(r), 1)
      return { data: null, error: null }
    }
    const q: Record<string, unknown> = {
      select: (_c?: string) => {
        if (op === 'insert') returning = true
        return q
      },
      insert: (p: unknown) => ((op = 'insert'), (payload = p), q),
      update: (p: unknown) => ((op = 'update'), (payload = p), q),
      upsert: (p: unknown) => ((op = 'upsert'), (payload = p), q),
      delete: () => ((op = 'delete'), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      limit: (n: number) => ((lim = n), q),
      maybeSingle: async () => {
        const res = run()
        return { data: Array.isArray(res.data) ? (res.data[0] ?? null) : null, error: res.error }
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    }
    return q
  }
  return { from } as never
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
