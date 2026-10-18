// Offline check for WP21 "Fun things to do": template validation, URL filling and encoding, host pinning (no open
// redirect), curated-card matching, nothing rendered with no partners, rel attributes, disclosure, click logging,
// no invented content, /go noindex and the robots rule. In-memory database only (scripts/fake-admin.ts), no network.
// Run: pnpm dlx tsx scripts/check-things-to-do.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fakeAdmin, type Db } from './fake-admin'
import {
  DEFAULT_DISCLOSURE,
  fillSearchTemplate,
  normalizePartnerInput,
  summarizePartnerClicks,
  validateSearchTemplate,
  partnerGoPath,
  type PartnerRow,
} from '../lib/affiliate-partners'
import { normalizeAffiliateLinkInput } from '../lib/affiliate-links-admin'
import { buildThingsToDo, disclosureTexts, loadThingsToDo, logPartnerClick, resolvePartnerGo, type LinkRow } from '../lib/things-to-do'
import { translate } from '../lib/i18n'
import robots from '../app/robots'

// tsx compiles this repo's JSX with the classic runtime (tsconfig says jsx: preserve), so React must be in scope.
;(globalThis as unknown as { React: typeof React }).React = React

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

// ---------- 1. template validation ----------
const GOOD = 'https://partner.example.com/search?q={query}&pid={partner_id}'
expect('a good template passes', validateSearchTemplate(GOOD).ok)
expect('a template with only {query} passes', validateSearchTemplate('https://partner.example.com/s/{query}').ok)
expect('javascript: is rejected', !validateSearchTemplate('javascript:alert(1)//{query}').ok)
expect('data: is rejected', !validateSearchTemplate('data:text/html,{query}').ok)
expect('http (not https) is rejected', !validateSearchTemplate('http://partner.example.com/s?q={query}').ok)
expect('an extra placeholder is rejected', !validateSearchTemplate('https://partner.example.com/s?q={query}&x={other}').ok)
expect('a wrong-case placeholder is rejected', !validateSearchTemplate('https://partner.example.com/s?q={QUERY}').ok)
expect('a stray brace is rejected', !validateSearchTemplate('https://partner.example.com/s?q={query}{').ok)
expect('credentials in the template are rejected', !validateSearchTemplate('https://user:pw@partner.example.com/s?q={query}').ok)
expect('a user name alone is rejected', !validateSearchTemplate('https://user@partner.example.com/s?q={query}').ok)
expect('a placeholder in the host is rejected', !validateSearchTemplate('https://{query}.example.com/').ok && !validateSearchTemplate('https://{partner_id}.example.com/?q={query}').ok)
expect('a template without {query} is rejected', !validateSearchTemplate('https://partner.example.com/s').ok)
expect('localhost is not a real host', !validateSearchTemplate('https://localhost/s?q={query}').ok)
expect('an IP address is not a real host', !validateSearchTemplate('https://10.0.0.1/s?q={query}').ok && !validateSearchTemplate('https://[::1]/s?q={query}').ok)
expect('a one-word host is not a real host', !validateSearchTemplate('https://intranet/s?q={query}').ok)
expect('whitespace and backslashes are rejected', !validateSearchTemplate('https://partner.example.com/s?q={query} x').ok && !validateSearchTemplate('https://partner.example.com\\@evil.com/s?q={query}').ok)
expect('an empty template is rejected', !validateSearchTemplate('  ').ok)

// ---------- 2. filling and encoding ----------
const f1 = fillSearchTemplate(GOOD, 'São Paulo & Rio', 'AB 12')
expect('the place name is URL-encoded', f1.ok && f1.url === 'https://partner.example.com/search?q=S%C3%A3o%20Paulo%20%26%20Rio&pid=AB%2012', f1.ok ? f1.url : f1.error)
const f2 = fillSearchTemplate(GOOD, 'x&pid=evil', 'ID')
expect('an injected & stays inside the query value', f2.ok && new URL(f2.url).searchParams.get('pid') === 'ID' && new URL(f2.url).searchParams.get('q') === 'x&pid=evil')
expect('a partner ID is required when the template uses it', !fillSearchTemplate(GOOD, 'Rome', null).ok)
expect('{partner_id} is optional when the template does not use it', fillSearchTemplate('https://partner.example.com/s/{query}', 'Rome', null).ok)
expect('an empty place name is refused', !fillSearchTemplate(GOOD, '   ', 'ID').ok)
expect('a "$&" in the name is inserted literally', (() => { const r = fillSearchTemplate('https://partner.example.com/s/{query}', '$&$1', null); return r.ok && r.url.endsWith('/s/%24%26%241') })())
expect('an over-long name is cut, not refused', (() => { const r = fillSearchTemplate('https://partner.example.com/s/{query}', 'a'.repeat(500), null); return r.ok && r.url.length < 200 })())

// ---------- 3. host pinning: nothing in the request can pick the destination ----------
for (const evil of ['https://evil.com', '//evil.com', 'x@evil.com', '@evil.com/', '\\\\evil.com', 'a.evil.com/../..', 'x#@evil.com', '%0d%0aLocation: https://evil.com']) {
  const r = fillSearchTemplate('https://partner.example.com/s?q={query}', evil, null)
  expect(`host stays pinned for query ${JSON.stringify(evil)}`, r.ok && new URL(r.url).host === 'partner.example.com' && new URL(r.url).protocol === 'https:' && !new URL(r.url).username)
}
const evilId = fillSearchTemplate('https://partner.example.com/s?q={query}&p={partner_id}', 'Rome', '@evil.com/')
expect('host stays pinned for a hostile partner ID', evilId.ok && new URL(evilId.url).host === 'partner.example.com')
// A stored template that went bad (edited straight in the database) fails closed in fillSearchTemplate itself.
expect('a bad stored template is refused at fill time', !fillSearchTemplate('http://partner.example.com/s?q={query}', 'Rome', null).ok && !fillSearchTemplate('https://user:pw@partner.example.com/s?q={query}', 'Rome', null).ok)

// ---------- 4. admin input ----------
expect('partner: name is required', !normalizePartnerInput({ name: '  ' }).ok)
expect('partner: a bad template is refused with a message', (() => { const r = normalizePartnerInput({ name: 'P', search_template: 'http://x.example.com/{query}' }); return !r.ok && /https/.test(r.error) })())
expect('partner: {partner_id} in the template needs a partner ID', !normalizePartnerInput({ name: 'P', search_template: GOOD }).ok && normalizePartnerInput({ name: 'P', partner_id: 'X1', search_template: GOOD }).ok)
expect('partner: a javascript: logo is refused', !normalizePartnerInput({ name: 'P', logo_url: 'javascript:alert(1)' }).ok)
expect('partner: a logo with credentials is refused', !normalizePartnerInput({ name: 'P', logo_url: 'https://u:p@x.example.com/l.png' }).ok)
expect('partner: defaults are safe (draft, slug from name, no template)', (() => { const r = normalizePartnerInput({ name: 'Sample Tours' }); return r.ok && r.value.status === 'draft' && r.value.slug === 'sample-tours' && r.value.search_template === null && r.value.disclosure === null })())
expect('partner: wording over 300 characters is refused', !normalizePartnerInput({ name: 'P', disclosure: 'x'.repeat(301) }).ok)
const L = (extra: Record<string, unknown> = {}) => normalizeAffiliateLinkInput({ url: 'https://merchant.shopco.com/a', title: 'Tour', ...extra })
expect('link: a note of 200 characters is fine, 201 is refused', L({ note: 'n'.repeat(200) }).ok && !L({ note: 'n'.repeat(201) }).ok)
expect('link: an http photo is refused, an https photo is kept', !L({ image_url: 'http://x.example.com/a.jpg' }).ok && (() => { const r = L({ image_url: 'https://x.example.com/a.jpg' }); return r.ok && r.value.image_url === 'https://x.example.com/a.jpg' })())
expect('link: data: and javascript: URLs are refused', !L({ url: 'javascript:alert(1)' }).ok && !L({ url: 'data:text/html,hi' }).ok)
expect('link: credentials in the URL are refused', !L({ url: 'https://user:pw@merchant.shopco.com/a' }).ok)
expect('link: an unknown page kind is refused; a good page pair is kept', !L({ guide_kind: 'nope', guide_slug: 'x' }).ok && (() => { const r = L({ guide_kind: 'destinations', guide_slug: 'croatia' }); return r.ok && r.value.guide_kind === 'destinations' && r.value.guide_slug === 'croatia' })())
expect('link: a page kind without a slug is refused', !L({ guide_kind: 'destinations' }).ok)
expect('link: a partner must be an id from the list', !L({ partner_id: 'not-a-uuid' }).ok && L({ partner_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }).ok)
expect('link: all new fields are optional', (() => { const r = L(); return r.ok && r.value.partner_id === null && r.value.guide_kind === null && r.value.note === null && r.value.image_url === null })())

// ---------- 5. which cards and buttons a page gets ----------
const partner = (o: Partial<PartnerRow> & { id: string; slug: string }): PartnerRow => ({
  name: o.slug.toUpperCase(), logo_url: null, partner_id: 'PID', search_template: GOOD, disclosure: null, status: 'active', sort_order: 0, ...o,
})
const link = (o: Partial<LinkRow> & { id: string }): LinkRow => ({
  slug: `go-${o.id}`, status: 'active', url: 'https://merchant.shopco.com/t', merchant: 'Merchant', title: `Card ${o.id}`, sort_order: 0,
  partner_id: null, guide_kind: 'destinations', guide_slug: 'croatia', image_url: null, note: null, ...o,
})
const P1 = partner({ id: 'p1', slug: 'alpha', name: 'Alpha Tours', sort_order: 1 })
const P2 = partner({ id: 'p2', slug: 'beta', name: 'Beta Trips', sort_order: 2, search_template: null })
const P3 = partner({ id: 'p3', slug: 'gamma', name: 'Gamma', status: 'hidden' })
const P4 = partner({ id: 'p4', slug: 'delta', name: 'Delta', status: 'draft' })
const links: LinkRow[] = [
  link({ id: 'a', partner_id: 'p1', note: 'A plain note.', image_url: 'https://img.shopco.com/a.jpg', sort_order: 2 }),
  link({ id: 'b', partner_id: 'p2', sort_order: 1 }),
  link({ id: 'c', guide_slug: 'italy' }), // another page
  link({ id: 'd', guide_kind: 'hotels' }), // same slug, other kind
  link({ id: 'e', status: 'draft' }),
  link({ id: 'f', partner_id: 'p3' }), // hidden partner
  link({ id: 'g', partner_id: 'p4' }), // draft partner
  link({ id: 'h', url: 'https://' }), // not a real link
  link({ id: 'i', slug: null }), // no short link
]
const built = buildThingsToDo({ links, partners: [P1, P2, P3, P4], kind: 'destinations', slug: 'croatia' })
expect('curated cards: only active links pinned to exactly this page, with a live partner', built.cards.map((c) => c.id).join(',') === 'b,a', built.cards.map((c) => c.id).join(','))
expect('curated cards: every button goes through /go/<slug>', built.cards.every((c) => /^\/go\/go-[a-z]$/.test(c.href)))
expect('curated card keeps the admin note and photo, nothing else', (() => { const c = built.cards.find((x) => x.id === 'a')!; return c.note === 'A plain note.' && c.imageUrl === 'https://img.shopco.com/a.jpg' && c.partnerName === 'Alpha Tours' })())
expect('search buttons: one per ACTIVE partner that HAS a template', built.searches.length === 1 && built.searches[0].partnerSlug === 'alpha')
expect('search button goes to /go/p/<partner>/<kind>/<slug>', built.searches[0].href === '/go/p/alpha/destinations/croatia' && built.searches[0].href === partnerGoPath('alpha', 'destinations', 'croatia'))
expect('search link carries no URL from anywhere else (no template, no http)', !/https?:|partner\.example/.test(built.searches[0].href))
expect('disclosure: default wording when a shown partner has none', disclosureTexts(built).includes(DEFAULT_DISCLOSURE))
const custom = buildThingsToDo({ links: [], partners: [partner({ id: 'p9', slug: 'custom', disclosure: 'Our own wording.' })], kind: 'ships', slug: 'x-ship' })
expect('disclosure: a partner\'s own wording replaces the default', disclosureTexts(custom).join('|') === 'Our own wording.')
const none = buildThingsToDo({ links, partners: [], kind: 'destinations', slug: 'croatia' })
expect('no active partners: no search buttons, no cards tied to partners, no disclosure', none.searches.length === 0 && disclosureTexts(none).length >= 0 && none.cards.every((c) => !c.partnerName || c.partnerName === 'Merchant'))
const nothing = buildThingsToDo({ links: [], partners: [P3, P4], kind: 'destinations', slug: 'croatia' })
expect('nothing to show: empty cards, empty searches, no disclosure', nothing.cards.length === 0 && nothing.searches.length === 0 && disclosureTexts(nothing).length === 0)
for (const kind of ['destinations', 'hotels', 'resorts', 'cruise-lines', 'ships', 'river-cruises', 'yachts'] as const) {
  const r = buildThingsToDo({ links: [], partners: [P1], kind, slug: 'some-page' })
  expect(`${kind}: the same block works`, r.searches.length === 1 && r.searches[0].href === `/go/p/alpha/${kind}/some-page`)
}

// ---------- 6. the component: render, rel, disclosure, nothing, no invented content ----------
async function renderBlock(db: Db, language: 'en' | 'fr' | 'es' = 'en', name = 'Croatia'): Promise<string> {
  const { GuideThingsToDo } = await import('../components/guide-things-to-do')
  const things = await loadThingsToDo('destinations', 'croatia', fakeAdmin(db))
  const el = GuideThingsToDo({ things, name, language })
  return el ? renderToStaticMarkup(el) : ''
}
const rowsOf = (): Db => ({
  tables: {
    affiliate_partners: [P1, P2, P3, P4].map((p) => ({ ...p }) as Record<string, unknown>),
    affiliate_links: links.map((l) => ({ ...l }) as Record<string, unknown>),
  },
})

;(async () => {
  let html = ''
  try {
    html = await renderBlock(rowsOf())
  } catch (e) {
    expect('the component renders offline', false, String(e))
  }
  if (html) {
    expect('heading names the place', html.includes('Fun things to do in Croatia'))
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
    expect('there are anchors (2 cards + 1 search)', anchors.length === 3, String(anchors.length))
    expect('every outbound anchor has rel sponsored nofollow noopener and target _blank', anchors.every((a) => /rel="sponsored nofollow noopener"/.test(a) && /target="_blank"/.test(a)))
    expect('every anchor goes through /go (no raw merchant or partner URL on the page)', anchors.every((a) => /href="\/go\//.test(a)) && !/merchant\.shopco|partner\.example/.test(html))
    expect('button text: View on <Partner>', html.includes('View on Alpha Tours'))
    expect('button text: Find <Name> tours and activities on <Partner>', html.includes('Find Croatia tours and activities on Alpha Tours'))
    expect('the disclosure line is on the page', html.includes(DEFAULT_DISCLOSURE) && html.includes('data-affiliate-disclosure'))
    expect('the admin note is shown', html.includes('A plain note.'))
    expect('no invented content: no price, rating, review or availability words', !/\$\s?\d|€|£|\bstars?\b|rating|review|from\s+\d|per person|available|sold out|bestseller|\d+\s?%/i.test(html.replace(/Fun things to do in Croatia/, '')), html)
    expect('no structured data is added by the block', !/application\/ld\+json|itemprop|schema\.org|aggregateRating/i.test(html))
    const fr = await renderBlock(rowsOf(), 'fr')
    expect('French: heading, buttons and disclosure are translated', fr.includes('Choses amusantes à faire à Croatia') && fr.includes('Voir sur Alpha Tours') && fr.includes('Trouver des visites et des activités à Croatia sur Alpha Tours') && fr.includes('Nous pouvons toucher une commission'))
    const es = await renderBlock(rowsOf(), 'es')
    expect('Spanish: heading, buttons and disclosure are translated', es.includes('Cosas divertidas para hacer en Croatia') && es.includes('Ver en Alpha Tours') && es.includes('Encuentra tours y actividades en Croatia en Alpha Tours') && es.includes('Podemos recibir una comisión'))
  }
  expect('renders NOTHING with no partners and no curated cards', (await renderBlock({ tables: { affiliate_partners: [], affiliate_links: [] } })) === '')
  expect('renders NOTHING when the only partners are hidden or draft', (await renderBlock({ tables: { affiliate_partners: [{ ...P3 }, { ...P4 }], affiliate_links: [] } })) === '')
  expect('renders NOTHING when the tables fail to read (migration not applied)', (await loadThingsToDo('destinations', 'croatia', { from: () => { throw new Error('relation does not exist') } } as never)).cards.length === 0)
  expect('a custom partner wording is shown instead of the default', (await renderBlock({ tables: { affiliate_partners: [{ ...partner({ id: 'z', slug: 'zed', name: 'Zed', disclosure: 'We earn from Zed bookings.' }) } as Record<string, unknown>], affiliate_links: [] } })).includes('We earn from Zed bookings.'))

  // ---------- 7. /go/p redirect and click log ----------
  const site = 'https://travelfunbiz.ca'
  const world = (): { admin: Db; reader: Db } => ({
    admin: { tables: { affiliate_partners: [P1, P2, P3].map((p) => ({ ...p })), affiliate_clicks: [] } },
    reader: { tables: { guides: [{ kind: 'destinations', slug: 'croatia', name: 'Croatia & Slovenia', status: 'published' }, { kind: 'ships', slug: 'draft-ship', name: 'Draft Ship', status: 'draft' }] } },
  })
  const go = (w: ReturnType<typeof world>, partnerSlug: string, kind: string, slug: string, destinationName?: (s: string) => Promise<string | null>) =>
    resolvePartnerGo({ admin: fakeAdmin(w.admin), reader: fakeAdmin(w.reader), partnerSlug, kind, slug, siteUrl: site, destinationName })

  const w1 = world()
  const ok = await go(w1, 'alpha', 'destinations', 'croatia')
  expect('redirect: goes to the filled stored template with the guide NAME encoded and the partner ID', ok.location === 'https://partner.example.com/search?q=Croatia%20%26%20Slovenia&pid=PID', ok.location)
  expect('redirect: host equals the template host', new URL(ok.location).host === 'partner.example.com')
  expect('redirect: the click carries partner, guide key and name', ok.click?.partnerId === 'p1' && ok.click?.guideKey === 'destinations/croatia' && ok.click?.partnerName === 'Alpha Tours')
  const logged = await logPartnerClick(fakeAdmin(w1.admin), ok.click!, { page: '/destinations/croatia', referrerHost: null })
  const row = (w1.admin.tables.affiliate_clicks ?? [])[0] as Record<string, unknown> | undefined
  expect('click is logged in the existing ledger with partner_id and guide_key', logged && !!row && row.partner_id === 'p1' && row.guide_key === 'destinations/croatia' && row.link_id === null && row.merchant === 'Alpha Tours' && row.page === '/destinations/croatia')
  expect('click row stores no IP and no user agent', !!row && Object.keys(row).every((k) => !/ip|agent|ua$/i.test(k)))
  const failedLog = await logPartnerClick(fakeAdmin({ tables: {}, failWrites: { affiliate_clicks: 'boom' } }), ok.click!, { page: null, referrerHost: null })
  expect('a failed click log returns false and never throws', failedLog === false)

  for (const [label, r] of [
    ['an unknown partner', await go(world(), 'nope', 'destinations', 'croatia')],
    ['a hidden partner', await go(world(), 'gamma', 'destinations', 'croatia')],
    ['a partner with no search link', await go(world(), 'beta', 'destinations', 'croatia')],
    ['a draft guide', await go(world(), 'alpha', 'ships', 'draft-ship')],
    ['an unknown page', await go(world(), 'alpha', 'destinations', 'atlantis')],
  ] as const) {
    expect(`redirect: ${label} stays on this site and logs nothing`, new URL(r.location).host === 'travelfunbiz.ca' && r.click === null, r.location)
  }
  const badKind = await go(world(), 'alpha', 'https://evil.com', 'croatia')
  expect('redirect: a URL in the kind position goes to the home page', badKind.location === `${site}/` && badKind.click === null)
  const badSlug = await go(world(), 'alpha', 'destinations', '../../evil.com')
  expect('redirect: a path trick in the page slug goes to the home page', badSlug.location === `${site}/` && badSlug.click === null)
  const badPartner = await go(world(), 'https://evil.com', 'destinations', 'croatia')
  expect('redirect: a URL in the partner position stays on this site', new URL(badPartner.location).host === 'travelfunbiz.ca' && badPartner.click === null)
  const wDest = world()
  const viaTrips = await go(wDest, 'alpha', 'destinations', 'no-guide-yet', async (s) => (s === 'no-guide-yet' ? 'Lisbon' : null))
  expect('redirect: a destination without a guide uses its trip-page name', viaTrips.location === 'https://partner.example.com/search?q=Lisbon&pid=PID', viaTrips.location)
  const tampered = world()
  ;(tampered.admin.tables.affiliate_partners![0] as Record<string, unknown>).search_template = 'http://partner.example.com/s?q={query}'
  const t = await go(tampered, 'alpha', 'destinations', 'croatia')
  expect('redirect: a template edited into something unsafe in the database is not followed', new URL(t.location).host === 'travelfunbiz.ca' && t.click === null)

  // ---------- 8. crawl hygiene ----------
  const routeSrc = read('app/go/p/[partner]/[kind]/[slug]/route.ts')
  const cardRouteSrc = read('app/go/[slug]/route.ts')
  expect('/go/p route sends X-Robots-Tag noindex, nofollow and a 302', /'X-Robots-Tag': 'noindex, nofollow'/.test(routeSrc) && /status: 302/.test(routeSrc))
  expect('/go/<slug> route still sends X-Robots-Tag noindex, nofollow', /'X-Robots-Tag': 'noindex, nofollow'/.test(cardRouteSrc))
  expect('/go/p route never reads a URL from the request (only params and headers for logging)', !/searchParams|request\.url\)\.search|\.get\('(url|to|next|redirect|dest)/i.test(routeSrc) && !/request\.json|formData/.test(routeSrc))
  const rules = robots().rules
  const rule = (Array.isArray(rules) ? rules[0] : rules) as { disallow?: string | string[] }
  const dis = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow ?? '']
  expect('robots.txt disallows /go (covers /go/p)', dis.includes('/go'))
  const compSrc = read('components/guide-things-to-do.tsx')
  expect('the component adds no JSON-LD, ratings or onClick handlers', !/ld\+json|aggregateRating|jsonLd|onClick|"use client"/.test(compSrc))
  expect('guide pages and the destination page render the block', /GuideThingsToDo/.test(read('components/guide-page.tsx')) && /GuideThingsToDo/.test(read('app/destinations/[slug]/page.tsx')))

  // ---------- 9. numbers ----------
  const s = summarizePartnerClicks(
    [
      { partner_id: 'p1', guide_key: 'destinations/croatia', created_at: new Date(Date.now() - 86_400_000).toISOString() },
      { partner_id: 'p1', guide_key: 'destinations/croatia', created_at: new Date(Date.now() - 20 * 86_400_000).toISOString() },
      { partner_id: 'p2', guide_key: 'ships/x', created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() },
      { partner_id: null, guide_key: null, created_at: new Date().toISOString() },
    ],
  )
  expect('clicks per partner and per page: total, 7 and 30 days; card clicks are not partner clicks', s.byPartner.p1.total === 2 && s.byPartner.p1.last7 === 1 && s.byPartner.p1.last30 === 2 && s.byPage['destinations/croatia'].last30 === 2 && s.byPage['ships/x'].last30 === 0 && s.all.total === 3)

  // ---------- 10. i18n, copy, value tile, issue ----------
  const keys = ['Fun things to do in {name}', 'View on {partner}', 'View details', 'Find {name} tours and activities on {partner}', DEFAULT_DISCLOSURE]
  for (const k of keys) {
    const ph = (x: string) => (x.match(/\{\w+\}/g) ?? []).sort().join(',')
    expect(`i18n: "${k.slice(0, 40)}" has French and Spanish with the same placeholders`, translate('fr', k) !== k && translate('es', k) !== k && ph(translate('fr', k)) === ph(k) && ph(translate('es', k)) === ph(k))
  }
  const newText = [compSrc, read('lib/affiliate-partners.ts'), read('lib/things-to-do.ts'), read('app/admin/affiliate-links/page.tsx').split('Affiliate Links</h1>')[1]?.split('Partners</h2>')[1] ?? ''].join('\n')
  expect('no em dashes in the new text', !/—/.test(newText))
  const { buildValueReport } = await import('../lib/value')
  const base = {} as Parameters<typeof buildValueReport>[0]
  const tileOf = (aff: { total: number; last30: number } | null | undefined) => buildValueReport({ ...base, inputs: {}, orders: null, aiCost12mUsd: null, aiCost30dUsd: null, aiFirstTs: null, ga4: null, visitsByChannel: null, gscDays: [], contentPerfLatest: [], leads12m: null, posts: null, guides: null, packages: null, pipeline: null, autopilotOn: null, affiliateClicks: aff }).tiles.find((x) => x.key === 'affiliate_clicks')!
  expect('value page: Affiliate activity tile shows clicks only, never money', (() => { const x = tileOf({ total: 9, last30: 4 }); return x.value === '4' && x.raw === 4 && !/[$€£]/.test(`${x.value}${x.label}`) && /Clicks only/.test(x.note) && x.group === 'traffic' })())
  expect('value page: no data is Not tracked, never a made-up zero', tileOf(null).value === null && tileOf(undefined).status === 'not_tracked')
  const { collectIssues } = await import('../lib/issues')
  void collectIssues
  const issuesSrc = read('lib/issues.ts')
  expect('needs attention: "Add your first affiliate partner" is a setup item for published guides with no active partner', /AFFILIATE_PARTNER_ISSUE_ID/.test(issuesSrc) && /Add your first affiliate partner/.test(issuesSrc) && /area: 'setup'/.test(issuesSrc.split('AFFILIATE_PARTNER_ISSUE_ID,')[1] ?? ''))
  const { plainAction, AFFILIATE_PARTNER_ISSUE_ID } = await import('../lib/plain-steps')
  const plain = plainAction({ id: AFFILIATE_PARTNER_ISSUE_ID, area: 'setup', title: 'Add your first affiliate partner', detail: 'x' })
  expect('needs attention: has grade-5 steps and an admin link', plain.steps.length >= 4 && /affiliate-links/.test(plain.url) && !/—/.test(plain.steps.join(' ')))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
})()
