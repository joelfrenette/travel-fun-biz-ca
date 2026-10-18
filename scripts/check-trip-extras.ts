// Offline check for the "Plan the extras for your trip" block: selection by category priority (max 4, one per
// category, active only, tours excluded), nothing for past trips, nothing without links or before migration 0049,
// rel attributes, disclosure, no invented text, en/fr/es keys, and admin writes degrading before 0049 like 0048.
// In-memory database only (scripts/fake-admin.ts), no network.
// Run: pnpm dlx tsx scripts/check-trip-extras.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fakeAdmin, type Db } from './fake-admin'
import { pickTripExtras, loadTripExtras, TRIP_EXTRA_CATEGORIES, MAX_TRIP_EXTRAS, type TripExtraLink } from '../lib/trip-extras'
import { TripExtras } from '../components/trip-extras'
import { DEFAULT_DISCLOSURE } from '../lib/affiliate-partners'
import { normalizeAffiliateLinkInput, saveLink, isMissingCategory, MIGRATION_0049_MESSAGE } from '../lib/affiliate-links-admin'
import { LINK_CATEGORIES, isLinkCategory } from '../lib/link-categories'
import { translate } from '../lib/i18n'

// tsx compiles this repo's JSX with the classic runtime, so React must be in scope.
;(globalThis as unknown as { React: typeof React }).React = React

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

let n = 0
const link = (category: string | null, extra: Partial<TripExtraLink> = {}): TripExtraLink => {
  n++
  return { id: `l${n}`, slug: `link-${n}`, status: 'active', url: `https://merchant${n}.shopco.com/a`, merchant: `Merchant ${n}`, title: `Title ${n}`, sort_order: n, note: null, category, ...extra }
}

async function main() {
  // ---------- 1. selection ----------
  expect('priority is insurance, transport, luggage, connectivity, stays; max 4', TRIP_EXTRA_CATEGORIES.join(',') === 'insurance,transport,luggage,connectivity,stays' && MAX_TRIP_EXTRAS === 4)
  const all = ['stays', 'connectivity', 'luggage', 'transport', 'insurance', 'tours', 'other'].map((c) => link(c))
  const picked = pickTripExtras(all)
  expect('seven categories give 4 cards in priority order (stays is cut)', picked.map((p) => p.category).join(',') === 'insurance,transport,luggage,connectivity', picked.map((p) => p.category).join(','))
  expect('tours are never picked', !pickTripExtras([link('tours'), link('tours')]).length)
  expect('other and uncategorised are never picked', pickTripExtras([link('other'), link(null)]).length === 0)
  const two = pickTripExtras([link('insurance', { sort_order: 5, title: 'Later' }), link('insurance', { sort_order: 1, title: 'First' }), link('insurance', { sort_order: 3, title: 'Mid' })])
  expect('at most one per category, the lowest sort_order wins', two.length === 1 && two[0].title === 'First')
  expect('draft and hidden links are never picked', pickTripExtras([link('insurance', { status: 'draft' }), link('transport', { status: 'hidden' })]).length === 0)
  expect('a draft is skipped for the next active one in the same category', (() => { const r = pickTripExtras([link('luggage', { status: 'draft', sort_order: 1, title: 'Draft one' }), link('luggage', { status: 'active', sort_order: 2, title: 'Live one' })]); return r.length === 1 && r[0].title === 'Live one' })())
  expect('a link without a real URL or slug is skipped', pickTripExtras([link('insurance', { url: 'https://' }), link('transport', { slug: null }), link('luggage', { url: 'https://example.com/REPLACE' })]).length === 0)
  expect('no links gives an empty list', pickTripExtras([]).length === 0)
  const withNote = pickTripExtras([link('insurance', { note: '  A note an admin wrote.  ' }), link('transport', { note: null }), link('luggage', { note: '   ' })])
  expect('the description is the stored note, trimmed, else none', withNote[0].note === 'A note an admin wrote.' && withNote[1].note === null && withNote[2].note === null)
  const m = pickTripExtras([link('insurance', { merchant: null, title: 'Only a title', slug: 'only-title' }), link('transport', { merchant: 'Only Merchant', title: null, slug: 'only-merchant' })])
  expect('title falls back to merchant and merchant to title (stored text only)', m[0].merchant === 'Only a title' && m[0].title === 'Only a title' && m[1].title === 'Only Merchant')
  expect('the button target is the /go short link', pickTripExtras([link('insurance', { slug: 'allianz-travel-insurance' })])[0].href === '/go/allianz-travel-insurance')

  // ---------- 2. loading ----------
  const rows = (): Db => ({
    tables: {
      affiliate_links: [
        { id: 'a', slug: 'allianz', status: 'active', url: 'https://allianz.shopco.com/x', merchant: 'Allianz', title: 'Travel insurance', sort_order: 1, note: null, category: 'insurance' },
        { id: 'b', slug: 'viator', status: 'active', url: 'https://viator.shopco.com/x', merchant: 'Viator', title: 'Tours', sort_order: 2, note: null, category: 'tours' },
        { id: 'c', slug: 'airhelp', status: 'draft', url: 'https://airhelp.shopco.com/x', merchant: 'AirHelp', title: 'Flight help', sort_order: 3, note: null, category: 'insurance' },
        { id: 'd', slug: 'bounce', status: 'active', url: 'https://bounce.shopco.com/x', merchant: 'Bounce', title: 'Luggage storage', sort_order: 4, note: 'Stored by the admin.', category: 'luggage' },
      ],
    },
  })
  const loaded = await loadTripExtras(false, fakeAdmin(rows()))
  expect('an upcoming trip gets only active, categorised, non-tours links', loaded.map((x) => x.id).join(',') === 'a,d', loaded.map((x) => x.id).join(','))
  expect('a past trip loads nothing (and asks the database nothing)', (await loadTripExtras(true, { from: () => { throw new Error('should not be called') } } as never)).length === 0)
  expect('nothing when there are no links at all', (await loadTripExtras(false, fakeAdmin({ tables: { affiliate_links: [] } }))).length === 0)
  expect('nothing before migration 0049 (the column cannot be read)', (await loadTripExtras(false, { from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'column affiliate_links.category does not exist' } }) }) }) }) } as never)).length === 0)
  expect('nothing when the client throws', (await loadTripExtras(false, { from: () => { throw new Error('relation does not exist') } } as never)).length === 0)

  // ---------- 3. rendering ----------
  const html = renderToStaticMarkup(React.createElement(TripExtras, { extras: loaded, language: 'en' }))
  expect('renders the heading and the neutral intro', html.includes('Plan the extras for your trip') && html.includes('Travellers often add these. Booking through our links costs you nothing extra.'))
  expect('each button goes through /go with sponsored nofollow noopener and a new tab', (html.match(/rel="sponsored nofollow noopener"/g) ?? []).length === loaded.length && (html.match(/target="_blank"/g) ?? []).length === loaded.length && html.includes('href="/go/allianz"') && html.includes('href="/go/bounce"'))
  expect('the button says View on <Merchant>', html.includes('View on Allianz') && html.includes('View on Bounce'))
  expect('the commission disclosure is visible', html.includes(DEFAULT_DISCLOSURE) && html.includes('data-affiliate-disclosure'))
  expect('the note is shown only where one is stored (one note paragraph for two cards)', html.includes('Stored by the admin.') && (html.match(/<p class="text-sm text-muted-foreground">/g) ?? []).length === 1)
  // Every visible text node must be a stored value, a fixed UI string, or the disclosure.
  const allowed = ['Plan the extras for your trip', 'Travellers often add these. Booking through our links costs you nothing extra.', DEFAULT_DISCLOSURE, 'Allianz', 'Travel insurance', 'View on Allianz', 'Bounce', 'Luggage storage', 'Stored by the admin.', 'View on Bounce']
  const texts = html.replace(/<svg[\s\S]*?<\/svg>/g, '').split(/<[^>]+>/).map((s) => s.trim()).filter(Boolean)
  expect('no invented text: every text node is stored data or a fixed string', texts.every((t) => allowed.includes(t)), JSON.stringify(texts.filter((t) => !allowed.includes(t))))
  expect('no claims or urgency wording in the component', !/cover(s|age)|medical|reimburs|guarantee|best price|cheap|limited time|hurry|don't miss|only \d|% off|save \$/i.test((read('components/trip-extras.tsx') + read('lib/trip-extras.ts')).replace(/\/\/.*$/gm, '')))
  expect('renders nothing with no extras', renderToStaticMarkup(React.createElement(TripExtras, { extras: [], language: 'en' })) === '')
  expect('no em dashes in the new text', !/—/.test(read('components/trip-extras.tsx') + read('lib/trip-extras.ts') + read('lib/link-categories.ts') + read('supabase/migrations/0049_affiliate_category.sql')))

  // ---------- 4. languages ----------
  for (const key of ['Plan the extras for your trip', 'Travellers often add these. Booking through our links costs you nothing extra.', 'View on {partner}', DEFAULT_DISCLOSURE]) {
    expect(`fr and es have: ${key.slice(0, 40)}`, translate('fr', key) !== key && translate('es', key) !== key && translate('en', key) === key)
  }
  const fr = renderToStaticMarkup(React.createElement(TripExtras, { extras: loaded, language: 'fr' }))
  expect('the French block is translated, and the stored merchant name stays as stored', fr.includes('Planifiez les extras de votre voyage') && fr.includes('Voir sur Allianz'))

  // ---------- 5. trip page wiring ----------
  const page = read('app/packages/[slug]/page.tsx')
  expect('trip page loads extras in its parallel fetch, given the past-trip flag', /loadTripExtras\(isPastTrip\)/.test(page))
  expect('trip page renders the block for upcoming trips only', /\{!isPastTrip && <TripExtras extras=\{tripExtras\} language=\{language\} \/>\}/.test(page))
  expect('the component is a server component with no handlers', !/use client|onClick|onChange|useState/.test(read('components/trip-extras.tsx')))

  // ---------- 6. admin: category validation ----------
  const L = (extra: Record<string, unknown> = {}) => normalizeAffiliateLinkInput({ url: 'https://merchant.shopco.com/a', title: 'T', ...extra })
  expect('categories list matches the migration check', LINK_CATEGORIES.length === 7 && LINK_CATEGORIES.every((c) => read('supabase/migrations/0049_affiliate_category.sql').includes(`'${c}'`)))
  expect('admin: a valid category is kept, case and spaces normalised', (() => { const r = L({ category: ' Insurance ' }); return r.ok && r.value.category === 'insurance' })())
  expect('admin: empty or missing category is null', (() => { const a = L({ category: '' }); const b = L(); return a.ok && a.value.category === null && b.ok && b.value.category === null })())
  expect('admin: an unknown category is refused', !L({ category: 'cruises' }).ok && !isLinkCategory('cruises'))
  const listSrc = read('app/admin/affiliate-links/page.tsx')
  expect('admin form has a Category dropdown and the list shows it', /htmlFor="category"/.test(listSrc) && /data-category=\{l\.category\}/.test(listSrc))
  expect('admin routes still check isAuthorized first', /isAuthorized\(request\)/.test(read('app/api/admin/affiliate-links/route.ts')) && /isAuthorized\(request\)/.test(read('app/api/admin/affiliate-links/[id]/route.ts')))

  // ---------- 7. before migration 0049: writes degrade like 0048 ----------
  const noCat = (o: Record<string, unknown>) => ('category' in o ? 'column "category" of relation "affiliate_links" does not exist' : null)
  const pre = (): Db => ({ tables: { affiliate_links: [{ id: 'old1', slug: 'old-one', url: 'https://old-shop.shopco.com/a', status: 'draft', sort_order: 0 }] }, rejectInsert: (t, r) => (t === 'affiliate_links' ? noCat(r) : null), rejectUpdate: (t, p) => (t === 'affiliate_links' ? noCat(p) : null) })
  const plain = L({ title: 'Plain' })
  const withNote2 = L({ title: 'With note', note: 'hello' })
  const withCat = L({ title: 'Categorised', category: 'insurance' })
  if (plain.ok && withNote2.ok && withCat.ok) {
    const d1 = pre()
    const created = await saveLink(fakeAdmin(d1), plain.value)
    expect('before 0049: creating a link with no category still works (retried without it)', created.ok && (d1.tables.affiliate_links ?? []).length === 2 && !('category' in (d1.tables.affiliate_links![1] as object)))
    const d2 = pre()
    const withNew = await saveLink(fakeAdmin(d2), withNote2.value)
    expect('before 0049: the 0048 fields are still saved (only category is dropped)', withNew.ok && (d2.tables.affiliate_links![1] as { note?: string }).note === 'hello' && !('category' in (d2.tables.affiliate_links![1] as object)))
    const d3 = pre()
    const edited = await saveLink(fakeAdmin(d3), { ...plain.value, slug: 'old-one', status: 'active' }, 'old1')
    expect('before 0049: editing an existing link works', edited.ok && (d3.tables.affiliate_links![0] as { status: string }).status === 'active')
    const blocked = await saveLink(fakeAdmin(pre()), withCat.value)
    expect('before 0049: setting a category is a clear 409, not silently dropped', !blocked.ok && blocked.status === 409 && blocked.error === MIGRATION_0049_MESSAGE && /migration 0049/.test(blocked.error))
    const blockedEdit = await saveLink(fakeAdmin(pre()), withCat.value, 'old1')
    expect('before 0049: editing with a category is also a 409', !blockedEdit.ok && blockedEdit.status === 409)
    // Before 0048 as well: no category, no new fields still works; a category is the 0049 409.
    const noBoth = (o: Record<string, unknown>) => (['partner_id', 'guide_kind', 'guide_slug', 'image_url', 'note', 'category'].some((k) => k in o) ? 'column "note" of relation "affiliate_links" does not exist' : null)
    const old = (): Db => ({ tables: { affiliate_links: [] }, rejectInsert: (t, r) => (t === 'affiliate_links' ? noBoth(r) : null) })
    const dOld = old()
    expect('before 0048 and 0049: a plain link still saves', (await saveLink(fakeAdmin(dOld), plain.value)).ok && dOld.tables.affiliate_links!.length === 1)
    const oldCat = await saveLink(fakeAdmin(old()), withCat.value)
    expect('before 0048 and 0049: a category is refused with a 409', !oldCat.ok && oldCat.status === 409)
    const other = await saveLink(fakeAdmin({ tables: {}, failWrites: { affiliate_links: 'connection reset' } }), withCat.value)
    expect('an unrelated database error is still a 500', !other.ok && other.status === 500)
  }
  expect('missing-category detector matches column errors only', isMissingCategory('column "category" of relation "affiliate_links" does not exist') && isMissingCategory("Could not find the 'category' column of 'affiliate_links' in the schema cache") && !isMissingCategory('duplicate key value violates unique constraint') && !isMissingCategory('column "note" does not exist'))
  expect('the migration is additive and idempotent', /add column if not exists category/.test(read('supabase/migrations/0049_affiliate_category.sql')) && /create index if not exists/.test(read('supabase/migrations/0049_affiliate_category.sql')) && !/drop |delete |truncate /i.test(read('supabase/migrations/0049_affiliate_category.sql')))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}
void main()
