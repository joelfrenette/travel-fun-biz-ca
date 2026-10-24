// Self-check for Convert to Past Trip (WP14): isPastTrip modes, the recap quality gate, the alert tag default,
// the cleaning of admin input, and the "never unpublish a past trip" guard in drift and the supplier-page watch.
// No network, no database, no model call.
// Run: pnpm dlx tsx scripts/check-recap.ts
import { isPastTrip, normaliseRecapMode, happenedLabel, defaultAlertTag, cleanAlertTag, effectiveAlertTag, hasRecap } from '../lib/past-trip'
import { recapBlockers, recapGrounding, cleanRecap, usableNotes, RECAP_WORDS_MIN, gateRecap, notesWordCount, NOTES_MIN_WORDS, NOTES_TOO_SHORT_REASON, type RecapTrip, type RecapNote } from '../lib/recap-composer'
import { RECAP_LOG_NAME } from '../lib/package-sources'
import { recapDriftFindings, type PackageDriftRow } from '../lib/content-drift'
import { watchableTrips } from '../lib/source-watch'
import { cleanJournal } from '../lib/recap-run'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}

const TODAY = '2026-10-11'

// ─── isPastTrip modes ───────────────────────────────────────────────────────────────
check('auto: last date before today is past', isPastTrip({ available_to: '2026-10-10', recap_mode: 'auto' }, TODAY))
check('auto: last date today is NOT past (the old rule)', !isPastTrip({ available_to: TODAY, recap_mode: 'auto' }, TODAY))
check('auto: future date is not past', !isPastTrip({ available_to: '2027-01-01', recap_mode: 'auto' }, TODAY))
check('auto: no date is not past', !isPastTrip({ available_to: null, recap_mode: 'auto' }, TODAY))
check('a missing recap_mode (before migration 0037) behaves as auto', isPastTrip({ available_to: '2026-01-01' }, TODAY) && !isPastTrip({ available_to: '2027-01-01', recap_mode: undefined }, TODAY))
check('recap forces past even with a future date or no date', isPastTrip({ available_to: '2027-01-01', recap_mode: 'recap' }, TODAY) && isPastTrip({ available_to: null, recap_mode: 'recap' }, TODAY))
check('live forces not past even when the dates passed', !isPastTrip({ available_to: '2026-01-01', recap_mode: 'live' }, TODAY))
check('an unknown mode is auto', normaliseRecapMode('weird') === 'auto' && normaliseRecapMode(null) === 'auto')

// ─── Labels and tags ────────────────────────────────────────────────────────────────
check('happened label: one month', happenedLabel('2026-05-12', '2026-05-19') === 'May 2026', happenedLabel('2026-05-12', '2026-05-19'))
check('happened label: two months, same year', happenedLabel('2026-05-28', '2026-06-04') === 'May to June 2026')
check('happened label: across a year end', happenedLabel('2026-12-28', '2027-01-04') === 'December 2026 to January 2027')
check('happened label: one date only, and none', happenedLabel(null, '2026-05-19') === 'May 2026' && happenedLabel(null, null) === null)
check('alert tag default is alert:<category slug>', defaultAlertTag('Singles Cruise') === 'alert:singles-cruise' && defaultAlertTag('') === 'alert:trips' && defaultAlertTag(null) === 'alert:trips')
check('alert tag: own tag wins, a bad one falls back to the default', effectiveAlertTag({ alert_tag: 'Alert:Cruises ', category: 'x' }) === 'alert:cruises' && effectiveAlertTag({ alert_tag: 'bad tag!!', category: 'Hosted Tours' }) === 'alert:hosted-tours' && cleanAlertTag('') === null)
check('hasRecap needs real text', hasRecap({ recap_summary: 'Hi' }) && !hasRecap({ recap_summary: '  ' }) && !hasRecap({}))

// ─── The recap gate ─────────────────────────────────────────────────────────────────
const trip: RecapTrip = { name: 'Greek Isles Singles Cruise', destination: 'Greece', category: 'Cruise', duration: '7 nights', available_from: '2026-05-12', available_to: '2026-05-19', short_description: 'A relaxed singles cruise around the islands.', full_description: null, highlights: ['Island hopping'] }
const notes: RecapNote[] = [
  { date: '2026-05-12', title: 'Arrival', body: 'We met the group in Athens and had a welcome dinner by the water.' },
  { date: '2026-05-14', title: 'First island', body: 'Everyone swam off the boat and then we walked up to the village for lunch.' },
  { date: '2026-05-17', title: 'Last full day', body: 'A slow morning, a long beach afternoon and a farewell toast on deck.' },
]
const grounding = recapGrounding(trip, usableNotes(notes))
check('grounding has the real dates in several forms and no price', grounding.includes('May 12, 2026') && grounding.includes('2026-05-19') && !/price|\$/i.test(grounding), grounding)

const sentence = 'We met the group in Athens, had a welcome dinner by the water, swam off the boat and walked up to the village for lunch before a slow morning and a long beach afternoon. '
const goodSummary = `Our Greek Isles Singles Cruise happened in May 2026 and took the group around the islands of Greece. ${sentence.repeat(5)}`
const good = { summary: goodSummary, highlights: ['A welcome dinner by the water in Athens', 'Swimming off the boat at the first island', 'A farewell toast on deck'] }
const clean = recapBlockers(good, grounding, trip.name)
check('a grounded recap passes the gate', clean.length === 0, clean)
check('summary length floor is enforced', recapBlockers({ ...good, summary: 'We had fun in Greece.' }, grounding, trip.name).some((b) => /too short/.test(b)))
check('too few highlights is held', recapBlockers({ ...good, highlights: ['One'] }, grounding, trip.name).some((b) => /highlights/.test(b)))

const withText = (extra: string) => ({ ...good, summary: `${good.summary} ${extra}` })
const blocked = (extra: string) => recapBlockers(withText(extra), grounding, trip.name)
check('a number not in the notes is held (numbers)', blocked('Forty-two of us joined and 37 swam.').some((b) => /number not in/.test(b)), blocked('37 swam.'))
check('a made-up count in words is held', blocked('We tried four restaurants that week.').some((b) => /count written in words/.test(b)))
check('a number that IS in the notes passes (the 12th of May)', blocked('We met the group in Athens on May 12.').length === 0, blocked('We met the group in Athens on May 12.'))
check('a price is held', blocked('It cost $2,499 per person.').length > 0 && blocked('Great price for what you get.').some((b) => /price/.test(b)))
check('a deal or discount is held', blocked('We got a great deal.').some((b) => /price, deal/.test(b)))
check('opinion "best" is allowed in a recap', blocked('It was the best hotel.').every((b) => !/superlative/.test(b)))
check('superlatives are held (number one, award-winning, 5-star, world-class)', ['It was the number one hotel.','An award-winning ship.', 'A 5-star resort.', 'World-class dining.'].every((t) => blocked(t).some((b) => /superlative/.test(b))))
check('"the best time to visit" is not a superlative', blocked('It was the best time to visit.').every((b) => !/superlative/.test(b)))
check('a date beyond the row (another month) is held', blocked('We went back in August.').some((b) => /month the trip dates do not include/.test(b)), blocked('We went back in August.'))
check('a year not in the row is held', blocked('It was just like 2019.').some((b) => /number not in/.test(b)))
check('a made-up venue or person is held', blocked('Dinner was at Taverna Poseidon with Maria Papadopoulos.').some((b) => /named place or person/.test(b)), blocked('Dinner was at Taverna Poseidon.'))
check('a quote or guest testimonial is held', blocked('One guest said "it changed my life".').some((b) => /quote/.test(b)) && blocked('Guests said it was lovely.').some((b) => /quote/.test(b)))
check('"we" and "our" are allowed (first person, Joel\'s account)', blocked('We walked up to the village for lunch and our group had a slow beach afternoon.').length === 0, blocked('We walked up to the village for lunch.'))
check('a dash or a link is held', blocked('A long day — and a good one.').some((b) => /dash/.test(b)) && blocked('See https://example.com.').some((b) => /link/.test(b)))
check('cleanRecap removes dashes before the gate sees them', !/—|–/.test(cleanRecap({ summary: 'A long day — a good one.', highlights: ['a – b'] }).summary))
check('RECAP_WORDS_MIN is the 110 floor', RECAP_WORDS_MIN === 110)
check('notes with nothing written are not counted', usableNotes([{ date: '2026-05-12', title: '', body: '' }, ...notes]).length === 3)
check('journal input: date and title required, blank rows dropped, sorted', cleanJournal([{ date: '', title: '', body: '' }, { date: '2026-05-14', title: 'b', body: 'x' }, { date: '2026-05-12', title: 'a', body: '' }])?.map((e) => e.title).join('') === 'ab' && cleanJournal([{ date: 'bad', title: 'x', body: '' }]) === null)

// ─── QA round 1: the stricter gate (sentence support, names, number words, weather and feelings, thin notes) ───
const alaska: RecapTrip = { name: 'Alaska Cruise', destination: 'Alaska', available_from: '2026-06-01', available_to: '2026-06-08', short_description: null, full_description: null, highlights: null }
const alaskaNotes: RecapNote[] = [
  { date: '2026-06-01', title: 'Boarding', body: 'We boarded the ship in Juneau and found the spa on deck five.' },
  { date: '2026-06-03', title: 'Glacier day', body: 'The glacier views were calm and the spa was great.' },
  { date: '2026-06-05', title: 'Ashore', body: 'We walked the town and had coffee.' },
]
const aG = recapGrounding(alaska, usableNotes(alaskaNotes))
const only = (sentence: string, re: RegExp, g = aG, name = alaska.name) => recapBlockers({ summary: sentence, highlights: [] }, g, name).filter((b) => re.test(b))
check('support: "we toured a winery and met the captain" fails against spa/glacier/Juneau notes', only('We toured a winery and met the captain.', /not backed by the notes/).length === 1, only('We toured a winery and met the captain.', /not backed/))
check('support: "the spa was great and the glacier views were calm" passes', only('The spa was great and the glacier views were calm.', /not backed by the notes/).length === 0, only('The spa was great and the glacier views were calm.', /not backed/))
check('support: one unsupported sentence is enough to hold the whole recap', recapBlockers({ ...good, summary: `${good.summary} We toured a winery and met the captain.` }, grounding, trip.name).some((b) => /not backed/.test(b)))
check('support: an unsupported highlight is held too', recapBlockers({ ...good, highlights: [...good.highlights.slice(0, 2), 'A private wine tasting with the captain'] }, grounding, trip.name).some((b) => /not backed/.test(b)))
check('support: light stemming counts walked/walk and views/view as the same word', only('We walk the town for coffee.', /not backed by the notes/).length === 0)
check('names: a mid-sentence capitalised word not in the notes is held (Dubrovnik, Maria)', only('We sailed to Dubrovnik.', /a name the notes/).length === 1 && only('Our friend Maria came along.', /a name the notes/).length === 1)
check('names: Juneau passes because the notes say it', only('We boarded the ship in Juneau.', /a name the notes/).length === 0)
check('names: a capital at the start of a sentence is not a name', only('Coffee was had in the town.', /a name the notes/).length === 0)
check('number words: "two", "a dozen", "a couple of", "hundreds" are held', ['We saw two whales.', 'A dozen of us went ashore.', 'We spent a couple of hours there.', 'Hundreds of birds flew by.'].every((t) => only(t, /number written in words/).length === 1), ['We saw two whales.'].map((t) => only(t, /number written in words/)))
check('number words: allowed when the notes use the same word', only('We saw two whales.', /number written in words/, recapGrounding(alaska, usableNotes([...alaskaNotes, { date: '2026-06-06', title: 'Whales', body: 'We saw two whales from the deck.' }]))).length === 0)
check('weather: "warm and sunny" is held unless the notes say it', only('It was warm and sunny on deck.', /weather, crowd or season/).length === 1 && only('It was warm and sunny on deck.', /weather, crowd or season/, recapGrounding(alaska, usableNotes([...alaskaNotes, { date: '2026-06-06', title: 'Deck', body: 'It was warm and sunny on deck.' }]))).length === 0)
check('feelings: "nobody got seasick" is held unless the notes say it', only('Nobody got seasick.', /how people felt/).length === 1 && only('Nobody got seasick.', /how people felt/, recapGrounding(alaska, usableNotes([...alaskaNotes, { date: '2026-06-06', title: 'Sea', body: 'Nobody got seasick on the crossing.' }]))).length === 0)
const shortNotes: RecapNote[] = [{ date: '2026-06-01', title: 'a', body: 'We boarded.' }, { date: '2026-06-02', title: 'b', body: 'Glacier day.' }, { date: '2026-06-03', title: 'c', body: 'Spa day.' }]
check('thin notes: under 40 words in total never auto-publish (draft with the reason)', notesWordCount(shortNotes) < NOTES_MIN_WORDS && gateRecap(good, grounding, trip.name, shortNotes)[0] === NOTES_TOO_SHORT_REASON && NOTES_TOO_SHORT_REASON === 'add a few more notes so the recap stays true to the trip')
check('thin notes: 40 words or more do not add that reason', notesWordCount(notes) >= NOTES_MIN_WORDS && !gateRecap(good, grounding, trip.name, notes).includes(NOTES_TOO_SHORT_REASON), notesWordCount(notes))
check('the Convert to Past Trip log row name is shared by the list filter and the extract guard', RECAP_LOG_NAME === 'Recap (written from journal notes)')

// ─── Never unpublish a past trip ────────────────────────────────────────────────────
const rows: PackageDriftRow[] = [
  { id: '1', slug: 'past-no-recap', name: 'Past No Recap', status: 'published', available_to: '2026-05-19', recap_mode: 'auto', recap_summary: null },
  { id: '2', slug: 'past-with-recap', name: 'Past With Recap', status: 'published', available_to: '2026-05-19', recap_mode: 'recap', recap_summary: 'We went.' },
  { id: '3', slug: 'past-live', name: 'Forced Live', status: 'published', available_to: '2026-05-19', recap_mode: 'live', recap_summary: null },
  { id: '4', slug: 'future', name: 'Future', status: 'published', available_to: '2027-05-19', recap_mode: 'auto', recap_summary: null },
  { id: '5', slug: 'draft-past', name: 'Draft', status: 'draft', available_to: '2026-05-19', recap_mode: 'auto', recap_summary: null },
  { id: '6', slug: 'forced-recap-no-text', name: 'Forced Recap', status: 'published', available_to: null, recap_mode: 'recap', recap_summary: null },
]
const found = recapDriftFindings(rows, TODAY)
check('drift: only published past trips with no recap and not forced live are listed', found.map((f) => f.packageSlug).join(',') === 'past-no-recap,forced-recap-no-text', found.map((f) => f.packageSlug))
check('drift: the only kind is needs_recap and no wording suggests unpublishing', found.every((f) => f.kind === 'needs_recap' && !/unpublish|take (it|the page) down|remove the page|archive/i.test(`${f.detail} ${f.href}`) && f.href.includes('#past-trip-panel')), found)
check('drift: the detail tells the admin to keep it published', found.every((f) => /keep it published/i.test(f.detail)))
check('drift: no finding for a trip that is not past, forced live, or already has a recap', !found.some((f) => ['past-with-recap', 'past-live', 'future'].includes(f.packageSlug)))
const watch = watchableTrips([{ available_to: '2026-05-19', recap_mode: 'auto', n: 'past' }, { available_to: '2027-05-19', recap_mode: 'auto', n: 'future' }, { available_to: '2026-05-19', recap_mode: 'live', n: 'live' }, { available_to: null, recap_mode: 'recap', n: 'forced' }], TODAY)
check('supplier-page watch skips past trips (auto or forced), keeps future and forced-live ones', watch.map((w) => w.n).join(',') === 'future,live', watch)

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
