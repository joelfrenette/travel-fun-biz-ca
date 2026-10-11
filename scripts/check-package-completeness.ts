// Self-check for trip detail intake (WP11): the completeness score and the auto-apply rules of
// proposeEnrichment. No network, no database: the copy writer is replaced by a fake.
// Run: pnpm dlx tsx scripts/check-package-completeness.ts
import { completenessScore, THIN_BELOW } from '../lib/package-completeness'
import { proposeEnrichment, sameSiteHost, copyBlockers, itemSupported, type CopyWriter } from '../lib/package-enrich'
import { groundDraft, dateGrounded, numberNextToUnit, type ExtractedDraft } from '../lib/package-extract'
import { detectFile, pdfPageCount, estimateCostUsd } from '../lib/package-sources'
import { watchedUrls, scanPageText, rowMonths, isoWeek, rotateByWeek } from '../lib/source-watch'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

// ─── Completeness ───────────────────────────────────────────────────────────────────

const live = { full_description: null, highlights: null, price_includes: null, not_included: null, itinerary: null, ai_faqs: null, gallery_urls: [], departure_dates: null, available_from: '2027-05-01', available_to: '2027-05-08' }
const thinLive = completenessScore(live)
check('a live-style trip (only dates) scores 5 and is thin', thinLive.score === 5 && thinLive.thin, thinLive)
check('thin trip lists plain reasons', thinLive.reasons.length === 7 && thinLive.reasons.includes('no full description'), thinLive.reasons)
check('399 word description earns nothing, 400 earns 30', completenessScore({ full_description: words(399) }).score === 0 && completenessScore({ full_description: words(400) }).score === 30)
check('3 highlights earn nothing, 4 earn 15', completenessScore({ highlights: ['a', 'b', 'c'] }).score === 0 && completenessScore({ highlights: ['a', 'b', 'c', 'd'] }).score === 15)
check('included 10, not included 5', completenessScore({ price_includes: 'Breakfast' }).score === 10 && completenessScore({ not_included: 'Flights' }).score === 5)
const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ day: i + 1, title: `Stop ${i + 1}`, description: '' }))
check('itinerary: 2 stops nothing, 3 stops 15', completenessScore({ itinerary: stops(2) }).score === 0 && completenessScore({ itinerary: stops(3) }).score === 15)
check('itinerary scores only what the page renders (array of titled stops)', completenessScore({ itinerary: [{}, {}, {}] }).score === 0 && completenessScore({ itinerary: { days: [1, 2, 3] } }).score === 0 && completenessScore({ itinerary: 'a\nb\nc' }).score === 0)
check('faqs: 2 nothing, 3 earn 10', completenessScore({ ai_faqs: [{ question: 'q', answer: 'a' }, { question: 'q', answer: 'a' }] }).score === 0 && completenessScore({ ai_faqs: [1, 2, 3].map(() => ({ question: 'q', answer: 'a' })) }).score === 10)
check('gallery: 2 nothing, 3 earn 10', completenessScore({ gallery_urls: ['a', 'b'] }).score === 0 && completenessScore({ gallery_urls: ['a', 'b', 'c'] }).score === 10)
check('departure dates alone earn 5', completenessScore({ departure_dates: ['2027-05-01'] }).score === 5)
const full = completenessScore({ full_description: words(450), highlights: ['a', 'b', 'c', 'd'], price_includes: 'x', not_included: 'y', itinerary: stops(3), ai_faqs: [1, 2, 3].map(() => ({ question: 'q', answer: 'a' })), gallery_urls: ['a', 'b', 'c'], departure_dates: ['2027-05-01'] })
check('everything present is 100 and not thin', full.score === 100 && !full.thin && full.reasons.length === 0, full)
check('exactly 60 is not thin, 59 is', completenessScore({ full_description: words(400), highlights: ['a', 'b', 'c', 'd'], price_includes: 'x', not_included: 'y' }).thin === false && THIN_BELOW === 60 && completenessScore({ full_description: words(400), highlights: ['a', 'b', 'c', 'd'], price_includes: 'x' }).score === 55)

// ─── Source helpers ─────────────────────────────────────────────────────────────────

check('PNG, JPEG, WebP, PDF are detected by bytes', detectFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mediaType === 'image/png' && detectFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mediaType === 'image/jpeg' && detectFile(Buffer.from('RIFF....WEBPVP8 '))?.mediaType === 'image/webp' && detectFile(Buffer.from('%PDF-1.7\n'))?.kind === 'pdf')
check('an executable or a renamed file is refused', detectFile(Buffer.from('MZ\u0090\u0000\u0003')) === null && detectFile(Buffer.from('<html>')) === null)
check('PDF page count reads /Count', pdfPageCount(Buffer.from('%PDF-1.4 /Type /Pages /Count 31 /Kids')) === 31)
check('cost estimate is plain arithmetic', estimateCostUsd(10_000, 2_000) === 0.06, estimateCostUsd(10_000, 2_000))

// ─── Enrichment: auto-apply rules ───────────────────────────────────────────────────

const transcript = `Greek Isles Cruise for Singles. 7 nights from Athens, departing June 12, 2027.
Price from $2,499 CAD per person. Included: daily breakfast, airport transfers, a local guide.
Not included: flights, travel insurance. Group size up to 24 travellers. Supplier: Island Hopper Tours.
Day 1 arrive in Athens and meet the group. Day 2 sail to the first island and relax on the beach.`

const emptyPkg = {
  id: 'p1', name: 'Greek Isles Cruise for Singles', destination: 'Greece', country: null, region: null, supplier: null, duration: '', duration_days: null,
  price_display: '', price_value: null, currency: 'CAD', category: 'Cruise', available_from: null, available_to: null, departure_dates: null,
  price_includes: null, not_included: null, max_people: null, booking_url: 'https://info.travelfunbiz.com/', more_info_url: null, itinerary: null,
  highlights: null, full_description: null, meta_title: null, meta_description: null, keywords: [], short_description: 'A relaxed singles cruise around the Greek islands.',
}

const raw = {
  fields: {
    destination: 'Greece', country: 'Greece', supplier: 'Island Hopper Tours', duration: '7 nights', duration_days: 8,
    price_display: 'From $2,499 CAD per person', price_value: 2499, currency: 'CAD', max_people: 24,
    available_from: '2027-06-12',
    price_includes: ['Daily breakfast', 'Airport transfers', 'A local guide', 'Welcome cocktail party'],
    not_included: ['Flights', 'Travel insurance'],
    booking_url: 'https://invented.example.com/book',
    category: 'Cruise',
    itinerary: [
      { day: 1, title: 'Arrive in Athens', description: 'Meet the group.' },
      { day: 2, title: 'Sail to the first island', description: 'Relax on the beach.' },
      { day: 3, title: 'Sunset wine tasting', description: 'Taste the island wines.' },
    ],
  },
  evidence: { price_display: 'Price from $2,499 CAD per person', supplier: 'Supplier: Island Hopper Tours' },
}
const draft: ExtractedDraft = groundDraft(raw, transcript, undefined, 'fake-model')

const changeOf = (list: { field: string }[], field: string) => list.find((c) => c.field === field) as ReturnType<typeof Object> | undefined as any

let writerCalls = 0
const sentence = 'You will spend relaxing days exploring the coast with a small friendly group and a local guide. '
const goodWriter: CopyWriter = async () => {
  writerCalls++
  return {
    raw: {
      full_description: sentence.repeat(12).trim(),
      highlights: ['Seven nights around the islands', 'Daily breakfast', 'A local guide', 'Small group travel'],
      meta_title: 'Greek Isles Cruise for Singles',
      meta_description: 'A relaxed singles cruise around the islands with a small group.',
      keywords: ['greek isles cruise', 'singles cruise', 'small group cruise'],
    },
    usage: { input: 1000, output: 500 },
  }
}

;(async () => {
  const e = await proposeEnrichment(emptyPkg as any, draft, { transcript, writeCopy: goodWriter })

  const price = changeOf(e.facts, 'price_display')
  check('empty + grounded fact auto-applies (price)', price?.autoApply === true && price.proposed.includes('2,499'), price)
  check('grounded number fields auto-apply (duration_days, max_people)', changeOf(e.facts, 'duration_days')?.autoApply === true && changeOf(e.facts, 'max_people')?.autoApply === true)
  check('grounded date auto-applies', changeOf(e.facts, 'available_from')?.autoApply === true)
  const inc = changeOf(e.facts, 'price_includes')
  check('an inclusion the source never mentions is dropped, the rest still apply', inc?.autoApply === false && !String(inc.proposed).includes('cocktail') && String(inc.proposed).includes('breakfast'), inc)
  check('a list with a dropped item is not auto-applied (needs a look)', inc?.autoApply === false)
  const notInc = changeOf(e.facts, 'not_included')
  check('a fully supported list auto-applies as newline text', notInc?.autoApply === true && notInc.proposed === 'Flights\nTravel insurance', notInc)
  const it = changeOf(e.facts, 'itinerary')
  check('itinerary keeps only stops found in the source and is not auto-applied when one was dropped', it && it.proposed.length === 2 && it.autoApply === false, it)
  check('an invented link never appears (groundDraft drops it)', !changeOf(e.facts, 'booking_url'))
  check('category is a judgment: never auto, and equal values are skipped', !changeOf(e.facts, 'category'))

  const differ = await proposeEnrichment({ ...emptyPkg, price_display: 'From $1,999 CAD' } as any, draft, { transcript, writeCopy: goodWriter })
  const d = changeOf(differ.facts, 'price_display')
  check('a non-empty fact is never auto-overwritten: differs, click to replace', d && d.autoApply === false && /click replace/i.test(d.reason), d)

  const noText = await proposeEnrichment(emptyPkg as any, draft, { writeCopy: goodWriter })
  check('without stored source text lists are not proposed and no copy is written', !changeOf(noText.facts, 'not_included') && noText.copy.length === 0 && noText.calls === 0)

  // Copy
  const fd = changeOf(e.copy, 'full_description')
  check('clean copy for an empty field auto-applies', fd?.autoApply === true && !fd.held, fd)
  check('copy: highlights, meta and keywords all produced', ['highlights', 'meta_title', 'meta_description', 'keywords'].every((f) => changeOf(e.copy, f)?.autoApply === true))
  check('exactly one copy model call, tokens returned', e.calls === 1 && e.usage?.input === 1000)

  const badWriter = (text: string): CopyWriter => async () => ({ raw: { full_description: text, highlights: ['Daily breakfast'], meta_title: 'Greek Isles Cruise for Singles', meta_description: 'Short and fine.', keywords: ['greek cruise'] } })
  const sup = await proposeEnrichment(emptyPkg as any, draft, { transcript, writeCopy: badWriter(`${sentence.repeat(12)} This is the best award-winning cruise.`) })
  check('a superlative holds the copy back (held, never auto)', changeOf(sup.copy, 'full_description')?.held === true && changeOf(sup.copy, 'full_description')?.autoApply === false)
  const num = await proposeEnrichment(emptyPkg as any, draft, { transcript, writeCopy: badWriter(`${sentence.repeat(12)} Prices drop to $1,899 in spring.`) })
  check('a number not in the source holds the copy back', /number not in the source/.test(changeOf(num.copy, 'full_description')?.reason ?? ''), changeOf(num.copy, 'full_description'))
  const agency = await proposeEnrichment(emptyPkg as any, draft, { transcript, writeCopy: badWriter(`${sentence.repeat(12)} We have hosted this trip many times.`) })
  check('an agency history claim holds the copy back', changeOf(agency.copy, 'full_description')?.held === true)
  const dash = await proposeEnrichment(emptyPkg as any, draft, { transcript, writeCopy: badWriter(`${sentence.repeat(12)} Relax \u2014 enjoy the sea.`) })
  check('a dash is repaired, not blocked, and never survives', changeOf(dash.copy, 'full_description')?.autoApply === true && !/[\u2013\u2014]/.test(changeOf(dash.copy, 'full_description').proposed))
  const venue = await proposeEnrichment(emptyPkg as any, draft, { transcript, writeCopy: badWriter(`${sentence.repeat(12)} Dinner is at Hotel Olympus Palace on the first night.`) })
  check('a named place not in the source holds the copy back', changeOf(venue.copy, 'full_description')?.held === true)
  const short = await proposeEnrichment(emptyPkg as any, draft, { transcript, writeCopy: badWriter('Too short to be a description.') })
  check('a description under the minimum is held', changeOf(short.copy, 'full_description')?.held === true)

  // Non-empty copy is never rewritten
  let called = 0
  const full = await proposeEnrichment({ ...emptyPkg, full_description: 'Already written.', highlights: ['a', 'b'], meta_title: 'T', meta_description: 'D', keywords: ['k'] } as any, draft, { transcript, writeCopy: async () => { called++; return { raw: {} } } })
  check('copy is not generated for fields that already have text, and the model is not called', full.copy.length === 0 && called === 0 && full.calls === 0)

  // Source-copied highlights
  const hlDraft = groundDraft({ fields: { highlights: ['Daily breakfast', 'Airport transfers', 'A local guide', 'Relax on the beach', 'Seven nights'] } }, transcript, undefined, 'm')
  const hl = await proposeEnrichment({ ...emptyPkg, full_description: 'x', meta_title: 'T', meta_description: 'D', keywords: ['k'] } as any, hlDraft, { transcript, writeCopy: async () => { called++; return { raw: {} } } })
  check('4+ supported highlights from the source are used without a model call', changeOf(hl.copy, 'highlights')?.autoApply === true && called === 0)

  // Helpers
  check('itemSupported accepts source words and rejects invented ones', itemSupported('Daily breakfast', transcript.toLowerCase()) && !itemSupported('Welcome cocktail party', transcript.toLowerCase()))
  check('copyBlockers: clean text passes', copyBlockers(sentence.repeat(12), { grounding: transcript, field: 'full_description' }).length === 0)
  check('copyBlockers: thousands separators match (2,499 vs 2499)', copyBlockers('Prices start from 2499 per person and the group is small and friendly for everyone who joins.', { grounding: 'From $2,499 CAD', field: 'meta_description' }).length === 0)

  // ─── Round 1 QA rules ─────────────────────────────────────────────────────────────
  // Rule 1: price_value must sit inside the price as shown
  const pv = groundDraft({ fields: { price_display: 'From $2,499 CAD per person', price_value: 2499 } }, transcript, undefined, 'm')
  check('price_value matching the price shown is kept', pv.fields.price_value === 2499)
  const pvBad = groundDraft({ fields: { price_display: 'From $2,499 CAD per person', price_value: 24 } }, transcript, undefined, 'm')
  check('price_value from a stray number elsewhere (24 travellers) is dropped', pvBad.fields.price_value === undefined && pvBad.dropped.some((d) => d.field === 'price_value'))
  const hasPrice = await proposeEnrichment({ ...emptyPkg, price_display: 'From $1,999 CAD', price_value: null } as any, draft, { transcript, writeCopy: goodWriter })
  check('price_value is click-only when the page already shows a price', changeOf(hasPrice.facts, 'price_value')?.autoApply === false)
  const usd = groundDraft({ fields: { price_display: 'From $2,499 CAD per person', price_value: 2499, currency: 'CAD' } }, transcript, undefined, 'm')
  const curr = await proposeEnrichment({ ...emptyPkg, currency: 'USD' } as any, usd, { transcript, writeCopy: goodWriter })
  check('currency differs from a deliberate USD row: price shown and number are click-only', changeOf(curr.facts, 'price_display')?.autoApply === false && changeOf(curr.facts, 'price_value')?.autoApply === false && /Currency differs/.test(changeOf(curr.facts, 'price_display')?.reason))
  const dflt = await proposeEnrichment(emptyPkg as any, usd, { transcript, writeCopy: goodWriter })
  check('the CAD default counts as unset: price still auto-applies from a text source', changeOf(dflt.facts, 'price_display')?.autoApply === true && changeOf(dflt.facts, 'price_value')?.autoApply === true)

  // Rule 2: dates need month, day and year together
  check('dateGrounded: month day, year', dateGrounded('2027-06-12', 'Departs June 12, 2027.') && dateGrounded('2027-06-12', 'Departs 12 June 2027') && dateGrounded('2027-06-19', 'June 12-19, 2027') && dateGrounded('2027-06-12', 'Date: 2027-06-12') && dateGrounded('2027-06-12', 'on 06/12/2027'))
  check('dateGrounded: scattered year and day are not enough', !dateGrounded('2027-06-12', 'Copyright 2027. Call 12 people. Room 12.') && !dateGrounded('2027-06-12', 'July 12, 2027') && !dateGrounded('2027-06-12', 'June 2027, 12 nights'))
  const dd = groundDraft({ fields: { available_from: '2027-06-12', departure_dates: ['2027-06-12', '2027-08-30'] } }, transcript, undefined, 'm')
  check('an ungrounded departure date is dropped, a grounded one kept', JSON.stringify(dd.fields.departure_dates) === '["2027-06-12"]')

  // Rule 3: counts next to a unit word
  check('numberNextToUnit: 24 travellers, 7 nights, 7-night', numberNextToUnit(24, 'Group size up to 24 travellers', 'people|travell?ers?') && numberNextToUnit(7, '7 nights from Athens', 'nights?|days?') && numberNextToUnit(7, 'a 7-night cruise', 'nights?'))
  check('numberNextToUnit: a number far from any unit does not count', !numberNextToUnit(24, 'Call 24 hours. Cabins sleep many guests comfortably on board today', 'guests?|people') && !numberNextToUnit(14, 'Booking opens 14 March for everyone this year. Eight nights at sea', 'nights?|days?'))
  const cnt = groundDraft({ fields: { max_people: 2027, duration_days: 12 } }, transcript, undefined, 'm')
  check('max_people and duration_days from unrelated numbers are dropped', cnt.fields.max_people === undefined && cnt.fields.duration_days === undefined)

  // Rule 4: file sources never auto-apply prices, dates, links, duration, group size
  const blankPkg = { ...emptyPkg, destination: null, booking_url: null }
  const fileDraft = groundDraft({ fields: { price_display: 'From $2,499 CAD per person', price_value: 2499, duration: '7 nights', duration_days: 8, max_people: 24, available_from: '2027-06-12', supplier: 'Island Hopper Tours', destination: 'Athens', booking_url: 'https://www.islandhopper.example/book' } }, `${transcript} Book at https://www.islandhopper.example/book`, undefined, 'm')
  for (const kind of ['screenshot', 'pdf'] as const) {
    const fe = await proposeEnrichment(blankPkg as any, fileDraft, { transcript: `${transcript} Book at https://www.islandhopper.example/book`, kind, writeCopy: goodWriter })
    const blocked = ['price_display', 'price_value', 'duration', 'duration_days', 'max_people', 'available_from', 'booking_url']
    check(`${kind}: every price/date/link/duration/group-size fact is click-only`, blocked.every((f) => changeOf(fe.facts, f) && changeOf(fe.facts, f).autoApply === false), blocked.map((f) => [f, changeOf(fe.facts, f)?.autoApply]))
    check(`${kind}: supplier and destination still auto-apply`, changeOf(fe.facts, 'supplier')?.autoApply === true && changeOf(fe.facts, 'destination')?.autoApply === true)
  }
  const ue = await proposeEnrichment(blankPkg as any, fileDraft, { transcript: `${transcript} Book at https://www.islandhopper.example/book`, kind: 'url', sourceUrl: 'https://islandhopper.example/greece', writeCopy: goodWriter })
  check('url source: a link on the same site or parent domain auto-applies', changeOf(ue.facts, 'booking_url')?.autoApply === true, changeOf(ue.facts, 'booking_url'))
  const ue2 = await proposeEnrichment(blankPkg as any, fileDraft, { transcript: `${transcript} Book at https://www.islandhopper.example/book`, kind: 'url', sourceUrl: 'https://other-site.example/page', writeCopy: goodWriter })
  check('url source: a link on a different site is click-only', changeOf(ue2.facts, 'booking_url')?.autoApply === false)

  // Round 2: currency, link hosts, dash ranges, rotation
  const usdText = 'Island cruise. From $2,499 USD per person for 7 nights. Departs June 12, 2027.'
  const usdDraft = groundDraft({ fields: { price_display: 'From $2,499 USD per person', price_value: 2499, currency: 'USD' } }, usdText, undefined, 'm')
  const usdOnCad = await proposeEnrichment(emptyPkg as any, usdDraft, { transcript: usdText, writeCopy: goodWriter })
  check('extracted USD on a CAD row: price shown and number are click-only with a currency note', changeOf(usdOnCad.facts, 'price_display')?.autoApply === false && changeOf(usdOnCad.facts, 'price_value')?.autoApply === false && /Currency differs/.test(changeOf(usdOnCad.facts, 'price_display')?.reason), changeOf(usdOnCad.facts, 'price_display'))
  const noCur = groundDraft({ fields: { price_display: 'From $2,499 CAD per person', price_value: 2499 } }, transcript, undefined, 'm')
  const noCurE = await proposeEnrichment(emptyPkg as any, noCur, { transcript, writeCopy: goodWriter })
  check('no currency extracted: prices auto-apply', changeOf(noCurE.facts, 'price_display')?.autoApply === true && changeOf(noCurE.facts, 'price_value')?.autoApply === true)
  check('sameSiteHost: same host and parent domain pass', sameSiteHost('https://www.x.example/a', 'https://www.x.example/b') && sameSiteHost('https://www.x.example/a', 'https://x.example/') && sameSiteHost('https://x.example/', 'https://book.x.example/'))
  check('sameSiteHost: sibling subdomains and other sites fail', !sameSiteHost('https://www.x.example/', 'https://tours.x.example/') && !sameSiteHost('https://x.example/', 'https://y.example/') && !sameSiteHost('https://evilx.example/', 'https://x.example/'))
  const en = String.fromCharCode(0x2013)
  const em = String.fromCharCode(0x2014)
  check('dateGrounded accepts en and em dash ranges', dateGrounded('2027-06-19', `June 12${en}19, 2027`) && dateGrounded('2027-06-12', `June 12${em}19, 2027`))
  check('rotateByWeek starts at a different trip in different weeks', rotateByWeek([1, 2, 3, 4], new Date('2026-10-10T12:00:00Z'))[0] !== rotateByWeek([1, 2, 3, 4], new Date('2026-10-17T12:00:00Z'))[0] && rotateByWeek([1, 2, 3], new Date()).length === 3)

  // Rule 9: PDF page count reads page tree nodes only
  check('pdfPageCount ignores outline /Count values', pdfPageCount(Buffer.from('%PDF-1.4 /Type /Outlines /Count 99 >> /Type /Pages /Kids [1 0 R] /Count 4 >>')) === 4)

  // Source watch (pure parts)
  const none = { available_from: '2027-06-12', available_to: '2027-06-19' }
  check('watchedUrls skips the funnel root and keeps a supplier page', JSON.stringify(watchedUrls({ booking_url: 'https://info.travelfunbiz.com/', more_info_url: 'https://www.collette.com/group/abc' })) === '["https://www.collette.com/group/abc"]')
  check('watchedUrls skips null and non-web links', watchedUrls({ booking_url: null, more_info_url: 'mailto:a@b.c' }).length === 0)
  check('page that says Tour Cancelled is flagged', scanPageText('Greek Isles. Tour Cancelled. Contact us.', none, '2026-10-10').some((f) => f.kind === 'cancelled'))
  check('sold out and wait list are flagged', scanPageText('This departure is sold out', none, '2026-10-10').length === 1 && scanPageText('This departure has a waitlist now', none, '2026-10-10').length === 1)
  check('a generic waitlist link is not flagged', scanPageText('Subscribe to our newsletter or join the waitlist today', none, '2026-10-10').length === 0)
  check('a departure date month counts as expected for the date check', scanPageText('Departing September 3, 2027', { ...none, departure_dates: ['2027-09-03'] }, '2026-10-10').length === 0)
  check('cancellation policy wording is not flagged', scanPageText('If the trip is cancelled by the traveller, fees apply. Free cancellation up to 60 days.', none, '2026-10-10').length === 0)
  check('dates that include the trip month are fine', scanPageText('Departing June 12, 2027 from Toronto', none, '2026-10-10').length === 0)
  check('dates that never include the trip month are flagged', scanPageText('Now departing September 3, 2027', none, '2026-10-10').some((f) => f.kind === 'dates'))
  check('a page with no dates says nothing about dates', scanPageText('A lovely trip around the islands', none, '2026-10-10').length === 0)
  check('rowMonths covers the window', JSON.stringify(rowMonths('2027-06-28', '2027-07-05')) === '["2027-06","2027-07"]')
  check('isoWeek labels a date', isoWeek(new Date('2026-10-10T12:00:00Z')) === '2026-W41', isoWeek(new Date('2026-10-10T12:00:00Z')))

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
})()
