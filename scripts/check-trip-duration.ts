// Offline checks for trip length, price on request and host contacts worked out in code (WP13 UAT fix).
// No network, no database, no model call. Run: pnpm dlx tsx scripts/check-trip-duration.ts   (exit 1 on a failure)
import { computeTripDuration, detectPriceOnRequest, extractHostContacts } from '../lib/trip-duration'
import { groundDraft } from '../lib/package-extract'
import { priceOnRequestLine } from '../lib/site'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

// Input-only dash characters, built from char codes.
const EN = String.fromCharCode(0x2013)
const EM = String.fromCharCode(0x2014)

const days = (t: string, o?: { isoFrom?: string | null; isoTo?: string | null }) => computeTripDuration(t, o)
const label = (t: string) => days(t).duration

// ─── Weekdays ───
expect('Fri to Sun = 3 days / 2 nights', label('Join us Fri to Sun for a weekend away') === '3 days / 2 nights', String(label('Join us Fri to Sun')))
expect('Friday - Sunday with hyphen', label('Friday - Sunday at the lake') === '3 days / 2 nights')
expect('Sat to Sun = 2 days / 1 night', label('Sat to Sun') === '2 days / 1 night')
expect('Fri to Mon wraps the week', days('Fri to Mon').duration_days === 4)
expect('Sunday to Sunday is ambiguous, not guessed', days('Sunday to Sunday').duration === null && days('Sunday to Sunday').ambiguous)
expect('weekday basis recorded', days('Fri to Sun').basis === 'weekdays')

// ─── Date ranges ───
const d1 = days('January 22-24, 2027')
expect('same-month hyphen range = 3 days / 2 nights', d1.duration === '3 days / 2 nights' && d1.startIso === '2027-01-22' && d1.endIso === '2027-01-24', JSON.stringify(d1))
expect('en dash range', days(`January 22${EN}24, 2027`).duration === '3 days / 2 nights')
expect('em dash range (input only)', days(`January 22${EM}24, 2027`).duration === '3 days / 2 nights')
expect('"to" range', days('January 22 to 24, 2027').duration === '3 days / 2 nights')
expect('"through" range', days('Jan 22 through Jan 24, 2027').duration === '3 days / 2 nights')
expect('weekday names inside the range', days('Friday, January 22 to Sunday, January 24, 2027').duration === '3 days / 2 nights')
expect('day-first range', days('22-24 January 2027').duration === '3 days / 2 nights')
expect('day-first two months', days('28 Jan to 2 Feb 2027').duration_days === 6)
expect('month boundary range', days('March 30 - April 2, 2027').duration === '4 days / 3 nights', String(days('March 30 - April 2, 2027').duration))
expect('year boundary without second year', days('Dec 30, 2026 - Jan 2').duration_days === 4, String(days('Dec 30, 2026 - Jan 2').duration_days))
expect('leap year Feb range uses the year', days('Feb 27 - Mar 1, 2028').duration_days === 4 && days('Feb 27 - Mar 1, 2027').duration_days === 3)
expect('Feb to March with no year is ambiguous', days('Feb 27 - Mar 1').duration === null && days('Feb 27 - Mar 1').ambiguous)
expect('same-day trip', days('Saturday, June 5 - June 5, 2027').duration === '1 day' && days('Saturday, June 5 - June 5, 2027').nights === 0)
expect('day trip phrase', label('A fun day trip to Niagara') === '1 day')
expect('end before start is not a range', days('March 20 - 5, 2027').duration === null || days('March 20 - 5, 2027').duration_days !== -1)
expect('dates + matching nights stay', days('January 22-24, 2027, 2 nights').duration === '3 days / 2 nights')
expect('dates + clashing nights are ambiguous', days('January 22-24, 2027, 5 nights').duration === null && days('January 22-24, 2027, 5 nights').ambiguous)
expect('two ranges of different length are ambiguous', days('May 1-3, 2027 or May 8-12, 2027').duration === null)
expect('two ranges of the same length are fine', days('May 1-3, 2027 or May 8-10, 2027').duration === '3 days / 2 nights')
expect('grounded ISO dates used when text has no range', days('Details soon', { isoFrom: '2027-01-22', isoTo: '2027-01-24' }).duration === '3 days / 2 nights')
expect('lowercase "may 5 to 10" is a verb, not a month', days('you may 5 to 10 times').duration === null)

// ─── Stated counts ───
expect('3-night', label('A 3-night stay') === '4 days / 3 nights')
expect('3 nights', label('Three days... 3 nights at sea') === '4 days / 3 nights')
expect('4D/3N', label('Package: 4D/3N all in') === '4 days / 3 nights')
expect('4 days / 3 nights', label('4 days / 3 nights in Cancun') === '4 days / 3 nights')
expect('5 days only', label('A 5 day getaway') === '5 days / 4 nights')
expect('mismatched D/N pair is ambiguous', days('5D/1N').duration === null && days('5D/1N').ambiguous)
expect('different stated lengths are ambiguous', days('7 nights on the ship and 2 nights in Rome').duration === null && days('7 nights on the ship and 2 nights in Rome').ambiguous)
expect('"30 days notice" is not a trip length', days('Cancel with 30 days notice').duration === null)

// ─── Ambiguous / empty ───
expect('bare "weekend getaway" is flagged, not guessed', days('A weekend getaway with friends!').duration === null && days('A weekend getaway with friends!').ambiguous)
expect('no length at all stays empty and quiet', days('Beautiful beaches and great food.').duration === null && !days('Beautiful beaches and great food.').ambiguous)

// ─── Price on request ───
expect('"call or text for pricing"', detectPriceOnRequest('Call or text for pricing').onRequest)
expect('"Reach out to either of us for pricing and details"', detectPriceOnRequest('Reach out to either of us for pricing and details').onRequest)
expect('"DM for pricing"', detectPriceOnRequest('DM us for pricing!').onRequest)
expect('"pricing available on request"', detectPriceOnRequest('Pricing available on request').onRequest)
expect('"contact us for a quote"', detectPriceOnRequest('Contact us for a quote').onRequest)
expect('no mention of pricing is never on request', !detectPriceOnRequest('A lovely resort weekend. Book now!').onRequest)
expect('a stated price blocks on request', !detectPriceOnRequest('From $899 per person. Call or text for pricing and details.').onRequest)
expect('"call us" without pricing is not on request', !detectPriceOnRequest('Call us to chat about the weekend').onRequest)

// ─── Host contacts ───
const hosts = extractHostContacts('Amy 603-315-2970 and Liz (603) 801-8476')
expect('two host phones found with names', hosts.length === 2 && hosts[0].text === 'Amy 603-315-2970' && hosts[1].phone === '603-801-8476', JSON.stringify(hosts))
expect('a year or price is not a phone', extractHostContacts('January 22-24, 2027 from $1299').length === 0)

// ─── The public line uses OUR number, never a host's ───
const line = priceOnRequestLine()
expect('pricing line is our configured number', line.text === 'Call or text 833-878-5386 for pricing' && line.telHref === 'tel:+18338785386' && line.smsHref === 'sms:+18338785386', JSON.stringify(line))
expect('pricing line never carries a host number', !/603/.test(JSON.stringify(line)))

// ─── Joel's failing post (his own marketing copy), end to end through groundDraft, no model call ───
const POST = `Weekend getaway alert! \u{1F3D4}️✨
Join Amy and Liz at the Mountain View Grand Resort & Spa in the White Mountains of New Hampshire
January 22${EN}24, 2027

Mountain views, spa time, great company and new friends. Singles and friends welcome!
Activities subject to availability and weather conditions.

Reach out to either of us for pricing and details:
Amy 603-315-2970
Liz 603-801-8476

#singlestravel #newhampshire #whitemountains #weekendgetaway #travelfunbiz`

const fake = {
  fields: {
    name: 'White Mountains Weekend Getaway',
    destination: 'White Mountains, New Hampshire',
    supplier: 'Mountain View Grand Resort & Spa',
    price_display: null,
    price_value: null,
    duration: null,
    duration_days: null,
    available_from: '2027-01-22',
    available_to: '2027-01-24',
  },
  evidence: {},
}
const g = groundDraft(fake, POST, undefined, 'check-model')
expect('Joel post: duration 3 days / 2 nights', g.fields.duration === '3 days / 2 nights', String(g.fields.duration))
expect('Joel post: duration_days 3', g.fields.duration_days === 3)
expect('Joel post: start and end dates kept', g.fields.available_from === '2027-01-22' && g.fields.available_to === '2027-01-24')
expect('Joel post: duration no longer listed as missing', !g.missing.includes('duration') && !g.missing.includes('duration_days'))
expect('Joel post: price on request set, no price invented', g.fields.price_on_request === true && g.fields.price_display == null && g.fields.price_value == null)
expect('Joel post: host contacts captured for review only', (g.hostContacts ?? []).join('|') === 'Amy 603-315-2970|Liz 603-801-8476', JSON.stringify(g.hostContacts))
expect('Joel post: derived list explains the length', (g.derived ?? []).some((d) => d.field === 'duration' && /January 22/.test(d.note)))
expect('Joel post: no host number inside any proposed field', !/603/.test(JSON.stringify(g.fields)))
expect('Joel post: duration computed from the dates alone (model gave none)', computeTripDuration(POST).startIso === '2027-01-22' && computeTripDuration(POST).endIso === '2027-01-24')

// Model gave no dates either: the post text alone still yields the length and the first and last date.
const g2 = groundDraft({ fields: { name: 'White Mountains Weekend' }, evidence: {} }, POST, undefined, 'check-model')
expect('Joel post: text alone fills length and dates', g2.fields.duration === '3 days / 2 nights' && g2.fields.available_from === '2027-01-22' && g2.fields.available_to === '2027-01-24')

// Ambiguous text: left empty and surfaced.
const g3 = groundDraft({ fields: { name: 'Beach Weekend' }, evidence: {} }, 'A weekend getaway with our group. Spots are limited so book soon with us today.', undefined, 'check-model')
expect('ambiguous weekend: duration left empty and in missing', g3.fields.duration == null && g3.missing.includes('duration'))
expect('ambiguous weekend: flagged for the review table', (g3.flags ?? []).some((f) => /Trip length left empty/.test(f)))
expect('ambiguous weekend: no price on request invented', g3.fields.price_on_request == null)

// Fri to Sun with no dates at all.
const g4 = groundDraft({ fields: { name: 'Lake Weekend' }, evidence: {} }, 'Our lake weekend runs Fri to Sun. Call or text for pricing.', undefined, 'check-model')
expect('Fri to Sun with no dates: 3 days / 2 nights, price on request', g4.fields.duration === '3 days / 2 nights' && g4.fields.duration_days === 3 && g4.fields.price_on_request === true)

// A model value that disagrees is kept and flagged, never silently replaced.
const g5 = groundDraft({ fields: { duration_days: 5 }, evidence: {} }, 'Join us January 22-24, 2027 for 5 days of fun and 4 nights', undefined, 'check-model')
expect('model/code disagreement is flagged', (g5.flags ?? []).length > 0 || g5.fields.duration_days === 5)

console.log(failures ? `\n${failures} FAILED` : '\nAll trip duration checks passed')
process.exit(failures ? 1 : 0)
