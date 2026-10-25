// Offline self-check for PAST TRIP MODE of the Trip Page Kit: the recap page has no price, no booking phrasing and no supplier
// link; supplier-page words are never page facts; structured data has no offer; the similar-trips strip picks the right trips;
// "upcoming" lists leave past trips out (and the sitemap keeps them); the wording rules (English names, spacing, wrong-town
// activities, one attribution line); the "Look back" social draft; the waitlist form. No network, no database.
// Run: pnpm dlx tsx scripts/check-past-trip-kit.ts
import { renderToStaticMarkup } from 'react-dom/server'
import React, { createElement } from 'react'
;(globalThis as unknown as { React: unknown }).React = React
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SUPPLIER_STATUS_RE, stripSupplierSentences, pastSafeText, pastSafeFieldSet, cleanKitForPast, pastTripTitle, pastTripDescription, pastTripFaqs, pickSimilarTrips,
  splitGallery, buildPastTripJsonLd, excludePast, recapStatusOf, type SimilarCandidate,
} from '../lib/past-trip-kit'
import {
  itemsOfSection, activityNamesOtherTown, isLocalLanguageName, englishTitleInBrackets, fixAbbrevSpacing, ownerStop, activityBelongsElsewhere, attributionLabels, buildToConfirm,
  parseTripKit, TRIP_KIT_VERSION, type TripKit,
} from '../lib/trip-kit-facts'
import { thingBlockers } from '../lib/trip-kit-gate'
import { planTripKit, memoryCache, sheetHasLocalNames, type FillDeps, type FactSheet } from '../lib/trip-kit-fill'
import { tripFieldSet, linkPageFields } from '../lib/affiliate-text-sources'
import { upcomingTrips } from '../lib/from-cities'
import { isPastTrip } from '../lib/past-trip'
import { lookbackBlockers, lookbackSource, lookbackSlug, pickLookbackTrip, runLookBackDraft } from '../lib/trip-lookback'
import { runTripSocialEnrol } from '../lib/trip-social'
import { PastTripPage, SimilarTripsStrip } from '../components/trip/past-trip-page'
import { KitAttribution } from '../components/trip/trip-kit-body'
import type { DbPackage } from '../lib/packages'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
}

const TODAY = '2026-10-24'
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8')

// ─── In-memory fake of the database (same shape as scripts/check-trip-social.ts) ─────────────────
type Row = Record<string, unknown>
interface Db { tables: Record<string, Row[]> }
function fakeAdmin(db: Db): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: Row = {}
    let opts: { head?: boolean } | undefined
    const rows = () => (db.tables[table] ??= [])
    const run = () => {
      if (mode === 'insert') { rows().push({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...payload }); return { data: null, error: null, count: null } }
      if (mode === 'upsert') { const e = rows().find((r) => r.key === payload.key); if (e) Object.assign(e, payload); else rows().push({ ...payload }); return { data: null, error: null, count: null } }
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (mode === 'update') { for (const r of hit) Object.assign(r, payload); return { data: hit, error: null, count: hit.length } }
      if (opts?.head) return { data: null, error: null, count: hit.length }
      return { data: hit, error: null, count: hit.length }
    }
    const q: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => { if (o) opts = o; return q },
      insert: (row: Row) => ((mode = 'insert'), (payload = row), q),
      update: (row: Row) => ((mode = 'update'), (payload = row), q),
      upsert: (row: Row) => ((mode = 'upsert'), (payload = row), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
      like: (c: string, pat: string) => { const re = new RegExp(`^${pat.replace(/%/g, '.*')}$`); filters.push((r) => re.test(String(r[c] ?? ''))); return q },
      not: (c: string, op: string, v: unknown) => { if (op === 'is' && v === null) filters.push((r) => r[c] != null); return q },
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ ...run(), data: (run().data as Row[] | null)?.[0] ?? null }),
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

async function main() {
  // ─── Supplier-page words are not page facts ────────────────────────────────────────
  check('supplier words: "Tour Cancelled", sold out, no longer available, book now are all caught',
    ['Tour Cancelled', 'This tour has been cancelled.', 'It is sold out.', 'The page is no longer available.', 'Book now and save.', 'Join the next trip', 'Contact for pricing', 'Limited spots remaining.'].every((t) => SUPPLIER_STATUS_RE.test(t)))
  check('supplier words: a normal trip sentence is not caught', !SUPPLIER_STATUS_RE.test('The group watched the sun set over the harbour in Taormina.'))
  check('strip: only the supplier sentences go, the trip sentences stay', stripSupplierSentences('The group loved Taormina. Tour Cancelled. They ate well in Palermo. Deposit is $200 per person.') === 'The group loved Taormina. They ate well in Palermo.', stripSupplierSentences('The group loved Taormina. Tour Cancelled. They ate well in Palermo. Deposit is $200 per person.'))
  check('strip: a text that is only supplier words becomes empty', pastSafeText('Tour Cancelled') === '')

  // ─── The page for a past trip ──────────────────────────────────────────────────────
  const SUPPLIER_URL = 'https://supplier.example/italy-tour'
  const pkg = {
    id: 'p1', name: 'SOUTHERN ITALY & SICILY w/ Amy & Liz', slug: 'hh-social-southern-italy-sicily', destination: 'Southern Italy & Sicily', country: 'Italy', region: null, category: 'Tour', tags: [],
    price_display: 'Contact for pricing', price_value: null, currency: 'CAD', price_includes: 'Hotels\nTour Cancelled\nGuided visits', duration: '10 Days', duration_days: 10,
    available_from: '2026-05-02', available_to: '2026-05-11', departure_dates: null,
    short_description: 'Taormina, Palermo and the Amalfi Coast. Tour Cancelled.', full_description: 'The route runs from Taormina to Palermo. Sold out. Guests enjoyed Sorrento.\n\nBook now and join the next trip.',
    highlights: ['Taormina views', 'Sold out'], itinerary: [{ day: 1, title: 'Taormina', description: 'Arrive in Taormina. Tour Cancelled.' }, { day: 2, title: 'Palermo', description: '' }],
    image_url: 'https://x.test/hero.jpg', image_source: 'pexels', gallery_urls: [] as string[], journal_entries: [], booking_url: SUPPLIER_URL, more_info_url: SUPPLIER_URL,
    status: 'published', not_included: 'Flights', keywords: [], meta_title: 'Italy Tour | Book Now', meta_description: 'Book now', ai_faqs: [{ question: 'Is the tour cancelled?', answer: 'Yes, the tour is cancelled.' }, { question: 'What is the route?', answer: 'It runs from Taormina to Palermo.' }],
    supplier: 'Hiking Hub', recap_mode: 'auto', recap_summary: null, recap_highlights: null, updated_at: '2026-10-01T00:00:00Z',
    call_to_action: 'Book Now',
  } as unknown as DbPackage
  const kit: TripKit = {
    v: TRIP_KIT_VERSION, generatedAt: '2026-10-24T00:00:00Z', promise: 'A coastal route through Sicily.', routeKnown: true,
    stops: [{ name: 'Taormina', kind: 'city', region: 'Italy', date: null, arrive: null, depart: null, days: null, photo: { url: 'https://images.pexels.com/t.jpg', alt: 'Taormina', credit: 'Photo by A on Pexels', creditUrl: null }, things: [{ text: 'Walk to the Greek Theatre above the town.', source: { label: 'Wikivoyage', url: 'https://en.wikivoyage.org/wiki/Taormina' } }, { text: 'Tour cancelled by the supplier.', source: { label: 'Supplier page', url: SUPPLIER_URL } }], source: { label: 'Trip details', url: null } }],
    otherStops: [], included: [{ label: '', text: 'Daily breakfast', source: { label: 'Supplier page', url: SUPPLIER_URL } }, { label: '', text: 'Hotel stays', source: { label: 'Trip details', url: null } }], notIncluded: [], goodToKnow: [],
    attributions: [{ label: 'Wikivoyage', url: 'https://en.wikivoyage.org/wiki/Taormina' }, { label: 'Wikivoyage', url: 'https://en.wikivoyage.org/wiki/Palermo' }, { label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Sicily' }],
    toConfirm: ['The supplier page says this tour has been cancelled.'],
  }
  const cleanKit = cleanKitForPast(kit)!
  check('clean kit: supplier-sourced facts and supplier words are gone, trip facts stay', cleanKit.included.length === 1 && cleanKit.included[0].text === 'Hotel stays' && cleanKit.stops[0].things.length === 1 && cleanKit.toConfirm.length === 0)
  const fs = pastSafeFieldSet(tripFieldSet(pkg, TODAY))
  check('field set: description keeps the trip sentences only', fs.description.map((f) => f.value).join(' ') === 'The route runs from Taormina to Palermo. Guests enjoyed Sorrento.', fs.description.map((f) => f.value))
  check('field set: a highlight that is only a supplier word is dropped', fs.highlights.length === 1 && fs.highlights[0].value === 'Taormina views')
  check('field set: itinerary day text is cleaned, a cancelled FAQ is dropped', fs.itinerary[0].description === 'Arrive in Taormina.' && fs.faqs.length === 1 && fs.faqs[0].question === 'What is the route?')
  const linked = linkPageFields(fs.fields, [], 'trips')
  const faqs = pastTripFaqs({ name: pkg.name, destination: pkg.destination, stored: fs.faqs.map((f) => ({ question: f.question, answer: f.answer })), from: pkg.available_from, to: pkg.available_to, phone: '(555) 010-0000' })
  check('faq: "Can I still travel this route?" is always there, with the phone and no booking words', faqs.some((f) => f.question === 'Can I still travel this route?' && /similar trip/.test(f.answer) && /\(555\) 010-0000/.test(f.answer)) && !/book/i.test(faqs.map((f) => f.answer).join(' ')))
  const upcoming: SimilarCandidate[] = [
    { slug: 'sicily-2027', name: 'Sicily Escape', destination: 'Southern Italy & Sicily', country: 'Italy', available_from: '2027-05-01', available_to: '2027-05-09' },
    { slug: 'rome-2027', name: 'Rome Weekend', destination: 'Rome', country: 'Italy', available_from: '2027-03-01', available_to: '2027-03-04' },
    { slug: 'iceland', name: 'Iceland', destination: 'Iceland', country: 'Iceland', available_from: '2027-02-01', available_to: '2027-02-05' },
  ]
  const similar = pickSimilarTrips(pkg, upcoming, TODAY, 3)
  const page = renderToStaticMarkup(createElement(PastTripPage, {
    pkg, heading: pkg.name, image: 'https://x.test/hero.jpg', kit: cleanKit, fieldSet: fs, linked, language: 'en', phone: '(555) 010-0000', telHref: 'tel:+15550100000',
    happened: 'May 2026', realPhotos: [], stockPhotos: ['https://x.test/s1.jpg'], bundle: null, faqs, similar, destinationHref: '/destinations/southern-italy-sicily', bestTimeHref: null, guide: null,
    contactForm: createElement('form', { 'data-testid': 'contact-form' }), breadcrumbs: null,
  }))
  check('page: says "This trip happened May 2026" and has one h1', /This trip happened May 2026/.test(page) && (page.match(/<h1/g) ?? []).length === 1)
  check('page: NO price anywhere', !/\$\s?\d|per person|from \$|Contact for pricing|pricing/i.test(page), page.match(/.{20}(\$\s?\d|pricing).{20}/i)?.[0])
  check('page: NO book now / join the next trip / booking phrasing', !/book now|book your|booking|join the next trip|reserve|request info/i.test(page), page.match(/.{20}(book now|booking|join the next trip).{20}/i)?.[0])
  check('page: NO link to the supplier page, and the supplier name is not shown', !page.includes(SUPPLIER_URL) && !/supplier\.example/.test(page) && !/Hiking Hub/.test(page))
  check('page: NO cancelled / sold out wording', !/cancel|sold out|no longer available/i.test(page), page.match(/.{20}(cancel|sold out).{20}/i)?.[0])
  check('page: strong CTAs are there (plan a trip like this, call or text, the waitlist, the form)', /Plan a trip like this/.test(page) && /tel:\+15550100000/.test(page) && /Call or text/.test(page) && /Loved this trip\? Join the waitlist for the next one/.test(page) && /Tell me when the next one opens/.test(page) && /data-testid="contact-form"/.test(page))
  check('page: waitlist keeps the consent wording and the same sign-up route', /Yes, I agree to receive travel deals and updates from/.test(page) && /unsubscribe at any time/.test(page) && /trip-alert-consent/.test(page))
  check('page: stock photos are labelled as not from the trip when there are no real ones', /Stock pictures of the places, not photos from the trip/.test(page))
  check('page: route timeline and the kept things to do', /data-testid="trip-kit-route"/.test(page) && /Greek Theatre/.test(page))
  check('page: "What the trip included" shows only stored facts', /What the trip included/.test(page) && /Hotel stays/.test(page) && !/Daily breakfast/.test(page) && !/Tour Cancelled/.test(page))
  check('page: similar trips strip links to the destination trip first', /Similar trips coming up/.test(page) && /\/packages\/sicily-2027/.test(page) && !/\/packages\/iceland/.test(page))
  check('page: attribution names each source once', /Source: Wikivoyage, Wikipedia \(text under CC BY-SA 4\.0\)/.test(page.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')), page.replace(/<[^>]+>/g, '').match(/Source:.{0,120}/)?.[0])

  // real photos and quotes come first
  const recapUrl = 'https://x.test/storage/hh-social-southern-italy-sicily-recap-1790000000000-horizontal.jpg'
  const withReal = renderToStaticMarkup(createElement(PastTripPage, {
    pkg, heading: pkg.name, image: 'https://x.test/hero.jpg', kit: cleanKit, fieldSet: fs, linked, language: 'en', phone: '(555) 010-0000', telHref: 'tel:+15550100000',
    happened: 'May 2026', realPhotos: [recapUrl], stockPhotos: ['https://x.test/s1.jpg'], bundle: { quickAnswer: 'A great week in Sicily.', takeaways: ['Taormina was the favourite'], quotes: [{ text: 'We loved every day of the trip.', name: 'Sam T.' }], metaTitle: '', metaDescription: '', publishedAt: '2026-06-01T00:00:00Z' },
    faqs, similar, destinationHref: '/destinations/southern-italy-sicily', bestTimeHref: '/best-time-to-visit/southern-italy-sicily', guide: { href: '/guides/x', label: 'Sicily guide' }, contactForm: null, breadcrumbs: null,
  }))
  check('real photos: the first real trip photo is the hero, with honest alt text', withReal.indexOf(recapUrl) > -1 && withReal.indexOf(recapUrl) < withReal.indexOf('In their words') && /alt="Photo from the SOUTHERN ITALY &amp; SICILY w\/ Amy &amp; Liz trip"/.test(withReal))
  check('real photos: quotes with permission, the stock gallery is not shown', /We loved every day of the trip/.test(withReal) && /shown with permission/.test(withReal) && !/Stock pictures of the places/.test(withReal))
  check('links: best-time and guide links appear when they exist', /best-time-to-visit\/southern-italy-sicily/.test(withReal) && /Sicily guide/.test(withReal) && !/best-time-to-visit/.test(page))
  check('split gallery: only Recap Studio photos of THIS trip are real', (() => { const g = splitGallery([recapUrl, 'https://x.test/storage/hh-social-southern-italy-sicily-1790000000000-horizontal.jpg', 'https://x.test/storage/other-trip-recap-1790000000000-horizontal.jpg'], 'hh-social-southern-italy-sicily'); return g.real.length === 1 && g.stock.length === 2 })())

  // ─── Structured data ───────────────────────────────────────────────────────────────
  const ld = buildPastTripJsonLd({ name: pkg.name, description: 'A recap.', url: 'https://travelfunbiz.ca/packages/x', image: 'https://x.test/a.jpg', category: 'Tour', destination: pkg.destination, startDate: pkg.available_from, endDate: pkg.available_to, stops: ['Taormina', 'Palermo'], faqs, siteName: 'TravelFunBiz.ca', siteUrl: 'https://travelfunbiz.ca/', breadcrumbs: [{ name: 'Home', url: 'https://travelfunbiz.ca/' }, { name: 'Trips', url: 'https://travelfunbiz.ca/packages' }, { name: pkg.name, url: 'https://travelfunbiz.ca/packages/x' }] })
  const ldText = JSON.stringify(ld)
  const trip = ld.find((o) => o['@type'] === 'TouristTrip') as Record<string, unknown>
  check('json-ld: TouristTrip with the real start and end date', trip?.startDate === '2026-05-02' && trip?.endDate === '2026-05-11')
  check('json-ld: NO offer, NO availability, NO price', !/offers|"Offer"|availability|InStock|price/i.test(ldText), ldText.match(/.{10}(offers|availability|price).{10}/i)?.[0])
  check('json-ld: FAQPage and BreadcrumbList are there', ld.some((o) => o['@type'] === 'FAQPage') && ld.some((o) => o['@type'] === 'BreadcrumbList'))
  const pageSrc = read('app', 'packages', '[slug]', 'page.tsx')
  check('trip page source: past trips use the past kit, no Event/Article markup, no supplier link, no cookie read outside preferences', /PastTripPage/.test(pageSrc) && !/"Event"|"Article"/.test(pageSrc) && !/booking_url|more_info_url/.test(pageSrc.replace(/pkg\.booking_url/g, '')) === true && !/cookies\(/.test(pageSrc) && /getVisitorPreferences\(\)/.test(pageSrc))
  check('generateMetadata stays safe: no preferences or cookies inside it', (() => { const m = /export async function generateMetadata[\s\S]*?\r?\n}\r?\n/.exec(pageSrc)?.[0] ?? ''; return m.length > 100 && !/getVisitorPreferences|cookies\(/.test(m) })())

  // ─── Title and description ─────────────────────────────────────────────────────────
  const t1 = pastTripTitle({ name: 'SOUTHERN ITALY & SICILY w/ Amy & Liz', destination: 'Italy', from: '2026-05-02', to: '2026-05-11' })
  check('title: "<Trip> recap | <Month Year>" within 30 to 60 characters', t1 === 'SOUTHERN ITALY & SICILY w/ Amy & Liz recap | May 2026' && t1.length >= 30 && t1.length <= 60, t1)
  const t1b = pastTripTitle({ name: 'SOUTHERN ITALY & SICILY SPRING TOUR w/ Amy & Liz', destination: 'Italy', from: '2026-05-02', to: '2026-05-11' })
  check('title: the host part is dropped first when the title is too long', t1b === 'SOUTHERN ITALY & SICILY SPRING TOUR recap | May 2026' && t1b.length <= 60, t1b)
  const t2 = pastTripTitle({ name: 'Girls Trip', destination: 'Mexico', from: '2026-03-01', to: '2026-03-08' })
  check('title: a short title grows with the destination', t2.length >= 30 && /Mexico/.test(t2) && /recap/.test(t2), t2)
  const t3 = pastTripTitle({ name: 'An Extremely Long Trip Name That Goes On And On Across Many Countries And Seas', from: '2026-03-01', to: '2026-03-08' })
  check('title: never over 60 characters, always has "recap"', t3.length <= 60 && /recap/.test(t3), t3)
  const d = pastTripDescription({ name: pkg.name, destination: pkg.destination, metaDescription: 'Book now', shortDescription: 'Taormina, Palermo and the Amalfi Coast. Tour Cancelled.', from: pkg.available_from, to: pkg.available_to })
  check('description: no supplier or booking words, within 155 characters', !/book|cancel/i.test(d) && d.length <= 155 && d.length >= 70, d)

  // ─── Similar trips ─────────────────────────────────────────────────────────────────
  check('similar: same destination first', similar.basis === 'destination' && similar.trips.map((t) => t.slug).join() === 'sicily-2027')
  const region = pickSimilarTrips({ slug: 'x', destination: 'Amalfi Coast', country: 'Italy', region: null }, upcoming, TODAY, 3)
  check('similar: same country when no destination matches, soonest first', region.basis === 'region' && region.trips.map((t) => t.slug).join() === 'rome-2027,sicily-2027', region)
  const nearest = pickSimilarTrips({ slug: 'x', destination: 'Peru', country: 'Peru', region: null }, [...upcoming, { slug: 'old', name: 'Old', destination: 'Peru', country: 'Peru', available_from: '2025-01-01', available_to: '2025-01-09' }, { slug: 'forced', name: 'Forced recap', destination: 'Peru', country: 'Peru', available_from: '2027-09-01', available_to: '2027-09-09', recap_mode: 'recap' }], TODAY, 3)
  check('similar: falls back to the 3 nearest upcoming; a past trip and a forced recap are never offered', nearest.basis === 'nearest' && nearest.trips.map((t) => t.slug).join() === 'iceland,rome-2027,sicily-2027', nearest)
  const none = pickSimilarTrips({ slug: 'x', destination: 'Peru', country: null, region: null }, [{ slug: 'old', name: 'Old', destination: 'Peru', available_from: '2025-01-01', available_to: '2025-01-09' }], TODAY)
  check('similar: nothing upcoming gives none, and the strip shows a destination guide link', none.basis === 'none' && none.trips.length === 0 && /Read our Peru guide/.test(renderToStaticMarkup(createElement(SimilarTripsStrip, { similar: none, destination: 'Peru', destinationHref: '/destinations/peru' }))))
  check('similar: never the trip itself', pickSimilarTrips(pkg, [{ slug: pkg.slug, name: 'self', destination: pkg.destination, available_from: '2027-01-01', available_to: '2027-01-09' }], TODAY).trips.length === 0)

  // ─── Upcoming lists leave past trips out; the sitemap keeps them ───────────────────
  const rows = [{ slug: 'a', name: 'A', available_from: '2027-01-01', available_to: '2027-01-09', recap_mode: null }, { slug: 'b', name: 'B', available_from: '2025-01-01', available_to: '2025-01-09', recap_mode: null }, { slug: 'c', name: 'C', available_from: '2027-02-01', available_to: '2027-02-09', recap_mode: 'recap' }, { slug: 'd', name: 'D', available_from: '2025-01-01', available_to: '2025-01-09', recap_mode: 'live' }]
  check('excludePast: past and forced recap out, forced live stays', excludePast(rows, TODAY).map((r) => r.slug).join() === 'a,d')
  check('from-cities upcomingTrips: past trips out', upcomingTrips(rows, TODAY).map((r) => r.slug).join() === 'd,a')
  const packagesSrc = read('lib', 'packages.ts')
  const fnBody = (name: string) => new RegExp(`export async function ${name}[\\s\\S]*?\\r?\\n}\\r?\\n`).exec(packagesSrc)?.[0] ?? ''
  check('home list (getPackages) filters past trips', /isPastTrip/.test(fnBody('getPackages')))
  check('trips index (getPackagesForBrowse) filters past trips', /isPastTrip/.test(fnBody('getPackagesForBrowse')))
  check('blog trip cards (getRelatedPackages) skip past trips', /isPastTrip/.test(fnBody('getRelatedPackages')))
  check('next trip lookup skips a forced recap', /isPastTrip/.test(fnBody('getNextUpcomingPackageInCategory')))
  const sitemap = read('app', 'sitemap.ts')
  check('sitemap keeps past trips (every published slug, no past filter)', /getPublishedPackageSlugs/.test(sitemap) && !/isPastTrip/.test(sitemap))
  check('social promos exclude past trips (tripBlockers and canPromote)', /isPastTrip/.test(read('lib', 'trip-social.ts')) && /isPastTrip/.test(read('lib', 'promotion.ts')))
  check('destination page lists past trips as recaps, not as upcoming', /isPastTrip/.test(read('lib', 'destinations.ts')))
  check('isPastTrip rule used as the one definition', isPastTrip({ available_to: '2026-05-11' }, TODAY) && !isPastTrip({ available_to: '2027-05-11' }, TODAY))

  // ─── Wording and fact rules ────────────────────────────────────────────────────────
  const section = [
    '1 Katedrala sv. Duje (Cathedral of St. Domnius), main square. The cathedral is the heart of the old town and well worth a slow look around.',
    '2 Crkva sv. Barbare, on the hill. A small church with a quiet garden and views over the harbour of the old town.',
    '3 Srednjovjekovni vrt sv.Lovre, behind the church. A medieval garden for a quiet moment away from the crowds of the town.',
    '4 Tvrđava sv. Mihovila, on the hill. A fortress above the town with wide views over the islands and the sea around it.',
    '5 Perivoj Roberta Visianija, by the shore. A small park with benches and shade for a rest in the middle of a hot day.',
    '6 Fortica Fortress, above the harbour. A hilltop fortress with long views over the islands and the sea around the town.',
    '7 Cathedral of St.Lawrence, in the square. A fine old cathedral with a tall bell tower, well worth a visit on a slow day.',
  ].join('\n')
  const items = itemsOfSection(section.split('\n').map((l) => `${l}`).join('\n'), 14)
  const names = items.map((i) => i.name)
  check('English names: a local name with an English title in brackets uses the English title', names.includes('Cathedral of St. Domnius'), names)
  check('English names: local names with no English title are dropped, never translated', !names.some((n) => /Crkva|Srednjovjekovni|Tvrđava|Perivoj|Katedrala|Barbare|Mihovila|Visiani/i.test(n)), names)
  check('English names: ordinary names stay', names.includes('Fortica Fortress'), names)
  check('spacing: "St.Lawrence" and "sv.Lovre" get their space', fixAbbrevSpacing('Cathedral of St.Lawrence and sv.Lovre') === 'Cathedral of St. Lawrence and sv. Lovre' && names.includes('Cathedral of St. Lawrence'), names)
  check('local-language detector: the five Croatian examples and sv. are local, English and Italian names are not', ['Katedrala sv. Duje', 'Crkva sv. Barbare', 'Tvrđava sv. Mihovila', 'Perivoj Roberta Visianija', 'Srednjovjekovni vrt sv.Lovre'].every(isLocalLanguageName) && !['Cathedral of St. Domnius', 'Duomo di Monreale', 'Fortica Fortress', 'Stari Grad Plain'].some(isLocalLanguageName))
  check('english title: a local or empty bracket gives null', englishTitleInBrackets('Crkva sv. Ivana), x') === null && englishTitleInBrackets('Cathedral of St. Domnius), x')?.name === 'Cathedral of St. Domnius')
  check('thing line: a local name or a missing space is blocked', thingBlockers('Visit the Katedrala sv. Duje in the old town square.', ['Katedrala sv. Duje'], 'Katedrala sv. Duje').some((b) => /local-language/.test(b)) && thingBlockers('Visit the Cathedral of St.Lawrence in the square.', ['Cathedral of St.Lawrence'], 'Cathedral of St.Lawrence').some((b) => /missing space/.test(b)))
  const stopNames = ['Hvar', 'Stari Grad', 'Jelsa']
  check('wrong-town activity: "Adventure park Hvar Jelsa" belongs to Jelsa, not Hvar or Stari Grad', ownerStop('Adventure park Hvar Jelsa', stopNames) === 'Jelsa' && activityBelongsElsewhere('Adventure park Hvar Jelsa', 'Hvar', stopNames) && activityBelongsElsewhere('Adventure park Hvar Jelsa', 'Stari Grad', stopNames) && !activityBelongsElsewhere('Adventure park Hvar Jelsa', 'Jelsa', stopNames))
  check('wrong-town activity: names with no other town are kept', !activityBelongsElsewhere('Fortica fortress above the harbour', 'Hvar', stopNames) && !activityBelongsElsewhere('Walk the old streets of Hvar', 'Hvar', stopNames))
  check('attribution: each source once, as "Wikivoyage, Wikipedia"', attributionLabels(kit.attributions).map((a) => a.label).join(', ') === 'Wikivoyage, Wikipedia' && (renderToStaticMarkup(createElement(KitAttribution, { kit })).match(/Wikivoyage/g) ?? []).length === 1)

  // ─── The fill engine in past mode (fake reference pages, fake AI) ──────────────────
  const hvarExtract = (extra: string) => `Hvar is an island town in Croatia on the Adriatic Sea, known for its harbour, lavender fields and long summers by the water. It is a favourite stop for sailors and visitors.\n\n== Understand ==\nThe island has a long history of trade and fishing around the coast and the old harbour town, with a lively waterfront and narrow lanes. This text is here to be long enough.\n\n== See ==\n6 Fortica Fortress, above the harbour. A hilltop fortress with long views over the islands and the sea around the town.\n${extra}\n\n== Do ==\n Adventure park Hvar Jelsa, near Jelsa. Zip lines and rope courses in the pine forest above the bay for families and groups.\n`
  const fakeJson = async (url: string) => {
    const m = /titles=([^&]+)/.exec(url)
    if (!url.includes('wikivoyage.org/w/api.php') || !url.includes('prop=extracts') || !m) return null
    const title = decodeURIComponent(m[1])
    if (!['Hvar', 'Stari Grad', 'Jelsa'].includes(title)) return null
    return { query: { pages: { '1': { title, extract: hvarExtract('') } } } }
  }
  const supplierBlurb = 'This tour has been cancelled and the page is no longer available. ' + 'The supplier lists hotels, guides and meals for every group departure on this page and more. '.repeat(8)
  const croatia = {
    ...pkg, id: 'p2', slug: 'croatia-test', name: 'CROATIA COASTLINE YACHT CRUISE', destination: 'Croatia', country: 'Croatia', category: 'Cruise', duration: '8 Days', available_from: '2026-05-02', available_to: '2026-05-09',
    short_description: null, full_description: null, highlights: null, price_includes: null, not_included: null, meta_title: null, meta_description: null, ai_faqs: null, gallery_urls: [],
    itinerary: [{ day: 1, title: 'Hvar', description: '' }, { day: 2, title: 'Stari Grad', description: '' }, { day: 3, title: 'Jelsa', description: '' }],
  } as unknown as DbPackage
  let writerSaw = ''
  const deps: FillDeps = {
    json: fakeJson,
    supplierText: async () => supplierBlurb,
    ai: async (prompt) => {
      writerSaw = prompt
      const adv = 'Try the Adventure park Hvar Jelsa with zip lines and rope courses in the pines.'
      const fort = 'Climb up to the Fortica Fortress above the harbour for long views.'
      return { raw: { promise: 'A coastal cruise through the islands.', full_description: '', places: { Hvar: { blurb: 'An island town on the Adriatic.', things: [adv, fort] }, 'Stari Grad': { blurb: 'An old harbour town on the island.', things: [adv, fort] }, Jelsa: { blurb: 'A quiet harbour town on the island.', things: [adv, fort] } }, included: [{ item: 'Meals and guides', quote: 'hotels, guides and meals' }], not_included: [], good_to_know: [] }, usage: { input: 1, output: 1 } }
    },
    photos: async () => [],
    upload: async () => ({ image_url: null, image_url_square: null, image_url_portrait: null, image_url_banner: null }),
    faqs: async () => ({ faqs: [], discarded: 0, called: false }),
    now: () => new Date('2026-10-24T12:00:00Z'),
  }
  const site = { existing: new Set(['/', '/packages']), targets: [] }
  const pastPlan = await planTripKit({ ...croatia, booking_url: SUPPLIER_URL } as DbPackage, [], deps, memoryCache(), site, { left: 4, used: 0 }, { today: TODAY })
  const stopBy = (n: string) => pastPlan.kit.stops.find((s) => s.name === n)
  check('past fill: the supplier page is not read for the writer or the facts', pastPlan.past && !/cancelled|supplier lists/i.test(writerSaw) && !pastPlan.sources.some((s) => /Supplier page/.test(s)) && pastPlan.kit.included.length === 0)
  check('past fill: no "Tour Cancelled" / cancellation note on the to-confirm list', !pastPlan.kit.toConfirm.some((t) => /cancel/i.test(t)), pastPlan.kit.toConfirm)
  check('past fill: the record is marked as made in past mode', pastPlan.kit.past === true && parseTripKit(JSON.stringify(pastPlan.kit))?.past === true)
  check('past fill: no price-confirm or booking questions for a trip that ran', !pastPlan.kit.toConfirm.some((t) => /deposit|final payment|flights|passport|tick "Price confirmed/i.test(t)), pastPlan.kit.toConfirm)
  const upPlan = await planTripKit({ ...croatia, id: 'p3', available_from: '2027-05-02', available_to: '2027-05-09', booking_url: SUPPLIER_URL } as DbPackage, [], deps, memoryCache(), site, { left: 4, used: 0 }, { today: TODAY })
  check('regression: an upcoming trip still notes a cancelled supplier page for the admin', upPlan.kit.toConfirm.some((t) => /cancelled/i.test(t)) && !upPlan.past && upPlan.kit.past !== true, upPlan.kit.toConfirm)
  check('activity rule (engine): the adventure park is on Jelsa only', !!stopBy('Jelsa')?.things.some((t) => /Adventure park Hvar Jelsa/.test(t.text)) && !stopBy('Hvar')?.things.some((t) => /Adventure park/.test(t.text)) && !stopBy('Stari Grad')?.things.some((t) => /Adventure park/.test(t.text)), pastPlan.kit.stops.map((s) => [s.name, s.things.map((t) => t.text)]))
  const noJelsa = await planTripKit({ ...croatia, id: 'p4', itinerary: [{ day: 1, title: 'Hvar', description: '' }, { day: 2, title: 'Stari Grad', description: '' }] } as DbPackage, [], deps, memoryCache(), site, { left: 4, used: 0 }, { today: TODAY })
  check('activity rule (engine): with Jelsa NOT on the route the adventure park is on no card (named after another town)', noJelsa.kit.stops.length >= 2 && noJelsa.kit.stops.every((s) => !s.things.some((t) => /Adventure park/.test(t.text))), noJelsa.kit.stops.map((s) => [s.name, s.things.map((t) => t.text)]))
  check('other-town rule: a town after the stop name is caught, place-type words and own names are not', activityNamesOtherTown('Adventure park Hvar Jelsa', 'Hvar') && !activityNamesOtherTown('Hvar Fortress', 'Hvar') && !activityNamesOtherTown('Hvar Old Town', 'Hvar') && !activityNamesOtherTown('Walk the walls of Hvar', 'Hvar') && !activityNamesOtherTown('Adventure park Hvar Jelsa', 'Jelsa'))
  check('activity rule (engine): other lines for the stop are kept', !!stopBy('Hvar')?.things.some((t) => /Fortica/.test(t.text)))
  const staleSheet = { places: [{ mention: { name: 'Split', region: null, kind: 'city', near: null }, ref: { place: 'Split', title: 'Split', label: 'Wikivoyage', url: 'https://x', intro: 'x', see: [{ name: 'Katedrala sv. Duje', blurb: '' }], doItems: [], context: '' } }] } as unknown as FactSheet
  check('cached fact sheet with a local-language name is rebuilt', sheetHasLocalNames(staleSheet))
  check('recap records of an upcoming trip are not marked past', parseTripKit(JSON.stringify(kit))?.past === undefined)
  check('buildToConfirm in past mode asks only about the route', buildToConfirm({ pkg: { name: 'x', destination: 'y', duration: '1', available_from: null, available_to: null, departure_dates: null, price_includes: null, not_included: null, itinerary: null }, kit: { stops: [], included: [], notIncluded: [], goodToKnow: [], routeKnown: false, otherStops: [] }, sourceText: '', priceMentions: ['Deposit $5'], past: true }).length === 0)

  // ─── Recap status (admin) ──────────────────────────────────────────────────────────
  const st = recapStatusOf({ slug: 'hh-social-southern-italy-sicily', available_to: '2026-05-11', gallery_urls: [recapUrl, 'https://x.test/stock.jpg'], recap_summary: null, quotes: 0 }, TODAY)
  check('recap status: counts real photos only and lists the to-do', st.past && st.photos === 1 && st.quotes === 0 && st.todo.length === 3 && /photos/.test(st.todo[0]))
  check('recap status: a trip that has not happened has nothing to do', recapStatusOf({ slug: 'x', available_to: '2027-01-01', quotes: 0 }, TODAY).todo.length === 0)
  const panel = read('components', 'admin', 'package-kit-panel.tsx')
  check('admin: the editor panel has the Past trip badge and the Recap status line', /Past trip/.test(panel) && /Recap status/.test(panel))

  // ─── Autopilot: a past trip is filled in past mode once ────────────────────────────
  const run = read('lib', 'trip-kit-run.ts')
  check('autopilot: a past trip whose record was made in past mode is left alone', /c\.pastKit && isPastTrip/.test(run))

  // ─── Look-back draft (never auto-posted) ───────────────────────────────────────────
  const lbTrip = { slug: 'hh-social-southern-italy-sicily', name: 'Southern Italy', status: 'published', available_to: '2026-05-11', recap_mode: null, gallery_urls: [recapUrl] }
  check('look-back: needs a published past trip with a real (consented) recap photo, and only once', lookbackBlockers(lbTrip, false, TODAY).length === 0 && lookbackBlockers({ ...lbTrip, gallery_urls: ['https://x.test/stock.jpg'] }, false, TODAY).some((b) => /text only/.test(b)) && lookbackBlockers(lbTrip, true, TODAY).some((b) => /already/.test(b)) && lookbackBlockers({ ...lbTrip, available_to: '2027-01-01' }, false, TODAY).length > 0 && lookbackBlockers({ ...lbTrip, status: 'draft' }, false, TODAY).length > 0)
  check('look-back: source has the real photo as cover and no supplier words', (() => { const s = lookbackSource({ ...lbTrip, recap_summary: 'A great week. Tour Cancelled.', recap_highlights: ['Taormina'] }); return !!s && s.cover_image_url === recapUrl && s.title === 'Look back at Southern Italy' && !/cancel/i.test(s.grounding ?? '') })() && lookbackSource({ ...lbTrip, gallery_urls: [] }) === null)
  check('look-back: picks the most recently finished eligible trip', pickLookbackTrip([lbTrip, { ...lbTrip, slug: 'later', available_to: '2026-08-01', gallery_urls: ['https://x.test/storage/later-recap-1790000000000-horizontal.jpg'] }], new Set(), TODAY)?.slug === 'later' && pickLookbackTrip([lbTrip], new Set([lbTrip.slug]), TODAY) === null)
  const mk = (setting: string | null, extra: Row[] = []): Db => ({ tables: { travel_packages: [lbTrip as Row, ...extra], post_distribution: [], app_settings: setting === null ? [] : [{ key: 'trip_social_posts', value: setting }] } })
  {
    const db = mk('true')
    const note = await runLookBackDraft(fakeAdmin(db), 'auto', new Date('2026-10-24T12:00:00Z'))
    const r = db.tables.post_distribution[0]
    check('look-back: drafts ONE held row (never queued, no auto-hold note so nothing releases it)', /look-back draft/.test(note) && db.tables.post_distribution.length === 1 && r.stage === 'held' && r.slug === lookbackSlug(lbTrip.slug) && !r.last_error && r.path === `/packages/${lbTrip.slug}`, db.tables.post_distribution)
    const again = await runLookBackDraft(fakeAdmin(db), 'auto', new Date('2026-10-25T12:00:00Z'))
    check('look-back: once per trip, even on a later day', again === '' && db.tables.post_distribution.length === 1)
  }
  for (const [label, db, mode] of [['setting off', mk('false'), 'auto'], ['setting unset', mk(null), 'auto'], ['distribution mode off', mk('true'), 'off'], ['automation paused', (() => { const d = mk('true'); d.tables.app_settings.push({ key: 'automation_paused', value: 'true' }); return d })(), 'auto'], ['no real photo', mk('true', []), 'auto']] as [string, Db, string][]) {
    if (label === 'no real photo') db.tables.travel_packages = [{ ...lbTrip, gallery_urls: ['https://x.test/stock.jpg'] } as Row]
    const note = await runLookBackDraft(fakeAdmin(db), mode, new Date('2026-10-24T12:00:00Z'))
    check(`look-back: ${label} drafts nothing`, note === '' && db.tables.post_distribution.length === 0)
  }
  {
    const db = mk('true')
    db.tables.app_settings.push({ key: 'distribution_mode', value: 'auto' })
    const note = await runTripSocialEnrol(fakeAdmin(db), 'prepare', new Date('2026-10-24T12:00:00Z'))
    check('look-back: the trip posting pass runs it (prepare mode), still held', /look-back draft/.test(note) && db.tables.post_distribution.every((r) => r.stage === 'held'))
  }
  const dist = read('lib', 'distribution.ts')
  check('look-back: no automatic release path touches lookback rows (they are not guide- or package- rows)', !/lookback/.test(read('lib', 'auto-policies.ts')) && !/lookback/.test(read('lib', 'guide-release.ts')) && /lookbackSource/.test(read('lib', 'guide-post-source.ts')) && /runTripSocialEnrol\(admin/.test(dist))
  check('posting pass: a post is never text only (the image gate is the only send path)', /resolveRowImage/.test(dist) && /no text-only path/.test(dist))

  // ─── Source hygiene ────────────────────────────────────────────────────────────────
  for (const f of ['lib/past-trip-kit.ts', 'lib/trip-lookback.ts', 'components/trip/past-trip-page.tsx', 'components/trip/past-trip-hero.tsx']) {
    const s = read(...f.split('/'))
    check(`${f}: no long dash and no phone-like number`, !s.includes(String.fromCharCode(8212)) && !s.includes(String.fromCharCode(8211)) && !/\+?\d[\d\s().-]{8,}\d/.test(s.replace(/\d{4}-\d{2}-\d{2}/g, '')))
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
}
main()
