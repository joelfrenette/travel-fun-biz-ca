// Offline check: "Send me the itinerary and dates" on trip pages (lib/itinerary-magnet.ts, lib/itinerary-magnet-run.ts).
// Run: npx --yes tsx --tsconfig tsconfig.json scripts/check-itinerary-magnet.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { sendLeadAck, buildLeadAckEmail, LEAD_ACK_SETTING_KEY, type LeadAckInput } from '../lib/lead-ack'
import {
  buildItinerary,
  buildItineraryLead,
  bumpItineraryCount,
  isItineraryLeadMessage,
  itineraryEmailStatus,
  itineraryRequestSchema,
  parseItineraryCounts,
  parseItineraryMode,
  signItineraryToken,
  verifyItineraryToken,
} from '../lib/itinerary-magnet'
import { itineraryFormProblem } from '../lib/itinerary-form'
import { handleItineraryRequest, type ItineraryRunDeps } from '../lib/itinerary-magnet-run'
import { isHotLead, normalizeIntent, whatTheyAsked } from '../lib/lead-desk'
import type { TripKit } from '../lib/trip-kit-facts'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const SECRET = 'test-secret-for-itinerary-check'
const TODAY = '2026-10-31'
const ORIGIN = 'https://www.example.test'
const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

const baseTrip = {
  name: 'Greek Isles Cruise',
  destination: 'Greece',
  duration: '8 days',
  available_from: '2027-03-10',
  available_to: '2027-03-17',
  departure_dates: ['2026-01-01', '2027-03-10', '2027-05-02'],
  price_includes: 'Seven nights on board\nAll breakfasts\nTaxes from $199 per person',
  not_included: 'Flights\nTravel insurance',
  itinerary: [
    { day: 1, title: 'Athens', description: 'Arrive and settle in. Rooms from $1,999 per person.' },
    { day: 2, title: 'Santorini', description: 'A day on the island.' },
  ],
}
const PRICE = { by: 'Shelby', at: '2026-10-20T12:00:00Z', text: 'From $2,499 per person' }

// A fake of everything outside the handler: the lead desk, GoHighLevel, the settings, the sender.
function rig(opts: { mode?: 'on' | 'off'; ackOn?: boolean; allow?: boolean; saveId?: string | null; trip?: Partial<typeof baseTrip & { slug: string; recap_mode: null }> | null; secret?: string } = {}) {
  const log: string[] = []
  const saved: Record<string, unknown>[] = []
  const notes: { id: string; message: string }[] = []
  const counts: string[] = []
  const emails: { subject: string; text: string; to: string[] }[] = []
  const settings = new Map<string, string>()
  if (opts.ackOn) settings.set(LEAD_ACK_SETTING_KEY, 'true')
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    log.push('fetch')
    emails.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }) as unknown as typeof fetch
  const deps: ItineraryRunDeps = {
    getMode: async () => opts.mode ?? 'on',
    allow: async () => opts.allow ?? true,
    getTrip: async () => (opts.trip === null ? null : { name: baseTrip.name, slug: 'greek-isles-2027', available_to: baseTrip.available_to, recap_mode: null, ...(opts.trip ?? {}) }),
    saveLead: async (lead) => {
      log.push('save')
      saved.push(lead as unknown as Record<string, unknown>)
      return opts.saveId === undefined ? 'lead-aaaa-1111' : opts.saveId
    },
    forward: async () => (log.push('forward'), { ok: true }),
    markSent: async () => void log.push('markSent'),
    sendAck: async (input: LeadAckInput) =>
      sendLeadAck(input, { fetchImpl, get: async (k) => settings.get(k) ?? null, set: async (k, v) => void settings.set(k, v), now: () => new Date('2026-10-31T12:00:00Z') }),
    noteEmail: async (id, message) => void notes.push({ id, message }),
    bumpCount: async (slug) => void (counts.push(slug), log.push('count')),
    secret: () => (opts.secret === undefined ? SECRET : opts.secret),
    now: () => new Date('2026-10-31T12:00:00Z'),
    origin: ORIGIN,
  }
  return { deps, log, saved, notes, counts, emails }
}

const form = (extra: Record<string, unknown> = {}) => ({ slug: 'greek-isles-2027', name: 'Jane Doe', email: 'jane@mailbox.ca', consent: true, ...extra })

async function main() {
  process.env.RESEND_API_KEY = 're_test'
  process.env.LEAD_ACK_FROM_EMAIL = 'hello@mail.example.org'

  // ── off mode changes nothing ──────────────────────────────────────────────────────
  expect('mode: only the exact word on is on', parseItineraryMode('on') === 'on' && ['off', '', 'ON', 'true', 'yes', null, undefined, ' on'].every((v) => parseItineraryMode(v as string | null) === 'off'))
  {
    const r = rig({ mode: 'off' })
    const out = await handleItineraryRequest(form(), r.deps)
    expect('off: the API answers 404 and nothing runs (no lead, no GHL, no email, no count)', out.status === 404 && r.log.length === 0 && r.notes.length === 0 && r.emails.length === 0)
  }
  {
    const trip = readFileSync('app/packages/[slug]/page.tsx', 'utf8')
    expect('off: the trip page draws the box only inside itineraryMode === "on"', /\{itineraryMode === "on" && \(\s*<section id="itinerary"/.test(trip) && (trip.match(/ItineraryRequestForm/g) ?? []).length === 2)
    expect('off: a past trip never reads the switch (always off)', /isPastTrip \? Promise\.resolve\("off" as const\) : getItineraryMagnetMode\(\)/.test(trip))
    const store = readFileSync('lib/itinerary-magnet-store.ts', 'utf8')
    expect('off: a failed settings read fails closed to off', /catch \{\s*return 'off'/.test(store))
    const page = readFileSync('app/itinerary/[token]/page.tsx', 'utf8')
    expect('off: the itinerary page is not found unless the mode is on', /getItineraryMagnetMode\(\)\) !== "on"\) notFound\(\)/.test(page))
  }

  // ── consent ──────────────────────────────────────────────────────────────────────
  expect('form: unticked consent blocks the send', itineraryFormProblem({ name: 'Jane', email: 'jane@mailbox.ca', consent: false }) !== null)
  expect('form: ticked consent, name and email passes', itineraryFormProblem({ name: 'Jane', email: 'jane@mailbox.ca', consent: true }) === null)
  expect('form: no name or a bad email blocks the send', itineraryFormProblem({ name: ' ', email: 'jane@mailbox.ca', consent: true }) !== null && itineraryFormProblem({ name: 'Jane', email: 'nope', consent: true }) !== null)
  {
    const comp = readFileSync('components/itinerary-request-form.tsx', 'utf8')
    const alert = readFileSync('components/trip-alert-form.tsx', 'utf8')
    expect('form: the consent box starts unticked', /const \[consent, setConsent\] = useState\(false\)/.test(comp) && !/defaultChecked|checked=\{true\}/.test(comp))
    expect('form: the check runs before anything is sent', comp.indexOf('itineraryFormProblem(') > -1 && comp.indexOf('itineraryFormProblem(') < comp.indexOf('fetch("/api/itinerary-request"'))
    const wording = ['Yes, I agree to receive travel deals and updates from', 'by email. I can unsubscribe at any time.']
    expect('form: exact consent wording of the existing sign-up box', wording.every((w) => comp.includes(w) && alert.includes(w)) && comp.includes('site.addressLines.join(", ")') && comp.includes('site.phone ? `, ${site.phone}` : ""'))
    expect('form: has the hidden honeypot', /name="company_website"|company_website: honeypot/.test(comp) && comp.includes('left-[-9999px]'))
  }
  {
    expect('API schema: missing consent is rejected', !itineraryRequestSchema.safeParse({ slug: 'a', name: 'J', email: 'j@x.test' }).success)
    expect('API schema: consent false is rejected', !itineraryRequestSchema.safeParse(form({ consent: false })).success)
    expect('API schema: consent as the text "true" is rejected', !itineraryRequestSchema.safeParse(form({ consent: 'true' })).success)
    expect('API schema: ticked consent is accepted, phone optional', itineraryRequestSchema.safeParse(form()).success && itineraryRequestSchema.safeParse(form({ phone: '+1 416 555 0100' })).success)
    for (const bad of [undefined, false, 'yes', 1]) {
      const r = rig()
      const out = await handleItineraryRequest(form({ consent: bad }), r.deps)
      expect(`API: consent ${JSON.stringify(bad)} gives 400 and creates no lead`, out.status === 400 && r.log.length === 0)
    }
  }

  // ── the lead ─────────────────────────────────────────────────────────────────────
  {
    const r = rig({ ackOn: true })
    const out = await handleItineraryRequest(form({ phone: '+1 416 555 0100', attribution: { utm_source: 'facebook', page_path: '/packages/greek-isles-2027' } }), r.deps)
    const lead = r.saved[0] as { intent: string; message: string; package: string; email: string; attribution: { utm_source: string; page_path: string } }
    expect('lead: saved with intent itinerary', out.status === 200 && lead?.intent === 'itinerary')
    expect('lead: carries the trip slug and the trip name', lead.message.includes('(/packages/greek-isles-2027)') && lead.package === 'Greek Isles Cruise' && lead.message.startsWith('[Itinerary requested]'))
    expect('lead: keeps the UTM source and the page path (same attribution path)', lead.attribution.utm_source === 'facebook' && lead.attribution.page_path === '/packages/greek-isles-2027')
    expect('lead: records the consent line', /Consent to emails: yes/.test(lead.message))
    expect('lead: saved BEFORE GoHighLevel, then marked sent, then counted once', r.log.indexOf('save') < r.log.indexOf('forward') && r.log.indexOf('forward') < r.log.indexOf('markSent') && r.counts.length === 1 && r.counts[0] === 'greek-isles-2027')
    expect('lead desk: the intent is understood and described', normalizeIntent('itinerary') === 'itinerary' && whatTheyAsked({ intent: 'itinerary', message: lead.message }) === 'Asked for the itinerary and dates')
    expect('lead desk: marker alone (before migration 0063) reads the same', whatTheyAsked({ intent: null, message: lead.message }) === 'Asked for the itinerary and dates')
    expect('lead desk: no phone is not hot, a phone number is (existing rule, unchanged)', !isHotLead({ intent: 'itinerary', phone: '', message: lead.message }) && isHotLead({ intent: 'itinerary', phone: '+1 416 555 0100', message: lead.message }))
    const built = buildItineraryLead({ name: 'A', email: 'a@x.test', attribution: undefined }, { name: 'T', slug: 'my-trip' })
    expect('lead: page path defaults to the trip page when none was sent', built.attribution?.page_path === '/packages/my-trip' && !('phone' in built))
    const mig = readFileSync('supabase/migrations/0063_itinerary_requests.sql', 'utf8')
    expect('migration: widens the intent check to include itinerary, no table, nothing applied', /'callback', 'quote', 'info', 'itinerary'/.test(mig) && !/create table/i.test(mig))
    const mig55 = readFileSync('supabase/migrations/0055_lead_desk.sql', 'utf8')
    expect('migration: it replaces the check 0055 made', /leads_intent_check/.test(mig55) && /leads_intent_check/.test(mig))
  }
  {
    const r = rig({ ackOn: true })
    await handleItineraryRequest(form({ email: 'claude-test+1@example.com' }), r.deps)
    expect('test lead: is_test handling unchanged, no email goes to a test person', r.emails.length === 0 && /not sent - this is a test lead/.test(r.notes[0]?.message ?? ''))
  }
  {
    expect('honeypot: quiet success, no lead', (await handleItineraryRequest(form({ company_website: 'x' }), rig().deps)).status === 200 && rig().log.length === 0)
    const r1 = rig({ allow: false }); const o1 = await handleItineraryRequest(form(), r1.deps)
    expect('throttle: over the limit gives 429 and no lead', o1.status === 429 && r1.log.length === 0)
    const r2 = rig({ trip: null }); const o2 = await handleItineraryRequest(form(), r2.deps)
    expect('unknown or unpublished trip gives 404 and no lead', o2.status === 404 && r2.log.length === 0)
    const r3 = rig({ trip: { available_to: '2025-01-01' } }); const o3 = await handleItineraryRequest(form(), r3.deps)
    expect('a trip that already ran gives 404 and no lead', o3.status === 404 && r3.log.length === 0)
    const r4 = rig({ secret: '' }); const o4 = await handleItineraryRequest(form(), r4.deps)
    expect('no signing secret: 503 and no lead is created that could not be answered', o4.status === 503 && r4.log.length === 0)
    const r5 = rig({ saveId: null }); const o5 = await handleItineraryRequest(form(), r5.deps)
    expect('lead not saved: 500, GoHighLevel and the email are not attempted', o5.status === 500 && !r5.log.includes('forward') && r5.emails.length === 0)
  }

  // ── token ────────────────────────────────────────────────────────────────────────
  {
    const now = new Date('2026-10-31T12:00:00Z')
    const a = signItineraryToken('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'greek-isles-2027', SECRET, now)
    const b = signItineraryToken('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'greek-isles-2027', SECRET, now)
    const va = verifyItineraryToken(a, SECRET, now)
    expect('token: opens for its own lead and trip', va?.leadId === '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa' && va?.slug === 'greek-isles-2027')
    expect('token: lead B has a different token', a !== b && verifyItineraryToken(b, SECRET, now)?.leadId === '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const [payloadB] = b.split('.')
    const [, sigA] = a.split('.')
    expect('token: lead A signature on lead B payload does not open', verifyItineraryToken(`${payloadB}.${sigA}`, SECRET, now) === null)
    const [payloadA] = a.split('.')
    const forged = Buffer.from(JSON.stringify({ l: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', s: 'greek-isles-2027', e: 9999999999 })).toString('base64url')
    expect('token: an edited payload does not open', verifyItineraryToken(`${forged}.${sigA}`, SECRET, now) === null && payloadA !== forged)
    expect('token: the slug alone (not a token) opens nothing', verifyItineraryToken('greek-isles-2027', SECRET, now) === null && verifyItineraryToken('', SECRET, now) === null)
    expect('token: another secret does not open it', verifyItineraryToken(a, 'other-secret', now) === null)
    expect('token: no secret opens nothing', verifyItineraryToken(a, '', now) === null)
    expect('token: expires after 90 days', verifyItineraryToken(a, SECRET, new Date(now.getTime() + 91 * 86_400_000)) === null && verifyItineraryToken(a, SECRET, new Date(now.getTime() + 89 * 86_400_000)) !== null)
    expect('token: carries no email, name or phone', !Buffer.from(payloadA, 'base64url').toString().match(/@|jane|phone/i))
    expect('token: the message check ties a lead to its own trip', isItineraryLeadMessage('[Itinerary requested] Trip: X (/packages/greek-isles-2027)\nConsent to emails: yes', 'greek-isles-2027') && !isItineraryLeadMessage('[Itinerary requested] Trip: X (/packages/other)', 'greek-isles-2027') && !isItineraryLeadMessage('Hello (/packages/greek-isles-2027)', 'greek-isles-2027'))
    const page = readFileSync('app/itinerary/[token]/page.tsx', 'utf8')
    expect('page: loads the lead named inside the signed token, not one named in the URL', /eq\("id", claim\.leadId\)/.test(page) && /isItineraryLeadMessage\(lead\.message, claim\.slug\)/.test(page))
    expect('page: trip comes from the token slug', /getPublishedPackageBySlug\(claim\.slug\)/.test(page))
  }

  // ── the page content ─────────────────────────────────────────────────────────────
  {
    const v = buildItinerary({ trip: baseTrip, kit: null, price: null, today: TODAY, phone: '(833) 878-5386' })
    const flat = JSON.stringify(v)
    expect('page: no price anywhere without the confirmed switch', !/\$|\d,\d{3}|per person|CAD|USD/i.test(flat.replace('"phone":"(833) 878-5386"', '')) && v.price === null && !!v.priceAsk)
    expect('page: price sentences are cut out of stored text, the rest is kept', v.days[0].text === 'Arrive and settle in.' && v.included.join('|') === 'Seven nights on board|All breakfasts')
    expect('page: day by day is exactly what is stored, in order', v.days.map((d) => `${d.label}:${d.title}`).join('|') === 'Day 1:Athens|Day 2:Santorini' && v.noDayPlan === null)
    expect('page: only upcoming dates are listed (the 2026-01-01 departure is dropped)', v.dates.length === 3 && !v.dates.some((d) => /2026/.test(d)) && v.datesAsk === null)
    const p = buildItinerary({ trip: baseTrip, kit: null, price: PRICE, today: TODAY, phone: '(833) 878-5386' })
    expect('page: with the confirmed switch on, the price is exactly the agent words and the existing note', p.price?.headline === 'From $2,499 per person' && /Confirmed by your agent on October 20, 2026, subject to availability\./.test(p.price?.note ?? '') && p.priceAsk === null)
    expect('page: even with the switch on, stored text still has no other price', !/1,999|\$199/.test(JSON.stringify({ ...p, price: null })))
    const priceFn = readFileSync('lib/itinerary-magnet.ts', 'utf8')
    expect('page: uses the trip page function for the price line', /price \? priceConfirmedLine\(price\) : null/.test(priceFn))
    const pageSrc = readFileSync('app/itinerary/[token]/page.tsx', 'utf8')
    expect('page: never reads the stored price fields', !/price_display|price_value|\.currency/.test(pageSrc + priceFn.replace(/price_includes/g, '')))
  }
  {
    const empty = { ...baseTrip, itinerary: null, price_includes: null, not_included: null, departure_dates: null, available_from: null, available_to: null, duration: '' }
    const v = buildItinerary({ trip: empty, kit: null, price: null, today: TODAY, phone: '' })
    expect('no plan: says so plainly and shows nothing made up', v.days.length === 0 && /do not have a day by day plan/.test(v.noDayPlan ?? '') && v.places === null)
    expect('no facts: every missing section uses the ask your agent wording', v.included.length === 0 && /Your agent will confirm exactly what is included/.test(v.includedAsk ?? '') && /Your agent will confirm what is not included/.test(v.notIncludedAsk ?? '') && /Your agent will confirm the next departure dates/.test(v.datesAsk ?? '') && v.duration === null && v.dates.length === 0)
    const past = buildItinerary({ trip: { ...empty, available_from: '2025-01-01', available_to: '2025-01-08' }, kit: null, price: null, today: TODAY, phone: '' })
    expect('past dates are never shown as confirmed', past.dates.length === 0 && !!past.datesAsk)
    const kit = { v: 1, generatedAt: '', promise: null, routeKnown: false, stops: [{ name: 'Mykonos', kind: 'stop', region: null, date: null, arrive: null, depart: null, days: null, photo: null, things: [{ text: 'invented sights', source: { label: 'x', url: null } }], source: { label: 'x', url: null } }], otherStops: [], included: [], notIncluded: [], goodToKnow: [], attributions: [], toConfirm: ['secret admin note'] } as unknown as TripKit
    const k = buildItinerary({ trip: empty, kit, price: null, today: TODAY, phone: '' })
    const kflat = JSON.stringify(k)
    expect('kit with no day plan: lists only the place names, still says there is no plan', k.days.length === 0 && !!k.noDayPlan && k.places?.names.join() === 'Mykonos' && k.places.heading === 'The places this trip is built around')
    expect('kit text and admin notes never leak into the page', !/invented sights|secret admin note/.test(kflat))
  }

  // ── the email ────────────────────────────────────────────────────────────────────
  {
    const r = rig({ ackOn: false })
    const out = await handleItineraryRequest(form(), r.deps)
    expect('email off: no email is attempted at all', r.emails.length === 0 && !r.log.includes('fetch'))
    expect('email off: the visitor still gets the link to the on-screen itinerary', out.status === 200 && out.body.emailed === false && typeof out.body.url === 'string' && String(out.body.url).startsWith('/itinerary/'))
    const note = r.notes[0]?.message ?? ''
    expect('email off: the lead says the email was not sent, and why', itineraryEmailStatus(note) === 'Not sent: the instant lead reply is switched off' && note.startsWith('[Itinerary requested]'))
    const tok = String(out.body.url).replace('/itinerary/', '')
    expect('email off: the link in the answer opens for this lead only', verifyItineraryToken(tok, SECRET, new Date('2026-10-31T12:00:00Z'))?.leadId === 'lead-aaaa-1111' && verifyItineraryToken(tok, 'other', new Date('2026-10-31T12:00:00Z')) === null)
  }
  {
    const r = rig({ ackOn: true })
    const out = await handleItineraryRequest(form(), r.deps)
    const mail = r.emails[0]
    expect('email on: one email, to the visitor, through the lead reply path', out.body.emailed === true && r.emails.length === 1 && mail.to[0] === 'jane@mailbox.ca')
    expect('email on: subject, private link, trip name, first name and the standard footer', mail.subject === 'Your itinerary and dates' && mail.text.includes(`${ORIGIN}${out.body.url}`) && mail.text.includes('Greek Isles Cruise') && mail.text.startsWith('Hi Jane,') && /It is not an advertisement/.test(mail.text) && /reply to this email/.test(mail.text))
    expect('email on: no price in the email, no dashes', !/\$\d/.test(mail.text) && !dashes.test(mail.subject + mail.text))
    expect('email on: the lead says the email was sent', itineraryEmailStatus(r.notes[0].message) === 'Sent')
    const again = await handleItineraryRequest(form(), r.deps)
    expect('email on: the existing once per address per day rule still applies (second ask: no email, link still works)', again.body.emailed === false && r.emails.length === 1 && /already emailed in the last 24 hours/.test(itineraryEmailStatus(r.notes[1].message) ?? ''))
    const plain = buildLeadAckEmail('Jane Doe')
    expect('the normal lead reply email is unchanged', plain.subject === 'We got your message' && plain.text.startsWith('Hi Jane,') && !/itinerary/i.test(plain.text))
    const src = readFileSync('lib/itinerary-magnet-run.ts', 'utf8')
    expect('email goes only through sendAck (no direct Resend call in the new code)', !/resend\.com|fetch\(/.test(src) && !/resend/i.test(readFileSync('app/api/itinerary-request/route.ts', 'utf8')))
  }

  // ── the counter, noindex, admin ──────────────────────────────────────────────────
  {
    let raw: string | null = null
    raw = bumpItineraryCount(raw, 'a', new Date('2026-10-31T00:00:00Z'))
    raw = bumpItineraryCount(raw, 'a')
    raw = bumpItineraryCount(raw, 'b')
    const c = parseItineraryCounts(raw)
    expect('counter: counts per trip', c.a.count === 2 && c.b.count === 1)
    expect('counter: junk reads as empty', Object.keys(parseItineraryCounts('junk')).length === 0 && Object.keys(parseItineraryCounts(null)).length === 0)
    const page = readFileSync('app/itinerary/[token]/page.tsx', 'utf8')
    expect('page: noindex, nofollow, no referrer, never cached', /index: false, follow: false/.test(page) && /referrer: "no-referrer"/.test(page) && /dynamic = "force-dynamic"/.test(page))
    expect('page: robots.txt also keeps /itinerary/ out', /'\/itinerary\/'/.test(readFileSync('app/robots.ts', 'utf8')))
    expect('page: no visitor email or phone is read or drawn (first name only)', !/lead\.email|lead\.phone/.test(page) && /select\("name, message"\)/.test(page) && /ackFirstName\(lead\.name\)/.test(page))
    const admin = readFileSync('app/api/admin/itinerary-magnet/route.ts', 'utf8')
    expect('admin route: both methods check isAuthorized first', (admin.match(/if \(!isAuthorized\(request\)\)/g) ?? []).length === 2)
    const env = readFileSync('.env.example', 'utf8')
    expect('.env.example documents the secret and the mode', /ITINERARY_TOKEN_SECRET=/.test(env) && /itinerary_magnet_mode/.test(env))
    const copy = readFileSync('lib/itinerary-magnet.ts', 'utf8') + readFileSync('lib/lead-ack-copy.ts', 'utf8') + readFileSync('app/itinerary/[token]/page.tsx', 'utf8') + readFileSync('components/itinerary-request-form.tsx', 'utf8')
    expect('no em or en dashes in the new copy', !dashes.test(copy))
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
  process.exit(failures ? 1 : 0)
}
main()
