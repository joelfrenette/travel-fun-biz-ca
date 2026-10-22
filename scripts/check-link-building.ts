// Offline checks for the Link building workspace (lib/link-targets.ts, lib/link-building.ts, /api/admin/links-building).
// No network, no database. Run: pnpm dlx tsx scripts/check-link-building.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { site } from '../lib/site'
import {
  COPY_BANNED, GROUP_ORDER, LINK_TARGETS, MAX_EARNED, MAX_NOTE_LENGTH, MAX_PARTNER_TASKS, MAX_TASKS_STORED,
} from '../lib/link-targets'
import {
  addEarned, applyTaskPatch, buildDrafts, checkNap, directoryDescriptions, napBlock, napSummary, parseEarned, parseTaskState,
  serializeEarned, serializeTaskState, suggestPartnerTasks, validateEarnedInput, allTargets, type NapSurface,
} from '../lib/link-building'
import { buildOrganizationJsonLd } from '../lib/org-jsonld'
import { adminNavItems } from '../lib/admin-nav'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const EM = String.fromCharCode(0x2014)

// ---- config shape
const ids = LINK_TARGETS.map((t) => t.id)
expect('target ids are unique and well formed', new Set(ids).size === ids.length && ids.every((i) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(i)))
expect('every target has a known group, effort and value, and the text fields filled', LINK_TARGETS.every((t) => GROUP_ORDER.includes(t.group) && ['low', 'medium', 'high'].includes(t.effort) && ['low', 'medium', 'high'].includes(t.value) && t.title && t.how && t.searchPhrase && t.officialSite))
expect('no target holds a URL (we give search phrases and official site names only)', LINK_TARGETS.every((t) => ![t.title, t.how, t.searchPhrase, t.officialSite].some((s) => /https?:\/\/|www\./i.test(s))))
expect('every group has at least one task or is filled from data (partners)', GROUP_ORDER.every((g) => g === 'partners' || LINK_TARGETS.some((t) => t.group === g)))
expect('memberships are never assumed: association tasks ask the owner to tick', LINK_TARGETS.filter((t) => t.group === 'associations').every((t) => t.askHolds))
expect('PR items are ideas only', LINK_TARGETS.filter((t) => t.group === 'pr').every((t) => t.ideaOnly))
expect('the sidebar has a Link building item that points at the page', adminNavItems.some((i) => i.title === 'Link building' && i.href === '/admin/links-building'))
const titles = adminNavItems.slice(1).map((i) => i.title)
expect('sidebar items stay sorted', titles.join('|') === [...titles].sort((a, b) => a.localeCompare(b)).join('|'))

// ---- partner suggestions
const partners = suggestPartnerTasks(['Viking', 'viking ', 'Royal Caribbean', null, '', 'AmaWaterways'], ['Viking', 'GetYourGuide'])
expect('partner tasks are deduped by name and skip blanks', partners.map((p) => p.id).join(',') === 'partner-viking,partner-royal-caribbean,partner-amawaterways,partner-getyourguide', partners.map((p) => p.id).join(','))
expect('partner tasks read "ask <partner> to link to your agent page"', partners[0].title === 'Ask Viking to link to your agent page' && partners.every((p) => p.group === 'partners' && p.drafts.includes('partner')))
expect('partner suggestions are capped', suggestPartnerTasks(Array.from({ length: 200 }, (_, i) => `Supplier ${i}`), []).length === MAX_PARTNER_TASKS)
expect('partner ids never collide with static ids', allTargets(partners).length === new Set(allTargets(partners).map((t) => t.id)).size)

// ---- task JSON parse and limits
expect('bad task JSON fails open to an empty map', Object.keys(parseTaskState('{nope')).length === 0 && Object.keys(parseTaskState(null)).length === 0 && Object.keys(parseTaskState('[1,2]')).length === 0 && Object.keys(parseTaskState('{"tasks":[1]}')).length === 0)
expect('oversized task JSON is refused', Object.keys(parseTaskState(`{"tasks":{"a":{"status":"done"}},"pad":"${'x'.repeat(400_100)}"}`)).length === 0)
const parsed = parseTaskState(JSON.stringify({ tasks: { 'good-id': { status: 'done', note: ` ${'n'.repeat(900)} `, holds: true, at: 'x' }, 'Bad Id': { status: 'done' }, 'bad-status': { status: 'wow' }, 'no-obj': 5 } }))
expect('parse keeps valid entries only, trims and bounds the note', Object.keys(parsed).join() === 'good-id' && parsed['good-id'].note!.length === MAX_NOTE_LENGTH && parsed['good-id'].holds === true)
const many: Record<string, unknown> = {}
for (let i = 0; i < MAX_TASKS_STORED + 50; i++) many[`t-${i}`] = { status: 'todo' }
expect('parse is bounded to the max stored', Object.keys(parseTaskState(JSON.stringify({ tasks: many }))).length === MAX_TASKS_STORED)
expect('serialize then parse round trips', JSON.stringify(parseTaskState(serializeTaskState(parsed))) === JSON.stringify(parsed))
const known = new Set(['google-business-profile', 'assoc-acta'])
const r1 = applyTaskPatch({}, 'google-business-profile', { status: 'doing' }, known, 'T')
expect('a patch sets status', 'map' in r1 && r1.map['google-business-profile'].status === 'doing')
expect('a patch rejects an unknown id, a bad status, a non-text note and a non-boolean holds',
  'error' in applyTaskPatch({}, 'nope', { status: 'done' }, known, 'T') && 'error' in applyTaskPatch({}, 'assoc-acta', { status: 'finished' }, known, 'T')
  && 'error' in applyTaskPatch({}, 'assoc-acta', { note: 5 }, known, 'T') && 'error' in applyTaskPatch({}, 'assoc-acta', { holds: 'yes' }, known, 'T'))
const r2 = 'map' in r1 ? applyTaskPatch(r1.map, 'google-business-profile', { note: 'asked Sam' }, known, 'T2') : r1
expect('a note patch keeps the earlier status', 'map' in r2 && r2.map['google-business-profile'].status === 'doing' && r2.map['google-business-profile'].note === 'asked Sam')
const full: Record<string, { status: 'todo'; at: string }> = {}
for (let i = 0; i < MAX_TASKS_STORED; i++) full[`t-${i}`] = { status: 'todo', at: '' }
expect('a patch is refused when the saved list is full', 'error' in applyTaskPatch(full, 'assoc-acta', { status: 'done' }, known, 'T'))

// ---- earned links
const okEarned = validateEarnedInput({ page: '/destinations/cancun', source: 'example-blog', date: '2026-10-22' })
expect('earned input validates', !('error' in okEarned))
expect('earned input rejects empty, long, and bad dates', ['', 'x'.repeat(201)].every((v) => 'error' in validateEarnedInput({ page: v, source: 's', date: '2026-10-22' })) && 'error' in validateEarnedInput({ page: 'p', source: 's', date: '22/10/2026' }) && 'error' in validateEarnedInput({ page: 'p', source: 's', date: '2026-13-40' }))
expect('earned parse fails open and drops bad rows', parseEarned('garbage').length === 0 && parseEarned(JSON.stringify({ items: [{ id: 'e-1', page: 'a', source: 'b', date: '2026-10-22' }, { id: 'E 2', page: 'a', source: 'b', date: '2026-10-22' }, { id: 'e-3', page: 'a', source: 'b', date: 'x' }] })).length === 1)
let items = parseEarned(serializeEarned([]))
for (let i = 0; i < MAX_EARNED; i++) { const a = addEarned(items, { page: 'p', source: 's', date: '2026-10-22' }, `e-${i}`); if ('items' in a) items = a.items }
expect('earned list is capped', items.length === MAX_EARNED && 'error' in addEarned(items, { page: 'p', source: 's', date: '2026-10-22' }, 'e-x'))
expect('earned entries are added newest first', (() => { const a = addEarned([], { page: 'p', source: 's', date: '2026-10-22' }, 'e-1'); const b = 'items' in a ? addEarned(a.items, { page: 'q', source: 's', date: '2026-10-23' }, 'e-2') : a; return 'items' in b && b.items[0].id === 'e-2' })())

// ---- drafts
const nap = { name: site.name, addressLines: site.addressLines, phone: site.phone, url: site.url }
const ctx = { ...nap, city: site.address.locality, linkUrl: `${site.url}/`, anchor: `${site.name}: hosted group trips and cruises`, targetName: 'Viking' }
const kinds = ['directory', 'partner', 'review', 'agent_page', 'association', 'pitch', 'bio'] as const
const allDrafts = kinds.flatMap((k) => buildDrafts(k, ctx))
expect('every draft kind produces text', kinds.every((k) => buildDrafts(k, ctx).length > 0 && buildDrafts(k, ctx).every((d) => d.text.length > 20)))
expect('every draft is free of em dashes, prices, response-time promises and superlatives', allDrafts.every((d) => !COPY_BANNED.some((re) => re.test(d.text) || re.test(d.label))), allDrafts.filter((d) => COPY_BANNED.some((re) => re.test(d.text))).map((d) => d.label).join('; '))
const dirs = directoryDescriptions({ name: site.name, city: site.address.locality })
expect('directory descriptions fit 50, 150 and 300 characters', dirs.every((d) => d.text.length <= d.limit) && dirs.map((d) => d.limit).join() === '50,150,300', dirs.map((d) => d.text.length).join())
expect('the longer descriptions are fuller than the shorter ones', dirs[0].text.length < dirs[1].text.length && dirs[1].text.length < dirs[2].text.length)
expect('partner and agent-page drafts carry the live URL, the anchor text and the exact NAP', (['partner', 'agent_page'] as const).every((k) => { const t = buildDrafts(k, ctx)[0].text; return t.includes(ctx.linkUrl) && t.includes(ctx.anchor) && t.includes(site.phone) && t.includes(site.addressLines[0]) }))
expect('the review request offers nothing in return and asks for an honest review', /honest/i.test(buildDrafts('review', ctx)[0].text) && !/discount|free|gift|credit|reward|win/i.test(buildDrafts('review', ctx)[0].text))
expect('the NAP block is built from site facts', napBlock(nap).includes(site.name) && napBlock(nap).includes(site.phone))
const srcText = ['lib/link-targets.ts', 'lib/link-building.ts', 'lib/links-building-data.ts', 'app/admin/links-building/page.tsx', 'app/api/admin/links-building/route.ts', 'scripts/check-link-building.ts'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n')
expect('no em dash anywhere in the feature source', !srcText.includes(EM))

// ---- NAP consistency helper
const expected = { name: site.name, phone: site.phone, street: site.addressLines[0], locality: site.address.locality, region: site.address.region, postalCode: site.address.postalCode }
const ld = buildOrganizationJsonLd() as { name: string; telephone: string; address: { streetAddress: string; addressLocality: string; addressRegion: string; postalCode: string } }
const good: NapSurface[] = [
  { surface: 'site', name: site.name, phone: site.phone, street: site.addressLines[0], locality: site.address.locality, region: site.address.region, postalCode: site.address.postalCode },
  { surface: 'jsonld', name: ld.name, phone: ld.telephone, street: ld.address.streetAddress, locality: ld.address.addressLocality, region: ld.address.addressRegion, postalCode: ld.address.postalCode },
  { surface: 'text', text: `Call or text ${site.phone} for pricing` },
]
expect('the real JSON-LD matches lib/site.ts', napSummary(checkNap(good, expected)).bad === 0 && checkNap(good, expected).length >= 13)
expect('a different phone is flagged', checkNap([{ surface: 'x', phone: '(416) 555-0100' }], expected)[0].ok === false)
expect('the same phone in another format passes', checkNap([{ surface: 'x', phone: '833-878-5386' }, { surface: 'y', phone: '+1 833 878 5386' }], expected).every((f) => f.ok))
expect('the old Canada office number is flagged in a phone field and in free text', checkNap([{ surface: 'x', phone: '(365) 800-6363' }, { surface: 'y', text: 'Call 365-800-6363 today' }], expected).every((f) => !f.ok))
expect('a stray number in free text is flagged', checkNap([{ surface: 'x', text: 'Reach us at 416-555-0100 or ' + site.phone }], expected)[0].ok === false)
expect('a wrong address piece or name is flagged', checkNap([{ surface: 'x', name: 'Other Travel', street: '1 Main St', postalCode: 'M1M 1M1' }], expected).filter((f) => !f.ok).length === 3)
expect('empty fields are skipped, not failed', checkNap([{ surface: 'x', name: '', phone: null }], expected).length === 0)
expect('the site phone is the shared number on the live profile', site.phone === '(833) 878-5386')

// ---- route auth: every handler checks isAuthorized before anything else
const route = readFileSync(join(root, 'app/api/admin/links-building/route.ts'), 'utf8')
const handlers = [...route.matchAll(/export async function (GET|POST)\(request: Request\) \{\r?\n([^\r\n]*)/g)]
expect('GET and POST both exist and each starts with the isAuthorized check', handlers.map((h) => h[1]).sort().join() === 'GET,POST' && handlers.every((h) => /^\s*if \(!isAuthorized\(request\)\) return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)/.test(h[2])))
expect('the route has no other exported handler', (route.match(/export async function/g) ?? []).length === 2)
expect('the route sends nothing and calls no AI', !/sendMail|fetch\(|anthropic|openai|resend|nodemailer/i.test(route + readFileSync(join(root, 'lib/links-building-data.ts'), 'utf8')))
expect('the page lives under the admin shell', readFileSync(join(root, 'app/admin/links-building/page.tsx'), 'utf8').includes('/api/admin/links-building'))

console.log(failures ? `\n${failures} check(s) failed` : '\nAll link building checks passed')
process.exit(failures ? 1 : 0)
