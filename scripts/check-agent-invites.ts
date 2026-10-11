// Offline checks for the agent submission links and the add-a-trip wizard (growth loop WP13).
// No database, no network, a fake clock. Run: pnpm dlx tsx scripts/check-agent-invites.ts
import {
  generateToken, isTokenFormat, isUuid, clampDays, clampMaxUses, expiryFrom, inviteState, canWorkOnExisting, blockMessage, countInWindow, dailyAllowance, limitMessage,
  isEditableState, canSend, validateStart, validateSource, cleanDraftEdits, agentFieldViews, filledLabels, cleanText, TOKEN_LENGTH, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS,
  MAX_DRAFTS_PER_DAY, MAX_SOURCES_PER_DAY, MAX_TOTAL, MAX_TOTAL_CAP, DAY_MS,
} from '../lib/agent-invites'
import { agentWriteBlock, decisionAllowed, isHelperSource, photoRoom, MAX_PHOTOS_PER_DAY, GALLERY_MAX } from '../lib/agent-invites'
import { claimSlot, claimSlots } from '../lib/slots'
import { fetchHtmlSafe } from '../lib/package-extract'
import { prepareImages } from '../lib/screenshot-slices'
import { missingFacts, isPlaceholderName, categoryNotSet } from '../lib/trip-checklist'
import { publicUrlRejection } from '../lib/agent-submissions'
import { gateName, gateTags, publishBlockers } from '../lib/trip-wizard'
import { planIllustrativeCover } from '../lib/package-ingest'

let failures = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}

;(async () => {
  // ─── Tokens ────────────────────────────────────────────────────────────────────
  const t = generateToken()
  check('token is 32 url-safe characters', t.length === TOKEN_LENGTH && /^[A-Za-z0-9_-]{32}$/.test(t), t)
  check('two tokens differ', generateToken() !== generateToken())
  check('token from fixed bytes is stable and 32 long', generateToken(() => Buffer.alloc(24, 255)) === '_'.repeat(32), generateToken(() => Buffer.alloc(24, 255)))
  check('isTokenFormat accepts a real token', isTokenFormat(t))
  check('isTokenFormat rejects short, long, odd characters, non strings', !isTokenFormat('abc') && !isTokenFormat(`${t}x`) && !isTokenFormat(`${t.slice(0, 31)}/`) && !isTokenFormat(`${t.slice(0, 31)}'`) && !isTokenFormat(undefined) && !isTokenFormat(12345) && !isTokenFormat(''))
  check('isUuid', isUuid('123e4567-e89b-12d3-a456-426614174000') && !isUuid('123') && !isUuid("x' or 1=1 --") && !isUuid(null))

  // ─── Expiry, revocation, uses ──────────────────────────────────────────────────
  const now = new Date('2026-10-11T12:00:00Z')
  const inv = { expires_at: '2026-11-10T12:00:00Z', revoked_at: null as string | null, uses: 0, max_uses: MAX_TOTAL }
  check('default expiry is 30 days', DEFAULT_EXPIRY_DAYS === 30 && expiryFrom(now, 30).toISOString() === '2026-11-10T12:00:00.000Z')
  check('expiry days are clamped (0, junk, 500)', clampDays(0) === 30 && clampDays('x') === 30 && clampDays(500) === MAX_EXPIRY_DAYS && clampDays(7) === 7 && clampDays(7.9) === 7)
  check('max uses default 20 and capped at 50', clampMaxUses(undefined) === MAX_TOTAL && clampMaxUses(999) === MAX_TOTAL_CAP && clampMaxUses(5) === 5)
  check('a fresh link is usable', inviteState(inv, now).ok)
  check('expired link is refused', (() => { const s = inviteState({ ...inv, expires_at: '2026-10-11T12:00:00Z' }, now); return !s.ok && s.reason === 'expired' })())
  check('expiry is exclusive at the exact instant, valid one second before', inviteState({ ...inv, expires_at: '2026-10-11T12:00:01Z' }, now).ok)
  check('revoked link is refused, and revoked wins over expired', (() => { const s = inviteState({ ...inv, revoked_at: '2026-10-01T00:00:00Z', expires_at: '2026-01-01T00:00:00Z' }, now); return !s.ok && s.reason === 'revoked' })())
  check('a link at its total cap is refused for NEW trips', (() => { const s = inviteState({ ...inv, uses: 20 }, now); return !s.ok && s.reason === 'used-up' })())
  check('a link below its cap by one is usable', inviteState({ ...inv, uses: 19 }, now).ok)
  check('a used-up link can still work on existing drafts', canWorkOnExisting({ ...inv, uses: 20 }, now).ok)
  check('an expired or revoked link cannot work on existing drafts', !canWorkOnExisting({ ...inv, expires_at: '2020-01-01T00:00:00Z' }, now).ok && !canWorkOnExisting({ ...inv, revoked_at: '2026-10-10T00:00:00Z' }, now).ok)
  check('block messages are plain and never mention internals', ['expired', 'revoked', 'used-up'].every((r) => /Ask Joel/.test(blockMessage(r as 'expired'))))

  // ─── The per-day limiter (fake clock) ──────────────────────────────────────────
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString()
  check('no events: allowed, 5 left', (() => { const a = dailyAllowance([], now, MAX_DRAFTS_PER_DAY); return a.allowed && a.left === 5 && a.nextAt === null })())
  check('4 in the last day: still allowed, 1 left', (() => { const a = dailyAllowance([at(1), at(2), at(3), at(23)], now, MAX_DRAFTS_PER_DAY); return a.allowed && a.left === 1 })())
  check('5 in the last day: refused', !dailyAllowance([at(1), at(2), at(3), at(4), at(5)], now, MAX_DRAFTS_PER_DAY).allowed)
  check('events older than 24h do not count', dailyAllowance([at(25), at(30), at(48), at(100), at(200), at(1)], now, MAX_DRAFTS_PER_DAY).allowed && countInWindow([at(25), at(1), at(23.9)], now) === 2)
  check('exactly 24h ago has left the window', countInWindow([new Date(now.getTime() - DAY_MS)], now) === 0)
  check('future-dated events are ignored', countInWindow([new Date(now.getTime() + 3_600_000)], now) === 0)
  check('nextAt is when the oldest counted event leaves the window', (() => {
    const a = dailyAllowance([at(1), at(2), at(3), at(4), at(20)], now, MAX_DRAFTS_PER_DAY)
    return !a.allowed && a.nextAt?.getTime() === now.getTime() - 20 * 3_600_000 + DAY_MS
  })())
  check('the window rolls: after the oldest leaves, a new one is allowed', dailyAllowance([at(1), at(2), at(3), at(4), at(24.5)], now, MAX_DRAFTS_PER_DAY).allowed)
  check('sources limiter uses 10 a day', MAX_SOURCES_PER_DAY === 10 && !dailyAllowance(Array.from({ length: 10 }, (_, i) => at(i)), now, MAX_SOURCES_PER_DAY).allowed && dailyAllowance(Array.from({ length: 9 }, (_, i) => at(i)), now, MAX_SOURCES_PER_DAY).allowed)
  check('limit messages are plain', /try again after/.test(limitMessage('drafts', new Date('2026-10-12T00:00:00Z'))) && /sources/.test(limitMessage('sources', null)))

  // ─── The draft's life ──────────────────────────────────────────────────────────
  check('in_progress and rejected are editable; submitted and approved are locked', isEditableState('in_progress') && isEditableState('rejected') && !isEditableState('submitted') && !isEditableState('approved'))
  check('canSend needs an unlocked draft and one read source', canSend('in_progress', 1).ok && canSend('rejected', 2).ok && !canSend('in_progress', 0).ok && !canSend('submitted', 3).ok && !canSend('approved', 3).ok)

  // ─── The forms ─────────────────────────────────────────────────────────────────
  check('start needs a name of 3+ letters', !validateStart({ tripName: 'ab' }).ok && validateStart({ tripName: '  Greek Isles  ' }).ok)
  check('start strips control characters and caps length', (() => { const v = validateStart({ tripName: `Trip\u0000\n name ${'x'.repeat(300)}` }); return v.ok && v.value.tripName.length === 120 && !/[\u0000\n]/.test(v.value.tripName) })())
  check('source: one thing at a time', !validateSource({ url: 'https://a.example', text: 'x'.repeat(50) }).ok && !validateSource({ fileCount: 1, text: 'x'.repeat(50) }).ok && !validateSource({}).ok)
  check('source: https link ok, http and junk refused', validateSource({ url: 'https://supplier.example/trip' }).ok && !validateSource({ url: 'http://supplier.example' }).ok && !validateSource({ url: 'javascript:alert(1)' }).ok && !validateSource({ url: 'not a url' }).ok)
  check('source: text needs 40+ letters', !validateSource({ text: 'too short' }).ok && validateSource({ text: 'x'.repeat(40) }).ok)
  check('source: a file set is a file', (() => { const v = validateSource({ fileCount: 3 }); return v.ok && v.value.kind === 'file' })())
  check('cleanText keeps newlines only when asked', cleanText('a\r\nb', 20, true) === 'a\nb' && cleanText('a\nb', 20) === 'a b')

  // The agent may edit only plain text fields
  const e = cleanDraftEdits({ name: 'New Name', destination: 'Athens', short_description: 'A short line.', highlights: 'One\n\nTwo\n', price_includes: 'Breakfast\nTransfers', dates_note: 'June 2027', price_display: '$1', slug: 'hack', status: 'published', supplier: 'x', booking_url: 'https://x.example', featured: true })
  check('edits: only the whitelisted fields get through', e.ok && JSON.stringify(Object.keys(e.value.columns).sort()) === JSON.stringify(['destination', 'highlights', 'name', 'price_includes', 'short_description']) && e.value.datesNote === 'June 2027', e)
  check('edits: highlights are split into clean lines', e.ok && JSON.stringify(e.value.columns.highlights) === '["One","Two"]')
  check('edits: a status or price or slug in the request is ignored, never written', e.ok && !('status' in e.value.columns) && !('price_display' in e.value.columns) && !('slug' in e.value.columns) && !('booking_url' in e.value.columns))
  check('edits: a name under 3 letters is refused', !cleanDraftEdits({ name: 'x' }).ok)
  check('edits: an empty patch is fine and writes nothing', (() => { const r = cleanDraftEdits({}); return r.ok && Object.keys(r.value.columns).length === 0 })())

  // What the agent sees
  const views = agentFieldViews({ name: 'Greek Isles', destination: 'Athens', short_description: '', highlights: ['A', 'B'], price_display: 'From $2,499 CAD', price_value: 2499, image_url: 'https://x.example/a.jpg', gallery_urls: ['u1'], ai_faqs: [{ question: 'q' }], booking_url: 'https://secret.example', max_people: 24 })
  const price = views.find((v) => v.key === 'price_display')
  check('a price shows as found, never its value', !!price && price.filled && price.value === null && price.hidden === true, price)
  check('photos show as found, never their addresses', views.filter((v) => v.key === 'image_url' || v.key === 'gallery_urls').every((v) => v.value === null && v.filled))
  check('non-price values the agent supplied are shown', views.find((v) => v.key === 'destination')?.value === 'Athens' && views.find((v) => v.key === 'highlights')?.value === 'A\nB')
  check('fields outside the agent list never appear (booking link, group size, faqs)', !views.some((v) => ['booking_url', 'max_people', 'ai_faqs', 'price_value'].includes(v.key)))
  check('filledLabels gives unique plain names and drops unknown columns', JSON.stringify(filledLabels(['price_display', 'price_value', 'currency', 'highlights', 'secret_column', 'image_url'])) === '["Price","Highlights","Cover photo"]', filledLabels(['price_display', 'price_value', 'currency', 'highlights', 'secret_column', 'image_url']))

  // ─── Links the agent types ─────────────────────────────────────────────────────
  const pub = async (host: string) => ['93.184.216.34']
  const priv = async () => ['10.0.0.5']
  const mixed = async () => ['93.184.216.34', '127.0.0.1']
  check('public https link passes', (await publicUrlRejection('https://supplier.example/trip', pub)) === null)
  check('http refused', (await publicUrlRejection('http://supplier.example/trip', pub)) !== null)
  check('login in the address refused', (await publicUrlRejection('https://user:pw@supplier.example/', pub)) !== null)
  check('IP literals, localhost and private names refused', (await publicUrlRejection('https://127.0.0.1/', pub)) !== null && (await publicUrlRejection('https://localhost/', pub)) !== null && (await publicUrlRejection('https://169.254.169.254/latest', pub)) !== null && (await publicUrlRejection('https://intranet.local/', pub)) !== null && (await publicUrlRejection('https://[::1]/', pub)) !== null)
  check('a name that resolves to a private address is refused', (await publicUrlRejection('https://evil.example/', priv)) !== null && (await publicUrlRejection('https://evil.example/', mixed)) !== null)
  check('a name that does not resolve is refused', (await publicUrlRejection('https://nope.example/', async () => { throw new Error('ENOTFOUND') })) !== null)

  // ─── The wizard's pure parts ───────────────────────────────────────────────────
  const empty = missingFacts({})
  check('an empty trip lists all 8 missing facts, each with a nudge', empty.length === 8 && empty.every((m) => m.nudge && m.hint), empty.map((m) => m.key))
  const part = missingFacts({ price_display: '$1', available_from: '2027-01-22', duration: '3 nights', max_people: 20, price_includes: 'x', not_included: 'y', itinerary: [{ day: 1, title: 't', description: '' }] })
  check('a filled fact leaves the checklist (booking link is the only one left)', part.length === 1 && part[0].key === 'booking', part.map((m) => m.key))
  check('placeholder names', isPlaceholderName('New trip 2026-10-11') && isPlaceholderName('') && isPlaceholderName(null) && !isPlaceholderName('Greek Isles Cruise'))
  const src = 'Greek Isles Cruise for Singles. 7 nights from Athens, departing June 12, 2027. Island hopping with a small group.'
  check('name gate: title case, grounded name accepted', gateName('greek isles cruise for singles', src).name === 'Greek Isles Cruise for Singles', gateName('greek isles cruise for singles', src))
  check('name gate: a number not in the source refused', gateName('Greek Isles 14 Day Cruise', src).name === null)
  check('name gate: a name not in the source refused', gateName('Luxury Maldives Honeymoon', src).name === null)
  check('tag gate: only source-supported tags, lowercase, unique', JSON.stringify(gateTags(['Island Hopping', 'island hopping', 'safari', 'small group'], src)) === '["island hopping","small group"]', gateTags(['Island Hopping', 'island hopping', 'safari', 'small group'], src))
  check('publish needs name, destination, duration, price (placeholder name does not count)', publishBlockers({ name: 'New trip 2026-10-11', destination: 'Athens', duration: '7 nights', price_display: '$1' }).join() === 'Trip name' && publishBlockers({ name: 'Greek', destination: 'A', duration: 'x', price_display: 'y' }).length === 0 && publishBlockers({}).length === 4)
  const stored = { image_url: 'https://s/a.jpg', image_url_square: 'https://s/b.jpg', image_url_portrait: 'https://s/c.jpg', image_url_banner: 'https://s/d.jpg' }
  const cover = planIllustrativeCover({ image_url: null, image_source: null }, stored, { photographer: 'Ann' }, '2026-10-11T00:00:00Z')
  check('illustrative cover: sets the 4 shapes and image_source pexels, each its own edit with an illustrative credit', cover.edits.length === 5 && cover.updates.image_source === 'pexels' && cover.edits.every((x) => /illustrative/.test(x.credit ?? '')), cover.edits.map((x) => x.field))
  check('illustrative cover: never replaces an existing cover', planIllustrativeCover({ image_url: 'https://x/y.jpg' }, stored, { photographer: 'Ann' }, 'now').edits.length === 0)

  // ─── Fix round 1 ───────────────────────────────────────────────────────────────

  // 1 (S1): nothing an agent sends touches a trip once it is not a draft
  check('S1: agent writes allowed only while the trip is a draft', agentWriteBlock('draft') === null && !!agentWriteBlock('published') && !!agentWriteBlock('archived') && !!agentWriteBlock(undefined) && !!agentWriteBlock(null))
  check('S1: a refused write says Joel already published it', /already published/.test(agentWriteBlock('published') ?? ''))
  check('S1: reject only from submitted or in_progress', decisionAllowed('submitted', 'reject').ok && decisionAllowed('in_progress', 'reject').ok && !decisionAllowed('approved', 'reject').ok && !decisionAllowed('rejected', 'reject').ok)
  check('S1: approve unless already approved', decisionAllowed('submitted', 'approve').ok && decisionAllowed('rejected', 'approve').ok && decisionAllowed('in_progress', 'approve').ok && !decisionAllowed('approved', 'approve').ok)

  // 2 (S2): the agent path follows redirects by hand, every hop checked
  const html = '<html><body>' + 'A trip page with plenty of words. '.repeat(20) + '</body></html>'
  const page = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } })
  const route = (map: Record<string, () => Response>) => (async (u: string) => (map[u] ? map[u]() : new Response('no', { status: 404 }))) as unknown as typeof fetch
  const publicDns = async () => ['93.184.216.34']
  const okFetch = await fetchHtmlSafe('https://a.example/x', { fetch: route({ 'https://a.example/x': () => redirect('https://www.a.example/y'), 'https://www.a.example/y': page }), lookup: publicDns })
  check('S2: a same-site redirect is followed and the final page returned', !!okFetch && okFetch.finalUrl === 'https://www.a.example/y' && okFetch.html.includes('plenty of words'))
  check('S2: a redirect to http is refused', (await fetchHtmlSafe('https://a.example/x', { fetch: route({ 'https://a.example/x': () => redirect('http://a.example/y'), 'http://a.example/y': page }), lookup: publicDns })) === null)
  check('S2: a redirect to a private or metadata address is refused', (await fetchHtmlSafe('https://a.example/x', { fetch: route({ 'https://a.example/x': () => redirect('https://169.254.169.254/latest/meta-data'), 'https://169.254.169.254/latest/meta-data': page }), lookup: publicDns })) === null && (await fetchHtmlSafe('https://a.example/x', { fetch: route({ 'https://a.example/x': () => redirect('https://localhost/'), 'https://localhost/': page }), lookup: publicDns })) === null)
  check('S2: a redirect to another website is refused', (await fetchHtmlSafe('https://a.example/x', { fetch: route({ 'https://a.example/x': () => redirect('https://other.example/y'), 'https://other.example/y': page }), lookup: publicDns })) === null)
  let hops = 0
  const looping = (async (u: string) => (hops++, redirect(`https://a.example/${hops}`))) as unknown as typeof fetch
  check('S2: more than 3 redirects are refused', (await fetchHtmlSafe('https://a.example/0', { fetch: looping, lookup: publicDns })) === null && hops <= 4, hops)
  check('S2: a hop whose name resolves to a private address is refused (DNS checked per hop)', (await fetchHtmlSafe('https://a.example/x', { fetch: route({ 'https://a.example/x': () => redirect('https://www.a.example/y'), 'https://www.a.example/y': page }), lookup: async (h) => (h.startsWith('www.') ? ['10.1.2.3'] : ['93.184.216.34']) })) === null)
  check('S2: a first hop that is private is refused without any request', (await (async () => { let called = false; const r = await fetchHtmlSafe('https://a.example/x', { fetch: (async () => { called = true; return page() }) as unknown as typeof fetch, lookup: async () => ['127.0.0.1'] }); return r === null && !called })()))
  check('S2: a non-HTML answer is refused', (await fetchHtmlSafe('https://a.example/x', { fetch: route({ 'https://a.example/x': () => new Response('x', { status: 200, headers: { 'content-type': 'application/pdf' } }) }), lookup: publicDns })) === null)

  // 3 and 4 (S2): atomic daily slots, taken before the model call
  const keys = new Set<string>()
  const fakeAdmin = { from: () => ({ insert: async (row: { key: string }) => (keys.has(row.key) ? { error: { message: 'duplicate key' } } : (keys.add(row.key), { error: null })) }) } as never
  const results = await Promise.all(Array.from({ length: 20 }, () => claimSlot(fakeAdmin, 'trip_improve:abc', 12, now)))
  check('S2 improve: 20 parallel claims get exactly 12 slots', results.filter(Boolean).length === 12, results.filter(Boolean).length)
  check('S2 improve: the 13th claim is refused', !(await claimSlot(fakeAdmin, 'trip_improve:abc', 12, now)))
  check('S2 improve: slot keys are trip_improve:<id>:<day>:<n>', keys.has('trip_improve:abc:2026-10-11:1') && keys.has('trip_improve:abc:2026-10-11:12') && !keys.has('trip_improve:abc:2026-10-11:13'))
  const completes = await Promise.all(Array.from({ length: 6 }, () => claimSlot(fakeAdmin, 'trip_complete:abc', 3, now)))
  check('S2 complete: 6 parallel claims get exactly 3 slots', completes.filter(Boolean).length === 3)
  check('S2: another trip and the next day have their own slots', (await claimSlot(fakeAdmin, 'trip_complete:other', 3, now)) && (await claimSlot(fakeAdmin, 'trip_complete:abc', 3, new Date(now.getTime() + DAY_MS))))
  check('S2: a database that cannot be written never lets the work through', !(await claimSlot({ from: () => ({ insert: async () => ({ error: { message: 'down' } }) }) } as never, 'x', 3, now)))
  check('S2 photos: claimSlots returns how many it could take (20 a day per link)', (await claimSlots(fakeAdmin, 'agent_photo:l1', 15, MAX_PHOTOS_PER_DAY, now)) === 15 && (await claimSlots(fakeAdmin, 'agent_photo:l1', 15, MAX_PHOTOS_PER_DAY, now)) === 5 && (await claimSlots(fakeAdmin, 'agent_photo:l1', 1, MAX_PHOTOS_PER_DAY, now)) === 0)

  // 5 (S2): photos are refused before any upload when the gallery is full, and only those that fit are counted
  check('S2 photos: a full gallery (12) has room for none', photoRoom(GALLERY_MAX, 3) === 0 && photoRoom(15, 3) === 0)
  check('S2 photos: only the files that fit are counted (10 held, 5 sent -> 2)', photoRoom(10, 5) === 2 && photoRoom(0, 9) === 6 && photoRoom(5, 0) === 0 && photoRoom(0, 1) === 1)

  // 6: the screenshot set limits
  const sharp = (await import('sharp')).default
  const huge = await sharp({ create: { width: 600, height: 55000, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer()
  const overStrips = await prepareImages([{ buffer: huge, mediaType: 'image/png' }])
  check('limits: more than 40 strips is refused with "split into smaller screenshots", nothing returned to send', !!overStrips.error && /smaller screenshots/.test(overStrips.error) && overStrips.images.length === 0, overStrips.error)
  const overBytes = await prepareImages([{ buffer: Buffer.alloc(21 * 1024 * 1024), mediaType: 'image/png' }])
  check('limits: more than 20 MB of pictures is refused before any work', !!overBytes.error && overBytes.images.length === 0)
  const fine = await prepareImages([{ buffer: await sharp({ create: { width: 600, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer(), mediaType: 'image/png' }])
  check('limits: a normal tall screenshot still passes', !fine.error && fine.images.length === 3)

  // 7: the table's default category on a stub is "not set yet"
  check('category: empty, and Adventure on an empty draft stub, count as not set', categoryNotSet({ category: '' }) && categoryNotSet({ category: null }) && categoryNotSet({ category: 'Adventure', status: 'draft' }))
  check('category: Adventure with real text, or published, or another category, is set', !categoryNotSet({ category: 'Adventure', status: 'draft', short_description: 'A line' }) && !categoryNotSet({ category: 'Adventure', status: 'published' }) && !categoryNotSet({ category: 'Cruise', status: 'draft' }))
  check('category: a named stub still on Adventure shows "Kind of trip" in Still missing', missingFacts({ name: 'Greek Isles', category: 'Adventure', status: 'draft' }).some((m) => m.key === 'category') && !missingFacts({ name: 'Greek Isles', category: 'Cruise', status: 'draft' }).some((m) => m.key === 'category'))

  // 8: helper rows do not count against the agent
  check('helpers: automatic FAQs, own photos and the recap log are not the agent\'s sources', isHelperSource('Automatic FAQs (written from the trip description)') && isHelperSource('Photos added in the add-a-trip wizard') && isHelperSource('Recap log') && !isHelperSource('menu.pdf') && !isHelperSource(null) && !isHelperSource(undefined))

  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
