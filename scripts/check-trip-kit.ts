// Self-check for the Trip Page Kit: pure rules, the page blocks, the fill engine with fake fetchers (no network, no database).
// Run: pnpm dlx tsx scripts/check-trip-kit.ts
import { renderToStaticMarkup } from 'react-dom/server'
import React, { createElement } from 'react'
;(globalThis as unknown as { React: unknown }).React = React
import {
  parseTripKit, parsePriceConfirmed, priceConfirmedLine, placesFromList, placesFromName, hostFromName, isPriceText, withoutPriceSentences, scrubReferenceText,
  parseWikivoyageExtract, parseWikipediaSummary, buildKeyFacts, inclusionBlocks, buildToConfirm, attributionList, dateRangeText, timesFromText, dateOfDay,
  containsPhrase, TRIP_KIT_VERSION, tripPriceConfirmedKey, tripKitKey, type TripKit,
} from '../lib/trip-kit-facts'
import { tripKitBlockers, thingBlockers } from '../lib/trip-kit-gate'
import { planTripKit, memoryCache, tidyShort, metaYearWrong, supplierUrlOf, bundleText, type FillDeps } from '../lib/trip-kit-fill'
import { resolveReference } from '../lib/trip-kit-refs'
import { completenessScore } from '../lib/package-completeness'
import type { DbPackage } from '../lib/packages'
import { TripKitHero } from '../components/trip/trip-kit-hero'
import { KeyFactsStrip, RouteTimeline, InclusionBlock, GoodToKnow, AgentCta, KitAttribution } from '../components/trip/trip-kit-body'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 300)}` : ''}`)
}

async function main() {
  // ─── Price rule ──────────────────────────────────────────────────────────────────
  check('price text: dollar amount, pp, per person, discount', isPriceText('Deposit is only $150pp') && isPriceText('from $1,999') && isPriceText('Save 20% off today') === false ? true : isPriceText('Deposit is only $150pp') && isPriceText('about 150 pp') && isPriceText('per person'))
  check('price text: plain sentence is not a price', !isPriceText('Join us for a lovely, sun-filled adventure at the resort.'))
  check('withoutPriceSentences drops the money sentence only', withoutPriceSentences('We stay at a resort. Deposit is only $150pp to lock it in! Bring a friend.') === 'We stay at a resort. Bring a friend.')
  const rec = JSON.stringify({ by: 'Amy', at: '2026-10-03T12:00:00Z', text: 'From $1,999 per person' })
  check('price confirmed needs by + at + text', !!parsePriceConfirmed(rec) && !parsePriceConfirmed(JSON.stringify({ by: '', at: '2026-10-03T12:00:00Z', text: 'x' })) && !parsePriceConfirmed(JSON.stringify({ by: 'a', at: 'nope', text: 'x' })) && !parsePriceConfirmed(null) && !parsePriceConfirmed('{bad'))
  const line = priceConfirmedLine(parsePriceConfirmed(rec)!)
  check('price line says confirmed by your agent on a date, subject to availability', /Confirmed by your agent on October 3, 2026, subject to availability/.test(line.note) && line.headline.includes('1,999'), line)
  check('settings keys', tripPriceConfirmedKey('x') === 'trip_price_confirmed:x' && tripKitKey('x') === 'trip_kit:x')

  // ─── Places ──────────────────────────────────────────────────────────────────────
  const ny = placesFromList('Fort Lauderdale * Puerto Plata, Dominican Republic * Charlotte Amalie, St. Thomas * St. Johns, Antigua')
  check('places: star list keeps order and region', ny.length === 4 && ny[1].name === 'Puerto Plata' && ny[1].region === 'Dominican Republic', ny)
  const hr = placesFromList('Dubrovnik, Slano, Korcula, Vis, Bisevo, Hvar, Stari Grad, Boi, Split, Trogir, Sibenik, Vodice, and Zagreb')
  check('places: comma list with final and', hr.length === 13 && hr[12].name === 'Zagreb', hr.map((p) => p.name))
  const it = placesFromList('Southern Italy & Sicily, Featuring Taormina, Matera and the Amalfi Coast, Palermo, Monreale, Agrigento’s Valley of the Temples, Piazza Amerina, Giardini Naxos, Strait of Messina, Sorrento, Positano, Pompeii, and more')
  check('places: featuring list, "and more" dropped', it.some((p) => p.name === 'Taormina') && it.some((p) => p.name === 'Pompeii') && !it.some((p) => /more/i.test(p.name)), it.map((p) => p.name))
  const ab = placesFromList('Cologne, Germany to Basel, Switzerland')
  check('places: A to B gives a start and an end', ab.length === 2 && ab[0].kind === 'start' && ab[1].kind === 'end', ab)
  check('places: prose is not a list', placesFromList('We are staying at the STUNNING Joia Paraiso by Iberostar, an all-inclusive resort. Think swim-up bars, white sand, amazing food.').length === 0)
  check('places from the trip name only', placesFromName('RHINE RIVER & SWISS ALPS w/ Amy & Liz').map((p) => p.name).join('|') === 'Rhine River|Swiss Alps')
  check('host from name', hostFromName('WOMEN\'S TRIP 2027 w/ Amy & Liz') === 'Amy & Liz' && hostFromName('Croatia Cruise') === null)

  // ─── Dates and hours only when stored ────────────────────────────────────────────
  check('date range text has no dashes', dateRangeText('2026-09-04', '2026-09-08') === 'Sep 4 to 8, 2026' && dateRangeText('2027-01-23', '2027-02-14') === 'Jan 23 to Feb 14, 2027')
  check('day N date needs a start date and a day', dateOfDay('2027-06-12', 3) === '2027-06-14' && dateOfDay(null, 3) === null && dateOfDay('2027-06-12', null) === null)
  check('times: only what the text says', timesFromText('Arrive at 8:00 am. Depart 5:00 pm.').arrive === '8:00 am' && timesFromText('Enjoy the harbour.').arrive === null && timesFromText('Enjoy the harbour.').depart === null)

  // ─── Reference parsing ───────────────────────────────────────────────────────────
  const extract = `Dubrovnik is a historic walled city on the Adriatic Sea coast in Croatia. It is one of the most prominent tourist destinations in the Mediterranean and a seaport. Its population is about 65,000 people.\n\n== Understand ==\nThe city was built on maritime trade and later became a rival to Venice in the Adriatic for many years of history. This part is long enough to count.\n\n== See ==\n\n=== Old Town ===\nThe Placa Stradun is the central street.\n\n1 Pile Gate (Vrata od Pila), at the western end. A convenient starting place for a stroll through the Old Town. \n2 Sponza Palace (West of the Bell Tower). Daily 10:00-22:00. Gothic Renaissance palace. €5. \n3 Rector's Palace, Pred dvorom 1, ☏ +385 20 321 437. The former palace houses a museum about the city history. €15. \n\n== Do ==\n\n Cliff Jumping @ Cafe Buža. See listing. \n Lazareti, Frana Supila 8. Old quarantine hospital serves as a cultural centre.\n\n== Buy ==\nShops everywhere in the old town and beyond for a long time.`
  const ref = parseWikivoyageExtract('Dubrovnik', 'Dubrovnik', extract, 'https://en.wikivoyage.org/wiki/Dubrovnik')
  check('reference: parsed with See and Do names', !!ref && ref.see.map((i) => i.name).join('|') === 'Pile Gate|Sponza Palace|Rector\'s Palace' && ref.doItems.length >= 1, ref)
  check('reference: intro keeps no digit sentence', !!ref && !/\d/.test(ref.intro) && /walled city/.test(ref.intro), ref?.intro)
  check('reference: blurbs hold no hours, prices or phone numbers', !!ref && [...ref.see, ...ref.doItems].every((i) => !/\d|€|\+/.test(i.blurb)), ref?.see)
  check('reference: disambiguation page rejected', parseWikipediaSummary('Vis', { type: 'disambiguation', title: 'Vis', extract: 'Vis may refer to something.' }) === null)
  check('scrub drops sentences with digits or hours', scrubReferenceText('A lovely harbour town with many cafes. Open daily from 9 to 5. It has 300 steps up the hill to the castle.') === 'A lovely harbour town with many cafes.')
  const fakeJson = async (url: string) => {
    if (url.includes('wikivoyage.org/w/api.php') && url.includes('prop=extracts') && /titles=(Dubrovnik|Hvar|Split)\b/.test(url)) return { query: { pages: { '1': { title: decodeURIComponent(/titles=([^&]+)/.exec(url)![1]), extract } } } }
    return null
  }
  const found = await resolveReference({ name: 'Dubrovnik', region: 'Croatia', kind: 'city' }, ['croatia'], fakeJson)
  check('resolve: relevant page accepted', found?.title === 'Dubrovnik')
  const wrong = await resolveReference({ name: 'Dubrovnik', region: null, kind: 'city' }, ['peru'], fakeJson)
  check('resolve: a page that never mentions the trip country is rejected', wrong === null)

  // ─── Gate: the "best" policy ─────────────────────────────────────────────────────
  const g = (t: string) => tripKitBlockers(t, { grounding: 'Hvar Split Croatia trip', field: 'note' })
  check('gate: opinion words allowed (stunning, best, iconic)', g('Hvar is a stunning island and the best place to relax on the water.').length === 0, g('Hvar is a stunning island and the best place to relax on the water.'))
  check('gate: award claim blocked', g('Hvar is an award-winning island.').length > 0)
  check('gate: guarantee blocked', g('We guarantee you will love Hvar.').length > 0)
  check('gate: lowest price blocked', g('Enjoy Hvar at the lowest price.').length > 0 && g('Get the best price on Hvar.').length > 0)
  check('gate: money amount blocked', g('Hvar costs $500 per person.').length > 0)
  check('gate: fake urgency blocked', g('Hurry, this trip will sell out.').length > 0)
  check('gate: star rating blocked', g('A five-star stay near Hvar.').length > 0)
  check('thing line must name something from the reference page', thingBlockers('Wander the old streets and enjoy the harbour views here.', ['Pile Gate'], 'Pile Gate').length > 0 && thingBlockers('Start your walk at Pile Gate, the western entrance to the old town.', ['Pile Gate'], 'Pile Gate old town western entrance').length === 0)

  // ─── Page blocks ─────────────────────────────────────────────────────────────────
  const kit: TripKit = {
    v: TRIP_KIT_VERSION, generatedAt: '2026-10-24T00:00:00Z', promise: 'A coastal escape.', routeKnown: true,
    stops: [{ name: 'Dubrovnik', kind: 'city', region: 'Croatia', date: null, arrive: null, depart: null, days: null, photo: { url: 'https://images.pexels.com/x.jpg', alt: 'Dubrovnik', credit: 'Photo by A on Pexels', creditUrl: null }, things: [{ text: 'Walk the old town from Pile Gate.', source: { label: 'Wikivoyage', url: 'https://en.wikivoyage.org/wiki/Dubrovnik' } }], source: { label: 'Trip details', url: null } }],
    otherStops: ['Boi'], included: [], notIncluded: [], goodToKnow: [], attributions: [{ label: 'Wikivoyage', url: 'https://en.wikivoyage.org/wiki/Dubrovnik' }], toConfirm: ['secret admin note'],
  }
  const pkgRow = { name: 'Croatia Cruise', destination: 'Croatia', duration: '12 Days', available_from: '2027-06-12', available_to: '2027-06-23', departure_dates: null, price_includes: null, not_included: null, itinerary: null }
  const heroProps = { heading: 'Croatia Cruise', category: 'Cruise', destination: 'Croatia', destinationHref: '/destinations/croatia', image: '/x.jpg', duration: '12 Days', availableFrom: '2027-06-12', availableTo: '2027-06-23', promise: 'A coastal escape.', phone: '(555) 010-0000', telHref: 'tel:+15550100000' }
  const heroNo = renderToStaticMarkup(createElement(TripKitHero, { ...heroProps, price: null }))
  check('hero without a confirmed price shows no price and no dollar sign', !/\$|trip-kit-price/.test(heroNo) && /Talk to an agent about today/.test(heroNo), heroNo.slice(0, 200))
  const heroYes = renderToStaticMarkup(createElement(TripKitHero, { ...heroProps, price: parsePriceConfirmed(rec) }))
  check('hero with a confirmed price shows it with who/when wording', /From \$1,999 per person/.test(heroYes) && /Confirmed by your agent on October 3, 2026, subject to availability/.test(heroYes))
  check('hero has one h1 and the public phone link', (heroNo.match(/<h1/g) ?? []).length === 1 && heroNo.includes('tel:+15550100000'))
  const facts = renderToStaticMarkup(createElement(KeyFactsStrip, { pkg: pkgRow, kit }))
  check('key facts: dates and length from the row', /Jun 12 to 23, 2027/.test(facts) && /12 Days/.test(facts))
  check('key facts: host only when the name says so', buildKeyFacts({ ...pkgRow, name: 'Trip w/ Amy & Liz' }, null).some((f) => f.label === 'Hosted with') && !buildKeyFacts(pkgRow, null).some((f) => f.label === 'Hosted with'))
  const route = renderToStaticMarkup(createElement(RouteTimeline, { kit, cta: createElement('div', { id: 'midcta' }, 'cta') }))
  check('route: stop card with photo, alt = place name, lazy, things, other stops, mid cta', /Your route/.test(route) && /alt="Dubrovnik"/.test(route) && /loading="lazy"/.test(route) && /Pile Gate/.test(route) && /Also on the route/.test(route) && /midcta/.test(route))
  check('route: unknown order says "Where you are headed"', /Where you are headed/.test(renderToStaticMarkup(createElement(RouteTimeline, { kit: { ...kit, routeKnown: false }, cta: null }))))
  const incFlights = renderToStaticMarkup(createElement(InclusionBlock, { pkg: { price_includes: 'Seven nights in a cabin', not_included: 'Flights are not included' }, kit: null }))
  check('included block: stored "Flights are not included" is shown', /Flights are not included/.test(incFlights) && !/Wondering about flights/.test(incFlights))
  const incNone = renderToStaticMarkup(createElement(InclusionBlock, { pkg: { price_includes: null, not_included: null }, kit: null }))
  check('included block: nothing stored means "ask your agent", never an invented list', /Your agent will confirm/.test(incNone) && /Wondering about flights/.test(incNone))
  check('included lists never carry price text', inclusionBlocks({ price_includes: 'Breakfast\nDeposit $150pp', not_included: null }, null).included.map((f) => f.text).join('|') === 'Breakfast')
  const gtk = renderToStaticMarkup(createElement(GoodToKnow, { kit }))
  check('good to know: ask-your-agent fallbacks for deposit, passports, cancellation', /Ask your agent when the deposit is due/.test(gtk) && /Ask your agent what documents/.test(gtk) && /cancellation terms/.test(gtk))
  const gtk2 = renderToStaticMarkup(createElement(GoodToKnow, { kit: { ...kit, goodToKnow: [{ label: 'Deposit', text: 'The deposit is due by March 1, 2027.', source: { label: 'Supplier page', url: 'https://x.test' } }] } }))
  check('good to know: stored deposit date replaces the fallback', /due by March 1, 2027/.test(gtk2) && !/Ask your agent when the deposit is due/.test(gtk2))
  const cta = renderToStaticMarkup(createElement(AgentCta, { phone: '(555) 010-0000', telHref: 'tel:+15550100000', tripName: 'Croatia Cruise', heading: 'Talk', method: 'x' }))
  check('CTA: call or text link, callback request, no agent named', /tel:\+15550100000/.test(cta) && /Request a callback from a live agent/.test(cta) && /href="#enquire"/.test(cta) && !/Amy|Liz|Meagan|Scott/.test(cta))
  check('CTA: no chat button (no chat widget exists in this codebase)', !/Chat with us/.test(cta))
  const attr = renderToStaticMarkup(createElement(KitAttribution, { kit }))
  check('attribution line names Wikivoyage with its link and the licence', /Source:/.test(attr) && /Wikivoyage/.test(attr) && /CC BY-SA/.test(attr) && /en\.wikivoyage\.org/.test(attr))
  check('admin-only "to confirm" is never rendered by any block', ![heroNo, facts, route, gtk, cta, attr].some((h) => /secret admin note/.test(h)))
  check('kit round trip and defensive parse', parseTripKit(JSON.stringify(kit))?.stops[0].name === 'Dubrovnik' && parseTripKit('{"v":99}') === null && parseTripKit('nope') === null && parseTripKit(JSON.stringify({ v: 1, stops: [{ name: '' }, 5, { name: 'X', photo: { url: 'http://insecure' } }] }))?.stops[0].photo === null)
  check('attributions come only from reference sources', attributionList(kit.stops).length === 1)

  // ─── The fill engine with fakes ──────────────────────────────────────────────────
  const row = {
    id: 'pkg-1', name: 'CROATIA COASTLINE YACHT CRUISE', slug: 'croatia-test', destination: 'Croatia', country: null, region: null, category: 'Cruise', tags: [],
    price_display: 'Contact for pricing', price_value: null, currency: 'USD', price_includes: null, duration: '12 Days', duration_days: 12,
    available_from: '2027-06-12', available_to: '2027-06-23', departure_dates: null,
    short_description: 'Dubrovnik, Hvar, Split, Trogir and Zagreb', full_description: null, highlights: null, itinerary: null,
    image_url: 'https://x.test/a.jpg', gallery_urls: [], journal_entries: [], booking_url: 'https://info.travelfunbiz.com/', more_info_url: null,
    status: 'published', not_included: null, keywords: [], meta_title: 'Croatia Coastline Yacht Cruise | 12 Days', meta_description: 'A 12-day Croatia yacht cruise, Jun 12-23, 2027, visiting Dubrovnik, Hvar and Split. Book with TravelFunBiz.ca.', ai_faqs: null, supplier: null,
  } as unknown as DbPackage
  let aiCalls = 0
  let jsonCalls = 0
  const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 17 === 16 ? 'harbour.' : 'calm')).join(' ')
  const goodDescription = `The CROATIA COASTLINE YACHT CRUISE explores the Adriatic coast over 12 days. ${words(430)} Ask about this trip and a travel specialist can help you plan it.`
  const deps: FillDeps = {
    json: async (u) => {
      jsonCalls++
      return fakeJson(u)
    },
    supplierText: async () => null,
    ai: async (prompt) => {
      aiCalls++
      return {
        raw: {
          promise: 'A relaxed coastal cruise with historic towns and island stops.',
          full_description: goodDescription,
          highlights: ['Dubrovnik old town', 'Hvar island', 'Split and Trogir', 'Zagreb city', 'Relaxed yacht pace'],
          meta_title: 'Croatia Coastline Yacht Cruise | 12 Days', meta_description: 'A 12 day Croatia yacht cruise visiting Dubrovnik, Hvar, Split and Zagreb. Talk to a travel specialist about dates.',
          keywords: ['croatia yacht cruise', 'dubrovnik cruise', 'hvar trip', 'split trip', 'croatia group trip'],
          places: { Dubrovnik: { blurb: 'A historic walled city on the Adriatic.', things: ['Start your walk at Pile Gate, the western entrance to the old town.', 'Visit Sponza Palace and Rector\'s Palace in the old town.', 'Swim in the sea below the old wall at the harbour.'] } },
          included: [], not_included: [], good_to_know: [],
          _prompt: prompt.length,
        },
        usage: { input: 10, output: 10 },
      }
    },
    photos: async () => [{ id: 1, url: 'https://images.pexels.com/1.jpg', alt: 'Dubrovnik old town', width: 2000, height: 1200, photographer: 'Pat', photographerUrl: null, pageUrl: 'https://www.pexels.com/photo/1' }, { id: 2, url: 'https://images.pexels.com/2.jpg', alt: 'Dubrovnik harbour', width: 2000, height: 1200, photographer: 'Sam', photographerUrl: null, pageUrl: 'https://www.pexels.com/photo/2' }],
    upload: async () => ({ image_url: null, image_url_square: null, image_url_portrait: null, image_url_banner: null }),
    faqs: async () => ({ faqs: [1, 2, 3, 4].map((n) => ({ question: `Question ${n}?`, answer: `Answer ${n}.` })), discarded: 0, called: true }),
    now: () => new Date('2026-10-24T12:00:00Z'),
  }
  const site = { existing: new Set(['/', '/packages', '/destinations/croatia']), targets: [{ path: '/destinations/croatia', title: 'Croatia', dest: 'croatia', rank: 0 }] }
  const cache = memoryCache()
  const budget = { left: 4, used: 0 }
  const plan = await planTripKit(row, [], deps, cache, site, budget, { today: '2026-10-24' })
  check('engine: description, highlights, itinerary and FAQs are proposed', ['full_description', 'highlights', 'itinerary', 'ai_faqs'].every((f) => f in plan.updates), Object.keys(plan.updates))
  check('engine: NEVER writes a price field or the price record', !Object.keys(plan.updates).some((k) => /price|currency/.test(k)) && !plan.edits.some((e) => /price|currency/.test(e.field)))
  check('engine: nothing that already has a value is overwritten (meta stays)', !('meta_title' in plan.updates) && !('meta_description' in plan.updates))
  check('engine: the description gets a Related line to a page that exists', /\[Croatia\]\(\/destinations\/croatia\)/.test(String(plan.updates.full_description)))
  check('engine: every thing-to-do line has a cited source url', plan.kit.stops.every((s) => s.things.every((t) => !!t.source.url && /^https:\/\//.test(t.source.url))) && plan.kit.stops.some((s) => s.things.length > 0))
  check('engine: attribution list present for the reference pages used', plan.kit.attributions.some((a) => a.label === 'Wikivoyage'))
  check('engine: a line that names nothing from the reference page is dropped', plan.kit.stops.find((s) => s.name === 'Dubrovnik')!.things.every((t) => !/Swim in the sea below/.test(t.text) || /harbour|wall/.test(t.text)))
  check('engine: route stops without a reference page are listed, not invented', plan.kit.otherStops.length > 0 && plan.kit.stops.every((s) => !!s.name))
  check('engine: no arrival or departure hours, no dates invented', plan.kit.stops.every((s) => s.arrive === null && s.depart === null && s.date === null))
  check('engine: "to confirm" list covers flights, deposit, hours and cancellation', ['flights', 'Deposit', 'Hours in port', 'Cancellation'].every((w) => plan.kit.toConfirm.some((t) => t.includes(w))), plan.kit.toConfirm)
  check('engine: score rises', plan.after.completeness.score > plan.before.completeness.score && plan.after.seo.score >= plan.before.seo.score, [plan.before.completeness.score, plan.after.completeness.score])
  check('engine: stays within the call cap (places not needed, writer 1, FAQs 1)', aiCalls === 1 && budget.used === 2 && plan.calls === 2, { aiCalls, used: budget.used })
  const callsAfterFirst = { ai: aiCalls, json: jsonCalls }
  const budget2 = { left: 4, used: 0 }
  const again = await planTripKit(row, [], deps, cache, site, budget2, { today: '2026-10-24' })
  check('cache: a repeat run costs no AI call and no reference fetch', aiCalls === callsAfterFirst.ai && jsonCalls === callsAfterFirst.json && budget2.used === 0, { aiCalls, jsonCalls, used: budget2.used })
  check('cache: same plan the second time', JSON.stringify(Object.keys(again.updates).sort()) === JSON.stringify(Object.keys(plan.updates).sort()))
  const none = await planTripKit({ ...row, id: 'pkg-2' }, [], deps, memoryCache(), site, { left: 0, used: 0 }, { today: '2026-10-24' })
  check('budget: with no calls left nothing is written and no AI is called', !('full_description' in none.updates) && aiCalls === callsAfterFirst.ai + 0)

  // blockers: a description with an award and a price is held, never applied
  const badDeps: FillDeps = { ...deps, ai: async () => ({ raw: { promise: 'x', full_description: `The CROATIA COASTLINE YACHT CRUISE is an award-winning trip from $999 per person. ${words(430)}`, places: {}, highlights: ['a', 'b', 'c', 'd'] }, usage: { input: 1, output: 1 } }) }
  const badPlan = await planTripKit({ ...row, id: 'pkg-3' }, [], badDeps, memoryCache(), site, { left: 4, used: 0 }, { today: '2026-10-24' })
  check('blockers: award and price in the description hold it back', !('full_description' in badPlan.updates) && badPlan.held.some((h) => h.field === 'full_description' && h.reasons.some((r) => /award|price|\$/.test(r))), badPlan.held)

  // past trips: only empty fields, no short rewrite, no meta overwrite
  const past = await planTripKit({ ...row, id: 'pkg-4', available_to: '2026-01-01', available_from: '2025-12-28', short_description: 'Dubrovnik, Hvar, Split and Zagreb. Deposit is only $150pp.', meta_description: 'A trip in 2030.' }, [], deps, memoryCache(), site, { left: 4, used: 0 }, { today: '2026-10-24' })
  check('past trip: page text is not rewritten (short description and meta untouched)', past.past && !('short_description' in past.updates) && !('meta_description' in past.updates))

  // ─── Small pure helpers ──────────────────────────────────────────────────────────
  check('tidy short: money, emoji, tildes and dashes removed', tidyShort('~ Luxury stay: 7 nights — river view. \u{1F6CC}\u{1F305}~ Deposit is only $150pp!') === 'Luxury stay: 7 nights, river view.', tidyShort('~ Luxury stay: 7 nights — river view. \u{1F6CC}\u{1F305}~ Deposit is only $150pp!'))
  check('meta year check', metaYearWrong('A trip Dec 28 to Jan 4, 2026', '2026-12-28', '2027-01-04') === false && metaYearWrong('A trip, Jan 4, 2025', '2026-12-28', '2027-01-04') === true)
  check('supplier link: own site is not a source, a supplier site is', supplierUrlOf({ booking_url: 'https://info.travelfunbiz.com/', more_info_url: null }) === null && supplierUrlOf({ booking_url: 'https://groups.gocollette.com/x', more_info_url: null }) === 'https://groups.gocollette.com/x')
  check('bundle: price sentences are kept out of the grounding and listed', (() => { const b = bundleText({ ...row, short_description: 'A resort stay. Deposit is only $150pp.' } as DbPackage, [], null); return !/150/.test(b.grounding) && b.priceMentions.some((m) => /150/.test(m)) })())
  check('containsPhrase is accent and case blind', containsPhrase('Visit Korčula and Hvar', 'korcula'))
  check('completeness unchanged for the existing rules', completenessScore({}).score === 0)
  check('to confirm: deposit, final payment and flights asked only when no source states them', buildToConfirm({ pkg: pkgRow, kit: { stops: [], included: [], notIncluded: [], goodToKnow: [], routeKnown: false, otherStops: [] }, sourceText: 'Deposit due by March 1. Final payment is due in May. Flights are not included. Cancellation: see terms. Passport required.', priceMentions: [] }).length === 0)

  if (failed) {
    console.log(`\n${failed} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nall trip kit checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
