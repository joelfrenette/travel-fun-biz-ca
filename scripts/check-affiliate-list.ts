// Offline check for WP22 part 1 "one simple affiliate list": the partner settings folded into the link (create on first save,
// adopt a partner with the same short name, one partner per link), ON and OFF that switch the link and its search button
// together, the "Fun things to do" and trip extras blocks following ON and OFF, the admin routes, and the page source (one
// table, no partners section, no Draft/Hidden/Active words). In-memory database only, no network.
// Run: pnpm dlx tsx scripts/check-affiliate-list.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeAdmin, type Db } from './fake-admin'
import {
  applyAdvanced, setLinkOnOff, partnerForLink, orphanPartners, readAdvanced, validateAdvanced, hasAdvanced, partnerStatusFor, advancedOf, hidePartnerOfLink,
  type AdvancedInput,
} from '../lib/affiliate-link-partner'
import { loadThingsToDo } from '../lib/things-to-do'
import { loadTripExtras } from '../lib/trip-extras'
import type { PartnerRow } from '../lib/affiliate-partners'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const ADV = (o: Partial<AdvancedInput> = {}): AdvancedInput => ({ partner_code: '', search_template: '', logo_url: '', disclosure: '', ...o })
const TEMPLATE = 'https://partner.shopco.com/search?q={query}&pid={partner_id}'
const linkRow = (o: Record<string, unknown> = {}) => ({ id: 'L1', slug: 'viator', status: 'active', url: 'https://viator.shopco.com/aff', merchant: 'Viator', title: 'Viator tours', sort_order: 1, partner_id: null, guide_kind: null, guide_slug: null, image_url: null, note: null, category: null, ...o })
const partnerRow = (o: Record<string, unknown> = {}) => ({ id: 'P1', slug: 'viator', name: 'Viator', logo_url: null, partner_id: 'abc', search_template: TEMPLATE, disclosure: null, status: 'active', sort_order: 1, ...o })

async function main() {
  // ---------- 1. pure helpers ----------
  const partners = [partnerRow(), partnerRow({ id: 'P2', slug: 'tiqets' }), partnerRow({ id: 'P3', slug: 'solo' })] as unknown as PartnerRow[]
  expect('a link finds its partner by partner_id first', partnerForLink({ slug: 'other', partner_id: 'P2' }, partners).partner?.id === 'P2' && !partnerForLink({ slug: 'other', partner_id: 'P2' }, partners).adopted)
  expect('a link without partner_id finds the partner with the same short name and marks it adopted', (() => { const r = partnerForLink({ slug: 'viator', partner_id: null }, partners); return r.partner?.id === 'P1' && r.adopted })())
  expect('no match is no partner', partnerForLink({ slug: 'nothing', partner_id: null }, partners).partner === null)
  expect('partners no link claims come back as search-button-only rows', orphanPartners([{ slug: 'viator', partner_id: null }, { slug: 'x', partner_id: 'P2' }], partners).map((p) => p.id).join() === 'P3')
  expect('the five existing partners are adopted by name', ['viator', 'getyourguide', 'toursbylocals', 'tiqets', 'project-expedition'].every((s) => partnerForLink({ slug: s, partner_id: null }, [partnerRow({ id: 'X', slug: s }) as unknown as PartnerRow]).adopted))
  expect('link status maps to partner status', partnerStatusFor('active') === 'active' && partnerStatusFor('hidden') === 'hidden' && partnerStatusFor('draft') === 'draft')
  expect('advanced settings read from a body only when sent (ON/OFF never touches them)', readAdvanced({ status: 'active' }) === null && readAdvanced({ advanced: { partner_code: ' a ', search_template: TEMPLATE } })?.partner_code === 'a')
  expect('advanced settings are checked before anything is saved', validateAdvanced(ADV({ search_template: 'http://x.shopco.com/{query}' })).ok === false && validateAdvanced(ADV({ search_template: TEMPLATE })).ok === false && validateAdvanced(ADV({ search_template: TEMPLATE, partner_code: 'abc' })).ok && validateAdvanced(ADV()).ok && validateAdvanced(null).ok)
  expect('hasAdvanced and advancedOf', !hasAdvanced(ADV()) && hasAdvanced(ADV({ logo_url: 'x' })) && advancedOf(null).search_template === '' && advancedOf(partnerRow() as unknown as PartnerRow).partner_code === 'abc')

  // ---------- 2. saving the advanced part ----------
  const link = { id: 'L1', slug: 'viator', status: 'active', merchant: 'Viator', title: 'Viator tours', sort_order: 1, partner_id: null as string | null }
  const d1: Db = { tables: { affiliate_links: [linkRow()], affiliate_partners: [] } }
  const r1 = await applyAdvanced(fakeAdmin(d1), link, ADV({ search_template: TEMPLATE, partner_code: 'abc' }))
  const made = d1.tables.affiliate_partners![0] as Record<string, unknown>
  expect('first save of a search link creates the partner, named and slugged after the link, and links it', r1.ok && d1.tables.affiliate_partners!.length === 1 && made.slug === 'viator' && made.name === 'Viator' && made.search_template === TEMPLATE && made.status === 'active' && (d1.tables.affiliate_links![0] as { partner_id: string }).partner_id === made.id)
  const r1b = await applyAdvanced(fakeAdmin(d1), { ...link, partner_id: made.id as string }, ADV({ search_template: TEMPLATE, partner_code: 'xyz', disclosure: 'Our wording.' }))
  expect('saving again updates the same partner: still one partner per link', r1b.ok && d1.tables.affiliate_partners!.length === 1 && (d1.tables.affiliate_partners![0] as { partner_id: string; disclosure: string }).partner_id === 'xyz' && (d1.tables.affiliate_partners![0] as { disclosure: string }).disclosure === 'Our wording.')
  const d2: Db = { tables: { affiliate_links: [linkRow()], affiliate_partners: [partnerRow()] } }
  const r2 = await applyAdvanced(fakeAdmin(d2), link, ADV({ search_template: TEMPLATE, partner_code: 'abc', logo_url: 'https://cdn.shopco.com/logo.png' }))
  expect('an existing partner with the same short name is adopted on save (linked, updated, not duplicated)', r2.ok && d2.tables.affiliate_partners!.length === 1 && (d2.tables.affiliate_links![0] as { partner_id: string }).partner_id === 'P1' && (d2.tables.affiliate_partners![0] as { logo_url: string }).logo_url === 'https://cdn.shopco.com/logo.png')
  const d3: Db = { tables: { affiliate_links: [linkRow()], affiliate_partners: [] } }
  const r3 = await applyAdvanced(fakeAdmin(d3), link, ADV())
  expect('a link with nothing in the advanced part and no partner stays without one', r3.ok && d3.tables.affiliate_partners!.length === 0 && (d3.tables.affiliate_links![0] as { partner_id: unknown }).partner_id === null)
  const d4: Db = { tables: { affiliate_links: [linkRow({ slug: 'getyourguide', id: 'L2' })], affiliate_partners: [partnerRow({ slug: 'getyourguide' })] } }
  const r4 = await applyAdvanced(fakeAdmin(d4), { ...link, id: 'L2', slug: 'getyourguide' }, ADV())
  expect('emptying the advanced part clears the search link but keeps the partner row (and its history)', r4.ok && d4.tables.affiliate_partners!.length === 1 && (d4.tables.affiliate_partners![0] as { search_template: unknown }).search_template === null)
  const d5: Db = { tables: { affiliate_links: [linkRow({ slug: 'other', id: 'L9' })], affiliate_partners: [partnerRow({ slug: 'other' })] } }
  await applyAdvanced(fakeAdmin(d5), { ...link, id: 'L9', slug: 'other', status: 'hidden' }, ADV({ search_template: TEMPLATE, partner_code: 'abc' }))
  expect('the partner status follows the link status on save', (d5.tables.affiliate_partners![0] as { status: string }).status === 'hidden')
  const d6: Db = { tables: { affiliate_links: [linkRow({ slug: 'dupe' })], affiliate_partners: [partnerRow({ slug: 'dupe', id: 'PX' })] } }
  const r6 = await applyAdvanced(fakeAdmin(d6), { ...link, slug: 'dupe' }, ADV({ search_template: TEMPLATE, partner_code: 'abc' }))
  expect('a link whose slug matches a partner never creates a second one', r6.ok && d6.tables.affiliate_partners!.length === 1)
  const missingTable = { from: (t: string) => ({ select: () => Promise.resolve({ data: null, error: { message: `relation "${t}" does not exist` } }) }) } as never
  const typedMissing = await applyAdvanced(missingTable, link, ADV({ search_template: TEMPLATE, partner_code: 'abc' }))
  const emptyMissing = await applyAdvanced(missingTable, link, ADV())
  expect('before migration 0048: typing a search link is a clear 409, an empty advanced part is fine', !typedMissing.ok && typedMissing.status === 409 && /migration 0048/.test(typedMissing.error) && emptyMissing.ok)

  // ---------- 3. ON and OFF ----------
  const world = (): Db => ({
    tables: {
      affiliate_links: [linkRow({ guide_kind: 'destinations', guide_slug: 'croatia', partner_id: 'P1', category: 'insurance', id: 'L1' })],
      affiliate_partners: [partnerRow()],
      affiliate_clicks: [],
    },
  })
  const w = world()
  const admin = fakeAdmin(w)
  const onBlock = await loadThingsToDo('destinations', 'croatia', admin)
  expect('ON: the page shows the card and the search button', onBlock.cards.length === 1 && onBlock.searches.length === 1)
  const off = await setLinkOnOff(admin, 'L1', false)
  expect('OFF switches the link and its search button', off.ok && off.status === 'hidden' && (w.tables.affiliate_links![0] as { status: string }).status === 'hidden' && (w.tables.affiliate_partners![0] as { status: string }).status === 'hidden')
  const offBlock = await loadThingsToDo('destinations', 'croatia', admin)
  expect('OFF: "Fun things to do" has neither the card nor the search button, and trip extras drop it', offBlock.cards.length === 0 && offBlock.searches.length === 0 && (await loadTripExtras(false, admin)).length === 0)
  const on = await setLinkOnOff(admin, 'L1', true)
  expect('ON again brings everything back', on.ok && on.status === 'active' && (await loadThingsToDo('destinations', 'croatia', admin)).cards.length === 1 && (await loadTripExtras(false, admin)).length === 1)
  const adopted = world()
  adopted.tables.affiliate_links![0] = linkRow({ partner_id: null })
  await setLinkOnOff(fakeAdmin(adopted), 'L1', false)
  expect('OFF also reaches a partner that is only matched by name', (adopted.tables.affiliate_partners![0] as { status: string }).status === 'hidden')
  const gone = await setLinkOnOff(admin, 'nope', true)
  expect('ON/OFF of a link that is gone is a 404, not a crash', !gone.ok && gone.status === 404)
  const del = world()
  await hidePartnerOfLink(fakeAdmin(del), 'L1')
  expect('deleting a link hides its search button but keeps the partner row', (del.tables.affiliate_partners![0] as { status: string }).status === 'hidden' && del.tables.affiliate_partners!.length === 1)

  // ---------- 4. routes ----------
  const linksRoute = read('app/api/admin/affiliate-links/route.ts')
  const idRoute = read('app/api/admin/affiliate-links/[id]/route.ts')
  const partnerRoute = read('app/api/admin/affiliate-partners/route.ts')
  const partnerIdRoute = read('app/api/admin/affiliate-partners/[id]/route.ts')
  for (const [name, src] of [['links', linksRoute], ['links/[id]', idRoute], ['partners', partnerRoute], ['partners/[id]', partnerIdRoute]] as const) {
    const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|DELETE)\(request: Request[^)]*\) \{\r?\n  if \(!isAuthorized\(request\)\)/g)].length
    const declared = [...src.matchAll(/export async function (GET|POST|PATCH|DELETE)\(/g)].length
    expect(`${name}: every handler checks isAuthorized first`, handlers === declared && declared > 0)
  }
  expect('create, edit, ON, OFF, delete and the partner writes all refresh the whole site', /refreshAfterChange/.test(linksRoute) && (idRoute.match(/refreshAfterChange\(admin\)/g) ?? []).length === 3 && /refreshAfterChange\(admin\)/.test(partnerRoute) && (partnerIdRoute.match(/refreshAfterChange\(admin\)/g) ?? []).length === 2)
  expect('the list read keeps card clicks and partner clicks in separate queries', /not\('link_id', 'is', null\)/.test(linksRoute) && /not\('partner_id', 'is', null\)/.test(linksRoute))
  const { GET, POST } = await import('../app/api/admin/affiliate-links/route')
  const { PATCH, DELETE } = await import('../app/api/admin/affiliate-links/[id]/route')
  const { PATCH: pPatch } = await import('../app/api/admin/affiliate-partners/[id]/route')
  const anon = () => new Request('http://localhost/api/admin/affiliate-links', { method: 'POST', body: '{}' })
  const codes = await Promise.all([GET(anon()), POST(anon()), PATCH(anon(), { params: { id: 'x' } }), DELETE(anon(), { params: { id: 'x' } }), pPatch(anon(), { params: { id: 'x' } })].map((p) => p.then((r) => r.status)))
  expect('without an admin token the list routes answer 401', codes.every((c) => c === 401), codes.join())
  expect('ON/OFF is a status-only PATCH that accepts only active or hidden', /keys\.length === 1 && keys\[0\] === 'status'/.test(idRoute) && /wanted !== 'active' && wanted !== 'hidden'/.test(idRoute))

  // ---------- 5. the page ----------
  const page = read('app/admin/affiliate-links/page.tsx')
  const visible = page.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  expect('one table called Affiliate links; no separate Partners section', /<caption[^>]*>Affiliate links<\/caption>/.test(page) && !/Partners<\/h2>|Add a partner|Edit partner|Save partner|Create partner/.test(page) && (page.match(/<table/g) ?? []).length === 1)
  expect('columns: name, where it goes, category, linked words, clicks, ON/OFF, actions', ['Name', 'Where it goes', 'Category', 'Linked words', 'Clicks', 'ON / OFF', 'Actions'].every((c) => new RegExp(`<th[^>]*>${c}</th>`).test(page)))
  expect('every row has ON, OFF, Edit and Link a word buttons, and Delete asks first', /> ON<\/button>|>ON<\/button>/.test(page) && />OFF<\/button>/.test(page) && /Edit<\/Button>/.test(page) && /Link a word<\/Button>/.test(page) && /confirm\(`Delete/.test(page) && (page.match(/confirm\(/g) ?? []).length === 1)
  expect('the words Draft, Hidden and Active are never shown', !/>\s*(Draft|Hidden|Active)\b/.test(visible) && !/(Draft|Hidden|Active) \(/.test(visible) && !/<Badge[^>]*>\{[a-z.]*status\}/.test(visible))
  expect('the edit form has Name, URL, Category, Note, Photo link, Page, and the collapsed Advanced section with the former partner fields', ['htmlFor="name"', 'htmlFor="url"', 'htmlFor="category"', 'htmlFor="note"', 'htmlFor="image_url"', 'htmlFor="page"', 'Advanced: search button on guide pages', 'Partner ID', 'Search link', 'Logo link', 'Commission wording'].every((s) => page.includes(s)) && /useState\(false\)/.test(page) && /advancedOpen &&/.test(page))
  expect('the form has no status, sort order, merchant or partner dropdown', !/htmlFor="status"|htmlFor="sort_order"|htmlFor="merchant"|htmlFor="partner"/.test(page))
  expect('the word linker panel is on the same page', /<AffiliateWordLinker/.test(page) && /Link a word or phrase/.test(read('components/admin/affiliate-word-linker.tsx')))
  expect('category still shown with its data attribute (trip extras check)', /data-category=\{l\.category\}/.test(page) && /htmlFor="category"/.test(page))
  const newText = [page, read('components/admin/affiliate-word-linker.tsx'), read('lib/affiliate-link-partner.ts'), read('lib/affiliate-usage.ts'), read('lib/affiliate-linker.ts'), read('lib/affiliate-rules.ts'), read('lib/affiliate-refresh.ts'), read('components/affiliate-text.tsx'), read('supabase/migrations/0050_affiliate_keywords.sql')].join('\n')
  expect('no em dashes in the new text', !/—/.test(newText))
  expect('the admin UI uses plain English labels for the word linker', ['Word or phrase', 'Link it to', 'Where', 'Max per page', 'Preview', 'Save and turn on', 'Rescan the site', 'All pages', 'Guides and destinations', 'Blog posts'].every((s) => read('components/admin/affiliate-word-linker.tsx').includes(s)))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}
void main()
