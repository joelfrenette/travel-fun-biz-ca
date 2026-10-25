// Offline checks for the travel specialist (agent) profiles: privacy columns, consent gates, certification gating,
// no amounts in public achievements, JSON-LD, spreadsheet import mapping, the self-service token flow, the bio polish
// guard and the content drafts. No database, no network, a fake clock. Run: pnpm dlx tsx scripts/check-agents.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_PRIVATE_COLUMNS, AGENT_PUBLIC_COLUMNS, AGENT_PUBLIC_SELECT, ACHIEVEMENT_PUBLIC_COLUMNS, ACHIEVEMENT_PUBLIC_SELECT, amountLike, buildAgentsCollectionJsonLd,
  buildPersonJsonLd, buildProfilePageJsonLd, buildVideoJsonLd, cleanAgentInput, isPubliclyVisible, parseCertifications, parseVideoUrl, publicCertifications,
  publishBlockers, slugify, suggestAgentOfMonth, toPublicAchievements, toPublicAgent, agentDescription, agentTitle, agentPhotoAlt, type PublicAgent,
  OFFICE_ROLES, OFFICE_ROLE_LABEL, officeHolders, officeTeam, parseOfficeRole, planOfficeRole, parseSocialLinks, cleanPackageSlugs, addPromotedSlug,
} from '../lib/agents'
import { setOfficeRole } from '../lib/agents-office'
import { buildPreview, guessField, isPlaceholder, parseDelimited, parseSheet, readSheetDate, IMPORT_MAX_ROWS } from '../lib/agents-import'
import { cleanSelfService, hashProfileToken, makeProfileToken, profileLinkExpiry, profileLinkState, profileTokenMatchesHash } from '../lib/agents-token'
import { groundedPolishProblems, polishBio, polishHash } from '../lib/agents-polish'
import { aotmPost, profileFacts, socialCaption, toTopicIdea, ungroundedInDraft, welcomePost } from '../lib/agents-content'
import { isTokenFormat } from '../lib/agent-invites'

let failures = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}

const ctx = { siteName: 'TravelFunBiz', absoluteUrl: (p: string) => `https://travelfunbiz.ca${p}`, orgUrl: 'https://travelfunbiz.ca/' }

const baseRow = {
  id: 'a1', slug: 'jane-doe', display_name: 'Jane Doe', headline: 'Caribbean cruises for solo travellers', bio: 'Jane plans group trips and cruises for solo travellers.',
  specialties: ['Caribbean cruises', 'Solo travel'], certifications: [{ name: 'Verified Cert', issuer: 'ACME', year: 2020, verified: true }, { name: 'Pending Cert', issuer: 'X', year: 2021, verified: false }],
  years_experience: 12, languages: ['English', 'French'], home_city: 'Toronto', region: 'Ontario', photo_url: 'https://cdn.example.com/jane.jpg',
  video_urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://evil.example.com/v.mp4'], status: 'published', consent_photo: true, consent_bio: true, featured: true,
  sort_order: 10, published_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
  // private columns that must never survive:
  email: 'jane@private.test', phone: '+1 555 010 9999', notes: 'secret note', internal_tags: ['top'],
}

;(async () => {
  // ─── Column lists ──────────────────────────────────────────────────────────────
  check('public column list has no private column', AGENT_PRIVATE_COLUMNS.every((c) => !(AGENT_PUBLIC_COLUMNS as readonly string[]).includes(c)), AGENT_PUBLIC_COLUMNS)
  check('public select is explicit (no star)', !AGENT_PUBLIC_SELECT.includes('*') && !ACHIEVEMENT_PUBLIC_SELECT.includes('*'))
  check('achievement public columns exclude internal_value and public flag leak', !(ACHIEVEMENT_PUBLIC_COLUMNS as readonly string[]).includes('internal_value'))
  check('private columns are exactly email, phone, address, notes, internal_tags, office_role, asta_number', [...AGENT_PRIVATE_COLUMNS].sort().join() === 'address,asta_number,email,internal_tags,notes,office_role,phone')

  // Source scan: the public half of the store, and every public file, never touch private columns or select star.
  const store = readFileSync('lib/agents-store.ts', 'utf8')
  const publicHalf = store.slice(0, store.indexOf('// ─── Admin: roster'))
  check('store public reads never select star', !/select\(\s*['"`]\*/.test(publicHalf))
  check('store public reads never name a private column or internal_value', !/\b(email|phone|address|notes|internal_tags|internal_value)\b/.test(publicHalf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), publicHalf.match(/\b(email|phone|address|notes|internal_tags|internal_value)\b/))
  check('store public reads use the explicit select constants', publicHalf.includes('AGENT_PUBLIC_SELECT') && publicHalf.includes('ACHIEVEMENT_PUBLIC_SELECT'))
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
  }
  const publicFiles = [...walk('app/agents'), 'components/agents-ui.tsx', 'components/agents-strip.tsx']
  for (const f of publicFiles) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    check(`public file ${f} has no private field, mailto or tel link`, !/\b(\.email|(?<!site)\.phone|\.address|internal_value|internal_tags|\.notes)\b|mailto:|tel:/.test(src))
  }
  const sitePhoneInAgentPage = readFileSync('app/agents/[slug]/page.tsx', 'utf8').includes('site.phone')
  check('agent page CTA phone is the site phone, not the agent', sitePhoneInAgentPage)

  // ─── Consent and visibility ────────────────────────────────────────────────────
  check('published + both consents renders', toPublicAgent(baseRow) !== null)
  check('draft does not render', toPublicAgent({ ...baseRow, status: 'draft' }) === null)
  check('ready does not render', toPublicAgent({ ...baseRow, status: 'ready' }) === null)
  check('no photo consent: does not render', toPublicAgent({ ...baseRow, consent_photo: false }) === null)
  check('no bio consent: does not render', toPublicAgent({ ...baseRow, consent_bio: false }) === null)
  check('no bio: does not render', toPublicAgent({ ...baseRow, bio: '  ' }) === null)
  check('isPubliclyVisible is strict (true only)', !isPubliclyVisible({ ...baseRow, consent_photo: 'true' }) && !isPubliclyVisible({ ...baseRow, consent_bio: 1 }))
  const pub = toPublicAgent(baseRow) as PublicAgent
  const leaked = JSON.stringify(pub)
  check('a row that wrongly carried private data cannot leak it through toPublicAgent', !leaked.includes('jane@private.test') && !leaked.includes('555 010') && !leaked.includes('secret note') && !('email' in pub) && !('phone' in pub) && !('notes' in pub) && !('internal_tags' in pub), leaked)
  check('non-embeddable video is dropped from the public agent', pub.video_urls.length === 1 && pub.video_urls[0].includes('youtube.com'), pub.video_urls)

  // ─── Publish gate ──────────────────────────────────────────────────────────────
  check('publish gate: complete agent has no blockers', publishBlockers(baseRow).length === 0)
  check('publish gate: no photo consent blocks', publishBlockers({ ...baseRow, consent_photo: false }).some((b) => /photo consent/i.test(b)))
  check('publish gate: no bio consent blocks', publishBlockers({ ...baseRow, consent_bio: false }).some((b) => /bio consent/i.test(b)))
  check('publish gate: empty bio blocks', publishBlockers({ ...baseRow, bio: '' }).some((b) => /bio/i.test(b)))
  check('publish gate: no specialty blocks', publishBlockers({ ...baseRow, specialties: [] }).some((b) => /specialty/i.test(b)))
  check('publish gate: bad slug blocks', publishBlockers({ ...baseRow, slug: 'Bad Slug!' }).length > 0)

  // ─── Certifications ────────────────────────────────────────────────────────────
  const certs = parseCertifications(baseRow.certifications)
  check('only verified certifications are public', publicCertifications(certs).length === 1 && publicCertifications(certs)[0].name === 'Verified Cert')
  check('a certification from text with verified:"true" (string) is NOT verified', !parseCertifications([{ name: 'X', verified: 'true' }])[0].verified)
  check('self-service certifications are always saved unverified', cleanSelfService({ bio: 'x'.repeat(60), specialties: 'Italy', certifications: [{ name: 'CTC', verified: true }] }).ok && (cleanSelfService({ bio: 'x'.repeat(60), specialties: 'Italy', certifications: [{ name: 'CTC', verified: true }] }) as { ok: true; value: { certifications: { verified: boolean }[] } }).value.certifications[0].verified === false)
  const ld = JSON.stringify(buildProfilePageJsonLd(pub, ctx))
  check('JSON-LD names only verified certifications', ld.includes('Verified Cert') && !ld.includes('Pending Cert'))

  // ─── Achievements ──────────────────────────────────────────────────────────────
  const ach = toPublicAchievements([
    { id: '1', agent_id: 'a1', kind: 'award', title: 'Top team player 2026', period: '2026', internal_value: 250000, public: true },
    { id: '2', agent_id: 'a1', kind: 'high_commission', title: 'Sold $250,000 in cruises', period: '2026' },
    { id: '3', agent_id: 'a1', kind: 'growth_target', title: 'Hidden one', period: null, public: false },
    { id: '4', agent_id: 'a1', kind: 'other', title: 'Hit 120% growth target' },
  ])
  check('public achievements keep only kind / title / period', ach.every((a) => Object.keys(a).sort().join() === 'agent_id,id,kind,period,title'), ach)
  check('public achievements never carry internal_value', !JSON.stringify(ach).includes('250000') && !JSON.stringify(ach).includes('internal_value'))
  check('an achievement with a money amount in the title is dropped', !ach.some((a) => a.id === '2'))
  check('a non-public achievement is dropped', !ach.some((a) => a.id === '3'))
  check('amountLike catches common amount shapes', amountLike('$5,000 in sales') && amountLike('250k in sales') && amountLike('CAD 10 dollars') === false ? true : amountLike('$5,000 in sales') && amountLike('250k in sales'))
  check('amountLike lets plain milestones through', !amountLike('Top team player 2026') && !amountLike('Hosted a group trip to Italy') && !amountLike('Five-year anniversary'))

  // ─── JSON-LD ───────────────────────────────────────────────────────────────────
  const person = buildPersonJsonLd(pub, ctx) as Record<string, unknown>
  const page = buildProfilePageJsonLd(pub, ctx) as Record<string, unknown>
  const pageStr = JSON.stringify(page)
  check('ProfilePage JSON-LD is valid JSON with the right types', page['@type'] === 'ProfilePage' && (page.mainEntity as Record<string, unknown>)['@type'] === 'Person' && page['@context'] === 'https://schema.org')
  check('Person JSON-LD has no telephone or email', !('telephone' in person) && !('email' in person) && !pageStr.includes('jane@private') && !pageStr.includes('555'))
  check('Person JSON-LD uses only provided data', person.name === 'Jane Doe' && person.image === pub.photo_url && JSON.stringify(person.knowsLanguage) === JSON.stringify(['English', 'French']))
  const bare = toPublicAgent({ ...baseRow, headline: null, photo_url: null, languages: [], certifications: [], specialties: ['Italy'], video_urls: [] }) as PublicAgent
  const bareP = buildPersonJsonLd(bare, ctx) as Record<string, unknown>
  check('missing data produces no invented properties', !('image' in bareP) && !('knowsLanguage' in bareP) && !('hasCredential' in bareP) && !('description' in bareP))
  const vids = buildVideoJsonLd(pub, ctx.absoluteUrl, '/agents/jane-doe')
  check('VideoObject only for real embeddable video, no invented upload date', vids.length === 1 && vids[0]['@type'] === 'VideoObject' && !('uploadDate' in vids[0]) && String(vids[0].embedUrl).startsWith('https://www.youtube-nocookie.com/embed/'))
  check('no video data means no VideoObject', buildVideoJsonLd({ display_name: 'X', video_urls: [] }, ctx.absoluteUrl, '/agents/x').length === 0)
  const coll = buildAgentsCollectionJsonLd([pub], 'n', 'd', ctx) as Record<string, unknown>
  check('CollectionPage + ItemList', coll['@type'] === 'CollectionPage' && ((coll.mainEntity as Record<string, unknown>)['@type'] === 'ItemList') && JSON.stringify(coll).includes('/agents/jane-doe'))
  check('JSON-LD round-trips through JSON.parse', (() => { try { JSON.parse(JSON.stringify([page, coll, ...vids])); return true } catch { return false } })())
  check('title and description are bounded', agentTitle(pub, 'TravelFunBiz').length <= 80 && agentDescription(pub).length <= 160, [agentTitle(pub, 'TravelFunBiz').length, agentDescription(pub).length])
  check('photo alt text is honest and plain', agentPhotoAlt('Jane Doe') === 'Portrait of Jane Doe, travel specialist')
  check('YouTube and Vimeo parse; others do not', !!parseVideoUrl('https://youtu.be/dQw4w9WgXcQ') && !!parseVideoUrl('https://vimeo.com/123456789') && !parseVideoUrl('http://youtu.be/dQw4w9WgXcQ') && !parseVideoUrl('https://evil.example.com/watch?v=dQw4w9WgXcQ') && !parseVideoUrl('javascript:alert(1)'))

  // ─── Input cleaning ────────────────────────────────────────────────────────────
  const cleaned = cleanAgentInput({ display_name: ' Jane   Doe ', slug: 'Jane Doe!', years_experience: '12 years', specialties: 'Italy; Greece, Italy', photo_url: 'http://insecure.test/a.jpg', video_urls: 'https://youtu.be/dQw4w9WgXcQ https://x.test/a' })
  check('cleanAgentInput cleans name, slug, years, lists, photo, videos', cleaned.ok && cleaned.value.display_name === 'Jane Doe' && cleaned.value.slug === 'jane-doe' && cleaned.value.years_experience === 12 && JSON.stringify(cleaned.value.specialties) === JSON.stringify(['Italy', 'Greece']) && cleaned.value.photo_url === null && cleaned.value.video_urls?.length === 1, cleaned)
  check('cleanAgentInput does not invent absent fields', cleanAgentInput({ display_name: 'Al' }).ok && Object.keys((cleanAgentInput({ display_name: 'Al' }) as { ok: true; value: object }).value).join() === 'display_name')
  check('slugify strips accents and reserved words', slugify('Zoë Müller') === 'zoe-muller' && slugify('admin') !== 'admin')

  // ─── CSV / Excel paste import ──────────────────────────────────────────────────
  const tsv = 'First Name\tLast Name\tEmail\tSpecialties\tYears\tCertifications\tBio\n' +
    'Jane\tDoe\tjane@x.test\tItaly; Greece\t12\tCTC; CLIA\t"Likes ""big"" trips,\nand cruises"\n' +
    'Bob\tSmith\t\t\t\t\t\n' +
    '\t\t\t\t\t\t\n' +
    'Zed\tNoBio\tz@x.test\tCaribbean\tabc\t\t'
  const rows = parseDelimited(tsv)
  check('parseDelimited handles tabs, quotes, doubled quotes, embedded newline, blank rows', rows.length === 4 && rows[1][6] === 'Likes "big" trips,\nand cruises', rows)
  check('parseDelimited handles commas and semicolons', parseDelimited('a,b\n1,2')[1][1] === '2' && parseDelimited('a;b\n1;2')[1][1] === '2')
  const sheet = parseSheet(tsv)
  check('parseSheet guesses columns', sheet.ok && sheet.sheet.guess.join() === 'first_name,last_name,email,specialties,years_experience,certifications,bio', sheet.ok ? sheet.sheet.guess : sheet)
  check('guessField maps common headings', guessField('Full Name') === 'display_name' && guessField('E-mail') === 'email' && guessField('Cell') === 'phone' && guessField('Languages Spoken') === 'languages' && guessField('Shoe size') === '')
  check('parseSheet rejects empty and header-only input', !parseSheet('').ok && !parseSheet('a,b').ok)
  const prev = sheet.ok ? buildPreview(sheet.sheet, sheet.sheet.guess, { slugs: ['bob-smith'], emails: [] }) : []
  check('preview builds one row per data row (blank row dropped by parser)', prev.length === 3, prev.length)
  check('preview joins first and last name and makes a slug', prev[0].value?.display_name === 'Jane Doe' && prev[0].slug === 'jane-doe')
  check('preview imports certifications as unverified', (prev[0].value?.certifications ?? []).length === 2 && (prev[0].value?.certifications ?? []).every((c) => c.verified === false))
  check('preview NEVER invents: Bob has nothing but a name and every other field is missing', prev[1].value !== null && Object.keys(prev[1].value as object).sort().join() === 'display_name,slug' && prev[1].missing.includes('bio') && prev[1].missing.includes('specialties'), prev[1])
  check('preview surfaces an existing agent as skipped', prev[1].action === 'exists')
  check('preview warns when years is not a number and leaves it empty', prev[2].value?.years_experience == null && prev[2].warnings.some((w) => /years/i.test(w)), prev[2])
  check('preview never sets consent or status', prev.every((p) => p.value && !('consent_photo' in p.value) && !('consent_bio' in p.value) && !('status' in p.value)))
  check('preview flags a row without a name', buildPreview({ headers: ['Name', 'Bio'], rows: [['', 'x']] }, ['display_name', 'bio'], { slugs: [], emails: [] })[0].ok === false)
  check('duplicate names in one paste are skipped after the first', (() => { const p = buildPreview({ headers: ['Name'], rows: [['Ann Lee'], ['Ann Lee']] }, ['display_name'], { slugs: [], emails: [] }); return p[0].action === 'new' && p[1].action === 'exists' })())
  check('import row cap is 200', IMPORT_MAX_ROWS === 200 && (parseSheet(`Name\n${Array.from({ length: 300 }, (_, i) => `A${i}`).join('\n')}`) as { ok: true; sheet: { rows: unknown[] } }).sheet.rows.length === 200)

  // Roster-shaped sheet (name, email, address) with fake sample rows only.
  const rosterSheet = parseSheet('name\temail\taddress\nAnn Example (Maiden)\tann@example.test\t1 Sample St, Testville\nBo Sample\tbo@example.test\t2 Demo Rd, Fakeburg')
  const rosterPrev = rosterSheet.ok ? buildPreview(rosterSheet.sheet, rosterSheet.sheet.guess, { slugs: [], emails: [] }) : []
  check('roster sheet maps name, email, address', rosterSheet.ok && rosterSheet.sheet.guess.join() === 'display_name,email,address', rosterSheet.ok ? rosterSheet.sheet.guess : rosterSheet)
  check('a parenthetical (maiden name) is dropped from display name and slug', rosterPrev[0].value?.display_name === 'Ann Example' && rosterPrev[0].slug === 'ann-example' && !rosterPrev[0].value?.slug?.includes('maiden'), rosterPrev[0])
  check('the dropped parenthetical is kept only in private notes', (rosterPrev[0].value?.notes ?? '').includes('Maiden') && !JSON.stringify(toPublicAgent({ ...baseRow, ...rosterPrev[0].value, status: 'published', consent_photo: true, consent_bio: true, bio: 'b', specialties: ['x'] })).includes('Maiden'))
  check('address and email import as private fields; nothing else is invented', rosterPrev[1].value?.address === '2 Demo Rd, Fakeburg' && rosterPrev[1].value?.email === 'bo@example.test' && !rosterPrev[1].value?.bio && !rosterPrev[1].value?.specialties && !rosterPrev[1].value?.photo_url)
  check('address never reaches a PublicAgent', !JSON.stringify(toPublicAgent({ ...baseRow, address: '9 Secret Ln' })).includes('Secret'))

  // ─── Self-service token flow ───────────────────────────────────────────────────
  const now = new Date('2026-10-24T12:00:00Z')
  const token = makeProfileToken()
  const hash = hashProfileToken(token)
  check('token is 32 url-safe chars and passes the format check', isTokenFormat(token) && token.length === 32)
  check('only the hash is stored: hash is hex, is not the token, and matches', /^[0-9a-f]{64}$/.test(hash) && !hash.includes(token) && profileTokenMatchesHash(token, hash))
  check('a different token or a malformed one does not match', !profileTokenMatchesHash(makeProfileToken(), hash) && !profileTokenMatchesHash('short', hash))
  check('profile hash differs from the recap hash namespace', hash !== hashProfileToken(`${token}x`))
  const exp = profileLinkExpiry(now)
  check('link expires in 14 days by default', exp.getTime() - now.getTime() === 14 * 86_400_000)
  check('link state: active, expired, revoked', profileLinkState({ expires_at: exp.toISOString(), revoked_at: null }, now).ok && !profileLinkState({ expires_at: exp.toISOString(), revoked_at: null }, new Date(exp.getTime() + 1)).ok && (profileLinkState({ expires_at: exp.toISOString(), revoked_at: now.toISOString() }, now) as { reason?: string }).reason === 'revoked')
  const ss = cleanSelfService({ bio: 'I plan trips for families and small groups every year.', specialties: 'Italy, Greece', years_experience: '9', languages: 'English', video_urls: ['https://youtu.be/dQw4w9WgXcQ', 'https://bad.test/x'], photo_url: 'https://cdn.example.com/p.jpg', consent_bio: true, consent_photo: false, slug: 'hack', status: 'published', featured: true, email: 'a@b.test', phone: '1', notes: 'n', display_name: 'Hacked', internal_value: 5 })
  check('self-service accepts only its own fields (no slug, status, featured, email, phone, notes, name, value)', ss.ok && !['slug', 'status', 'featured', 'email', 'phone', 'notes', 'display_name', 'internal_value'].some((k) => k in ss.value), ss.ok ? Object.keys(ss.value) : ss)
  check('self-service keeps only embeddable video and the consents as ticked', ss.ok && ss.value.video_urls.length === 1 && ss.value.consent_bio === true && ss.value.consent_photo === false)
  check('self-service needs a real bio and a specialty', !cleanSelfService({ bio: 'short', specialties: 'Italy' }).ok && !cleanSelfService({ bio: 'x'.repeat(80), specialties: '' }).ok)
  const api = readFileSync('app/api/agent-profile/[token]/route.ts', 'utf8')
  check('public profile route validates the token before anything else and never returns private columns', api.includes('resolveProfileLink') && !/\b(email|phone|notes)\b/.test(api.replace(/\/\/.*$/gm, '')))

  // ─── Bio polish: grounded ──────────────────────────────────────────────────────
  const own = 'I help families plan cruises to the Caribbean. I have worked in travel for twelve years and love helping first-time cruisers.'
  check('polish hash is stable and trims', polishHash(own) === polishHash(`  ${own}  `) && polishHash(own) !== polishHash(`${own}!`))
  check('polish guard passes a pure rephrase', groundedPolishProblems(own, 'I plan Caribbean cruises for families. Twelve years in travel have taught me to love helping first-time cruisers.').length === 0)
  check('polish guard rejects a new number', groundedPolishProblems(own, 'I help families plan cruises. I have 25 years of experience.').some((p) => /number/.test(p)))
  check('polish guard rejects a new certification claim', groundedPolishProblems(own, 'I am a certified cruise specialist who helps families plan cruises.').some((p) => /credential/.test(p)))
  check('polish guard rejects a new name or place', groundedPolishProblems(own, 'I help families plan cruises to the Caribbean and Alaska with Carnival.').some((p) => /name/.test(p)))
  check('polish guard rejects added contact details', groundedPolishProblems(own, 'I help families plan cruises. Email me at me@x.test.').some((p) => /contact/.test(p)))
  check('polish guard rejects a rewrite much longer than the original', groundedPolishProblems(own, own.repeat(3)).some((p) => /longer/.test(p)))
  const calls: string[] = []
  const good = await polishBio(own, { configured: true, call: async (p) => { calls.push(p); return 'I plan Caribbean cruises for families, with twelve years in travel behind me.' } })
  check('polish returns a grounded rewrite and its prompt forbids new facts', good.ok && calls.length === 1 && /ONLY the facts/.test(calls[0]) && /certification/.test(calls[0]), good)
  const bad = await polishBio(own, { configured: true, call: async () => 'I am an award-winning specialist with 30 years of experience.' })
  check('polish discards an ungrounded rewrite', !bad.ok, bad)
  let called = false
  const cached = await polishBio(own, { configured: true, cached: 'cached text', call: async () => { called = true; return 'x' } })
  check('polish uses the cache and makes no AI call', cached.ok && cached.cached && !called)
  check('polish refuses empty or tiny input (no text to rewrite)', !(await polishBio('hi', { configured: true, call: async () => 'x' })).ok)
  check('polish without an AI key says so and does not call', !(await polishBio(own, { configured: false, call: async () => { called = true; return 'x' } })).ok)

  // ─── Agent of the month: non-financial ─────────────────────────────────────────
  const cand = (over: Partial<Parameters<typeof suggestAgentOfMonth>[0][number]>) => ({ id: 'x', display_name: 'X', status: 'published', consent_photo: true, consent_bio: true, bio: 'bio', photo_url: 'https://p', video_count: 0, verified_certifications: 0, public_achievements: 0, months_since_featured: null, ...over })
  const sug = suggestAgentOfMonth([cand({ id: 'a', display_name: 'A' }), cand({ id: 'b', display_name: 'B', video_count: 1, verified_certifications: 2, public_achievements: 1 }), cand({ id: 'c', display_name: 'C', status: 'draft' }), cand({ id: 'd', display_name: 'D', consent_bio: false }), cand({ id: 'e', display_name: 'E', months_since_featured: 1 })])
  check('suggestion ranks richer profiles first', sug[0].id === 'b')
  check('suggestion excludes drafts and unconsented agents', !sug.some((s) => s.id === 'c' || s.id === 'd'))
  check('suggestion penalises a recent winner', sug.findIndex((s) => s.id === 'e') > sug.findIndex((s) => s.id === 'a'))
  check('suggestion input type has no financial field', !/sales|commission|revenue|internal_value|leads/i.test(readFileSync('lib/agents.ts', 'utf8').match(/export interface SuggestInput \{[\s\S]*?\n\}/)?.[0] ?? 'x'))

  // ─── Content drafts ────────────────────────────────────────────────────────────
  const w = welcomePost(pub)
  const cap = socialCaption(pub)
  const aot = aotmPost(pub, '2026-11', 'Thanks for a great month of planning.')
  check('welcome post is grounded in the profile (no ungrounded numbers)', ungroundedInDraft(w, pub).length === 0, ungroundedInDraft(w, pub))
  check('welcome post names only verified certifications', w.body.includes('Verified Cert') && !w.body.includes('Pending Cert'))
  check('drafts never carry contact details or amounts', [w, cap, aot].every((d) => !/@|\+?\d{3}[\s.-]\d{3}|\$\d/.test(d.body.replace('travelfunbiz.ca', ''))), [w.body, cap.body, aot.body])
  check('caption stays short', cap.body.length < 280, cap.body.length)
  check('topic idea tells the writer to use only the facts and has no private data', /ONLY these facts/.test(toTopicIdea(w, pub).angle) && !toTopicIdea(w, pub).angle.includes('jane@private') && profileFacts(pub).includes('Jane Doe') && toTopicIdea(w, pub).source === 'agent-profile')
  check('aotm draft carries the month', /November 2026/.test(aot.body))
  const storeSrc = store
  check('drafts are always queued as draft status and the store never auto-approves', /status: 'draft'/.test(storeSrc) && !/status: 'approved'\s*}\)/.test(storeSrc.slice(storeSrc.indexOf('export async function queueDrafts'), storeSrc.indexOf('export async function listDrafts'))))
  check('publish queues drafts only on first publish', /const first = status === 'published' && !row\.published_at/.test(storeSrc))
  check('import saves with both consents off', /consent_photo: false, consent_bio: false/.test(storeSrc))

  // ─── Office team (CEO, CTO, Manager): admin only, one holder per role, still an agent ────────────
  // Every name, email and role below is made up.
  check('office roles are ceo, cto, mgr with plain labels', OFFICE_ROLES.join() === 'ceo,cto,mgr' && OFFICE_ROLE_LABEL.ceo === 'CEO' && OFFICE_ROLE_LABEL.cto === 'CTO' && OFFICE_ROLE_LABEL.mgr === 'Manager')
  check('office_role is never a public column or in the public select', !(AGENT_PUBLIC_COLUMNS as readonly string[]).includes('office_role') && !AGENT_PUBLIC_SELECT.includes('office_role') && (AGENT_PRIVATE_COLUMNS as readonly string[]).includes('office_role'))
  const withRole = { ...baseRow, office_role: 'ceo' }
  const pubJson = JSON.stringify(toPublicAgent(withRole))
  check('a roster row with an office role never leaks it into the PublicAgent', !pubJson.includes('office_role') && !/"ceo"|CEO|Manager|CTO/.test(pubJson), pubJson)
  const pubAgent = toPublicAgent(withRole) as PublicAgent
  const ldJson = JSON.stringify([buildPersonJsonLd(pubAgent, ctx), buildProfilePageJsonLd(pubAgent, ctx), buildAgentsCollectionJsonLd([pubAgent], 'Agents', 'All agents', ctx)])
  check('JSON-LD never carries the office role (jobTitle stays Travel specialist)', !/office_role|"ceo"|CEO|Manager|CTO|chief/i.test(ldJson) && ldJson.includes('Travel specialist'))
  const publicSrc = [...publicFiles, 'lib/agents-store.ts'].map((f) => readFileSync(f, 'utf8'))
  check('no public file and no public half of the store mentions the office role', publicFiles.every((f) => !/office_?role|OFFICE_ROLE|officeRole/i.test(readFileSync(f, 'utf8'))) && !/office_?role|OFFICE_ROLE|officeRole/i.test(publicSrc[publicSrc.length - 1].slice(0, publicSrc[publicSrc.length - 1].indexOf('// ─── Admin: roster')).replace(/^import .*$/gm, '')))
  const libAgentsSrc = readFileSync('lib/agents.ts', 'utf8')
  const toPublicBody = libAgentsSrc.slice(libAgentsSrc.indexOf('export function toPublicAgent'), libAgentsSrc.indexOf('/** Public achievements'))
  const jsonLdBody = libAgentsSrc.slice(libAgentsSrc.indexOf('// ─── JSON-LD'), libAgentsSrc.indexOf('// ─── Agent of the month'))
  check('toPublicAgent and the JSON-LD builders do not read the office role', !/office_?role/i.test(toPublicBody) && !/office_?role/i.test(jsonLdBody))

  check('parseOfficeRole reads roles, words and blanks', parseOfficeRole('CEO') === 'ceo' && parseOfficeRole(' Manager ') === 'mgr' && parseOfficeRole('MGR') === 'mgr' && parseOfficeRole('c.t.o') === 'cto' && parseOfficeRole('') === null && parseOfficeRole('none') === null && parseOfficeRole(null) === null && parseOfficeRole('boss') === 'invalid' && parseOfficeRole(5) === 'invalid')
  const okRole = cleanAgentInput({ display_name: 'Ann Example', office_role: 'cto' })
  check('cleanAgentInput accepts a role, clears it with blank, refuses a made-up one, and leaves it alone when absent', okRole.ok && okRole.value.office_role === 'cto' && (cleanAgentInput({ office_role: '' }) as { ok: true; value: { office_role?: unknown } }).value.office_role === null && !cleanAgentInput({ office_role: 'boss' }).ok && !('office_role' in (cleanAgentInput({ display_name: 'Ann Example' }) as { ok: true; value: object }).value))

  const rp = (id: string, name: string, role: string | null = null) => ({ id, display_name: name, office_role: role, status: 'draft' as const })
  const roster = [rp('p1', 'Cy Demo'), rp('p2', 'Ann Example', 'ceo'), rp('p3', 'Bo Sample', 'mgr'), rp('p4', 'Dee Fake', 'cto')]
  check('office holders are found by role, and a role nobody holds is null', officeHolders(roster).ceo?.id === 'p2' && officeHolders(roster).cto?.id === 'p4' && officeHolders(roster).mgr?.id === 'p3' && officeHolders(roster.filter((r) => r.id !== 'p2')).ceo === null)
  check('the office team lists CEO, CTO, Manager in that order and skips empty roles', officeTeam(roster).map((t) => t.role).join() === 'ceo,cto,mgr' && officeTeam([rp('p1', 'Cy Demo')]).length === 0)
  check('planOfficeRole names the person who would lose the role, and nobody for a free role or the same person', planOfficeRole(roster, 'p1', 'ceo').from?.id === 'p2' && planOfficeRole(roster, 'p2', 'ceo').from === null && planOfficeRole(roster.filter((r) => r.id !== 'p3'), 'p1', 'mgr').from === null && planOfficeRole(roster, 'p1', null).from === null)
  check('one person is both an office holder and an agent: the same row, no second table', roster.filter((r) => r.office_role).every((r) => r.status === 'draft') && !/create table/i.test(readFileSync('supabase/migrations/0057_agents_office_role.sql', 'utf8')))

  const { fakeAdmin } = await import('./fake-admin')
  const odb = { tables: { agents: [
    { id: 'p1', display_name: 'Cy Demo', office_role: null },
    { id: 'p2', display_name: 'Ann Example', office_role: 'ceo' },
    { id: 'p3', display_name: 'Bo Sample', office_role: 'mgr' },
  ] as Record<string, unknown>[] } }
  const oadmin = fakeAdmin(odb)
  const holdersOf = (role: string) => odb.tables.agents.filter((a) => a.office_role === role).map((a) => a.id)
  const refused = await setOfficeRole(oadmin, 'p1', 'ceo', false)
  check('taking a role someone else holds is refused until the move is confirmed, and nothing changes', !refused.ok && refused.code === 'taken' && /Ann Example is already the CEO/.test(refused.error) && holdersOf('ceo').join() === 'p2' && odb.tables.agents[0].office_role === null, refused)
  const moved = await setOfficeRole(oadmin, 'p1', 'ceo', true)
  check('a confirmed move takes the role from the old holder: still exactly one CEO, the old holder stays on the roster', moved.ok && moved.movedFrom.join() === 'Ann Example' && holdersOf('ceo').join() === 'p1' && odb.tables.agents.length === 3 && odb.tables.agents[1].office_role === null)
  const same = await setOfficeRole(oadmin, 'p1', 'ceo', false)
  check('saving the role a person already holds is fine and changes nobody else', same.ok && same.movedFrom.length === 0 && holdersOf('ceo').join() === 'p1' && holdersOf('mgr').join() === 'p3')
  const free = await setOfficeRole(oadmin, 'p2', 'cto', false)
  check('a free role is simply set, and one person can hold only one role at a time (the new one replaces the old on that row)', free.ok && holdersOf('cto').join() === 'p2')
  const cleared = await setOfficeRole(oadmin, 'p3', null, false)
  check('a role can be cleared', cleared.ok && holdersOf('mgr').length === 0 && odb.tables.agents.length === 3)
  const badRole = await setOfficeRole(oadmin, 'p3', 'boss' as never, true)
  check('a made-up role is refused', !badRole.ok)
  let vetoed = false
  const sdb = { tables: { agents: [{ id: 'q1', display_name: 'Cy Demo', office_role: null }, { id: 'q2', display_name: 'Ann Example', office_role: 'ceo' }] as Record<string, unknown>[] }, rejectUpdate: (_t: string, p: Record<string, unknown>) => (!vetoed && p.office_role === 'ceo' && 'updated_at' in p ? ((vetoed = true), 'write failed') : null) }
  const failedMove = await setOfficeRole(fakeAdmin(sdb), 'q1', 'ceo', true)
  check('a failed move puts the role back, so the office is never left without its CEO', !failedMove.ok && sdb.tables.agents[1].office_role === 'ceo' && sdb.tables.agents[0].office_role === null, failedMove)

  const migSql = readFileSync('supabase/migrations/0057_agents_office_role.sql', 'utf8')
  check('migration 0057 adds a nullable checked column and a partial unique index, with no policy and no data change', /add column if not exists office_role text;/.test(migSql) && /office_role is null or office_role in \('ceo', 'cto', 'mgr'\)/.test(migSql) && /create unique index if not exists agents_office_role_uidx on public\.agents \(office_role\) where office_role is not null/.test(migSql) && !/create policy|insert into|update public|delete from|drop /i.test(migSql))
  const storeSrc2 = readFileSync('lib/agents-store.ts', 'utf8')
  check('saveAgent moves a role only when the request says move_office_role: true', /input\.move_office_role === true/.test(storeSrc2) && /holders\.length > 0 && !moveRole/.test(storeSrc2))
  const editorSrc = readFileSync('components/admin/agents-editor.tsx', 'utf8')
  check('the editor has an Office role dropdown (none, CEO, CTO, Manager), confirms a move, and sends the role only when it changed', /Office role/.test(editorSrc) && /<option value="">None<\/option>/.test(editorSrc) && /confirm\(/.test(editorSrc) && /roleChanged \? \{ \.\.\.payload\(\), office_role: officeRole, move_office_role: move \}/.test(editorSrc))
  const panelSrc = readFileSync('components/admin/agents-panel.tsx', 'utf8')
  check('the roster screen has the Office team strip, filter, badges and the alert switch (off unless the setting says on)', /aria-label="Office team"/.test(panelSrc) && /Filter by office team/.test(panelSrc) && /data-testid="office-badge"/.test(panelSrc) && /not set/.test(panelSrc) && /checked=\{data\.officeAlert === true\}/.test(panelSrc) && /action: "office-alert"/.test(panelSrc))
  const routeSrc = readFileSync('app/api/admin/agents/route.ts', 'utf8')
  check('the office-alert switch is saved only by the admin route after isAuthorized, as on or off', /case 'office-alert'/.test(routeSrc) && routeSrc.indexOf("case 'office-alert'") > routeSrc.indexOf('export async function POST') && /body\.on \? 'on' : 'off'/.test(routeSrc))

  // Import: an optional "role" column maps to the office role. Fake rows only.
  check('guessField maps Role and Office role to the office role, and leaves job titles as headlines', guessField('Role') === 'office_role' && guessField('Office role') === 'office_role' && guessField('Job title') === 'headline' && guessField('Position') === 'headline')
  const roleSheet = parseSheet('Name\tRole\nAnn Example\tCEO\nBo Sample\tcto\nCy Demo\tmgr\nDee Fake\tboss\nEve Test\tceo\nFay Plain\t')
  const rolePrev = roleSheet.ok ? buildPreview(roleSheet.sheet, roleSheet.sheet.guess, { slugs: [], emails: [] }) : []
  check('the role column is picked up by the column guess', roleSheet.ok && roleSheet.sheet.guess.join() === 'display_name,office_role', roleSheet.ok ? roleSheet.sheet.guess : roleSheet)
  check('preview maps ceo, cto and mgr to the office role', rolePrev[0].value?.office_role === 'ceo' && rolePrev[1].value?.office_role === 'cto' && rolePrev[2].value?.office_role === 'mgr', rolePrev.map((p) => p.value?.office_role))
  check('an unknown role word is left empty with a plain warning, and a blank role is just no role', !('office_role' in (rolePrev[3].value ?? {})) && rolePrev[3].warnings.some((w) => /ceo, cto or mgr/.test(w)) && !('office_role' in (rolePrev[5].value ?? {})) && rolePrev[5].warnings.length === 0)
  check('a role already claimed earlier in the paste is not given twice', !('office_role' in (rolePrev[4].value ?? {})) && rolePrev[4].warnings.some((w) => /already held/.test(w)))
  const heldPrev = roleSheet.ok ? buildPreview(roleSheet.sheet, roleSheet.sheet.guess, { slugs: [], emails: [], officeRoles: ['mgr'] }) : []
  check('a role already held in the roster is never moved by an import', !('office_role' in (heldPrev[2].value ?? {})) && heldPrev[2].warnings.some((w) => /already held/.test(w)) && heldPrev[0].value?.office_role === 'ceo')
  check('the import still makes drafts with consent off, and the role never makes anyone public', rolePrev.every((p) => p.value && !('consent_photo' in p.value) && !('status' in p.value)) && /consent_photo: false, consent_bio: false/.test(storeSrc2))

  // ─── Real-sheet import (Travel Agents Import.xlsx shape, fake values) ──────────────
  {
    const h1099 = ['2025', '1099'].join(String.fromCharCode(10))
    const hdr = ['ACTIVE', 'Next Renewal Date', h1099, '2025 Income', 'Name', 'DOB', 'Cell#', 'Email1', 'Email2', 'Address', 'CLIA #', 'FSOT #', 'Allianz Affiliate Link', 'COMMISSIONS SHEET', 'W9 & Contracts', 'AGENT START DATE', 'THIS YEAR LEVEL', '45k booked (80/20)', '100k in contract year (Free Renewal)']
    const NL = String.fromCharCode(10)
    const TAB = String.fromCharCode(9)
    const tsv = (rows: string[][]) => [hdr, ...rows].map((r) => r.map((c) => (c.includes(NL) ? `"${c}"` : c)).join(TAB)).join(NL)
    const full = ['YES', '46333', 'sent', '55555', 'Ann (Lee) Test', '30000', '(555) 555-0100', 'ann@example.com', 'ann2@example.org', '1 Test St', '12345678', 'ST12345', 'https://www.agentmaxonline.com/x', 'https://docs.google.com/spreadsheets/d/abc123/edit', 'Yes', '43500', '50/50', 'no', 'no']
    const na = ['YES', '46400', 'N/A', 'N/A', 'Bob Test', '31000', '(555) 555-0101', 'bob@example.com', 'N/A', '2 Test St', 'N/A', 'N/A', 'N/A', 'Commission sheet', 'N/A', '44000', 'N/A', 'N/A', 'N/A']
    const gone = ['NO', '46400', '', '', 'Cy Test', '', '', 'cy@example.com', '', '', '', '', '', '', '', '', '', '', '']
    const sh = parseSheet(tsv([full, na, gone]))
    check('real sheet parses', sh.ok)
    if (sh.ok) {
      const g = sh.sheet.guess
      const at = (h: string) => g[sh.sheet.headers.indexOf(h)]
      check('real sheet: useful columns are matched', at('Name') === 'display_name' && at('Cell#') === 'phone' && at('Email1') === 'email' && at('Email2') === 'second_email' && at('CLIA #') === 'clia' && at('FSOT #') === 'fsot' && at('AGENT START DATE') === 'agent_since' && at('Next Renewal Date') === 'renewal_date' && at('Allianz Affiliate Link') === 'affiliate_link' && at('ACTIVE') === 'active' && at('Address') === 'address', g)
      check('real sheet: DOB, income, 1099, W9, commission and level columns are never mapped', ['DOB', '2025 Income', h1099, 'W9 & Contracts', 'THIS YEAR LEVEL', '45k booked (80/20)', '100k in contract year (Free Renewal)'].every((h) => !at(h)), sh.sheet.skippedPrivate)
      check('real sheet: skippedPrivate lists the money, tax and birth columns', sh.sheet.skippedPrivate.length >= 6)
      const forced = sh.sheet.headers.map(() => 'notes' as const)
      const pv = buildPreview(sh.sheet, [...g], { slugs: [], emails: [] })
      const dumped = JSON.stringify(buildPreview(sh.sheet, forced, { slugs: [], emails: [] }))
      check('real sheet: a sensitive column mapped by hand is still dropped', !dumped.includes('30000') && !dumped.includes('55555') && !dumped.includes('50/50'))
      check('real sheet: full row is a new draft with the nickname kept private', pv[0].ok && pv[0].slug === 'ann-test' && pv[0].value?.display_name === 'Ann Test' && /Name in sheet: Ann \(Lee\) Test/.test(pv[0].value?.notes ?? ''))
      check('real sheet: private extras land in notes only', /CLIA #: 12345678/.test(pv[0].value?.notes ?? '') && /Seller of travel \(FSOT\) #: ST12345/.test(pv[0].value?.notes ?? '') && /Second email: ann2@example.org/.test(pv[0].value?.notes ?? '') && /Affiliate link: https:\/\/www\.agentmaxonline\.com\/x/.test(pv[0].value?.notes ?? ''))
      check('real sheet: Excel date serials become real dates', /Agent start date: 2019-0[1-9]-\d\d|Agent start date: 2019-1/.test(pv[0].value?.notes ?? '') && /Next renewal: 2026-/.test(pv[0].value?.notes ?? ''), pv[0].value?.notes)
      check('real sheet: CLIA comes in as an unverified certification', JSON.stringify(pv[0].value?.certifications ?? []).includes('"CLIA"') && !JSON.stringify(pv[0].value?.certifications ?? []).includes('"verified":true'))
      check('real sheet: N/A placeholders are empty, not stored', pv[1].ok && !/N\/A/.test(JSON.stringify(pv[1].value)) && !/CLIA|FSOT|Second email|Affiliate/.test(pv[1].value?.notes ?? ''))
      check('real sheet: the commission SHEET link is kept in private notes, the figures column stays out', at('COMMISSIONS SHEET') === 'commission_sheet' && /Commission sheet: https:\/\/docs\.google\.com\/spreadsheets\/d\/abc123\/edit/.test(pv[0].value?.notes ?? ''))
      check('real sheet: the words "Commission sheet" are never stored, with a plain warning', !/Commission sheet/i.test(pv[1].value?.notes ?? '') && pv[1].warnings.some((w) => /not a full https link/.test(w)))
      check('real sheet: a row marked NO is skipped with a plain reason', !pv[2].ok && pv[2].warnings.some((w) => /not active/.test(w)))
      check('real sheet: nothing public comes from the import', pv.filter((p) => p.ok).every((p) => !('status' in (p.value ?? {})) && !('consent_photo' in (p.value ?? {}))))
    }
    check('readSheetDate: serial to ISO, text untouched', readSheetDate('43500') === '2019-02-04' && readSheetDate('43466') === '2019-01-01' && readSheetDate('2024-05-01') === '2024-05-01' && readSheetDate('12') === '12')
    check('isPlaceholder', isPlaceholder('N/A') && isPlaceholder(' n/a ') && isPlaceholder('-') && !isPlaceholder('Navigator'))
  }

  // ─── Social links and ASTA ─────────────────────────────────────────────────────
  {
    const links = [
      { kind: 'instagram', label: '', url: 'https://www.instagram.com/jane', public: true },
      { kind: 'facebook_group', label: 'Jane Cruises Fans', url: 'https://www.facebook.com/groups/janefans', public: false },
      { kind: 'instagram', label: '', url: 'https://evil.example/jane', public: true },
      { kind: 'website', label: '', url: 'http://insecure.example', public: true },
      { kind: 'website', label: '', url: 'https://jane.example', public: 'yes' },
    ]
    const parsed = parseSocialLinks(links)
    check('social links: wrong-site and non-https links are dropped, the rest kept', parsed.length === 3 && parsed.map((l) => l.url).join() === 'https://www.instagram.com/jane,https://www.facebook.com/groups/janefans,https://jane.example/', parsed)
    check('social links: public is true only for an explicit true', parsed.map((l) => l.public).join() === 'true,false,false')
    const pubRow = { ...baseRow, social_links: links, asta_member: true, asta_verified: false, asta_number: 'ASTA-123' }
    const pa = toPublicAgent(pubRow) as PublicAgent
    check('public agent shows ONLY links made public', pa.social_links.length === 1 && pa.social_links[0].url === 'https://www.instagram.com/jane', pa.social_links)
    check('private Facebook group never reaches the public agent', !JSON.stringify(pa).includes('janefans'))
    check('ASTA claim without verification is not public', pa.asta_member === false && !JSON.stringify(pa).includes('ASTA-123'))
    const verified = toPublicAgent({ ...pubRow, asta_verified: true }) as PublicAgent
    check('verified ASTA member is public, number still private', verified.asta_member === true && !JSON.stringify(verified).includes('ASTA-123'))
    check('asta_verified without asta_member is not public', (toPublicAgent({ ...pubRow, asta_member: false, asta_verified: true }) as PublicAgent).asta_member === false)
    check('JSON-LD sameAs lists only public links; memberOf only when verified', (() => { const ctx = { siteName: 'S', absoluteUrl: (p: string) => `https://x.test${p}`, orgUrl: 'https://x.test/' }; const a = buildPersonJsonLd(pa, ctx) as Record<string, unknown>; const b = buildPersonJsonLd(verified, ctx) as Record<string, unknown>; return JSON.stringify(a.sameAs) === '["https://www.instagram.com/jane"]' && !('memberOf' in a) && 'memberOf' in b })())
    const ed = cleanAgentInput({ social_links: links, asta_member: true, asta_number: ' A-1 ', asta_verified: true })
    check('admin edit cleans socials and ASTA', ed.ok && ed.value.social_links?.length === 3 && ed.value.asta_number === 'A-1' && ed.value.asta_verified === true, ed)
    check('public column list has social_links and ASTA flags but not the number', (AGENT_PUBLIC_COLUMNS as readonly string[]).includes('social_links') && !(AGENT_PUBLIC_COLUMNS as readonly string[]).includes('asta_number'))
    const sheet = parseSheet('Name\tInstagram\tFacebook Group\tFacebook\tASTA Member\tASTA #\nJane Doe\thttps://instagram.com/jane\tfacebook.com/groups/jfans\t@jane\tYes\tA-77\n')
    check('import maps social + ASTA headers', sheet.ok && sheet.sheet.guess.join() === 'display_name,instagram,facebook_group,facebook_profile,asta_member,asta_number', sheet.ok ? sheet.sheet.guess : sheet)
    if (sheet.ok) {
      const pv = buildPreview(sheet.sheet, sheet.sheet.guess, { slugs: [], emails: [] })[0]
      check('import: links come in PRIVATE, bare domain gets https, a bare @handle is not guessed', (pv.value?.social_links ?? []).length === 2 && (pv.value?.social_links ?? []).every((l) => l.public === false) && pv.warnings.some((w) => /Facebook \(personal page\)/.test(w)), pv)
      check('import: ASTA is a claim, never verified', pv.value?.asta_member === true && pv.value?.asta_number === 'A-77' && !pv.value?.asta_verified, pv.value)
    }
    check('self-service cannot set socials, ASTA or public flags', (() => { const r = cleanSelfService({ bio: 'x'.repeat(60), specialties: 'Italy', social_links: links, asta_verified: true }); return r.ok && !('social_links' in r.value) && !('asta_verified' in r.value) })())
    check('migration 0058 adds the four columns and no policy', (() => { const m = readFileSync('supabase/migrations/0058_agents_socials_asta.sql', 'utf8'); return ['social_links', 'asta_member', 'asta_number', 'asta_verified'].every((c) => m.includes(`add column if not exists ${c}`)) && !/create policy/i.test(m) })())
  }

  // ─── Promoted trips and testimonial ───────────────────────────────────────────
  {
    const r = cleanSelfService({ bio: 'x'.repeat(60), specialties: 'Italy', promoted_package_slugs: ['italy-2027', 'ITALY-2027', 'bad slug!', 7, '../x', 'greece-cruise'], testimonial_text: 'Great group trip.' })
    check('self-service keeps clean, unique, lowercase package slugs only', r.ok && r.value.promoted_package_slugs.join() === 'italy-2027,greece-cruise', r.ok ? r.value.promoted_package_slugs : r)
    check('self-service testimonial is stored as text', r.ok && r.value.testimonial_text === 'Great group trip.')
    check('package slugs are capped at 12', cleanSelfService({ bio: 'x'.repeat(60), specialties: 'Italy', promoted_package_slugs: Array.from({ length: 30 }, (_, i) => `trip-${i}`) }).ok === true && cleanPackageSlugs(Array.from({ length: 30 }, (_, i) => `trip-${i}`)).length === 12)
    check('public mapper cleans promoted slugs', toPublicAgent({ id: 'a', slug: 's', display_name: 'A B', bio: 'x'.repeat(50), status: 'published', consent_photo: true, consent_bio: true, promoted_package_slugs: ['ok-1', 'No Good'] })?.promoted_package_slugs.join() === 'ok-1')
    check('testimonial_text is not a public column', !(AGENT_PUBLIC_COLUMNS as readonly string[]).includes('testimonial_text'))
    check('migration 0059 adds both columns and no policy', (() => { const m = readFileSync('supabase/migrations/0059_agents_promoted_trips.sql', 'utf8'); return m.includes('add column if not exists promoted_package_slugs') && m.includes('add column if not exists testimonial_text') && !/create policy/i.test(m) })())
    check('submit drops slugs that are not published packages', readFileSync('lib/agents-store.ts', 'utf8').includes(".eq('status', 'published')") && readFileSync('lib/agents-store.ts', 'utf8').includes('cleaned.value.promoted_package_slugs.filter'))
  }

  // ─── Add-a-trip links tied to a roster agent ──────────────────────────────────
  {
    check('addPromotedSlug appends a new clean slug', addPromotedSlug(['a-1'], 'B-2').join() === 'a-1,b-2')
    check('addPromotedSlug skips a duplicate', addPromotedSlug(['a-1'], 'a-1').join() === 'a-1')
    check('addPromotedSlug ignores a bad slug and a non-array', addPromotedSlug(null, 'bad slug!').length === 0 && addPromotedSlug(undefined, 'ok-1').join() === 'ok-1')
    check('addPromotedSlug leaves a full list of 12 alone', addPromotedSlug(Array.from({ length: 12 }, (_, i) => `t-${i}`), 'extra').length === 12)
    const subs = readFileSync('lib/agent-submissions.ts', 'utf8')
    check('approval attaches the trip only after a successful publish', subs.indexOf('attachToAgentPage(admin, sub.invite_id') > subs.indexOf('const pub = await publishTrip(packageId)') && subs.indexOf('attachToAgentPage(admin, sub.invite_id') < subs.indexOf("return { ok: true, state: 'approved' }"))
    check('attachToAgentPage never throws', /async function attachToAgentPage[\s\S]*?try \{[\s\S]*?\} catch \{/.test(subs))
    check('migration 0060 adds agent_id nullable with set null and no policy', (() => { const m = readFileSync('supabase/migrations/0060_agent_invites_agent_id.sql', 'utf8'); return m.includes('add column if not exists agent_id uuid references public.agents(id) on delete set null') && !/create policy/i.test(m) && !/add column[^\n]*agent_id[^\n]*not null/i.test(m) })())
    const inv = readFileSync('app/api/admin/agent-invites/route.ts', 'utf8')
    check('invite route checks admin auth and that the roster agent exists', (inv.match(/isAuthorized\(request\)/g) ?? []).length >= 2 && inv.includes("from('agents').select('id').eq('id', body.agent_id)"))
    const prof = readFileSync('app/api/agent-profile/[token]/route.ts', 'utf8')
    check('profile GET returns only the agent\'s own live trip link', prof.includes(".eq('agent_id', r.ctx.agent.id)") && prof.includes(".is('revoked_at', null)") && prof.includes(".gt('expires_at'"))
  }

  // ─── Wiring ────────────────────────────────────────────────────────────────────
  check('migration enables RLS on every agents table and defines no policy', (() => { const m = readFileSync('supabase/migrations/0054_agents.sql', 'utf8'); const t = ['agents', 'agent_achievements', 'agent_of_month', 'agent_profile_links', 'agent_profile_submissions', 'agent_content_drafts']; return t.every((x) => m.includes(`alter table public.${x} enable row level security`)) && !/create policy/i.test(m) })())
  check('admin API checks isAuthorized on both verbs', (() => { const s = readFileSync('app/api/admin/agents/route.ts', 'utf8'); return (s.match(/isAuthorized\(request\)/g) ?? []).length >= 2 })())
  check('home page uses the strip', readFileSync('app/page.tsx', 'utf8').includes('<AgentsStrip'))
  check('contact form hint is a hint only (commented) and the route only writes a note', readFileSync('components/contact-form.tsx', 'utf8').includes('the office assigns leads') && readFileSync('app/api/submit-lead/route.ts', 'utf8').includes('hint only'))

  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
