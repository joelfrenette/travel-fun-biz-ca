// Offline check: what the guide page header feature shows (lib/guide-header.ts) and how the pages use it.
// Run: pnpm dlx tsx scripts/check-guide-header.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickHeaderFeature, quickFacts, firstSentence, type HeaderPastTrip } from '../lib/guide-header'
import { priceOnRequestLine } from '../lib/site'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

type Trip = { id: string; name: string }
const up = (id: string, from: string | null) => ({ item: { id, name: `Trip ${id}` } as Trip, from })
const past = (id: string, to: string | null, slug: string | null = `slug-${id}`): HeaderPastTrip => ({ id, slug, name: `Past ${id}`, available_to: to })
const guide = { name: 'Croatia', hero_image_url: 'https://images.pexels.com/photos/1/x.jpeg', hero_alt: 'Dubrovnik walls', key_takeaways: ['Best in May. It is warm.', 'Ferries link the islands.', 'Cash helps in small towns.', 'Book early for July.', 'Split has an airport.', 'A sixth line that is cut.'] }

// 1. nearest upcoming chosen
const many = pickHeaderFeature<Trip>(guide, [up('c', '2027-09-01'), up('a', '2027-03-01'), up('b', '2027-05-01')], [past('p', '2026-01-01')])
expect('nearest upcoming trip is the feature', many.kind === 'upcoming' && many.trip.id === 'a')
expect('upcoming wins over a past trip and over the photo', many.kind === 'upcoming')
expect('upcoming is bookable', many.bookable === true)

// many trips: header plus the rest, nearest first, nothing repeated
expect('many trips: the rest follow in date order', many.rest.map((t) => t.id).join(',') === 'b,c', many.rest.map((t) => t.id).join(','))
expect('many trips: header trip is not repeated in the rest', !many.rest.some((t) => t.id === 'a'))
expect('a trip with no date sorts after dated ones', (() => {
  const f = pickHeaderFeature<Trip>(null, [up('x', null), up('y', '2027-01-01')], [])
  return f.kind === 'upcoming' && f.trip.id === 'y' && f.rest[0].id === 'x'
})())

// one trip: not duplicated below
const one = pickHeaderFeature<Trip>(guide, [up('only', '2027-04-01')], [])
expect('one trip: shown in the header', one.kind === 'upcoming' && one.trip.id === 'only')
expect('one trip: nothing left for the section below (no duplicate)', one.rest.length === 0)

// 2. past-trip fallback
const pf = pickHeaderFeature<Trip>(guide, [], [past('old', '2025-05-01'), past('new', '2026-06-01'), past('noslug', '2026-09-01', null)])
expect('past fallback: most recent past trip with a recap page', pf.kind === 'past' && pf.trip.id === 'new')
expect('past trip is never bookable', pf.bookable === false)
expect('past fallback leaves no "rest" trips to list as bookable', pf.rest.length === 0)
expect('past trip without a slug is never chosen', !(pf.kind === 'past' && pf.trip.id === 'noslug'))

// 3. image plus facts fallback
const ff = pickHeaderFeature<Trip>(guide, [], [])
expect('image+facts fallback', ff.kind === 'facts')
expect('facts: image url and alt come from the stored hero', ff.kind === 'facts' && ff.image?.url === guide.hero_image_url && ff.image.alt === 'Dubrovnik walls')
expect('facts: at most five bullets, from the stored takeaways only', ff.kind === 'facts' && ff.facts.length === 5 && ff.facts.every((f) => guide.key_takeaways.some((t) => t.startsWith(f.replace(/\.$/, '')))))
expect('facts: only the first sentence of a line', ff.kind === 'facts' && ff.facts[0] === 'Best in May.')
expect('facts are not bookable', ff.bookable === false)
expect('facts only (no image) still shows the card', (() => {
  const f = pickHeaderFeature<Trip>({ ...guide, hero_image_url: null }, [], [])
  return f.kind === 'facts' && f.image === null && f.facts.length === 5
})())
expect('image only (no takeaways) still shows the photo', (() => {
  const f = pickHeaderFeature<Trip>({ ...guide, key_takeaways: [] }, [], [])
  return f.kind === 'facts' && !!f.image && f.facts.length === 0
})())
expect('image alt falls back to the guide name', (() => {
  const f = pickHeaderFeature<Trip>({ ...guide, hero_alt: '' }, [], [])
  return f.kind === 'facts' && f.image?.alt === 'Croatia'
})())
expect('overlong or empty lines are dropped, never rewritten', quickFacts(['', '   ', 'x'.repeat(300), 'Short one.']).join('|') === 'Short one.')
expect('firstSentence keeps a line with no full stop whole', firstSentence('Warm in May') === 'Warm in May')

// 4. nothing available
expect('no image and no takeaways: nothing (single column)', pickHeaderFeature<Trip>({ ...guide, hero_image_url: null, key_takeaways: [] }, [], []).kind === 'none')
expect('no guide at all and no trips: nothing', pickHeaderFeature<Trip>(null, [], []).kind === 'none')
expect('whitespace-only image url counts as no image', pickHeaderFeature<Trip>({ ...guide, hero_image_url: '  ', key_takeaways: null }, [], []).kind === 'none')

// price on request: the card (reused as it is) and the shared line
const card = read('components/package-card.tsx')
const line = priceOnRequestLine()
expect('PackageCard still renders the price-on-request line', card.includes('priceOnRequestLine()') && card.includes('Call or text {phone} for pricing'))
expect('price-on-request line carries the site phone when set', !line.phone || (line.telHref?.startsWith('tel:') ?? false))

// the pages use it
const feat = read('components/guide-header-feature.tsx')
const dest = read('app/destinations/[slug]/page.tsx')
const gp = read('components/guide-page.tsx')
expect('header card reuses PackageCard for an upcoming trip', feat.includes('<PackageCard package={feature.trip}'))
expect('past card has no booking wording', !/More Info|Book now|Book this|per person/i.test(feat.slice(feat.indexOf('feature.kind === "past"'), feat.indexOf('const srcSet'))))
expect('past card is labelled Past trip and links to the recap page', feat.includes('>Past trip<') && feat.includes('/packages/${trip.slug}'))
expect('feature card is a server component (no handlers, no use client)', !feat.includes('"use client"') && !/\bon[A-Z][A-Za-z]*=\{/.test(feat))
expect('photo card uses the srcset helper', feat.includes('heroSrcSet(') && feat.includes('HERO_SIZES.header'))
for (const [name, src] of [['destination page', dest], ['guide page', gp]] as const) {
  expect(`${name} picks the feature with the pure function`, src.includes('pickHeaderFeature<TravelPackage, HeaderPastTrip>('))
  expect(`${name} renders the header feature`, src.includes('<GuideHeaderFeature feature={feature}'))
  expect(`${name} header is two columns only when there is a feature`, /feature\.kind !== "none" \? "grid items-start gap-8 lg:grid-cols-\[minmax\(0,1fr\)_22rem\]"/.test(src))
  expect(`${name} drops the body photo only when the header shows it`, src.includes('!heroInHeader'))
  expect(`${name} lists only the REST below (no duplicate of the header trip)`, src.includes('feature.rest') || src.includes('restTrips'))
  expect(`${name} centres the rest grid`, src.includes('justify-center') && src.includes('text-center'))
  expect(`${name} keeps exactly one h1`, (src.match(/<h1/g) ?? []).length === 1)
}
expect('old left-aligned three-column trip grid is gone from the destination page', !dest.includes('lg:grid-cols-3">\n                {upcoming.map'))
expect('guide page no longer lists past trips as bookable cards', !gp.includes('packages.map((pkg)'))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
