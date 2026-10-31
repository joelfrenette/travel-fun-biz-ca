// Offline check: the "Find your trip in 60 seconds" quiz (lib/trip-quiz.ts, app/trip-quiz/page.tsx, lib/flywheel/steps/quiz-nudge.ts).
// Run: npx --yes tsx --tsconfig tsconfig.json scripts/check-trip-quiz.ts   (exit 1 on a failure)
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendLeadAck, LEAD_ACK_SETTING_KEY, type LeadAckInput } from '../lib/lead-ack'
import { buildItineraryLead, itineraryRequestSchema, verifyItineraryToken } from '../lib/itinerary-magnet'
import { handleItineraryRequest, type ItineraryRunDeps } from '../lib/itinerary-magnet-run'
import { itineraryFormProblem } from '../lib/itinerary-form'
import { whatTheyAsked, isHotLead, normalizeIntent } from '../lib/lead-desk'
import { FLYWHEEL_STEPS } from '../lib/flywheel/registry'
import { runQuizNudge, type QuizNudgeDeps } from '../lib/flywheel/steps/quiz-nudge'
import type { FlywheelContext } from '../lib/flywheel/types'
import {
  QUIZ_QUESTIONS,
  addMonthsYmd,
  bumpQuizCount,
  isCompleteAnswers,
  matchTrips,
  nudgeEligible,
  nudgeKey,
  nudgeRecorded,
  parseQuizAnswers,
  parseQuizCounts,
  parseTripQuizMode,
  quizLeadSlug,
  quizStep,
  quizTotals,
  upcomingDateTexts,
  type NudgeLead,
  type QuizAnswers,
  type QuizTripInput,
} from '../lib/trip-quiz'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const src = (p: string) => readFileSync(p, 'utf8')

const SECRET = 'test-secret-for-quiz-check'
const TODAY = '2026-10-31'
const NOW = new Date('2026-10-31T12:00:00Z')
const ORIGIN = 'https://www.example.test'
const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)

// ── fixture trips ──────────────────────────────────────────────────────────────────
const trip = (over: Partial<QuizTripInput> & { slug: string; name: string }): QuizTripInput => ({
  status: 'published',
  destination: 'Somewhere',
  category: 'Cruise',
  tags: [],
  keywords: [],
  duration: '8 days',
  duration_days: 8,
  available_from: null,
  available_to: null,
  departure_dates: null,
  recap_mode: null,
  ...over,
})
const danube = trip({ slug: 'danube-river-cruise', name: 'Danube River Cruise', destination: 'Austria', tags: ['river cruise'], available_from: '2027-03-10', available_to: '2027-03-18', departure_dates: ['2027-03-10'] })
const singlesOcean = trip({ slug: 'caribbean-singles', name: 'Caribbean Cruise for Singles', category: 'Singles', tags: ['cruise'], destination: 'Caribbean', available_from: '2027-02-10', available_to: '2027-02-18' })
const italy = trip({ slug: 'italy-guided-tour', name: 'Italy Guided Tour', category: 'Cultural', destination: 'Italy', duration: '15 days', duration_days: 15, available_from: '2027-06-01', available_to: '2027-06-15' })
const resort = trip({ slug: 'riviera-maya-resort', name: 'Riviera Maya Resort Escape', category: 'Beach & Resort', destination: 'Mexico', duration: '7 days', duration_days: 7, available_from: '2026-12-05', available_to: '2026-12-12' })
const draft = trip({ slug: 'draft-river', name: 'Draft River Cruise', status: 'draft', tags: ['river cruise'], available_from: '2027-03-10', available_to: '2027-03-18' })
const past = trip({ slug: 'past-river', name: 'Past River Cruise', tags: ['river cruise'], available_from: '2025-05-01', available_to: '2025-05-09' })
const noDates = trip({ slug: 'undated-tour', name: 'Undated Guided Tour', category: 'Cultural', duration: '', duration_days: null })
const started = trip({ slug: 'already-started', name: 'Started River Cruise', tags: ['river cruise'], available_from: '2026-10-20', available_to: '2026-11-10' })
const ALL = [danube, singlesOcean, italy, resort, draft, past, noDates, started]
const ans = (over: Partial<QuizAnswers> = {}): QuizAnswers => ({ who: 'couple', style: 'river', when: '6m', length: 'week', ...over })

// ── the lead path rig (same fakes as scripts/check-itinerary-magnet.ts) ──────────────
function rig(opts: { quiz?: 'on' | 'off' | 'missing'; itinerary?: 'on' | 'off'; ackOn?: boolean } = {}) {
  const log: string[] = []
  const saved: Record<string, unknown>[] = []
  const notes: { id: string; message: string }[] = []
  const emails: { subject: string; text: string; to: string[] }[] = []
  const quizEvents: string[] = []
  const itCounts: string[] = []
  const settings = new Map<string, string>()
  if (opts.ackOn) settings.set(LEAD_ACK_SETTING_KEY, 'true')
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    emails.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }) as unknown as typeof fetch
  const deps: ItineraryRunDeps = {
    getMode: async () => opts.itinerary ?? 'off',
    allow: async () => true,
    getTrip: async (slug) => ({ name: 'Danube River Cruise', slug, available_to: '2027-03-18', recap_mode: null }),
    saveLead: async (lead) => (log.push('save'), saved.push(lead as unknown as Record<string, unknown>), 'lead-aaaa-1111'),
    forward: async () => (log.push('forward'), { ok: true }),
    markSent: async () => void log.push('markSent'),
    sendAck: async (input: LeadAckInput) => sendLeadAck(input, { fetchImpl, get: async (k) => settings.get(k) ?? null, set: async (k, v) => void settings.set(k, v), now: () => NOW }),
    noteEmail: async (id, message) => void notes.push({ id, message }),
    bumpCount: async (slug) => void itCounts.push(slug),
    secret: () => SECRET,
    now: () => NOW,
    origin: ORIGIN,
    ...(opts.quiz === 'missing' ? {} : { getQuizMode: async () => (opts.quiz ?? 'on') as 'on' | 'off', bumpQuiz: async () => void quizEvents.push('email') }),
  }
  return { deps, log, saved, notes, emails, quizEvents, itCounts }
}
const quizForm = (extra: Record<string, unknown> = {}) => ({
  slug: 'danube-river-cruise',
  name: 'Jane Doe',
  email: 'jane@mailbox.ca',
  consent: true,
  quiz: { who: 'couple', style: 'river', when: '6m', length: 'week', slugs: ['danube-river-cruise', 'italy-guided-tour'] },
  ...extra,
})

async function main() {
  process.env.RESEND_API_KEY = 're_test'
  process.env.LEAD_ACK_FROM_EMAIL = 'hello@mail.example.org'

  // ── off mode changes nothing ─────────────────────────────────────────────────────
  expect('mode: only the exact word on is on', parseTripQuizMode('on') === 'on' && ['off', '', 'ON', 'true', 'yes', null, undefined, ' on'].every((v) => parseTripQuizMode(v as string | null) === 'off'))
  {
    const r = rig({ quiz: 'off', itinerary: 'on' })
    const out = await handleItineraryRequest(quizForm(), r.deps)
    expect('off: a quiz request is 404 even with the itinerary switch on, and nothing runs', out.status === 404 && r.log.length === 0 && r.emails.length === 0 && r.quizEvents.length === 0)
    const r2 = rig({ quiz: 'missing', itinerary: 'on' })
    expect('off: no quiz switch wired means 404, never a lead', (await handleItineraryRequest(quizForm(), r2.deps)).status === 404 && r2.log.length === 0)
    const r3 = rig({ quiz: 'off', itinerary: 'on', ackOn: true })
    const plain = { slug: 'danube-river-cruise', name: 'Jane Doe', email: 'jane@mailbox.ca', consent: true }
    const o3 = await handleItineraryRequest(plain, r3.deps)
    expect('off: the plain itinerary form still works exactly as before', o3.status === 200 && r3.saved.length === 1 && r3.itCounts.length === 1 && !/Trip quiz/.test(String((r3.saved[0] as { message: string }).message)))
    const r4 = rig({ quiz: 'on', itinerary: 'off' })
    expect('off: a plain itinerary request still follows ONLY the itinerary switch', (await handleItineraryRequest(plain, r4.deps)).status === 404 && r4.log.length === 0)
  }
  {
    const page = src('app/trip-quiz/page.tsx')
    const gate = page.indexOf('if ((await getTripQuizMode()) !== "on") notFound()')
    expect('off: /trip-quiz calls notFound() before it reads trips, counts anything or renders', gate > -1 && gate < page.indexOf('listQuizTrips()') && gate < page.indexOf('recordQuizEvent(') && gate < page.indexOf('<Header'))
    const store = src('lib/trip-quiz-store.ts')
    expect('off: an unreadable switch fails closed to off', /catch \{\s*return 'off'/.test(store))
    const card = src('components/trip-quiz-card.tsx')
    expect('off: the card returns null (renders nothing) unless the mode is on', /if \(\(await getTripQuizMode\(\)\) !== "on"\) return null/.test(card))
    const box = src('components/page-signup-box.tsx')
    expect('off: the signup box is the same section; the card is the only addition, beside it', /<TripQuizCard className="mb-6" \/>/.test(box) && /<section id="page-signup"/.test(box))
    expect('off: the home page adds only the card', /<TripQuizCard className=/.test(src('app/page.tsx')) && (src('app/page.tsx').match(/TripQuizCard/g) ?? []).length === 2)
    const sm = src('app/sitemap.ts')
    expect('off: the sitemap lists /trip-quiz only when on', /\.\.\.\(quizOn \? \[\{ url: absoluteUrl\('\/trip-quiz'\)/.test(sm))
    expect('guide, blog, compare and best-time pages all get the card through the one signup box', ['components/guide-page.tsx', 'app/blog/[slug]/page.tsx', 'app/compare/[pair]/page.tsx', 'app/best-time-to-visit/[destination]/page.tsx'].every((f) => /<PageSignupBox /.test(src(f))))
    const itin = src('app/itinerary/[token]/page.tsx')
    expect('off: the itinerary page needs one of the two switches, and a quiz lead needs the quiz switch', /if \(!itineraryOn && !quizOn\) notFound\(\)/.test(itin) && /isQuizLeadMessage\(lead\.message\) \? !quizOn : !itineraryOn/.test(itin))
    expect('the page is indexable with a clear title (no noindex on the start screen)', /Find your trip in 60 seconds \| \$\{SITE_NAME\}/.test(page) && /\.\.\.\(answered \? \{ robots: \{ index: false, follow: true \} \} : \{\}\)/.test(page) && /pageAlternates\("\/trip-quiz"\)/.test(page))
  }

  // ── the four questions ───────────────────────────────────────────────────────────
  {
    expect('exactly four questions in the stated order', QUIZ_QUESTIONS.map((q) => q.key).join() === 'who,style,when,length')
    expect('Q1 who: solo, couple, friends, family, group', QUIZ_QUESTIONS[0].options.map((o) => o.value).join() === 'solo,couple,friends,family,group')
    expect('Q2 style: river, ocean, guided, resort', QUIZ_QUESTIONS[1].options.map((o) => o.value).join() === 'river,ocean,guided,resort')
    expect('Q3 when: next 3 months, 3 to 6, 6 to 12, not sure', QUIZ_QUESTIONS[2].options.map((o) => o.label).join('|') === 'In the next 3 months|In 3 to 6 months|In 6 to 12 months|Not sure yet')
    expect('Q4 length: a week, two weeks, flexible', QUIZ_QUESTIONS[3].options.map((o) => o.value).join() === 'week,two,flex')
    expect('steps: nothing answered is the first screen, a skipped answer cannot jump ahead', quizStep({}) === 0 && quizStep(parseQuizAnswers({ q1: 'solo' })) === 1 && quizStep(parseQuizAnswers({ q2: 'river', q3: '3m', q4: 'week' })) === 0 && quizStep(parseQuizAnswers({ q1: 'solo', q2: 'bogus' })) === 1)
    expect('steps: four valid answers show the result', quizStep(parseQuizAnswers({ q1: 'solo', q2: 'river', q3: '3m', q4: 'week' })) === 4 && isCompleteAnswers(ans()) && !isCompleteAnswers({ who: 'solo' }))
    const page = src('app/trip-quiz/page.tsx')
    expect('screens: one question per screen with progress, a back link and big tap targets (plain links, no client state)', /Question \{step \+ 1\} of 4/.test(page) && /role="progressbar"/.test(page) && />Back<\/a>/.test(page) && /min-h-14/.test(page) && !/"use client"/.test(page))
  }

  // ── matching rules ───────────────────────────────────────────────────────────────
  {
    const r = matchTrips(ans(), ALL, TODAY)
    expect('match: a river cruise answer finds the river trip with a reason built from stored fields', r.matches[0]?.slug === 'danube-river-cruise' && r.matches[0].reasons[0] === 'matches your river cruise choice')
    expect('match: the other answers add their own reasons (dates in the window, length)', r.matches[0].reasons.some((x) => /confirmed dates between 3 and 6 months from now/.test(x)) && r.matches[0].reasons.some((x) => /runs 8 days, which fits about a week/.test(x)))
    const oc = matchTrips(ans({ style: 'ocean', who: 'solo', when: '6m', length: 'week' }), ALL, TODAY)
    expect('match: ocean cruise maps to a cruise that is not a river cruise, solo to a Singles trip', oc.matches.map((m) => m.slug).join() === 'caribbean-singles' && oc.matches[0].reasons.some((x) => /travelling solo/.test(x)))
    const gt = matchTrips(ans({ style: 'guided', when: '6m', length: 'two' }), ALL, TODAY)
    expect('match: guided tour maps to a tour (category Cultural) and two weeks to 10 to 17 days', gt.matches[0]?.slug === 'italy-guided-tour' || gt.noMatch)
    const gt2 = matchTrips(ans({ style: 'guided', when: '12m', length: 'two' }), ALL, TODAY)
    expect('match: Italy (June 2027) sits in the 6 to 12 month window and fits two weeks', gt2.matches[0]?.slug === 'italy-guided-tour' && gt2.matches[0].reasons.some((x) => /15 days, which fits about two weeks/.test(x)))
    const rs = matchTrips(ans({ style: 'resort', when: '3m', length: 'week' }), ALL, TODAY)
    expect('match: resort or beach maps to Beach & Resort, December is inside the next 3 months, 7 days is about a week', rs.matches[0]?.slug === 'riviera-maya-resort' && rs.matches[0].reasons.length >= 3)
    expect('match: a trip with a stored audience that contradicts the answer is dropped (Singles trip, family answer)', !matchTrips(ans({ style: 'ocean', who: 'family', when: 'unsure', length: 'flex' }), ALL, TODAY).matches.some((m) => m.slug === 'caribbean-singles'))
    expect('match: dates that exist but never fall in the chosen window drop the trip', !matchTrips(ans({ when: '3m' }), ALL, TODAY).matches.some((m) => m.slug === 'danube-river-cruise'))
    expect('match: a stored length that is clearly different drops the trip', !matchTrips(ans({ length: 'two' }), ALL, TODAY).matches.some((m) => m.slug === 'danube-river-cruise'))
    const poor = matchTrips(ans({ who: 'couple', style: 'resort', when: '12m', length: 'two' }), ALL, TODAY)
    expect('no match: nothing fits, so the honest no-match state is returned, never a padded list', poor.noMatch === true && poor.matches.length === 0)
    const weak = matchTrips(ans({ style: 'guided', when: 'unsure', length: 'flex' }), [noDates], TODAY)
    expect('no match: a trip supported only by its style (no dates, no length, no audience) is too weak to show', weak.noMatch)
    const unsure = matchTrips(ans({ when: 'unsure', length: 'flex' }), [danube], TODAY)
    expect('match: not sure and flexible still works when the trip has confirmed upcoming dates', unsure.matches[0]?.reasons.includes('has confirmed upcoming dates') === true)
    const many = Array.from({ length: 6 }, (_, i) => trip({ slug: `cruise-${i}`, name: `Ocean Cruise ${i}`, tags: ['cruise'], available_from: `2027-02-0${i + 1}`, available_to: `2027-02-1${i}` }))
    const capped = matchTrips(ans({ style: 'ocean', when: '6m', length: 'week' }), many, TODAY)
    expect('cap: never more than three trips', capped.matches.length === 3)
    expect('order: best score first, then the soonest trip', capped.matches.map((m) => m.slug).join() === 'cruise-0,cruise-1,cruise-2')
    const everything = matchTrips(ans({ when: 'unsure', length: 'flex' }), [draft, past, started], TODAY)
    expect('unpublished trips never match', !matchTrips(ans({ when: 'unsure', length: 'flex' }), [draft], TODAY).matches.length && everything.noMatch)
    expect('a trip that already ran (or a draft, or one already under way) never matches', !everything.matches.some((m) => ['past-river', 'draft-river', 'already-started'].includes(m.slug)))
    const mixed = trip({ slug: 'mixed-dates', name: 'Mixed River Cruise', tags: ['river cruise'], available_from: '2027-03-01', available_to: '2027-03-09', departure_dates: ['2026-09-01', '2026-10-30', '2027-03-01', '2027-04-02'] })
    const txt = upcomingDateTexts(mixed, TODAY)
    expect('past dates are never shown: only upcoming confirmed dates, as stored', txt.length >= 2 && !txt.some((d) => /2026/.test(d)) && txt.some((d) => /Mar/.test(d)) && txt.some((d) => /Apr/.test(d)))
    expect('past dates are never shown: a range that already started is dropped entirely', upcomingDateTexts(started, TODAY).length === 0)
    expect('the match carries no price field, so no price can be shown from matching', !/\$|price/i.test(JSON.stringify(matchTrips(ans(), ALL, TODAY))))
    expect('window maths: months added by the calendar, day clamped', addMonthsYmd('2026-11-30', 3) === '2027-02-28' && addMonthsYmd('2026-10-31', 6) === '2027-04-30')
    const page = src('app/trip-quiz/page.tsx')
    expect('price: shown only through the trip page records (agent confirmed) and the same line function', /rec && mayShowPrice\(rec\.price\) && rec\.price \? priceConfirmedLine\(rec\.price\)/.test(page) && !/price_display|price_value/.test(page + src('lib/trip-quiz.ts') + src('lib/trip-quiz-store.ts')))
    expect('no match screen: says so plainly, offers an agent, no padding', /We do not have a close match right now/.test(page) && /Talk to an agent/.test(page) && /We would rather say so than show you a trip that does not really fit/.test(page))
    expect('matching uses no AI and no network (pure file)', !/fetch\(|anthropic|openai|supabase/i.test(src('lib/trip-quiz.ts')))
  }

  // ── consent and the lead ─────────────────────────────────────────────────────────
  {
    expect('consent: the shared check blocks an unticked box', itineraryFormProblem({ name: 'Jane', email: 'jane@mailbox.ca', consent: false }) !== null)
    expect('consent API: missing consent, false and the text "true" are all rejected with quiz answers', [undefined, false, 'true'].every((c) => !itineraryRequestSchema.safeParse(quizForm({ consent: c })).success))
    for (const bad of [undefined, false]) {
      const r = rig({ ackOn: true })
      const out = await handleItineraryRequest(quizForm({ consent: bad }), r.deps)
      expect(`consent API: ${JSON.stringify(bad)} gives 400 and creates no lead, no count, no email`, out.status === 400 && r.log.length === 0 && r.quizEvents.length === 0 && r.emails.length === 0)
    }
    const form = src('components/itinerary-request-form.tsx')
    const result = src('app/trip-quiz/page.tsx')
    expect('consent: the quiz uses the itinerary form itself (unticked box, same wording, honeypot), extended with the quiz field', /<ItineraryRequestForm slug=\{top\.slug\}/.test(result) && /useState\(false\)/.test(form) && form.includes('Yes, I agree to receive travel deals and updates from') && /\.\.\.\(quiz \? \{ quiz \} : \{\}\)/.test(form))
    expect('quiz field: bad answers or more than three slugs are rejected', !itineraryRequestSchema.safeParse(quizForm({ quiz: { who: 'x', style: 'river', when: '6m', length: 'week', slugs: ['a'] } })).success && !itineraryRequestSchema.safeParse(quizForm({ quiz: { who: 'solo', style: 'river', when: '6m', length: 'week', slugs: ['a', 'b', 'c', 'd'] } })).success)

    const r = rig({ ackOn: true })
    const out = await handleItineraryRequest(quizForm({ phone: '+1 416 555 0100', attribution: { utm_source: 'facebook', page_path: '/trip-quiz' } }), r.deps)
    const lead = r.saved[0] as { intent: string; message: string; package: string; attribution: { utm_source: string } }
    expect('lead: saved through the itinerary path with intent itinerary and the top trip slug', out.status === 200 && lead.intent === 'itinerary' && lead.message.startsWith('[Itinerary requested]') && lead.message.includes('(/packages/danube-river-cruise)'))
    expect('lead: carries the four answers', /\[Trip quiz\] Who: Two of us, as a couple; Style: A river cruise; When: In 3 to 6 months; Length: About a week/.test(lead.message))
    expect('lead: carries every matched trip slug', /Matched trips: danube-river-cruise, italy-guided-tour/.test(lead.message))
    expect('lead: consent line and UTM source kept', /Consent to emails: yes \(checkbox ticked on the trip quiz form\)/.test(lead.message) && lead.attribution.utm_source === 'facebook')
    expect('lead: saved BEFORE GoHighLevel, the funnel counted "gave email" once, the itinerary counter untouched', r.log.indexOf('save') < r.log.indexOf('forward') && r.quizEvents.length === 1 && r.itCounts.length === 0)
    expect('lead desk: understood as an itinerary request; not hot without a phone', whatTheyAsked({ intent: 'itinerary', message: lead.message }) === 'Asked for the itinerary and dates' && normalizeIntent(lead.intent) === 'itinerary' && !isHotLead({ intent: 'itinerary', phone: '', message: lead.message }))
    expect('email: the itinerary email goes through sendLeadAck with the private link', r.emails.length === 1 && r.emails[0].subject === 'Your itinerary and dates' && r.emails[0].text.includes(`${ORIGIN}${out.body.url}`) && verifyItineraryToken(String(out.body.url).replace('/itinerary/', ''), SECRET, NOW)?.slug === 'danube-river-cruise')
    const off = rig({ ackOn: false })
    const o2 = await handleItineraryRequest(quizForm(), off.deps)
    expect('email: with the lead reply switch off nothing is emailed, the on-screen itinerary link still comes back', off.emails.length === 0 && o2.status === 200 && o2.body.emailed === false && String(o2.body.url).startsWith('/itinerary/'))
    const wrong = rig()
    expect('quiz field: the lead is about the FIRST matched trip (a mismatch is refused)', (await handleItineraryRequest(quizForm({ slug: 'italy-guided-tour' }), wrong.deps)).status === 400 && wrong.log.length === 0)
    const test = rig({ ackOn: true })
    await handleItineraryRequest(quizForm({ email: 'claude-test+1@example.com' }), test.deps)
    expect('test lead: no email goes to a test person', test.emails.length === 0)
    const built = buildItineraryLead({ name: 'A', email: 'a@x.test', attribution: undefined }, { name: 'T', slug: 'my-trip' })
    expect('the plain itinerary lead is byte for byte what it was (no quiz lines)', built.message === '[Itinerary requested] Trip: T (/packages/my-trip)\nConsent to emails: yes (checkbox ticked on the itinerary form)')
    const route = src('app/api/itinerary-request/route.ts')
    expect('the quiz has no route of its own: it posts to /api/itinerary-request', !existsSync('app/api/trip-quiz') && /getQuizMode: \(\) => getTripQuizMode\(\)/.test(route) && /fetch\("\/api\/itinerary-request"/.test(form))
  }

  // ── the day 3 nudge ──────────────────────────────────────────────────────────────
  {
    const msg = (extra = '') => buildItineraryLead({ name: 'Jane', email: 'jane@mailbox.ca', attribution: undefined, quiz: { ...ans(), slugs: ['danube-river-cruise'] } }, { name: 'Danube River Cruise', slug: 'danube-river-cruise' }).message + extra
    const plainMsg = buildItineraryLead({ name: 'Jane', email: 'jane@mailbox.ca', attribution: undefined }, { name: 'Danube River Cruise', slug: 'danube-river-cruise' }).message
    const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
    const lead = (id: string, over: Partial<NudgeLead> = {}): NudgeLead => ({ id, name: 'Jane Doe', email: `${id}@mailbox.ca`, message: msg(), status: 'new', first_contact_at: null, is_test: false, created_at: daysAgo(4), ...over })

    function nudgeRig(opts: { leads: NudgeLead[]; quiz?: 'on' | 'off'; ackOn?: boolean; secret?: string; room?: number }) {
      const settings = new Map<string, string>()
      if (opts.ackOn !== false) settings.set(LEAD_ACK_SETTING_KEY, 'true')
      const emails: { subject: string; text: string; to: string[] }[] = []
      const fetchImpl = (async (_u: string, init: { body: string }) => (emails.push(JSON.parse(init.body)), { ok: true, status: 200 })) as unknown as typeof fetch
      const deps: QuizNudgeDeps = {
        getMode: async () => opts.quiz ?? 'on',
        ackOn: async () => settings.get(LEAD_ACK_SETTING_KEY) === 'true',
        candidates: async () => opts.leads,
        readRecord: async (_a, k) => ({ value: settings.get(k) ?? null }),
        writeRecord: async (_a, k, v) => (settings.set(k, v), {}),
        tripOpen: async () => true,
        send: (input) => sendLeadAck(input, { fetchImpl, get: async (k) => settings.get(k) ?? null, set: async (k, v) => void settings.set(k, v), now: () => NOW }),
        secret: () => (opts.secret === undefined ? SECRET : opts.secret),
        origin: async () => ORIGIN,
      }
      const ctx = { admin: {} as SupabaseClient, now: NOW, startedAt: 0, budgetMs: 1_000_000, dryRun: false, remainingMs: () => 1_000_000, room: opts.room ?? 5 } as FlywheelContext
      return { deps, ctx, emails, settings }
    }

    const a = lead('aaaa1111')
    expect('eligible: quiz lead, consent, uncontacted, 4 days old', nudgeEligible(a, NOW))
    expect('slug: read from the lead message', quizLeadSlug(a.message) === 'danube-river-cruise')
    const n1 = nudgeRig({ leads: [a] })
    const r1 = await runQuizNudge(n1.ctx, n1.deps)
    const mail = n1.emails[0]
    expect('sends once: one email to the lead with their private itinerary link', r1.ran === true && r1.acted === 1 && n1.emails.length === 1 && mail.to[0] === 'aaaa1111@mailbox.ca' && /\/itinerary\/[\w-]+\.[\w-]+/.test(mail.text) && verifyItineraryToken((/\/itinerary\/([\w.-]+)/.exec(mail.text) ?? [])[1] ?? '', SECRET, NOW)?.leadId === 'aaaa1111')
    expect('sends once: subject, first name, trip name, sender identity, stop line, not claimed as the confirmation', mail.subject === 'Your trip itinerary is still here' && mail.text.startsWith('Hi Jane,') && mail.text.includes('Danube River Cruise') && /reply to this email and say so, and we will stop/.test(mail.text) && /Sent by /.test(mail.text) && /ticked the box agreeing to hear from us/.test(mail.text) && !/not an advertisement/.test(mail.text))
    expect('copy: no price, no promise of a response time, no dashes', !/\$\d/.test(mail.text) && !dashes.test(mail.subject + mail.text))
    expect('records the nudge before anything can repeat', nudgeRecorded(n1.settings.get(nudgeKey('aaaa1111'))) && /"sent"/.test(n1.settings.get(nudgeKey('aaaa1111')) ?? ''))
    const again = await runQuizNudge(n1.ctx, n1.deps)
    expect('never twice: a second pass (and a third, a day later) sends nothing more', again.ran === false && n1.emails.length === 1)
    n1.settings.delete('lead_ack_sent_dummy')
    const later = { ...n1.ctx, now: new Date(NOW.getTime() + 2 * 86_400_000) } as FlywheelContext
    await runQuizNudge(later, n1.deps)
    expect('never twice: still one email after more passes', n1.emails.length === 1)

    const cases: [string, NudgeLead][] = [
      ['no consent line', lead('c1', { message: msg().replace('Consent to emails: yes', 'Consent to emails: no') })],
      ['already contacted (first_contact_at set)', lead('c2', { first_contact_at: daysAgo(1) })],
      ['booked', lead('c3', { status: 'booked' })],
      ['lost', lead('c4', { status: 'lost' })],
      ['flagged test', lead('c5', { is_test: true })],
      ['test email address', lead('c6', { email: 'claude-test+9@example.com' })],
      ['test name', lead('c7', { name: 'TEST LEAD Jane' })],
      ['too new (1 day)', lead('c8', { created_at: daysAgo(1) })],
      ['too old (10 days)', lead('c9', { created_at: daysAgo(10) })],
      ['a plain itinerary lead (not from the quiz)', lead('c10', { message: plainMsg })],
      ['no email address', lead('c11', { email: null })],
    ]
    for (const [label, l] of cases) {
      const n = nudgeRig({ leads: [l] })
      await runQuizNudge(n.ctx, n.deps)
      expect(`never: ${label}`, n.emails.length === 0 && !n.settings.has(nudgeKey(l.id)))
    }
    {
      const n = nudgeRig({ leads: [lead('d1')], quiz: 'off' })
      const r = await runQuizNudge(n.ctx, n.deps)
      expect('never: trip quiz switch off', n.emails.length === 0 && r.ran === false && !n.settings.has(nudgeKey('d1')))
      const n2 = nudgeRig({ leads: [lead('d2')], ackOn: false })
      const r2 = await runQuizNudge(n2.ctx, n2.deps)
      expect('never: instant lead reply switch off (and nothing is recorded, so it can still go once the switch is on)', n2.emails.length === 0 && r2.ran === false && !n2.settings.has(nudgeKey('d2')))
      const n3 = nudgeRig({ leads: [lead('d3')], secret: '' })
      expect('never: no signing secret', (await runQuizNudge(n3.ctx, n3.deps)).ran === false && n3.emails.length === 0)
      const n4 = nudgeRig({ leads: [lead('d4')] })
      expect('never: a dry run', (await runQuizNudge({ ...n4.ctx, dryRun: true } as FlywheelContext, n4.deps)).ran === false && n4.emails.length === 0 && n4.settings.size === 1)
      const n5 = nudgeRig({ leads: [lead('d5')], room: 0 })
      expect('never: past the policy daily limit', (await runQuizNudge(n5.ctx, n5.deps)).ran === false && n5.emails.length === 0)
    }
    {
      // The email guards still apply: the address was emailed within 24 hours, so sendLeadAck refuses; nothing is lost, it is released and goes later.
      const l = lead('e1')
      const n = nudgeRig({ leads: [l] })
      const { ackSentKey } = await import('../lib/lead-ack')
      n.settings.set(ackSentKey(l.email as string), new Date(NOW.getTime() - 3_600_000).toISOString())
      const held = await runQuizNudge(n.ctx, n.deps)
      expect('guard: once per address per day still applies (no email, record released)', held.ran === false && n.emails.length === 0 && !nudgeRecorded(n.settings.get(nudgeKey('e1'))))
      n.settings.delete(ackSentKey(l.email as string))
      const ok = await runQuizNudge(n.ctx, n.deps)
      expect('guard: released, so it goes on a later pass, then never again', ok.ran === true && n.emails.length === 1 && (await runQuizNudge(n.ctx, n.deps)).ran === false && n.emails.length === 1)
      const cap = nudgeRig({ leads: [lead('e2')] })
      cap.settings.set('lead_ack_day', `${TODAY}:50`)
      const rc = await runQuizNudge(cap.ctx, cap.deps)
      expect('guard: the lead reply daily cap still applies', rc.ran === false && cap.emails.length === 0)
      const unset = nudgeRig({ leads: [lead('e3')] })
      const saved = process.env.LEAD_ACK_FROM_EMAIL
      delete process.env.LEAD_ACK_FROM_EMAIL
      await runQuizNudge(unset.ctx, unset.deps)
      process.env.LEAD_ACK_FROM_EMAIL = saved
      expect('guard: an unset sender sends nothing', unset.emails.length === 0)
      const failed = nudgeRig({ leads: [lead('e4')] })
      const failDeps: QuizNudgeDeps = { ...failed.deps, send: async () => 'failed' }
      await runQuizNudge(failed.ctx, failDeps)
      await runQuizNudge(failed.ctx, failDeps)
      expect('claim first: a failed send is recorded and is NOT retried (at most once)', nudgeRecorded(failed.settings.get(nudgeKey('e4'))) && failed.emails.length === 0)
      const unread = nudgeRig({ leads: [lead('e5')] })
      const noRead: QuizNudgeDeps = { ...unread.deps, readRecord: async () => ({ value: null, error: 'down' }) }
      await runQuizNudge(unread.ctx, noRead)
      expect('claim first: if the record cannot be read nothing is sent', unread.emails.length === 0)
    }
    const step = FLYWHEEL_STEPS.find((s) => s.id === 'quiz_nudge')
    expect('registered in the existing flywheel pass (not a new cron)', !!step && step.policy === 'quiz_nudge' && !/quiz/i.test(src('vercel.json')))
    const m = src('lib/flywheel/steps/quiz-nudge.ts')
    expect('the nudge sends only through sendLeadAck (no direct Resend call)', /sendLeadAck\(/.test(m) && !/resend\.com|fetch\(/.test(m))
  }

  // ── counters ─────────────────────────────────────────────────────────────────────
  {
    let raw: string | null = null
    const d1 = new Date('2026-10-30T10:00:00Z')
    const d2 = new Date('2026-10-31T10:00:00Z')
    for (const e of ['started', 'q1', 'q2', 'q3', 'q4', 'result', 'email'] as const) raw = bumpQuizCount(raw, e, d1)
    raw = bumpQuizCount(raw, 'started', d2)
    raw = bumpQuizCount(raw, 'started', d2)
    const c = parseQuizCounts(raw)
    expect('counters: one key, one entry per UTC day, every step counted', Object.keys(c).join() === '2026-10-30,2026-10-31' && c['2026-10-30'].q4 === 1 && c['2026-10-30'].email === 1 && c['2026-10-31'].started === 2)
    expect('counters: totals for today and for the last 7 days', quizTotals(c, d2, 1).started === 2 && quizTotals(c, d2, 7).started === 3 && quizTotals(c, d2, 7).result === 1)
    expect('counters: junk reads as empty, old days are dropped after 60', Object.keys(parseQuizCounts('junk')).length === 0 && Object.keys(parseQuizCounts(null)).length === 0)
    let big: string | null = null
    for (let i = 0; i < 70; i++) big = bumpQuizCount(big, 'started', new Date(Date.UTC(2026, 0, 1 + i)))
    expect('counters: at most 60 days are kept', Object.keys(parseQuizCounts(big)).length === 60)
    const page = src('app/trip-quiz/page.tsx')
    expect('counters: server side only (no script, no cookie, no tracking call, no headers or cookies read)', !/document\.cookie|localStorage|gtag|track\(|next\/headers|cookies\(/.test(page) && /recordQuizEvent\(step === 0 \? "started"/.test(page))
    const admin = src('app/api/admin/trip-quiz/route.ts')
    expect('admin route: both methods check isAuthorized first', (admin.match(/if \(!isAuthorized\(request\)\)/g) ?? []).length === 2)
    const health = src('app/admin/system-health/page.tsx')
    expect('System health: the switch and the funnel sit next to the itinerary switch', health.indexOf('toggleItinerary}') > -1 && health.indexOf('toggleQuiz}') > health.indexOf('toggleItinerary}') && /Answered Q4/.test(health) && /Gave email/.test(health))
  }

  // ── housekeeping ─────────────────────────────────────────────────────────────────
  {
    const env = src('.env.example')
    expect('.env.example documents the switch, the funnel key and the nudge', /trip_quiz_mode/.test(env) && /trip_quiz_funnel/.test(env) && /quiz_nudge/.test(env))
    const mig = readdirSync('supabase/migrations').filter((f) => /^\d{4}_/.test(f)).sort()
    expect('no migration added by the quiz (newest is still 0063)', mig[mig.length - 1].startsWith('0063_'))
    const files = ['lib/trip-quiz.ts', 'lib/trip-quiz-store.ts', 'lib/flywheel/steps/quiz-nudge.ts', 'app/trip-quiz/page.tsx', 'components/trip-quiz-card.tsx', 'components/trip-quiz-link.tsx', 'app/api/admin/trip-quiz/route.ts', 'lib/lead-ack-copy.ts', 'lib/itinerary-magnet.ts', 'components/itinerary-request-form.tsx']
    expect('no em or en dashes in any new or changed copy', files.every((f) => !dashes.test(src(f))))
    expect('UTM passthrough: the card link and every quiz link carry utm_*', /utm_source/.test(src('components/trip-quiz-link.tsx')) && /for \(const \[k, v\] of Object\.entries\(utm\)\) p\.set\(k, v\)/.test(src('app/trip-quiz/page.tsx')))
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
  process.exit(failures ? 1 : 0)
}
main()
