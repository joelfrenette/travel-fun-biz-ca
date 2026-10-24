// Offline check: GA4 client id on leads, key events and the server-side Measurement Protocol event.
// Run: pnpm dlx tsx scripts/check-ga4-lead.ts   (exit 1 on a failure)
import {
  GA4_PARAM_WHITELIST, buildGa4Event, buildMeasurementProtocolRequest, classifyLinkClick, gaClientIdFromCookie,
  gaClientIdIfConsented, isGaClientId, leadEventParams, sanitizeEventParams,
} from '../lib/ga4-lead'
import { sendLeadToMeasurementProtocol } from '../lib/ga4-mp'
import { attributionSchema } from '../lib/attribution'
import { contactSubmissionSchema } from '../lib/schemas/contact'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`ok   ${name}`)
  else { failures++; console.log(`FAIL ${name} ${detail}`) }
}

const COOKIES = 'theme=dark; _ga=GA1.1.1234567890.1712345678; _ga_ABC123=GS1.1.1.1.1.1.1.0; other=1'

// ---- client id: parsing, validation, consent gate
expect('parses the last two numeric parts of _ga', gaClientIdFromCookie(COOKIES) === '1234567890.1712345678')
expect('parses a bare _ga value', gaClientIdFromCookie('GA1.2.987654321.1700000000') === '987654321.1700000000')
expect('does not read _ga_ABC123 as _ga', gaClientIdFromCookie('_ga_ABC123=GS1.1.1.1.1.1.1.0') === null)
expect('no _ga cookie gives null', gaClientIdFromCookie('a=b; c=d') === null)
expect('empty and null give null', gaClientIdFromCookie('') === null && gaClientIdFromCookie(null) === null && gaClientIdFromCookie(undefined) === null)
expect('junk _ga gives null', gaClientIdFromCookie('_ga=hello') === null && gaClientIdFromCookie('_ga=GA1.1.abc.def') === null)
expect('too-short parts give null', gaClientIdFromCookie('_ga=GA1.1.12.34') === null)
expect('validator accepts a good id', isGaClientId('12345.67890') && isGaClientId('1234567890.1712345678'))
expect('validator rejects bad ids', !isGaClientId('1234') && !isGaClientId('12345.abcde') && !isGaClientId('1234567890123.1234567') && !isGaClientId(5) && !isGaClientId(null) && !isGaClientId('12345.67890; drop'))
expect('NO consent: the cookie is never read', gaClientIdIfConsented(false, COOKIES) === null)
expect('consent: the id comes through', gaClientIdIfConsented(true, COOKIES) === '1234567890.1712345678')

// ---- schema backward compatibility
expect('old attribution (no ga_client_id) still passes', attributionSchema.safeParse({ utm_source: 'x', page_path: '/a' }).success)
expect('empty attribution passes', attributionSchema.safeParse({}).success)
const withId = attributionSchema.parse({ page_path: '/a', ga_client_id: '1234567890.1712345678' })
expect('a valid ga_client_id is kept', withId.ga_client_id === '1234567890.1712345678')
const bad = attributionSchema.safeParse({ page_path: '/a', ga_client_id: 'not an id' })
expect('a malformed ga_client_id never rejects the lead', bad.success && bad.data.ga_client_id === undefined && bad.data.page_path === '/a')
const sub = contactSubmissionSchema.safeParse({ name: 'A B', email: 'a@b.co', attribution: { ga_client_id: '<script>' } })
expect('submission with a bad id is still accepted', sub.success)
expect('submission with a good id carries it', contactSubmissionSchema.parse({ name: 'A B', email: 'a@b.co', attribution: { ga_client_id: '12345.67890' } }).attribution?.ga_client_id === '12345.67890')

// ---- events: consent and GA id gating
const params = { page_path: '/packages/x', method: 'tel_link' }
expect('no consent: no event', buildGa4Event('click_to_call', params, { consent: false, gaId: 'G-ABC1234567' }) === null)
expect('no GA id: no event', buildGa4Event('click_to_call', params, { consent: true, gaId: undefined }) === null && buildGa4Event('click_to_call', params, { consent: true, gaId: '' }) === null)
expect('bad GA id: no event', buildGa4Event('click_to_call', params, { consent: true, gaId: 'UA-1' }) === null)
expect('unknown event name: nothing', buildGa4Event('purchase', params, { consent: true, gaId: 'G-ABC1234567' }) === null)
for (const n of ['generate_lead', 'click_to_call', 'click_to_text', 'book_call_click', 'affiliate_click']) {
  expect(`${n} fires with consent and a GA id`, buildGa4Event(n, params, { consent: true, gaId: 'G-ABC1234567' })?.name === n)
}

// ---- link classification
const tel = classifyLinkClick('tel:+15555550123', '/packages/x')
expect('tel: is click_to_call', tel?.name === 'click_to_call')
expect('the phone number is not in the params', !JSON.stringify(tel).includes('5555550123'))
expect('sms: is click_to_text', classifyLinkClick('sms:+15555550123', '/')?.name === 'click_to_text')
expect('TEL: upper case counts', classifyLinkClick('TEL:+15555550123')?.name === 'click_to_call')
const aff = classifyLinkClick('/go/viking-cruises?ref=1', '/blog/p')
expect('/go/ is affiliate_click with the slug only', aff?.name === 'affiliate_click' && aff.params.affiliate_slug === 'viking-cruises')
expect('absolute /go/ link counts', classifyLinkClick('https://travelfunbiz.ca/go/abc', '/', 'travelfunbiz.ca')?.name === 'affiliate_click')
expect('ordinary and mailto links are ignored', classifyLinkClick('/blog/x') === null && classifyLinkClick('mailto:a@b.co') === null && classifyLinkClick('https://other.com/go/x', '/', 'travelfunbiz.ca') === null && classifyLinkClick('') === null)

// ---- param whitelist: no PII
const dirty = sanitizeEventParams({
  trip_name: 'Greek Isles', source: 'facebook', intent: 'callback', page_path: '/packages/greek-2026-10-24',
  email: 'joel@example.com', phone: '+1 555 555 0123', name: 'Joel Frenette', message: 'hello', link_url: 'https://x.com/?e=a@b.co',
})
expect('whitelist keeps the allowed keys', dirty.trip_name === 'Greek Isles' && dirty.source === 'facebook' && dirty.intent === 'callback' && dirty.page_path === '/packages/greek-2026-10-24')
expect('whitelist drops every other key', Object.keys(dirty).every((k) => (GA4_PARAM_WHITELIST as readonly string[]).includes(k)))
expect('an email-looking value is dropped even under an allowed key', sanitizeEventParams({ trip_name: 'joel@example.com' }).trip_name === undefined)
expect('a phone-looking value is dropped even under an allowed key', sanitizeEventParams({ source: '+1 (555) 555-0123' }).source === undefined)
expect('values are cut to 100 characters', (sanitizeEventParams({ trip_name: 'x'.repeat(300) }).trip_name ?? '').length === 100)
expect('non-string values are dropped', Object.keys(sanitizeEventParams({ trip_name: 5, intent: { a: 1 } })).length === 0)
const lp = leadEventParams({ tripName: 'Greek Isles', source: undefined, intent: undefined, pagePath: '/packages/greek' })
expect('lead params default source to direct and intent to info', lp.source === 'direct' && lp.intent === 'info' && lp.trip_name === 'Greek Isles')
expect('lead params have no value or currency', !('value' in lp) && !('currency' in lp))

// ---- Measurement Protocol payload
const mid = 'G-ABC1234567'
const req = buildMeasurementProtocolRequest({ measurementId: mid, apiSecret: 's3cret', clientId: '1234567890.1712345678', tripName: 'Greek Isles', source: 'facebook', intent: 'callback' })
expect('MP request is built with secret, id and client id', !!req)
expect('MP url targets /mp/collect with the measurement id and secret', !!req && req.url.startsWith('https://www.google-analytics.com/mp/collect?') && req.url.includes(`measurement_id=${mid}`) && req.url.includes('api_secret=s3cret'))
expect('MP body: client_id and one generate_lead event', !!req && req.body.client_id === '1234567890.1712345678' && req.body.events.length === 1 && req.body.events[0].name === 'generate_lead')
expect('MP params are trip, source, intent (+ engagement time)', !!req && req.body.events[0].params.trip_name === 'Greek Isles' && req.body.events[0].params.source === 'facebook' && req.body.events[0].params.intent === 'callback' && req.body.events[0].params.engagement_time_msec === 1)
const bodyText = JSON.stringify(req?.body ?? {})
expect('MP body has no email, phone or user_id', !/@|user_id|email|phone/i.test(bodyText))
expect('MP body keys are all whitelisted or engagement time', !!req && Object.keys(req.body.events[0].params).every((k) => k === 'engagement_time_msec' || (GA4_PARAM_WHITELIST as readonly string[]).includes(k)))
expect('MP: no secret, no request', buildMeasurementProtocolRequest({ measurementId: mid, apiSecret: '', clientId: '12345.67890' }) === null && buildMeasurementProtocolRequest({ measurementId: mid, apiSecret: undefined, clientId: '12345.67890' }) === null)
expect('MP: no measurement id, no request', buildMeasurementProtocolRequest({ measurementId: '', apiSecret: 's', clientId: '12345.67890' }) === null)
expect('MP: no or bad client id, no request', buildMeasurementProtocolRequest({ measurementId: mid, apiSecret: 's', clientId: null }) === null && buildMeasurementProtocolRequest({ measurementId: mid, apiSecret: 's', clientId: 'bad' }) === null)
expect('MP: a test lead is skipped', buildMeasurementProtocolRequest({ measurementId: mid, apiSecret: 's', clientId: '12345.67890', isTest: true }) === null)

async function main() {
  // The sender must not touch the network when anything is missing.
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(null, { status: 204 }) }) as typeof fetch
  const noSecret = await sendLeadToMeasurementProtocol({ clientId: '12345.67890', isTest: false }, { NEXT_PUBLIC_GA_ID: mid })
  expect('no secret: nothing sent', noSecret === false && calls === 0)
  const noGa = await sendLeadToMeasurementProtocol({ clientId: '12345.67890', isTest: false }, { GA4_MEASUREMENT_PROTOCOL_SECRET: 's' })
  expect('no GA id: nothing sent', noGa === false && calls === 0)
  const noId = await sendLeadToMeasurementProtocol({ clientId: null, isTest: false }, { NEXT_PUBLIC_GA_ID: mid, GA4_MEASUREMENT_PROTOCOL_SECRET: 's' })
  expect('no client id: nothing sent', noId === false && calls === 0)
  const test = await sendLeadToMeasurementProtocol({ clientId: '12345.67890', isTest: true }, { NEXT_PUBLIC_GA_ID: mid, GA4_MEASUREMENT_PROTOCOL_SECRET: 's' })
  expect('test lead: nothing sent', test === false && calls === 0)
  const sent = await sendLeadToMeasurementProtocol({ clientId: '12345.67890', isTest: false, tripName: 'Greek Isles' }, { NEXT_PUBLIC_GA_ID: mid, GA4_MEASUREMENT_PROTOCOL_SECRET: 's' })
  expect('everything set: exactly one request', sent === true && calls === 1)
  globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
  const failed = await sendLeadToMeasurementProtocol({ clientId: '12345.67890', isTest: false }, { NEXT_PUBLIC_GA_ID: mid, GA4_MEASUREMENT_PROTOCOL_SECRET: 's' })
  expect('a network error is swallowed, never thrown', failed === false)
  globalThis.fetch = realFetch

  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
  console.log('\nAll GA4 lead checks passed')
}
main()
