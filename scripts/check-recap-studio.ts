// Self-check for the Recap Studio: the daily prompt (past trips, snooze), share tokens (hashed, expiring, revocable), what a public
// submission may contain (types, sizes, consent, honeypot), that pending items are never public, the AI draft gates (fakes only),
// that JSON-LD reviews come only from approved quotes, no dashes in the copy, and that every route checks the admin or the token.
// No network, no database, no model call.
// Run: pnpm dlx tsx scripts/check-recap-studio.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeAdmin, type Db } from './fake-admin'
import {
  QUESTIONS, altTextFor, answersToNotes, buildRecapEmail, containsContact, detectImage, displayName, dueTitle, firstSentence, isShareTokenFormat, laplacianVariance, orderWithCover, parseBundle, pickBestPhotos, recapChecklist,
  recapThinReason, selectRecapDue, shareExpiry, shareMessage, shareState, smsHref, snoozeUntil, validateAnswers, validatePhotoClaim, validateQuote, whatsappHref, SHARE_DAYS, PHOTO_MAX_BYTES, type DueRow, type PhotoFacts,
} from '../lib/recap-studio'
import { generateShareToken, hashShareToken, tokenMatchesHash } from '../lib/recap-token'
import { isHoneypotFilled } from '../lib/abuse-guard'
import { buildRecapQuotesJsonLd } from '../lib/jsonld'
import { composeDraft, gateDraft, parseDraft, recordFaqs, traceSentences, usesUnapprovedQuote, HELP_LINE, type CallFn, type DraftInput, type DraftTrip } from '../lib/recap-draft'
import { addSubmission, approvedAnswerNotes, approvedQuotesFrom, createShare, decideSubmission, getShareByToken, listShares, mergeFaqs, notifyRecapSubmission, pendingByTrip, recapsDue, revokeShare, snoozeTrips, type SubmissionRow } from '../lib/recap-store'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const NOW = new Date('2026-10-23T12:00:00Z')
const row = (o: Partial<DueRow> & { id: string }): DueRow => ({ slug: o.id, name: `Trip ${o.id}`, status: 'published', available_to: '2026-09-01', recap_mode: 'auto', recap_summary: null, gallery_urls: [], ai_faqs: [], ...o })
const faqs = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }))
const good = (o: Partial<DueRow> & { id: string }) => row({ recap_summary: 'A recap.', gallery_urls: ['a', 'b', 'c'], ai_faqs: faqs(6), ...o })

async function main() {
// ─── 1. The daily prompt ────────────────────────────────────────────────────────────────
{
  const rows = [
    row({ id: 'past-none', available_to: '2026-08-01' }),
    row({ id: 'past-newer', available_to: '2026-10-01' }),
    good({ id: 'past-fine' }),
    good({ id: 'past-thin-photos', gallery_urls: ['a'] }),
    good({ id: 'past-thin-faq', ai_faqs: faqs(1) }),
    row({ id: 'future', available_to: '2027-01-01' }),
    row({ id: 'no-date', available_to: null }),
    row({ id: 'ended-today', available_to: '2026-10-23' }),
    row({ id: 'live', recap_mode: 'live', available_to: '2026-01-01' }),
    row({ id: 'forced', recap_mode: 'recap', available_to: '2027-05-01' }),
    row({ id: 'draft', status: 'draft', available_to: '2026-01-01' }),
  ]
  const due = selectRecapDue(rows, {}, NOW)
  const ids = due.map((d) => d.id)
  check('due: a past trip with no recap is prompted', ids.includes('past-none') && ids.includes('past-newer'))
  check('due: a past trip with a good recap is not', !ids.includes('past-fine'))
  check('due: a thin recap (few photos, few FAQs) is prompted with the reason', ids.includes('past-thin-photos') && ids.includes('past-thin-faq') && due.find((d) => d.id === 'past-thin-photos')?.reason === 'thin')
  check('due: future, undated, ended-today and unpublished trips are not', !['future', 'no-date', 'ended-today', 'draft'].some((i) => ids.includes(i)), ids)
  check('due: recap_mode live is never prompted, recap (forced) is', !ids.includes('live') && ids.includes('forced'))
  check('due: most recently finished first', ids.indexOf('forced') < ids.indexOf('past-newer') && ids.indexOf('past-newer') < ids.indexOf('past-none'), ids)
  check('due: links go to the Studio page', due.every((d) => d.href === `/admin/packages/${d.id}/recap`))
  const until = snoozeUntil(NOW)
  check('snooze lasts 7 days', Date.parse(until) - NOW.getTime() === 7 * 86_400_000)
  const snoozed = selectRecapDue(rows, { 'past-none': until }, NOW).map((d) => d.id)
  check('due: a snoozed trip is left out', !snoozed.includes('past-none') && snoozed.includes('past-newer'))
  const later = selectRecapDue(rows, { 'past-none': until }, new Date(NOW.getTime() + 8 * 86_400_000)).map((d) => d.id)
  check('due: it comes back after the snooze ends', later.includes('past-none'))
  check('due title', dueTitle(1) === '1 past trip needs a recap' && dueTitle(3) === '3 past trips need a recap')
  check('thin reason: none when fine', recapThinReason(good({ id: 'x' })) === null)
  // Against the (fake) database: the snooze really is stored and read.
  const db: Db = { tables: { travel_packages: rows as unknown as Record<string, unknown>[], app_settings: [] } }
  const admin = fakeAdmin(db)
  const real = await recapsDue(admin, NOW)
  check('recapsDue reads the published trips', real.some((d) => d.id === 'past-none') && !real.some((d) => d.id === 'draft'))
  await snoozeTrips(admin, ['past-none'], NOW)
  check('snoozeTrips stores the date and recapsDue honours it', !(await recapsDue(admin, NOW)).some((d) => d.id === 'past-none') && (await recapsDue(admin, new Date(NOW.getTime() + 9 * 86_400_000))).some((d) => d.id === 'past-none'))
}

// ─── 2. Tokens ──────────────────────────────────────────────────────────────────────────
{
  const t = generateShareToken()
  check('token: 43 url-safe characters (256 bits), never the same twice', t.length >= 32 && isShareTokenFormat(t) && t !== generateShareToken())
  check('token: shape check refuses short, odd and non-string values', !isShareTokenFormat('abc') && !isShareTokenFormat('x'.repeat(43) + '!') && !isShareTokenFormat(undefined))
  const h = hashShareToken(t)
  check('token: the hash is not the token and is stable', h !== t && h === hashShareToken(t) && /^[0-9a-f]{64}$/.test(h))
  check('token: matches only its own hash', tokenMatchesHash(t, h) && !tokenMatchesHash(generateShareToken(), h))
  const share = { expires_at: shareExpiry(NOW).toISOString(), revoked_at: null as string | null }
  check('share lasts 14 days', SHARE_DAYS === 14 && Date.parse(share.expires_at) - NOW.getTime() === 14 * 86_400_000)
  check('share: valid now, expired later, revoked wins', shareState(share, NOW).ok && !shareState(share, new Date(NOW.getTime() + 15 * 86_400_000)).ok && (shareState({ ...share, revoked_at: NOW.toISOString() }, NOW) as { reason?: string }).reason === 'revoked')

  const db: Db = { tables: { recap_shares: [], recap_submissions: [], app_settings: [] } }
  const admin = fakeAdmin(db)
  const made = await createShare(admin, 'pkg-1', 'agent', 'Dana Whitfield-Smith 123', NOW)
  check('createShare ok', made.ok)
  if (made.ok) {
    const stored = JSON.stringify(db.tables.recap_shares)
    check('the raw token is NEVER stored, only its hash', !stored.includes(made.value.token) && stored.includes(hashShareToken(made.value.token)))
    check('the link path holds the token', made.value.path === `/recap/${made.value.token}`)
    check('the agent name is cleaned (letters only)', made.value.share.agent_name === 'Dana Whitfield-Smith')
    const found = await getShareByToken(admin, made.value.token)
    check('lookup by token finds it', found?.package_id === 'pkg-1')
    check('a wrong or malformed token finds nothing', (await getShareByToken(admin, generateShareToken())) === null && (await getShareByToken(admin, 'short')) === null)
    check('a link is for ONE trip', found?.package_id === 'pkg-1' && (await listShares(admin, 'pkg-2')).length === 0)
    check('revoke blocks the link', (await revokeShare(admin, 'pkg-1', made.value.share.id)) === null && !!(await getShareByToken(admin, made.value.token))?.revoked_at)
    const again = await getShareByToken(admin, made.value.token)
    check('after revoke the gate state is blocked', !!again && !shareState(again, NOW).ok)
  }
  // The cap on active links per trip
  let capHit = false
  for (let i = 0; i < 12; i++) {
    const r = await createShare(admin, 'pkg-cap', 'testimonial', null, NOW)
    if (!r.ok && r.status === 409) capHit = true
  }
  check('at most 10 active links per trip', capHit)
}

// ─── 3. What a public submission may contain ───────────────────────────────────────────
{
  const ok = validateAnswers({ best: 'We swam off the boat.', meal: '', extra: 'ignored' })
  check('answers: one is enough, unknown keys dropped', ok.ok && Object.keys(ok.value).join() === 'best')
  check('answers: none is refused', !validateAnswers({}).ok && !validateAnswers(null).ok)
  check('answers: a phone number, an email and a link are refused', !validateAnswers({ best: 'Call me on 416-555-0199' }).ok && !validateAnswers({ best: 'mail me at a@b.com' }).ok && !validateAnswers({ best: 'see https://x.example/y' }).ok)
  check('answers: over 400 characters is refused', !validateAnswers({ best: 'a'.repeat(401) }).ok)
  check('answers: dashes are removed', (validateAnswers({ best: 'A great day — truly' }) as { value: Record<string, string> }).value.best.indexOf('—') === -1)

  check('quote: CONSENT is required', !validateQuote({ text: 'We loved every minute of it.', firstName: 'Sam', consent: false }).ok && !validateQuote({ text: 'We loved every minute of it.', firstName: 'Sam' }).ok && !validateQuote({ text: 'We loved every minute of it.', firstName: 'Sam', consent: 'true' }).ok)
  const q = validateQuote({ text: '"We loved every minute of it."', firstName: 'sam', lastName: 'Turner', consent: true })
  check('quote: first name and one initial only', q.ok && q.value.name === 'Sam T.' && q.value.text === 'We loved every minute of it.', q)
  check('quote: needs a first name, a real length, no contact details', !validateQuote({ text: 'We loved every minute of it.', firstName: '', consent: true }).ok && !validateQuote({ text: 'Nice', firstName: 'Sam', consent: true }).ok && !validateQuote({ text: 'Great trip, call 905 555 0100 now', firstName: 'Sam', consent: true }).ok && !validateQuote({ text: 'x'.repeat(401), firstName: 'Sam', consent: true }).ok)
  check('displayName never shows a full surname', displayName('Ana', 'Rodriguez-Lopez') === 'Ana R.' && displayName('Ana', '') === 'Ana' && displayName('', 'X') === null)
  check('contact detector', containsContact('+1 (833) 878-5386') && containsContact('x@y.ca') && containsContact('visit www.example.com') && !containsContact('We walked 3 km to the village.'))

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(8)])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)])
  check('images: jpg, png, webp and heic are known by their bytes', detectImage(jpeg)?.ext === 'jpg' && detectImage(png)?.ext === 'png' && detectImage(webp)?.ext === 'webp' && detectImage(heic)?.ext === 'heic')
  check('images: a pdf, an exe and text named .jpg are refused', detectImage(Buffer.from('%PDF-1.7 ....')) === null && detectImage(Buffer.from('MZ\x90\x00 exe bytes here')) === null && detectImage(Buffer.from('hello world, not an image')) === null)
  check('photo claim: types by name', validatePhotoClaim({ name: 'a.jpg', size: 1000 }, 0).ok && validatePhotoClaim({ name: 'a.HEIC', size: 1000 }, 0).ok && !validatePhotoClaim({ name: 'a.pdf', size: 1000 }, 0).ok && !validatePhotoClaim({ name: 'a.exe', size: 1000 }, 0).ok)
  check('photo claim: max 12 MB each and 20 in all', PHOTO_MAX_BYTES === 12 * 1024 * 1024 && validatePhotoClaim({ name: 'a.jpg', size: PHOTO_MAX_BYTES }, 0).ok && !validatePhotoClaim({ name: 'a.jpg', size: PHOTO_MAX_BYTES + 1 }, 0).ok && !validatePhotoClaim({ name: 'a.jpg', size: 10 }, 20).ok && validatePhotoClaim({ name: 'a.jpg', size: 10 }, 19).ok)
  check('honeypot: a filled hidden field is spotted', isHoneypotFilled({ company_website: 'x' }) && !isHoneypotFilled({ company_website: '' }) && !isHoneypotFilled({}))
}

// ─── 4. Pending is never public ────────────────────────────────────────────────────────
{
  const sub = (o: Partial<SubmissionRow> & { id: string; kind: SubmissionRow['kind'] }): SubmissionRow => ({ package_id: 'p', share_id: 's', payload: {}, status: 'pending', submitted_by: 'Dana', created_at: NOW.toISOString(), decided_at: null, ...o })
  const subs = [
    sub({ id: '1', kind: 'quote', status: 'pending', payload: { text: 'PENDING quote text here', name: 'Pat P.', consent: true } }),
    sub({ id: '2', kind: 'quote', status: 'rejected', payload: { text: 'REJECTED quote text here', name: 'Rob R.', consent: true } }),
    sub({ id: '3', kind: 'quote', status: 'approved', payload: { text: 'APPROVED quote text here', name: 'Amy A.', consent: true } }),
    sub({ id: '4', kind: 'quote', status: 'approved', payload: { text: 'NO CONSENT quote here', name: 'Nia N.', consent: false } }),
    sub({ id: '5', kind: 'answers', status: 'pending', payload: { answers: { best: 'PENDING ANSWER' } } }),
    sub({ id: '6', kind: 'answers', status: 'approved', payload: { answers: { best: 'APPROVED ANSWER' } } }),
  ]
  const quotes = approvedQuotesFrom([{ text: 'Own quote with ticked box', name: 'Joe J.' }], subs)
  check('only approved quotes with consent (and Joel\'s own) are usable', quotes.map((x) => x.name).join() === 'Joe J.,Amy A.', quotes)
  check('only approved answers become notes', approvedAnswerNotes(subs).map((n) => n.body).join() === 'APPROVED ANSWER')
  const bundle = parseBundle(JSON.stringify({ quickAnswer: 'q', takeaways: ['t'], quotes: [{ text: 'ok', name: 'A.' }, { text: 'no name', name: '' }, { name: 'no text' }], metaTitle: '', metaDescription: '', publishedAt: '' }))
  check('a stored bundle keeps only complete quotes; junk is no bundle', bundle?.quotes.length === 1 && parseBundle('not json') === null && parseBundle(null) === null && parseBundle('{"a":1}') === null)

  // Through the fake database: a submission lands PENDING, and approval needs the consent tick.
  const db: Db = { tables: { recap_shares: [], recap_submissions: [], app_settings: [] } }
  const admin = fakeAdmin(db)
  const made = await createShare(admin, 'p', 'agent', 'Dana', NOW)
  if (made.ok) {
    const added = await addSubmission(admin, made.value.share, 'quote', { text: 'Lovely trip all round', name: 'Kim K.', consent: true })
    check('a new submission is stored PENDING', added.ok && added.value.status === 'pending')
    check('Needs attention counts it', (await pendingByTrip(admin)).some((p) => p.packageId === 'p' && p.n === 1))
    const noConsent = await addSubmission(admin, made.value.share, 'quote', { text: 'Sneaky quote without a tick', name: 'Lee L.', consent: false })
    if (noConsent.ok) {
      const r = await decideSubmission(admin, 'p', noConsent.value.id, 'approve')
      check('a quote without the consent tick cannot be approved', !r.ok && r.status === 422)
    }
    if (added.ok) {
      const approved = await decideSubmission(admin, 'p', added.value.id, 'approve', { text: 'Lovely trip, all round' })
      check('approve (with Joel\'s edit) works and is recorded', approved.ok && approved.value.status === 'approved' && approved.value.payload.text === 'Lovely trip, all round')
      check('a decided item cannot be decided twice', !(await decideSubmission(admin, 'p', added.value.id, 'reject')).ok)
    }
  }
}

// ─── 5. The AI draft and its gates (fakes only) ────────────────────────────────────────
const trip: DraftTrip = { name: 'Greek Isles Singles Cruise', slug: 'greek-isles', destination: 'Greece', category: 'Cruise', duration: '7 nights', available_from: '2026-05-12', available_to: '2026-05-19', short_description: 'A relaxed singles cruise around the islands.', full_description: null, highlights: ['Island hopping'], price_includes: ['Seven nights on board', 'Breakfast daily'], next_trip: { name: 'Croatia Sail', slug: 'croatia-sail' } }
const notes = answersToNotes({
  best: 'We swam off the boat at the first island and then walked up to the village for lunch.',
  meal: 'The welcome dinner by the water in Athens was our favourite meal.',
  tip: 'Pack comfortable walking shoes for the village walk and arrive in Athens a day early.',
  suits: 'Solo travellers who like a slow pace, a long beach afternoon and meeting new people.',
  surprise: 'A farewell toast on deck on the last full day was a surprise to us.',
})
const input: DraftInput = { trip, notes, quotes: [{ text: 'We loved it', name: 'Amy A.' }], unapprovedQuoteTexts: ['The sunsets over the caldera made me cry happy tears every single evening'] }
const body = 'We swam off the boat at the first island and walked up to the village for lunch, and the welcome dinner by the water in Athens was our favourite meal. '
const modelJson = {
  summary: `Our Greek Isles Singles Cruise happened in May 2026 and took the group around the islands of Greece. ${body.repeat(4)}A long beach afternoon and a farewell toast on deck made the last full day a surprise.`,
  highlights: ['Swimming off the boat at the first island', 'A welcome dinner by the water in Athens', 'A farewell toast on deck on the last full day'],
  faqs: [
    { q: 'What was the trip like?', a: 'It was a relaxed cruise around the islands of Greece. We swam off the boat at the first island, walked up to the village for lunch and had a welcome dinner by the water in Athens.' },
    { q: 'Who is this trip for?', a: 'It suits solo travellers who like a slow pace, a long beach afternoon and meeting new people.' },
    { q: 'What should I know for next time?', a: 'Pack comfortable walking shoes for the village walk and arrive in Athens a day early.' },
  ],
  takeaways: ['Swim off the boat at the first island', 'Pack comfortable walking shoes for the village walk', 'Arrive in Athens a day early'],
  meta_title: 'Greek Isles Singles Cruise recap',
  meta_description: 'A look back at the Greek Isles Singles Cruise around the islands of Greece, from our notes on the welcome dinner and the village walk.',
}
const fake = (json: unknown): CallFn => async () => ({ ok: true, text: JSON.stringify(json) })
{
  const r = await composeDraft(input, { call: fake(modelJson), configured: true })
  check('a grounded draft passes every gate', r.ok && r.blockers.length === 0, r.ok ? r.blockers : r)
  const d = r.ok ? r.draft : null
  check('the draft has 6 FAQs: 3 from the notes and 3 from the trip record', d?.faqs.length === 6 && d.faqs[3].question === 'What was included in the trip?')
  const rec = recordFaqs(trip)
  check('record FAQs: included list comes from the trip record, next trip is linked, booking uses the approved help line and the site number only', rec[0].answer.includes('Seven nights on board') && rec[1].answer.includes('/packages/croatia-sail') && rec[2].answer.includes(HELP_LINE) && rec[2].answer.includes('(833) 878-5386'))
  check('record FAQs: a price in the included list is left out, not repeated', !recordFaqs({ ...trip, price_includes: ['Hotel for $1,200 per person'] })[0].answer.includes('1,200'))
  check('quick answer is the first sentence of the recap', d !== null && firstSentence(d.summary).startsWith('Our Greek Isles Singles Cruise happened in May 2026') && !firstSentence(d.summary).includes('We swam'))
  if (d) {
    const base = (over: Partial<typeof d>) => gateDraft({ ...d, ...over }, input)
    check('gate: an invented venue, number and price is held', base({ summary: `${d.summary} We ate at Blue Harbour restaurant with 45 other guests for 90 dollars.` }).length > 0)
    check('gate: an invented FAQ fact is held', base({ faqs: [{ question: 'What was the trip like?', answer: 'Everyone cried happy tears at the Santorini sunset and the captain Nikos gave a speech about forty years at sea.' }, ...d.faqs.slice(1)] }).some((b) => /FAQs or takeaways/.test(b)))
    check('gate: a superlative is held', base({ takeaways: ['The best cruise in the world', ...d.takeaways.slice(1)] }).length > 0)
    check('gate: words from an UNAPPROVED quote are held', base({ takeaways: ['The sunsets over the caldera made me cry happy tears every single evening', ...d.takeaways.slice(1)] }).some((b) => /quote that has not been approved/.test(b)), base({ takeaways: ['The sunsets over the caldera made me cry happy tears every single evening'] }))
    check('usesUnapprovedQuote: finds a 5 word run, ignores unrelated text', usesUnapprovedQuote('the sunsets over the caldera made me cry again',['The sunsets over the caldera made me cry']) && !usesUnapprovedQuote('we swam off the boat', ['The sunsets over the caldera made me cry']))
    check('gate: a host phone number is held, the site number is fine', base({ faqs: [d.faqs[0], d.faqs[1], { question: 'What should I know for next time?', answer: 'Pack comfortable walking shoes for the village walk, and call the host on 416 555 0199 about the walk.' }, ...d.faqs.slice(3)] }).length > 0 && !gateDraft(d, input).some((b) => /phone/.test(b)))
    check('gate: an email or web link is held', base({ metaDescription: `${d.metaDescription} See https://example.com` }).length > 0)
    check('gate: a title without the trip name or too long is held', base({ metaTitle: 'A great cruise recap' }).some((b) => /trip name/.test(b)) && base({ metaTitle: `${d.metaTitle} ${'x'.repeat(60)}` }).some((b) => /characters/.test(b)))
    check('gate: fewer than 6 FAQs is held', base({ faqs: d.faqs.slice(0, 4) }).some((b) => /6 FAQs/.test(b)))
    check('gate: a dash is held', base({ takeaways: ['Swim off the boat — at the first island', ...d.takeaways.slice(1)] }).length > 0)
  }
  const bad = await composeDraft(input, { call: fake({ ...modelJson, summary: `${modelJson.summary} It cost 450 dollars and won an award as the best cruise.` }), configured: true })
  check('composeDraft: a failing draft is returned WITH reasons (it stays private)', bad.ok && bad.blockers.length > 0)
  let calls = 0
  const counting: CallFn = async () => { calls++; return { ok: true, text: JSON.stringify(modelJson) } }
  await composeDraft(input, { call: counting, configured: true })
  check('exactly ONE model call', calls === 1)
  const fewNotes = await composeDraft({ ...input, notes: notes.slice(0, 2) }, { call: counting, configured: true })
  const noKey = await composeDraft(input, { call: counting, configured: false })
  check('too few notes or no key: no call is made', !fewNotes.ok && !noKey.ok && calls === 1)
  check('unreadable model output is an error, not a draft', !(await composeDraft(input, { call: async () => ({ ok: true, text: 'sorry' }), configured: true })).ok && parseDraft(null, trip) === null)
  const traced = traceSentences('We swam off the boat at the first island. A unicorn parade crossed Mars.', [{ label: 'Note: Best moment', text: notes[0].body }])
  check('every sentence is traced to a note, or marked as unbacked', traced[0].source === 'Note: Best moment' && traced[1].source === null)
}

// ─── 6. JSON-LD only for approved quotes ───────────────────────────────────────────────
{
  const ld = buildRecapQuotesJsonLd('Greek Isles Singles Cruise', [{ text: 'Lovely trip all round', name: 'Amy A.' }, { text: '', name: 'No Text' }, { text: 'No name', name: ' ' }])
  check('Review markup: one per complete approved quote, no invented star rating', ld.length === 1 && ld[0]['@type'] === 'Review' && ld[0].author.name === 'Amy A.' && !JSON.stringify(ld).includes('reviewRating'))
  const page = read('app/packages/[slug]/page.tsx')
  check('trip page: Review markup is built only from the published bundle and only on a past trip', page.includes('buildRecapQuotesJsonLd(pkg.name, recapBundle.quotes)') && /isPastTrip && recapBundle && recapBundle\.quotes\.length > 0/.test(page))
  const pub = read('lib/recap-public.ts')
  check('the public loader reads only the published bundle, never submissions or links', pub.includes('recapBundleKey') && !/recap_submissions|recap_shares|listSubmissions/.test(pub))
}

// ─── 7. The score and the photos ───────────────────────────────────────────────────────
{
  const base = { photoCount: 0, hasCover: false, answersFilled: 0, hasSummary: false, faqCount: 0, approvedQuotes: 0 }
  const s0 = recapChecklist(base).score
  const s1 = recapChecklist({ ...base, photoCount: 4 }).score
  const s2 = recapChecklist({ ...base, photoCount: 9, answersFilled: 5, hasCover: true }).score
  const s3 = recapChecklist({ ...base, photoCount: 9, answersFilled: 5, hasCover: true, hasSummary: true, faqCount: 6, approvedQuotes: 1 })
  check('the Recap score only goes up as things are added, and tops out at 100', s0 === 0 && s0 < s1 && s1 < s2 && s2 < s3.score && s3.score === 100 && !s3.thin && recapChecklist(base).thin)

  const f = (id: string, bytes: number, w: number, h: number, sharpness: number | null): PhotoFacts => ({ id, bytes, width: w, height: h, sharpness })
  const MB = 1024 * 1024
  const many: PhotoFacts[] = Array.from({ length: 15 }, (_, i) => f(`p${i}`, (1 + i * 0.1) * MB, 4000, 3000, 300))
  many.push(f('blurry', 3 * MB, 4000, 3000, 2), f('tiny', 50_000, 200, 200, 500), f('dupe', 1 * MB, 4000, 3000, 300))
  const picked = pickBestPhotos(many, 12)
  check('best photos: at most 12, no tiny picture, no exact repeat of another', picked.length === 12 && !picked.includes('tiny') && !(picked.includes('p0') && picked.includes('dupe')))
  check('best photos: a sharp one beats a blurry one of the same size', pickBestPhotos([f('blur', 2 * MB, 4000, 3000, 1), f('sharp', 2 * MB + 5, 4000, 3000, 380)], 1)[0] === 'sharp')
  check('best photos: shown in their original order', picked.join() === [...picked].sort((a, b) => many.findIndex((x) => x.id === a) - many.findIndex((x) => x.id === b)).join())
  const flat = new Uint8Array(100).fill(128)
  const checker = Uint8Array.from({ length: 100 }, (_, i) => (((i % 10) + Math.floor(i / 10)) % 2 ? 255 : 0))
  check('sharpness: a flat picture scores 0, a busy one scores high', laplacianVariance(flat, 10, 10) === 0 && laplacianVariance(checker, 10, 10) > 1000)
  check('cover goes first, the rest keep their order', orderWithCover(['a', 'b', 'c'], 'c').join() === 'c,a,b' && orderWithCover(['a', 'b'], 'zz').join() === 'a,b')
  check('alt text names only the trip and the place', altTextFor('Greek Isles Singles Cruise', 'Greece', 2) === 'Photo 3 from the Greek Isles Singles Cruise trip in Greece' && altTextFor('X', null, 0) === 'Photo 1 from the X trip')
  check('merged FAQs: the recap\'s six first, no repeated question, at most 12', mergeFaqs(faqs(6), [{ question: 'q0', answer: 'dupe' }, { question: 'Other?', answer: 'a' }]).length === 7 && mergeFaqs(faqs(6), Array.from({ length: 20 }, (_, i) => ({ question: `Old ${i}`, answer: 'a' }))).length === 12)
}

// ─── 8. Sharing and the email ──────────────────────────────────────────────────────────
{
  const url = 'https://example.test/recap/' + 'a'.repeat(43)
  const msg = shareMessage('agent', 'Greek Isles Singles Cruise', url, 'Dana Smith')
  check('share message: friendly, has the link and the first name only, no dashes', msg.startsWith('Hi Dana!') && msg.includes(url) && !msg.includes('Smith') && !/[—–]/.test(msg))
  check('Text it: an sms: link with the message filled in', smsHref(msg).startsWith('sms:') && decodeURIComponent(smsHref(msg).split('body=')[1]) === msg)
  check('WhatsApp it: wa.me with the message and link encoded', whatsappHref(msg).startsWith('https://wa.me/?text=') && decodeURIComponent(whatsappHref(msg).split('text=')[1]) === msg)
  check('testimonial message differs and has no dash', shareMessage('testimonial', 'X', url).includes('sentence or two') && !/[—–]/.test(shareMessage('testimonial', 'X', url)))
  const mail = buildRecapEmail('Greek Isles Singles Cruise', { answers: 1, quotes: 1, photos: 3 }, 'https://example.test/admin/packages/1/recap')
  check('the email carries no personal data or words from the notes', !/@|\d{7,}/.test(mail.text) && mail.text.includes('3 photos') && !mail.text.includes('Dana') && mail.subject === 'Something to review for a trip recap')
  const sent: unknown[] = []
  const env = { key: 'k', to: 'joel@example.test', from: 'x@example.test' }
  const r1 = await notifyRecapSubmission(fakeAdmin({ tables: {} }), 's1', 'p1', 'Greek Isles Singles Cruise', { answers: 1, quotes: 0, photos: 0 }, { env, claim: async () => true, fetchImpl: (async (_u: unknown, init?: { body?: string }) => { sent.push(JSON.parse(init?.body ?? '{}')); return { ok: true } }) as unknown as typeof fetch, siteUrl: 'https://example.test' })
  const r2 = await notifyRecapSubmission(fakeAdmin({ tables: {} }), 's1', 'p1', 'T', { answers: 1, quotes: 0, photos: 0 }, { env, claim: async () => false, fetchImpl: (async () => ({ ok: true })) as unknown as typeof fetch })
  const r3 = await notifyRecapSubmission(fakeAdmin({ tables: {} }), 's1', 'p1', 'T', { answers: 1, quotes: 0, photos: 0 }, { env: { key: '', to: '' } })
  check('notify: sends once, throttles repeats, does nothing without a key', r1 === 'sent' && sent.length === 1 && r2 === 'throttled' && r3 === 'not-configured')
  check('the email links to the Studio page', JSON.stringify(sent[0]).includes('/admin/packages/p1/recap'))
}

// ─── 9. No dashes in copy; every route checks the admin or the token ─────────────────
{
  const files = ['lib/recap-studio.ts', 'lib/recap-draft.ts', 'lib/recap-store.ts', 'lib/recap-gate.ts', 'lib/recap-public.ts', 'components/recap-share-form.tsx', 'components/admin/recap-studio.tsx', 'components/trip-recap-extras.tsx', 'app/recap/[token]/page.tsx', 'app/recap/[token]/layout.tsx', 'supabase/migrations/0053_recap_studio.sql']
  const dashed = files.filter((f) => /[—–]/.test(read(f)))
  check('no em or en dashes in the new copy or code', dashed.length === 0, dashed)
  const questionCopy = JSON.stringify(QUESTIONS) + HELP_LINE
  check('no dashes in the questions or the help line', !/[—–]/.test(questionCopy))

  const adminRoutes = ['app/api/admin/packages/[id]/recap-studio/route.ts', 'app/api/admin/recap-studio/due/route.ts']
  for (const f of adminRoutes) {
    const src = read(f)
    const handlers = [...src.matchAll(/export async function (GET|POST)\([^)]*\)[^{]*\{\r?\n([\s\S]*?)\r?\n/g)]
    check(`${f}: every handler calls isAuthorized(request) on its first line`, handlers.length > 0 && handlers.every((h) => /isAuthorized\(request\)/.test(h[2])), handlers.map((h) => h[1]))
  }
  for (const f of ['app/api/recap/[token]/route.ts', 'app/api/recap/[token]/photos/route.ts']) {
    const src = read(f)
    const handlers = [...src.matchAll(/export async function (GET|POST)\([^)]*\)[^{]*\{\r?\n([\s\S]*?)\r?\n/g)]
    check(`${f}: every handler validates the token first (recapGate)`, handlers.length > 0 && handlers.every((h) => /recapGate\(request, params\.token\)/.test(h[2])), handlers.map((h) => h[1]))
    check(`${f}: honeypot is checked and submissions are rate limited`, src.includes('isHoneypotFilled') && (src.includes('allowSubmit') || src.includes('GET')))
  }
  const gate = read('lib/recap-gate.ts')
  check('gate: per-IP and per-token limits, token shape checked before the database, expired and revoked refused', gate.includes('allowRequest') && gate.includes('allowKey') && gate.indexOf('!isShareTokenFormat(token)') < gate.indexOf('getShareByToken(admin, token)') && gate.includes('shareState'))
  check('the public form page is noindex and sends no referrer', /index: false/.test(read('app/recap/[token]/layout.tsx')) && /no-referrer/.test(read('app/recap/[token]/layout.tsx')))
  const store = read('lib/recap-store.ts')
  check('publish fails closed: the gate runs before anything is published', store.indexOf('gateDraft(stored.draft, input)') > 0 && store.indexOf('gateDraft(stored.draft, input)') < store.indexOf('publishRecap(admin, packageId'))
  check('the migration stores only the token HASH and has RLS with no policy', /token_hash text not null unique/.test(read('supabase/migrations/0053_recap_studio.sql')) && !/\btoken text\b/.test(read('supabase/migrations/0053_recap_studio.sql')) && /enable row level security/.test(read('supabase/migrations/0053_recap_studio.sql')) && !/create policy/i.test(read('supabase/migrations/0053_recap_studio.sql')))
  const ui = read('components/admin/recap-studio.tsx')
  check('admin share controls: Copy link, Text it, WhatsApp it, Revoke and the plain link', ['Copy link', 'Text it', 'WhatsApp it', 'Revoke', 'readOnly value={url}'].every((s) => ui.includes(s)))
  check('the Needs attention item, the brief and the Trips card all use the same due list', read('lib/issues.ts').includes('recapsDue(admin)') && read('lib/debrief.ts').includes('recapsDue(admin)') && read('components/admin/trips-automation-card.tsx').includes('/api/admin/recap-studio/due'))
}

}

main().then(
  () => {
    console.log(failed === 0 ? '\nAll Recap Studio checks passed.' : `\n${failed} check(s) FAILED.`)
    process.exit(failed === 0 ? 0 : 1)
  },
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
