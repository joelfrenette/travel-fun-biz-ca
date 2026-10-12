// Offline checks for trip length, price on request and host contacts worked out in code (WP13 UAT fix).
// No network, no database, no model call. Run: pnpm dlx tsx scripts/check-trip-duration.ts   (exit 1 on a failure)
import { computeTripDuration, detectPriceOnRequest, extractHostContacts, hasContactDetails, urlHoldsContact } from '../lib/trip-duration'
import { groundDraft } from '../lib/package-extract'
import { priceOnRequestLine, site } from '../lib/site'
import { publishBlockers } from '../lib/trip-wizard'
import { copyBlockers } from '../lib/package-enrich'
import { agentFieldViews } from '../lib/agent-invites'

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
expect('Friday - Sunday with hyphen', label('Friday - Sunday at the lake, a fun trip') === '3 days / 2 nights')
expect('Sat to Sun = 2 days / 1 night', label('Weekend trip: Sat to Sun') === '2 days / 1 night')
expect('Fri to Mon wraps the week', days('Getaway Fri to Mon').duration_days === 4)
expect('Sunday to Sunday is ambiguous, not guessed', days('Week-long trip Sunday to Sunday').duration === null && days('Week-long trip Sunday to Sunday').ambiguous)
expect('weekday basis recorded', days('Weekend getaway Fri to Sun').basis === 'weekdays')

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
const clash = days('January 22-24, 2027, 5 nights')
expect('dates + clashing nights: range kept as a click-only suggestion with the conflict named', clash.duration === '3 days / 2 nights' && clash.confidence === 'suggest' && /5 nights/.test(clash.conflict), JSON.stringify(clash))
expect('two ranges of different length are ambiguous', days('May 1-3, 2027 or May 8-12, 2027').duration === null)
expect('two ranges of the same length are fine', days('May 1-3, 2027 or May 8-10, 2027').duration === '3 days / 2 nights')
expect('grounded ISO dates used when text has no range', days('Details soon', { isoFrom: '2027-01-22', isoTo: '2027-01-24' }).duration === '3 days / 2 nights')
expect('lowercase "may 5 to 10" is a verb, not a month', days('you may 5 to 10 times').duration === null)

// ─── Stated counts ───
expect('3-night', label('A 3-night stay') === '4 days / 3 nights')
expect('3 nights', label('3 nights at sea on this cruise') === '4 days / 3 nights')
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
expect('pricing line is the site-wide number (site.phone)', line.text === `Call or text ${site.phone} for pricing` && site.phone === '(833) 878-5386' && line.telHref === 'tel:+18338785386' && line.smsHref === 'sms:+18338785386', JSON.stringify(line))
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

// ─── QA round: invented durations from bare counts ───
const none = (t: string) => days(t).duration === null
expect('"30 days before departure" is not a length', none('Final payment is due 30 days before departure.'))
expect('"within 14 days" is not a length', none('Cancel within 14 days for a refund.'))
expect('"7-day cancellation" is not a length', none('Our 7-day cancellation policy applies.'))
expect('"2 night minimum" is not a length', none('Hotel has a 2 night minimum on holidays.'))
expect('"60 days of booking" is not a length', none('Deposit due within 60 days of booking.'))
expect('"14 days notice" is not a length', none('Please give 14 days notice.'))
expect('length range "1-2 nights" is ambiguous and flagged', days('Stay 1-2 nights at the lodge').duration === null && days('Stay 1-2 nights at the lodge').ambiguous)
expect('length range "3-4 days" is ambiguous and flagged', days('A 3-4 days trip').duration === null && days('A 3-4 days trip').ambiguous)
expect('"Mon to Fri 9-5" office hours are not a trip', none('Our office is open Mon to Fri 9-5.'))
expect('"Thursday to Sunday" with no trip word is ignored', none('Open Thursday to Sunday for lunch.'))
expect('"Thursday to Sunday" with a trip word counts', days('Join us for a retreat Thursday to Sunday').duration === '4 days / 3 nights')
expect('bare count with no trip word is click-only', days('Take 5 days to explore the island at your pace').confidence !== 'sure')
expect('bare count in the form N-night <trip noun> with a strong trip word is automatic', days('A 3-night getaway for singles').confidence === 'sure')
expect('two different bare counts are ambiguous', days('7 nights on the ship and 3 nights in Rome').ambiguous)
expect('number word "Two nights"', label('Two nights in a cozy lodge on this getaway') === '3 days / 2 nights')
expect('number word "Three-night cruise"', label('A Three-night cruise') === '4 days / 3 nights')
expect('"Sat 22 - Sun 24 Jan 2027"', days('Sat 22 - Sun 24 Jan 2027').duration === '3 days / 2 nights')
expect('"1/22/2027 to 1/24/2027" (22 settles month/day)', days('1/22/2027 to 1/24/2027').duration === '3 days / 2 nights')
expect('"22/01/2027 - 24/01/2027" (day first)', days('22/01/2027 - 24/01/2027').duration === '3 days / 2 nights')
expect('"1/2/2027 to 1/4/2027" is skipped as ambiguous order', days('1/2/2027 to 1/4/2027').duration === null)
expect('ISO range', days('2027-01-22 to 2027-01-24').duration === '3 days / 2 nights')
expect('a phone number is not a date range', none('Call 603-315-2970 - 603-801-8476 now'))

const gClash = groundDraft({ fields: {}, evidence: {} }, 'Weekend retreat January 22-24, 2027. Total 5 nights.', undefined, 'check-model')
expect('clash is flagged and the range is click-only', (gClash.flags ?? []).some((f) => /5 nights/.test(f)) && (gClash.clickOnly ?? []).includes('duration') && gClash.fields.duration === '3 days / 2 nights')
const gBare = groundDraft({ fields: {}, evidence: {} }, 'Take 5 days to explore the island at your own pace, with a local guide.', undefined, 'check-model')
expect('bare count with no trip word fills but is click-only', (gBare.clickOnly ?? []).includes('duration_days'))

// ─── QA round: price on request wording ───
expect('"price upon inquiry"', detectPriceOnRequest('Trip price upon inquiry').onRequest)
expect('"price? call"', detectPriceOnRequest('Price? Call us!').onRequest)
expect('"pricing? text me"', detectPriceOnRequest('Pricing? Text me').onRequest)

// ─── QA round: publish gate and agent view ───
expect('price_on_request satisfies the Price publish gate', publishBlockers({ name: 'White Mountains Weekend', destination: 'New Hampshire', duration: '3 days / 2 nights', price_display: '', price_on_request: true }).length === 0)
expect('no price and no flag still blocks', publishBlockers({ name: 'White Mountains Weekend', destination: 'New Hampshire', duration: '3 days / 2 nights', price_display: '', price_on_request: false }).join() === 'Price')
const view = agentFieldViews({ name: 'X', price_display: '', price_on_request: true }).find((f) => f.key === 'price_display')
expect('agent view shows the price as found but never its value', view?.filled === true && view?.value === null)

// ─── QA round: phone numbers and emails never reach public text ───
const gp = groundDraft(
  {
    fields: {
      name: 'White Mountains Weekend',
      supplier: 'Mountain View Grand Resort & Spa',
      short_description: 'Call Amy at 603-315-2970 for pricing',
      full_description: 'A lovely weekend. Text Liz (603) 801-8476 or email liz@example.com to book.',
      highlights: ['Spa time', 'Call 603.315.2970 to join', 'Mountain views'],
      price_includes: ['Breakfast', 'Questions? liz@example.com'],
      meta_description: 'Reach out on 603 315 2970 today',
      keywords: ['white mountains', 'weekend getaway'],
    },
    evidence: {},
  },
  'Weekend at Mountain View Grand Resort & Spa. Call Amy at 603-315-2970 for pricing. Text Liz (603) 801-8476 or email liz@example.com to book. Spa time. Call 603.315.2970 to join. Mountain views. Breakfast. Questions? liz@example.com. Reach out on 603 315 2970 today. white mountains weekend getaway',
  undefined,
  'check-model',
)
const everything = JSON.stringify(gp.fields)
expect('no phone number or email in any proposed field', !/\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/.test(everything) && !/@/.test(everything), everything)
expect('clean list items are kept', JSON.stringify(gp.fields.highlights) === '["Spa time","Mountain views"]' && JSON.stringify(gp.fields.price_includes) === '["Breakfast"]')
expect('phone fields are dropped with a reason, not blanked silently', gp.dropped.some((d) => d.field === 'short_description') && gp.fields.short_description === undefined)
expect('the numbers still reach the review table as host contacts', (gp.hostContacts ?? []).length >= 2)
expect('copyBlockers refuses text with a phone number', copyBlockers('Call Amy at 603-315-2970 for pricing', { grounding: '603-315-2970', field: 'short_description' }).some((b) => /phone/.test(b)))
expect('copyBlockers passes clean text', !copyBlockers('A relaxed weekend in the mountains.', { grounding: 'weekend mountains', field: 'short_description' }).some((b) => /phone/.test(b)))

// ─── QA round 2: weekday ranges need a STRONG trip word and no schedule words ───
const notSure = (t: string) => days(t).confidence !== 'sure'
for (const t of [
  'Hotel check-in Mon to Fri front desk. Join us on this cruise',
  'Our concierge is available Mon - Fri during your stay at the resort',
  'Join us on tour. Office open Mon to Fri 9 to 5',
  'Resort. Open Mon to Fri. Spa weekend.',
]) expect(`not a sure length: ${t}`, notSure(t) && days(t).duration_days !== 5 || days(t).duration === null, JSON.stringify(days(t)))
expect('loose word only (resort) makes a weekday range click-only', days('Spa resort Mon to Fri with massage').confidence === 'suggest' || days('Spa resort Mon to Fri with massage').duration === null)
expect('strong word makes a weekday range automatic', days('Friends weekend getaway Fri to Sun').confidence === 'sure')

// ─── QA round 2: bare counts ───
for (const t of [
  'This trip includes a 7 day money-back guarantee',
  'Cruise price valid for 30 days',
  'Resort credit valid 14 days',
  'Tour includes 3 days of free parking',
  'Tour 1.5 days',
  'Cabin 2.5 nights',
]) expect(`bare count is not a sure length: ${t}`, notSure(t), JSON.stringify(days(t)))
expect('decimal "1.5 days" never becomes 5 days', days('Tour 1.5 days').duration_days !== 5 && days('Cabin 2.5 nights').duration_days !== 4)
expect('a loose trip word with a bare count is click-only', days('A 3-night cruise for singles').confidence === 'suggest')
expect('the pair form with a strong word is automatic', days('Weekend getaway, 4D/3N').confidence === 'sure')
const gAI = groundDraft({ fields: { duration: '5 nights', duration_days: 6 }, evidence: {} }, 'Weekend getaway January 22-24, 2027. Total 5 nights.', undefined, 'check-model')
expect('a grounded AI duration is not click-only because of a clash flag alone', !(gAI.clickOnly ?? []).includes('duration') && !(gAI.clickOnly ?? []).includes('duration_days'), JSON.stringify(gAI.clickOnly))

// ─── QA round 2: phone numbers in every shape ───
const phoneForms = [
  '+16033152970', `603${EN}315${EN}2970`, `603${String.fromCharCode(0x2011)}315${String.fromCharCode(0x2011)}2970`, '603-315-2970x12', 'Amy603-315-2970',
  '12345678901', '1 (603) 315-2970', '603.315.2970', '(603) 315 2970', `603 315 2970`, 'tel:+16033152970', '+44 20 7946 0958', '+1 603 315 2970 ext 4',
]
for (const p of phoneForms) expect(`phone form detected: ${p}`, hasContactDetails(`Call ${p} now`) || hasContactDetails(p))
expect('host contacts read +1 and unicode dashes', extractHostContacts('Amy +16033152970 and Liz 603–801–8476').map((c) => c.phone).join() === '603-315-2970,603-801-8476', JSON.stringify(extractHostContacts('Amy +16033152970 and Liz 603–801–8476')))
expect('host contacts read Amy603-315-2970 and extensions', extractHostContacts('Amy603-315-2970x12')[0]?.text === 'Amy 603-315-2970')
expect('international number is a host contact', extractHostContacts('Ring +44 20 7946 0958').length === 1)
for (const keep of ['From $2,499 CAD per person', 'January 22-24, 2027', '2027-01-22 to 2027-01-24', 'Florida Seller of Travel # ST42324', 'California Seller of Travel # 2154919-50', 'Toronto, ON M5G 2J5', 'Check in 3:00-5:00 pm', 'Booking ref ABC-12345', 'Price 1,299,000', 'Rooms 2027 2028 2029', 'Order 20270122', '7 nights from Athens']) {
  expect(`not a contact: ${keep}`, !hasContactDetails(keep), keep)
}
const gu = groundDraft(
  { fields: { name: 'Lake Weekend', destination: 'Lake George', short_description: 'Ring Liz on +16033152970 today', full_description: 'Follow @lakeweekendfun or instagram.com/lakeweekend for photos. Call +44 20 7946 0958.', booking_url: 'https://wa.me/16033152970', more_info_url: 'https://example.com/trip' }, evidence: {} },
  'Lake Weekend. Ring Liz on +16033152970 today. Follow @lakeweekendfun or instagram.com/lakeweekend for photos. Call +44 20 7946 0958. Book: https://wa.me/16033152970 More: https://example.com/trip',
  undefined,
  'check-model',
)
expect('no phone, handle or social link in any proposed field', !hasContactDetails(JSON.stringify(gu.fields).replace(/https:\/\/example\.com\/trip/g, '')), JSON.stringify(gu.fields))
expect('wa.me booking link is dropped', gu.fields.booking_url === undefined && gu.dropped.some((d) => d.field === 'booking_url'))
expect('an ordinary more-info link is kept', gu.fields.more_info_url === 'https://example.com/trip')
for (const bad of ['https://wa.me/16033152970', 'https://api.whatsapp.com/send?phone=16033152970', 'sms:+16033152970', 'tel:+16033152970', 'https://example.com/call/603-315-2970', 'https://example.com/book?phone=6033152970', 'https://t.me/amy']) {
  expect(`contact link: ${bad}`, urlHoldsContact(bad), bad)
}
for (const good of ['https://example.com/trip', 'https://www.facebook.com/events/1234567890', 'https://example.com/book?id=1234567890', 'https://example.com/tours/white-mountains-2027']) {
  expect(`ordinary link kept: ${good}`, !urlHoldsContact(good), good)
}
expect('copyBlockers checks URL fields too', copyBlockers('https://wa.me/16033152970', { grounding: '', field: 'booking_url' }).some((b) => /messaging link/.test(b)))
expect('copyBlockers refuses a social handle in copy', copyBlockers('Follow @lakeweekendfun for photos', { grounding: '', field: 'short_description' }).some((b) => /handle/.test(b)))

console.log(failures ? `\n${failures} FAILED` : '\nAll trip duration checks passed')
process.exit(failures ? 1 : 0)
