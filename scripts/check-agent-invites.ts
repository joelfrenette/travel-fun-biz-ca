// Offline checks for the agent submission links and the add-a-trip wizard (growth loop WP13).
// No database, no network, a fake clock. Run: pnpm dlx tsx scripts/check-agent-invites.ts
import {
  generateToken, isTokenFormat, isUuid, clampDays, clampMaxUses, expiryFrom, inviteState, canWorkOnExisting, blockMessage, countInWindow, dailyAllowance, limitMessage,
  isEditableState, canSend, validateStart, validateSource, cleanDraftEdits, agentFieldViews, filledLabels, cleanText, TOKEN_LENGTH, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS,
  MAX_DRAFTS_PER_DAY, MAX_SOURCES_PER_DAY, MAX_TOTAL, MAX_TOTAL_CAP, DAY_MS,
} from '../lib/agent-invites'
import { missingFacts, isPlaceholderName } from '../lib/trip-checklist'
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

  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
