// Offline check for WP23 "the word linker covers ALL public text". Behavioural: real builders, the real linker, the real
// components rendered to HTML, the real preview and usage report over an in-memory database. No network, no database.
// The only checks that read source files are the coverage ones (every renderer listed in the single list really calls the
// linker, and nothing calls it without being listed).
// Run: pnpm dlx tsx scripts/check-affiliate-text-sources.ts   (exit 1 on a failure)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { linkKeywords, linkTextParts, newLinkerState, MAX_LINKS_PER_PAGE, type AffiliateRule, type PageContext, type Part } from '../lib/affiliate-linker'
import { loadAffiliateRules, clearAffiliateRulesCache, rowsToRules } from '../lib/affiliate-rules'
import {
  SOURCE_FIELDS, EXCLUDED_TEXT, WHERE_WE_LOOK_TEXT, rendererFiles, whereWeLook, linkPageFields, fieldAsHtml, guideFieldSet, blogFieldSet, destinationBlurbFieldSet,
  tripFieldSet, pageCopyFieldSet, homeFieldSet, whoWeAreFieldSet, blogIndexFieldSet, guideIndexFieldSet, type LinkedFields, type TextField,
} from '../lib/affiliate-text-sources'
import {
  previewRule, buildUsageReport, loadUsageDocs, rescanSite, pageCopyIsUsable, staticUsageDocs, coverageSentence, breakdownLabel, MAX_USAGE_DOCS, PREVIEW_SHOWN, NO_PAGE_NOTICE, type UsageDoc,
} from '../lib/affiliate-usage'
import { createKeyword, previewKeyword } from '../lib/affiliate-keyword-actions'
import { resetUsageDebounce } from '../lib/affiliate-refresh'
import { AffiliateParts, AffiliateLinkified, AffiliateAutoDisclosure } from '../components/affiliate-text'
import { GuideTakeaways, linkedGuidePage } from '../components/guide-parts'
import { GuideHeaderActions } from '../components/guide-header-actions'
import { TripJournal } from '../components/trip-journal'
import { PageCopyIntro, PageCopyTakeaways, PageCopyFaq } from '../components/page-copy-parts'
import { FeaturesSection } from '../components/features-section'
import { fakeAdmin, type Db } from './fake-admin'

;(globalThis as unknown as { React: typeof React }).React = React

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

let n = 0
const rule = (phrase: string, slug = 'viator', extra: Partial<AffiliateRule> = {}): AffiliateRule => ({ id: `r${++n}`, phrase, slug, scope: 'all', max_per_page: 3, ...extra })
const count = (html: string) => (html.match(/data-affiliate-auto/g) ?? []).length
const P = 'Croatia tours'

// What a visitor's browser gets for one field.
function renderField(f: TextField, linked: LinkedFields): string {
  if (f.format === 'html') return linked.html(f)
  if (f.format === 'text') return renderToStaticMarkup(React.createElement(AffiliateParts, { parts: linked.parts(f) }))
  return renderToStaticMarkup(React.createElement(AffiliateLinkified, { parts: linked.linkified(f) }))
}
const renderAll = (fields: TextField[], linked: LinkedFields) => fields.map((f) => renderField(f, linked)).join('\n')
const link = (fields: TextField[], rules: AffiliateRule[] | null | undefined, ctx: PageContext) => linkPageFields(fields, rules, ctx)
const html = (value: string, key = 'blog.body'): TextField => ({ id: key, key, format: 'html', value })
const text = (value: string, key = 'blog.faq', id = key): TextField => ({ id, key, format: 'text', value })

async function main() {
  // ---------- 1. every field in the single list renders a link when the phrase is in it ----------
  type Case = { phrase: string; fields: TextField[]; ctx: PageContext }
  const guideBase = { summary: '', key_takeaways: [] as string[], body: '', faq: [] as { q: string; a: string }[] }
  const tripBase = { available_to: '2999-01-01', full_description: 'plain', short_description: null }
  const pastTrip = { ...tripBase, available_to: '2020-01-01' }
  const copyBase = { intro: 'plain intro', key_takeaways: [] as string[], faq: [] as { q: string; a: string }[] }
  const guideCase = (kind: 'guide' | 'destination', over: Partial<typeof guideBase>, mode: 'left' | 'right' = 'left'): Case => ({ phrase: P, fields: guideFieldSet({ ...guideBase, ...over }, kind, mode).fields, ctx: kind === 'guide' ? 'guides' : 'destinations' })
  const CASES: Record<string, Case> = {
    'blog.takeaways': { phrase: P, fields: blogFieldSet({ body: 'x', key_takeaways: [`${P} are great.`] }).fields, ctx: 'blog' },
    'blog.body': { phrase: P, fields: blogFieldSet({ body: `Try ${P} now.` }).fields, ctx: 'blog' },
    'blog.faq': { phrase: P, fields: blogFieldSet({ body: 'x', faq: [{ q: 'q?', a: `Yes, ${P}.` }] }).fields, ctx: 'blog' },
    'blog.more-stories': { phrase: P, fields: blogFieldSet({ body: 'x' }, { moreExcerpts: [`${P} for all`] }).fields, ctx: 'blog' },
    'guide.summary': guideCase('guide', { summary: `${P} here.` }),
    'guide.quick-facts': guideCase('guide', { key_takeaways: [`${P} are fun. Second.`] }),
    'guide.takeaways': guideCase('guide', { key_takeaways: [`Short first. ${P} second.`] }),
    'guide.body': guideCase('guide', { body: `Plan ${P} early.` }),
    'guide.faq': guideCase('guide', { faq: [{ q: 'q?', a: `Yes ${P}.` }] }),
    'destination.summary': guideCase('destination', { summary: `${P} here.` }),
    'destination.quick-facts': guideCase('destination', { key_takeaways: [`${P} are fun. Second.`] }, 'right'),
    'destination.takeaways': guideCase('destination', { key_takeaways: [`Short first. ${P} second.`] }),
    'destination.body': guideCase('destination', { body: `Plan ${P} early.` }),
    'destination.faq': guideCase('destination', { faq: [{ q: 'q?', a: `Yes ${P}.` }] }),
    'destination-trips.blurb': { phrase: P, fields: destinationBlurbFieldSet(`A land of ${P}.`).fields, ctx: 'destinations' },
    'trip.recap': { phrase: P, fields: tripFieldSet({ ...pastTrip, recap_summary: `We loved ${P}.` }).fields, ctx: 'trips' },
    'trip.recap-highlights': { phrase: P, fields: tripFieldSet({ ...pastTrip, recap_summary: 'ok', recap_highlights: [`${P} by boat`] }).fields, ctx: 'trips' },
    'trip.journal': { phrase: P, fields: tripFieldSet({ ...tripBase, journal_entries: [{ date: '2026-03-01', title: 't', body: `Day one of ${P}.` }] }).fields, ctx: 'trips' },
    'trip.description': { phrase: P, fields: tripFieldSet({ ...tripBase, full_description: `Join our ${P} today.\n\nSee [Spain](/packages/spain).` }).fields, ctx: 'trips' },
    'trip.highlights': { phrase: P, fields: tripFieldSet({ ...tripBase, highlights: [`${P} by boat`] }).fields, ctx: 'trips' },
    'trip.itinerary': { phrase: P, fields: tripFieldSet({ ...tripBase, itinerary: [{ day: 1, title: 'Arrive', description: `Start with ${P}.` }] }).fields, ctx: 'trips' },
    'trip.included': { phrase: P, fields: tripFieldSet({ ...tripBase, price_includes: `Hotel\n${P} guide` }).fields, ctx: 'trips' },
    'trip.not-included': { phrase: P, fields: tripFieldSet({ ...tripBase, not_included: `Flights\nExtra ${P}` }).fields, ctx: 'trips' },
    'trip.faq': { phrase: P, fields: tripFieldSet({ ...tripBase, ai_faqs: [{ question: 'Safe?', answer: `Yes, ${P} are safe.` }] }).fields, ctx: 'trips' },
    'best-time.intro': { phrase: P, fields: pageCopyFieldSet({ ...copyBase, intro: `Our ${P} run in June.` }, 'best-time').fields, ctx: 'pages' },
    'best-time.takeaways': { phrase: P, fields: pageCopyFieldSet({ ...copyBase, key_takeaways: [`${P} sell out.`] }, 'best-time').fields, ctx: 'pages' },
    'best-time.faq': { phrase: P, fields: pageCopyFieldSet({ ...copyBase, faq: [{ q: 'q?', a: `Yes ${P}.` }] }, 'best-time').fields, ctx: 'pages' },
    'compare.intro': { phrase: P, fields: pageCopyFieldSet({ ...copyBase, intro: `Our ${P} differ.` }, 'compare').fields, ctx: 'pages' },
    'compare.takeaways': { phrase: P, fields: pageCopyFieldSet({ ...copyBase, key_takeaways: [`${P} differ.`] }, 'compare').fields, ctx: 'pages' },
    'compare.faq': { phrase: P, fields: pageCopyFieldSet({ ...copyBase, faq: [{ q: 'q?', a: `Yes ${P}.` }] }, 'compare').fields, ctx: 'pages' },
    // The fixed sentences of the site: the phrase is a few words of the sentence itself.
    'home.hero': { phrase: 'group adventures', fields: homeFieldSet('en').fields, ctx: 'pages' },
    'home.features-intro': { phrase: 'dedicated experience concierge', fields: homeFieldSet('en').fields, ctx: 'pages' },
    'home.features': { phrase: 'experienced travel professionals', fields: homeFieldSet('en').fields, ctx: 'pages' },
    'home.contact': { phrase: 'dream vacation', fields: homeFieldSet('en').fields, ctx: 'pages' },
    'who-we-are.intro': { phrase: 'dating service', fields: whoWeAreFieldSet().fields, ctx: 'pages' },
    'who-we-are.sections': { phrase: 'matching algorithm', fields: whoWeAreFieldSet().fields, ctx: 'pages' },
    'who-we-are.closing': { phrase: 'Just ask', fields: whoWeAreFieldSet().fields, ctx: 'pages' },
    'blog-index.intro': { phrase: 'group trips', fields: blogIndexFieldSet().fields, ctx: 'pages' },
    'guide-index.intro': { phrase: 'plain-English guide', fields: guideIndexFieldSet('destinations', 'Destinations').fields, ctx: 'pages' },
  }
  for (const f of SOURCE_FIELDS) {
    const c = CASES[f.key]
    if (!c) {
      expect(`${f.key}: a behavioural case exists for every field in the single list`, false, 'add a case to CASES')
      continue
    }
    const linked = link(c.fields, [rule(c.phrase)], c.ctx)
    const mine = c.fields.filter((x) => x.key === f.key)
    const out = renderAll(mine, linked)
    expect(`${f.key} (${f.format}): the phrase is linked to /go/ where the field is shown`, mine.length > 0 && count(out) >= 1 && out.includes('href="/go/viator"'), out.slice(0, 200))
  }
  expect('every case in the table names a field that is in the single list', Object.keys(CASES).every((k) => SOURCE_FIELDS.some((f) => f.key === k)))

  // ---------- 2. the list itself ----------
  const keys = SOURCE_FIELDS.map((f) => f.key)
  expect('the single list has unique keys, and every field names a loader, a format and a renderer', new Set(keys).size === keys.length && SOURCE_FIELDS.every((f) => !!f.loadedFrom && !!f.stored && ['html', 'text', 'linkified'].includes(f.format) && f.renderers.some((r) => r.role === 'links') && f.insideAnchorOrHeading === false))
  const emitted = new Set<string>()
  const richGuide = { summary: 's', key_takeaways: ['One. Two.'], body: 'b', faq: [{ q: 'q', a: 'a' }] }
  for (const set of [
    guideFieldSet(richGuide, 'guide', 'left'), guideFieldSet(richGuide, 'destination', 'left'),
    blogFieldSet({ body: 'b', faq: [{ q: 'q', a: 'a' }], key_takeaways: ['t'] }, { moreExcerpts: ['m'] }),
    destinationBlurbFieldSet('blurb'),
    tripFieldSet({ available_to: '2020-01-01', recap_summary: 'r', recap_highlights: ['h'], full_description: 'd', highlights: ['h'], itinerary: [{ day: 1, title: 't', description: 'd' }], price_includes: 'a', not_included: 'b', ai_faqs: [{ question: 'q', answer: 'a' }], journal_entries: [{ date: '2026-01-01', title: 't', body: 'b' }] }),
    pageCopyFieldSet({ intro: 'i', key_takeaways: ['t'], faq: [{ q: 'q', a: 'a' }] }, 'best-time'), pageCopyFieldSet({ intro: 'i', key_takeaways: ['t'], faq: [{ q: 'q', a: 'a' }] }, 'compare'),
    homeFieldSet('en'), whoWeAreFieldSet(), blogIndexFieldSet(), guideIndexFieldSet('hotels', 'Hotels'),
  ]) for (const f of set.fields) emitted.add(f.key)
  expect('the builders emit exactly the fields in the list (none missing, none unlisted)', keys.every((k) => emitted.has(k)) && [...emitted].every((k) => keys.includes(k)), JSON.stringify({ missing: keys.filter((k) => !emitted.has(k)), extra: [...emitted].filter((k) => !keys.includes(k)) }))
  expect('every text that is deliberately left out has a reason', EXCLUDED_TEXT.length >= 10 && EXCLUDED_TEXT.every((e) => e.where.length > 10 && e.reason.length > 20) && EXCLUDED_TEXT.some((e) => /Headings/.test(e.where)) && EXCLUDED_TEXT.some((e) => /Prices/.test(e.where)) && EXCLUDED_TEXT.some((e) => /JSON-LD/.test(e.where)) && EXCLUDED_TEXT.some((e) => /alt text/.test(e.where)) && EXCLUDED_TEXT.some((e) => /Forms/.test(e.where)) && EXCLUDED_TEXT.some((e) => /wholly one link/.test(e.where)))
  expect('"Where we look" names every page type and its places', whereWeLook().length === 11 && /Trip pages \(/.test(WHERE_WE_LOOK_TEXT) && /Blog posts \(/.test(WHERE_WE_LOOK_TEXT) && /Who we are page \(/.test(WHERE_WE_LOOK_TEXT) && /Best-time pages \(/.test(WHERE_WE_LOOK_TEXT))

  // ---------- 3. coverage: every renderer in the list really calls the linker, and none is unlisted ----------
  const renderers = rendererFiles()
  for (const r of renderers) {
    const src = read(r.file)
    const ok = r.role === 'links' ? /linkPageFields\(|linkedGuidePage\(/.test(src) : /AffiliateParts|AffiliateLinkified|linked\.html/.test(src)
    expect(`${r.file}: ${r.role === 'links' ? 'builds its fields and calls the linker' : 'shows linked text'}`, ok)
  }
  const walk = (dir: string): string[] => readdirSync(join(__dirname, '..', dir)).flatMap((e) => {
    const rel = `${dir}/${e}`
    return statSync(join(__dirname, '..', rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(e) ? [rel] : []
  })
  const callers = [...walk('app'), ...walk('components')].filter((f) => /linkPageFields\(|linkedGuidePage\(|loadAffiliateRules\(/.test(read(f)) && !f.startsWith('app/api/') && !f.startsWith('app/admin/'))
  const listed = new Set(renderers.map((r) => r.file))
  expect('no page or component calls the linker or loads the rules without being in the single list', callers.every((f) => listed.has(f)), JSON.stringify(callers.filter((f) => !listed.has(f))))
  const linkRenderers = renderers.filter((r) => r.role === 'links').map((r) => r.file)
  expect('every file that links is a page or the shared guide parts', linkRenderers.every((f) => /(^|\/)page\.tsx$|^components\/(guide-page|guide-index-page)\.tsx$/.test(f)), linkRenderers.join(','))
  expect('every page that loads rules also loads them with the rest of its data (fails open, never a 500)', linkRenderers.every((f) => /loadAffiliateRules\(\)/.test(read(f)) || f === 'components/guide-page.tsx'))

  // ---------- 4. the disclosure: once per page, only when a link was added ----------
  expect('no links, no disclosure line', renderToStaticMarkup(React.createElement(AffiliateAutoDisclosure, { count: 0, language: 'en' })) === '')
  expect('one or more links give exactly one disclosure line', count(renderToStaticMarkup(React.createElement(AffiliateAutoDisclosure, { count: 4, language: 'en' })).replace(/data-affiliate-auto-disclosure/g, 'data-affiliate-auto')) === 1)
  for (const f of linkRenderers) {
    const c = (read(f).match(/<AffiliateAutoDisclosure /g) ?? []).length
    const exclusive = f === 'app/destinations/[slug]/page.tsx' && /\{!guide && <AffiliateAutoDisclosure/.test(read(f)) && /<AffiliateAutoDisclosure count=\{linked\?\.count/.test(read(f))
    expect(`${f}: one disclosure line per page${exclusive ? ' (the two are in exclusive branches: guide or no guide)' : ''}`, c === 1 || (exclusive && c === 2), `found ${c}`)
  }
  // the count that feeds the line is the page total across ALL fields
  const totalFields = tripFieldSet({ ...tripBase, full_description: `Join ${P}.`, highlights: [`${P} by boat`, 'Wine'] }).fields
  const pageLinked = link(totalFields, [rule(P)], 'trips')
  expect('the page total that feeds the disclosure counts links across all fields', pageLinked.count === 2 && pageLinked.count === count(renderAll(totalFields, pageLinked)))

  // ---------- 5. matching: hyphens, dashes, apostrophes, spaces, plural ----------
  const m = (phrase: string, input: string, ctx: PageContext = 'blog') => linkKeywords(input, [rule(phrase)], { context: ctx }).count
  expect('case-insensitive, whole words', m('croatia tours', '<p>CROATIA TOURS</p>') === 1 && m('croatia tours', '<p>Croatia toursim</p>') === 0 && m('croatia tours', '<p>Croatia tour</p>') === 0)
  expect('a hyphen, an en dash or an apostrophe between words counts as a space', m('croatia tours', '<p>Croatia-tours</p>') === 1 && m('croatia tours', '<p>Croatia–tours</p>') === 1 && m('croatia tours', '<p>Croatia‐tours</p>') === 1 && m('rock and roll', "<p>rock 'n' roll</p>") === 0 && m('rock n roll', "<p>rock 'n' roll</p>") === 1)
  expect('the phrase may be typed with a hyphen too', m('croatia-tours', '<p>Croatia tours</p>') === 1 && m('croatia–tours', '<p>croatia-tours</p>') === 1)
  expect('spaces, line breaks and non-breaking spaces (also as &nbsp; and &#160;) are collapsed', m('croatia tours', '<p>Croatia   tours</p>') === 1 && m('croatia tours', '<p>Croatia\ntours</p>') === 1 && m('croatia tours', '<p>Croatia tours</p>') === 1 && m('croatia tours', '<p>Croatia&nbsp;tours</p>') === 1 && m('croatia tours', '<p>Croatia&#160;tours</p>') === 1 && m('croatia tours', '<p>Croatia&#xa0;tours</p>') === 1)
  expect('an entity that is not a space is left alone: "&amp;" is not part of a word', m('amp', '<p>R&amp;B</p>') === 0 && linkKeywords('<p>Fish &amp; Croatia&nbsp;tours</p>', [rule(P)], { context: 'blog' }).output.includes('Fish &amp; <a '))
  expect('a text node with no link keeps its &nbsp; exactly as written', linkKeywords('<p>Plain&nbsp;words &amp; more</p>', [rule(P)], { context: 'blog' }).output === '<p>Plain&nbsp;words &amp; more</p>')
  expect('plural: the last word may carry s or es ("croatia tour" finds "Croatia tours"; "bush" finds "bushes")', m('croatia tour', '<p>Croatia tours</p>') === 1 && m('croatia tour', '<p>Croatia tour</p>') === 1 && m('bush', '<p>two bushes</p>') === 1 && m('bush', '<p>a bushy day</p>') === 0)
  expect('plural is OFF for a phrase of 3 characters or fewer ("us" never finds "uses", "bus" never finds "buses")', m('us', '<p>He uses it</p>') === 0 && m('us', '<p>Join us today</p>') === 1 && m('bus', '<p>two buses</p>') === 0 && m('bus', '<p>the bus</p>') === 1 && m('car', '<p>cars</p>') === 0 && m('cars', '<p>cars</p>') === 1)
  expect('plural: only the last word, only s or es, nothing else guessed', m('croatia tours', '<p>Croatias tours</p>') === 0 && m('tour', '<p>touring tours</p>') === 1 && m('tour', '<p>touring</p>') === 0 && m('tour', '<p>toured</p>') === 0)
  expect('an apostrophe inside a word is optional ("children\'s tours" finds "childrens tours" and the curly apostrophe)', m("children's tours", '<p>Children’s tours</p>') === 1 && m("children's tours", '<p>childrens tours</p>') === 1 && m("children's tours", "<p>children's tours</p>") === 1 && m('croatia tours', "<p>Croatia's tours</p>") === 0)
  expect('plain text fields match the same way (no HTML involved)', (() => { const r = linkTextParts('Our Croatia-tours and Croatia tours.', [rule('croatia tours', 'viator', { max_per_page: 3 })], { context: 'blog' }); return r.count === 2 })())
  const sameKeyRules = [rule('croatia tours', 'one'), rule('Croatia-Tours', 'two')]
  expect('"croatia tours" and "Croatia-Tours" are the same phrase: the first rule keeps it', linkKeywords('<p>Croatia tours</p>', sameKeyRules, { context: 'blog' }).output.includes('/go/one') && !linkKeywords('<p>Croatia tours</p>', sameKeyRules, { context: 'blog' }).output.includes('/go/two'))
  expect('longest phrase first still holds with plural and hyphen forms', (() => { const o = linkKeywords('<p>Croatia river-cruises sail</p>', [rule('croatia', 'short'), rule('croatia river cruise', 'long')], { context: 'blog' }).output; return o.includes('/go/long') && !o.includes('/go/short') })())
  expect('"max per page" still counts one phrase across its spellings', linkKeywords('<p>Croatia tours, Croatia-tours and Croatia tour</p>', [rule('croatia tours', 'vi', { max_per_page: 2 })], { context: 'blog' }).count === 2)
  expect('a phrase of only dashes or apostrophes cannot be saved', (() => { const r = linkKeywords('<p>-- -- --</p>', [rule('--'), rule("''")], { context: 'blog' }); return r.count === 0 })())

  // ---------- 6. the limits hold across fields, in reading order ----------
  const g1 = guideFieldSet({ summary: 'p1x and p2x here', key_takeaways: ['Plain. p3x and p4x here.'], body: '<p>p5x p6x p7x</p>', faq: [{ q: 'q', a: 'p8x answer' }] }, 'guide', 'left')
  g1.body.value = '<p>p5x p6x p7x</p>'
  const eight = Array.from({ length: 8 }, (_, i) => rule(`p${i + 1}x`, `s${i + 1}`))
  const l1 = link(g1.fields, eight, 'guides')
  const out1 = renderAll(g1.fields, l1)
  expect('6 links per page across all fields; the first six in reading order win', l1.count === MAX_LINKS_PER_PAGE && [...out1.matchAll(/href="\/go\/(s\d)"/g)].map((x) => x[1]).join(',') === 's1,s2,s3,s4,s5,s6', out1)
  const g2 = guideFieldSet({ summary: `${P} one.`, key_takeaways: [`Quick. ${P} two.`], body: `<p>${P} three. ${P} four.</p>`, faq: [{ q: 'q', a: `${P} five.` }] }, 'guide', 'left')
  g2.body.value = `<p>${P} three. ${P} four.</p>`
  const l2 = link(g2.fields, [rule(P, 'viator', { max_per_page: 3 })], 'guides')
  const hits2 = g2.fields.map((f) => count(renderField(f, l2)))
  expect('3 per phrase across fields, in order: summary, takeaways, then the article (the fourth mention is left plain)', l2.count === 3 && hits2.join(',') === '1,0,1,1,0', hits2.join(','))
  const l2b = link(g2.fields, [rule(P, 'viator', { max_per_page: 1 })], 'guides')
  expect('max per page 1: only the very first place on the page is linked (the summary)', l2b.count === 1 && count(renderField(g2.fields[0], l2b)) === 1)
  const trip = tripFieldSet({ ...tripBase, full_description: `Join ${P}.`, highlights: [P, P], itinerary: [{ day: 1, title: 'x', description: P }], price_includes: P, ai_faqs: [{ question: 'q', answer: P }] })
  const l3 = link(trip.fields, [rule(P, 'viator', { max_per_page: 3 })], 'trips')
  expect('a trip page: 3 per phrase over description, highlights, itinerary, included and FAQ together', l3.count === 3 && count(renderAll(trip.description, l3)) === 1 && count(renderAll(trip.highlights, l3)) === 2 && count(renderAll(trip.included, l3)) === 0)
  const state = newLinkerState()
  linkKeywords('<p>aaaa bbbb</p>', [rule('aaaa'), rule('bbbb')], { context: 'blog', state })
  expect('the page state is one object shared by every field of a page', state.total === 2 && state.perKey.size === 2)

  // ---------- 7. nothing is linked in headings, anchors, buttons, prices, alt text, JSON-LD ----------
  const hostile = html(`<h2>${P}</h2><h3>${P}</h3><p><a href="/x">${P}</a></p><button>${P}</button><img src="/a.jpg" alt="${P}"><script type="application/ld+json">{"name":"${P}"}</script><details><summary>${P}?</summary></details><p title="${P}">no</p>`)
  const lh = link([hostile], [rule(P)], 'blog')
  expect('headings, links, buttons, alt text, JSON-LD and FAQ questions are never linked', lh.count === 0 && lh.html(hostile) === hostile.value)
  const linkifiedField: TextField = { id: 'trip.description#0', key: 'trip.description', format: 'linkified', value: `[${P}](/packages/croatia) and ${P}` }
  const ll = link([linkifiedField], [rule(P)], 'trips')
  const llOut = renderField(linkifiedField, ll)
  expect('a site link written [words](/path) stays an ordinary site link; only the plain words around it are linked', ll.count === 1 && count(llOut) === 1 && /<a [^>]*href="\/packages\/croatia"[^>]*>Croatia tours<\/a>/.test(llOut) && !/data-affiliate-auto[^>]*>Croatia tours<\/a> and/.test(llOut), `${ll.count} ${llOut}`)
  const pricey = {
    ...tripBase, name: `${P} package`, destination: P, price_display: `${P} from $999`, meta_title: P, meta_description: P, supplier: P, category: P, call_to_action: P, slug: 'croatia-tours',
    short_description: null, full_description: 'Plain text.', highlights: ['A'], itinerary: [{ day: 1, title: `${P} day`, description: 'No phrase.' }],
  }
  const lp = tripFieldSet(pricey)
  expect('a trip price, name, destination, supplier, call to action, meta and itinerary titles are not text fields at all', lp.fields.every((f) => !f.value.includes(P)) && lp.fields.length > 0)
  const llp = link(lp.fields, [rule(P)], 'trips')
  expect('so a trip whose only mentions are in those places gets no link and no disclosure count', llp.count === 0)
  const journalHtml = renderToStaticMarkup(React.createElement(TripJournal, { entries: [{ date: '2026-03-01', title: `${P} day`, body: `We did ${P}.` }], language: 'en', bodies: tripFieldSet({ ...tripBase, journal_entries: [{ date: '2026-03-01', title: `${P} day`, body: `We did ${P}.` }] }).journal.map((f) => linkTextParts(f.value, [rule(P)], { context: 'trips' }).parts) }))
  expect('the journal links the entry text, never the entry title (a heading)', count(journalHtml) === 1 && /<h3[^>]*>Croatia tours day<\/h3>/.test(journalHtml))
  const copy = { intro: `Hello ${P}.`, key_takeaways: [`${P} rule.`], faq: [{ q: `Do ${P} run?`, a: `Yes ${P}.` }] }
  const cs = pageCopyFieldSet(copy, 'best-time')
  const lc = link(cs.fields, [rule(P, 'viator', { max_per_page: 3 })], 'pages')
  const copyHtml = renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(PageCopyIntro, { copy, html: cs.intro ? lc.html(cs.intro) : undefined }),
    React.createElement(PageCopyTakeaways, { copy, parts: cs.takeaways.map((f) => lc.parts(f)) }),
    React.createElement(PageCopyFaq, { copy, answers: cs.faq.map((f) => lc.parts(f)) })))
  expect('best-time and compare copy: intro, takeaways and FAQ answers link; the FAQ question and the headings do not', count(copyHtml) === 3 && /<summary[^>]*>Do Croatia tours run\?<\/summary>/.test(copyHtml) && /<h2[^>]*>Key takeaways<\/h2>/.test(copyHtml))
  expect('the same components without the new props show the copy as written', count(renderToStaticMarkup(React.createElement(PageCopyFaq, { copy }))) === 0 && count(renderToStaticMarkup(React.createElement(PageCopyTakeaways, { copy }))) === 0)
  const lg = linkedGuidePage({ ...guideBase, summary: `${P} here.`, key_takeaways: [`${P} are fun. More.`], body: `Text ${P}.`, faq: [{ q: 'q', a: `${P}` }] }, [rule(P)], 'guides', 'left')
  const guide = { name: 'Croatia', body: '', faq: [], key_takeaways: [`${P} are fun. More.`] }
  const factsHtml = renderToStaticMarkup(React.createElement(GuideHeaderActions, { name: 'Croatia', guide, feature: { kind: 'none', rest: [], bookable: false }, language: 'en', factParts: lg.facts }))
  expect('quick facts in the guide header link; the "Quick facts" heading and the call-to-action panel do not', count(factsHtml) === 1 && /<h2[^>]*>Quick facts<\/h2>/.test(factsHtml) && !/data-affiliate-auto[^>]*>[^<]*Plan your/.test(factsHtml))
  const takeawaysHtml = renderToStaticMarkup(React.createElement(GuideTakeaways, { guide, parts: lg.takeaways }))
  expect('key takeaways link inside the list items, not in the heading', count(takeawaysHtml) >= 1 && /<h2[^>]*>Key takeaways<\/h2>/.test(takeawaysHtml))
  const featHtml = renderToStaticMarkup(React.createElement(FeaturesSection, { language: 'en', introParts: linkTextParts('We love Croatia tours.', [rule(P)], { context: 'pages' }).parts as Part[] }))
  expect('the home page "why choose us" paragraph links; the section title does not', count(featHtml) === 1 && /<h2[^>]*>Why Choose/.test(featHtml))

  // ---------- 8. OFF links, OFF rules, before migration 0050, read errors ----------
  const offRows = [
    { id: 'k1', phrase: P, scope: 'all', max_per_page: 3, affiliate_links: { slug: 'viator', status: 'hidden', url: 'https://merchant.shopco.com/a' } },
    { id: 'k2', phrase: P, scope: 'all', max_per_page: 3, affiliate_links: { slug: 'viator', status: 'draft', url: 'https://merchant.shopco.com/a' } },
  ]
  const offRules = rowsToRules(offRows)
  const tripFields = CASES['trip.description'].fields
  expect('an OFF link gives no rule, so no field is linked and no link is counted', offRules.length === 0 && link(tripFields, offRules, 'trips').count === 0 && renderAll(tripFields, link(tripFields, offRules, 'trips')) === renderAll(tripFields, link(tripFields, null, 'trips')))
  clearAffiliateRulesCache()
  const seen: string[] = []
  const stubClient = (result: { data: unknown; error: { message: string } | 'throw' | null }) => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: string) => (seen.push(`${c}=${v}`), q),
        order: () => q,
        limit: () => {
          if (result.error === 'throw') throw new Error('boom')
          return Promise.resolve({ data: result.data, error: result.error })
        },
      }
      return q
    },
  }) as never
  const none = await loadAffiliateRules({ client: stubClient({ data: [], error: null }), now: 1 })
  expect('the loader asks only for ON keywords (an OFF rule is never read)', seen.includes('status=on') && none.length === 0)
  clearAffiliateRulesCache()
  const before0050 = await loadAffiliateRules({ client: stubClient({ data: null, error: { message: 'relation "public.affiliate_keywords" does not exist' } }), now: 2 })
  clearAffiliateRulesCache()
  const readError = await loadAffiliateRules({ client: stubClient({ data: null, error: { message: 'timeout' } }), now: 3 })
  clearAffiliateRulesCache()
  const thrown = await loadAffiliateRules({ client: stubClient({ data: null, error: 'throw' }), now: 4 })
  clearAffiliateRulesCache()
  const allFailed = [before0050, readError, thrown]
  expect('before migration 0050, on a read error and on a thrown error: no rules, no throw', allFailed.every((r) => Array.isArray(r) && r.length === 0))
  const unlinked = allFailed.map((r) => renderAll(tripFields, link(tripFields, r, 'trips')))
  expect('every page type then renders its text unlinked and untouched (never a 500)', unlinked.every((o) => count(o) === 0 && o.includes('Join our Croatia tours today.')) && Object.values(CASES).every((c) => count(renderAll(c.fields, link(c.fields, [], c.ctx))) === 0))
  expect('a field list that is broken (not a string value) renders without throwing', (() => { try { const bad = { id: 'x', key: 'blog.body', format: 'html', value: undefined as unknown as string } as TextField; return link([bad], [rule(P)], 'blog').count === 0 } catch { return false } })())

  // ---------- 9. the time budget is shared by all the fields of a page ----------
  const realNow = Date.now
  let clock = 1_000_000
  Date.now = () => (clock += 30) // every look at the clock costs 30 ms, so the 50 ms budget is gone after two fields
  let budgetFields: TextField[] = []
  let budgetLinked: LinkedFields
  try {
    budgetFields = Array.from({ length: 40 }, (_, i) => html(`<p>word${i}x here</p>`, 'blog.body')).map((f, i) => ({ ...f, id: `f${i}` }))
    budgetLinked = linkPageFields(budgetFields, budgetFields.map((_, i) => rule(`word${i}x`, `w${i}`)), 'blog')
  } finally {
    Date.now = realNow
  }
  const linkedIds = budgetFields.filter((f) => count(budgetLinked.html(f)) > 0).map((f) => f.id)
  expect('one 50 ms budget for the whole page: the early fields are linked, the later ones are left plain, and the page says it ran out', linkedIds.length >= 2 && linkedIds.length < budgetFields.length && linkedIds[0] === 'f0' && budgetLinked.truncated && count(budgetLinked.html(budgetFields[budgetFields.length - 1])) === 0, linkedIds.join(','))
  const tFast = realNow()
  const bigFields = Array.from({ length: 30 }, (_, i) => ({ ...html('<p>' + 'plain filler words '.repeat(2000) + '</p>'), id: `b${i}` }))
  linkPageFields(bigFields, [rule(P)], 'blog')
  expect('30 long fields (a heavy page) finish in a bounded time', realNow() - tFast < 3000, `${realNow() - tFast} ms`)

  // ---------- 10. Preview and the renderer agree ----------
  const docOf = (ctx: PageContext, path: string, fields: TextField[], pageType?: UsageDoc['pageType']): UsageDoc => ({ context: ctx, path, title: path, pageType, fields })
  const tripDocFields = tripFieldSet({ ...tripBase, full_description: `Our ${P} are great. Also ${P} again.\n\nSee [${P}](/packages/x).`, highlights: [`${P} by boat`], itinerary: [{ day: 1, title: `${P} day`, description: `Start ${P}.` }], ai_faqs: [{ question: `Safe ${P}?`, answer: `Yes ${P}.` }] }).fields
  const guideDocFields = guideFieldSet({ summary: `Best ${P}.`, key_takeaways: [`Quick. ${P} rule.`], body: `<h2>${P}</h2><p>${P} here and ${P} there.</p>`, faq: [{ q: 'q', a: `${P}.` }] }, 'guide', 'left').fields
  guideDocFields.forEach((f) => { if (f.key === 'guide.body') f.value = `<h2>${P}</h2><p>${P} here and ${P} there.</p>` })
  const blogDocFields = blogFieldSet({ body: `Hi ${P}.`, key_takeaways: [`${P}.`] }, { moreExcerpts: [`${P}.`] }).fields
  const docs10: UsageDoc[] = [
    docOf('trips', '/packages/t1', tripDocFields, 'trip'),
    docOf('guides', '/hotels/h1', guideDocFields, 'guide'),
    docOf('blog', '/blog/b1', blogDocFields, 'blog'),
    docOf('pages', '/who-we-are', whoWeAreFieldSet().fields, 'who-we-are'),
  ]
  const pv = previewRule(docs10, { phrase: 'croatia tours', scope: 'all', max_per_page: 3 })
  const renderedCounts = docs10.slice(0, 3).map((d) => {
    const r = rule('croatia tours', 'xx', { id: 'preview', max_per_page: 3 })
    return count(renderAll(d.fields!, linkPageFields(d.fields!, [r], d.context)))
  })
  expect('Preview "linked" equals the links the page really renders, page by page', pv.pages.length === 3 && pv.pages.map((p) => p.willLink).join(',') === renderedCounts.join(','), `${pv.pages.map((p) => p.willLink)} vs ${renderedCounts}`)
  const written = (d: UsageDoc) => d.fields!.reduce((a, f) => a + (fieldAsHtml(f).replace(/<h[1-6][^>]*>.*?<\/h[1-6]>/g, '').replace(/<a [^>]*>.*?<\/a>/g, '').match(/Croatia tours/g) ?? []).length, 0)
  expect('Preview "written" equals what is really written outside headings and links', pv.pages.map((p) => p.count).join(',') === docs10.slice(0, 3).map(written).join(',') && pv.occurrences === docs10.slice(0, 3).map(written).reduce((a, b) => a + b, 0), `${pv.pages.map((p) => p.count)} vs ${docs10.slice(0, 3).map(written)}`)
  const rep10 = buildUsageReport(docs10, [{ id: 'k1', phrase: 'croatia tours', scope: 'all', status: 'on' }])
  expect('the usage report agrees with Preview (pages and occurrences)', rep10.phrases[0].pages === pv.pageCount && rep10.phrases[0].occurrences === pv.occurrences)
  expect('Preview and the page agree even on spelling variants (hyphen, non-breaking space, plural)', (() => {
    const fs = [text('We sell Croatia-tours, Croatia tours and Croatia tour.', 'blog.faq')]
    const p = previewRule([docOf('blog', '/blog/v', fs, 'blog')], { phrase: 'croatia tour', scope: 'all', max_per_page: 3 })
    return p.occurrences === 3 && p.pages[0].willLink === 3 && count(renderAll(fs, link(fs, [rule('croatia tour')], 'blog'))) === 3
  })())
  const lastPageNoise = pv.breakdown.map(breakdownLabel)
  expect('the breakdown says where: page type, field and the number of matches ("Trip pages (description): 2 matches")', lastPageNoise.includes('Trip pages (description): 2 matches'), lastPageNoise.join(' | '))
  expect('the breakdown has a row for every page type that had a match', ['Trip pages', 'Guides', 'Blog posts'].every((label) => pv.breakdown.some((b) => b.page === label)))
  expect('the breakdown never counts the heading or the existing link', pv.breakdown.find((b) => b.fieldKey === 'guide.body')?.matches === 2 && pv.breakdown.find((b) => b.fieldKey === 'trip.description')?.matches === 2)
  expect('"Checked N pages in M places"', /^Checked 4 pages in \d+ places\.$/.test(pv.coverage) && pv.checkedPages === 4 && pv.checkedPlaces >= 10, pv.coverage)
  expect('the places are counted from the fields the scanned pages really have', pv.checkedPlaces === new Set(docs10.flatMap((d) => d.fields!.filter((f) => f.value.trim()).map((f) => f.key))).size)

  // ---------- 11. zero matches: plain words, and saving stays allowed ----------
  const pz = previewRule(docs10, { phrase: 'zanzibar safaris', scope: 'all', max_per_page: 1 })
  expect('zero matches: it says how many pages and places were checked, that the phrase was not found, and what to try', pz.pageCount === 0 && !!pz.explanation && /Checked 4 pages in \d+ places\./.test(pz.explanation) && /was not found in any of them/.test(pz.explanation) && /singular or the plural/.test(pz.explanation) && /spelling/.test(pz.explanation), String(pz.explanation))
  expect('zero matches: the plain warning says it will link wherever it appears in future', pz.emptyNotice === 'No page uses this phrase yet; it will link wherever it appears in future.' && NO_PAGE_NOTICE === pz.emptyNotice)
  expect('a found phrase has no zero-match text', pv.explanation === null && pv.emptyNotice === null)
  expect('zero matches in a scope that has no page explains that too', /nothing to check/.test(previewRule(docs10.slice(3), { phrase: 'zanzibar safaris', scope: 'blog', max_per_page: 1 }).explanation ?? ''))
  const LA = '11111111-1111-4111-8111-111111111111'
  const zeroDb = (): Db => ({
    tables: {
      affiliate_links: [{ id: LA, slug: 'viator', title: 'Viator', merchant: 'Viator', status: 'active', url: 'https://viator.shopco.com/a' }],
      affiliate_keywords: [],
      guides: [{ kind: 'destinations', slug: 'croatia', name: 'Croatia', summary: 'Sun and sea.', key_takeaways: [], body: 'Nothing special here.', faq: [], status: 'published' }],
      posts: [],
    },
  })
  resetUsageDebounce()
  const zdb = zeroDb()
  const dep = { revalidate: () => {}, rescan: async () => ({ ok: true }), now: () => 90_000_000 }
  const zp = await previewKeyword(fakeAdmin(zdb), { phrase: 'zanzibar safaris', link_id: LA })
  expect('the Preview answer carries the explanation and the notice', zp.status === 200 && zp.body.pageCount === 0 && /not found in any of them/.test(String(zp.body.explanation)) && zp.body.emptyNotice === NO_PAGE_NOTICE)
  const zc = await createKeyword(fakeAdmin(zdb), { phrase: 'zanzibar safaris', link_id: LA }, dep)
  expect('"Save and turn on" still works when no page uses the phrase, and the answer says so', zc.status === 201 && (zdb.tables.affiliate_keywords![0] as { status: string }).status === 'on' && (zc.body.warnings as string[]).includes(NO_PAGE_NOTICE), JSON.stringify(zc.body))
  resetUsageDebounce()

  // ---------- 12. the usage report and Preview read every place, not 21 documents ----------
  const wide: Db = {
    tables: {
      affiliate_keywords: [
        { id: 'k1', phrase: 'croatia tours', link_id: 'L1', scope: 'all', max_per_page: 2, status: 'on', created_at: '2026-01-01' },
        { id: 'k2', phrase: 'dating service', link_id: 'L1', scope: 'all', max_per_page: 1, status: 'on', created_at: '2026-01-02' },
      ],
      guides: [
        { kind: 'destinations', slug: 'croatia', name: 'Croatia', summary: `Find ${P}.`, key_takeaways: [], body: 'x', faq: [], status: 'published' },
        { kind: 'hotels', slug: 'h1', name: 'Hotel', summary: 's', key_takeaways: [`Short. ${P} too.`], body: 'x', faq: [], status: 'published' },
      ],
      posts: [{ id: 'p1', title: 'Post', slug: 'p1', body: `Read about ${P}.`, faq: [{ q: 'q', a: `Yes ${P}.` }], tags: [], status: 'published', publish_date: '2026-01-01T00:00:00Z', related_package_id: null, key_takeaways: null }],
      travel_packages: [
        { id: 't1', slug: 't1', name: 'Croatia trip', destination: 'Croatia', status: 'published', available_from: '2026-01-01', available_to: '2999-01-01', full_description: `Our ${P}.`, highlights: [`${P} by boat`] },
        { id: 't2', slug: 't2', name: 'Greece trip', destination: 'Greece', status: 'published', available_from: '2026-01-01', available_to: '2999-01-01', full_description: 'Greek isles.', highlights: [] },
        { id: 't3', slug: 't3', name: 'Draft trip', destination: 'Spain', status: 'draft', available_to: '2999-01-01', full_description: P, highlights: [] },
      ],
      destination_blurbs: [
        { slug: 'greece', destination: 'Greece', blurb: `Islands and ${P}.` },
        { slug: 'croatia', destination: 'Croatia', blurb: `Ignored: ${P}, this destination has a guide.` },
        { slug: 'spain', destination: 'Spain', blurb: `Ignored: ${P}, no published trip.` },
      ],
      page_copy: [
        { path: '/best-time-to-visit/croatia', intro: `When ${P} run.`, key_takeaways: [], faq: [], status: 'published' },
        { path: '/compare/croatia-vs-greece', intro: 'x', key_takeaways: [`${P} differ.`], faq: [], status: 'published' },
        { path: '/compare/draft', intro: P, key_takeaways: [], faq: [], status: 'draft' },
      ],
    },
  }
  const site = await loadUsageDocs(fakeAdmin(wide), new Date('2026-10-18T00:00:00Z'))
  const paths = site.docs.map((d) => d.path)
  expect('the scan reads guides, destination guides, posts, trips, destination blurbs, best-time and compare copy and the fixed pages', ['/destinations/croatia', '/hotels/h1', '/blog/p1', '/packages/t1', '/packages/t2', '/destinations/greece', '/best-time-to-visit/croatia', '/compare/croatia-vs-greece', '/', '/who-we-are', '/blog', '/destinations', '/hotels'].every((p) => paths.includes(p)), paths.join(','))
  expect('drafts are left out; a blurb is read only where the destination page really shows it (no guide, has a published trip)', !paths.includes('/packages/t3') && !paths.includes('/compare/draft') && !paths.includes('/destinations/spain') && paths.filter((p) => p === '/destinations/croatia').length === 1)
  const rescanned = await rescanSite(fakeAdmin(wide), new Date('2026-10-18T00:00:00Z'))
  const k1 = rescanned.ok ? rescanned.report.phrases.find((p) => p.keywordId === 'k1')! : null
  const labels = (k1?.breakdown ?? []).map((b) => b.page)
  expect('the report finds the phrase in every kind of page, with a breakdown by page type and field', !!k1 && ['Destination guides', 'Guides', 'Blog posts', 'Trip pages', 'Destination pages without a guide', 'Best-time pages', 'Compare pages'].every((l) => labels.includes(l)), labels.join(','))
  expect('and in the fixed pages ("dating service" is on who we are)', rescanned.ok && rescanned.report.phrases.find((p) => p.keywordId === 'k2')!.examples.some((e) => e.path === '/who-we-are'))
  expect('the report says how many pages and places it checked', rescanned.ok && rescanned.report.scanned === site.docs.length && (rescanned.report.places ?? 0) >= 12 && !rescanned.report.truncated)
  expect('Preview over the same site finds it in the trip pages, the blurb and the copy', (() => {
    const p = previewRule(site.docs, { phrase: 'croatia tours', scope: 'all', max_per_page: 1 }, { totalDocs: site.totalDocs })
    return p.pageCount === 7 && p.breakdown.some((b) => b.page === 'Trip pages' && b.field === 'description' && b.matches === 1) && p.breakdown.some((b) => b.page === 'Trip pages' && b.field === 'highlights')
  })())
  expect('"Where" is honoured: a guides-only rule leaves the trip pages out and says so', (() => {
    const p = previewRule(site.docs, { phrase: 'croatia tours', scope: 'guides', max_per_page: 1 }, { totalDocs: site.totalDocs })
    return !p.breakdown.some((b) => b.page === 'Trip pages') && p.warnings.some((w) => /leaves out/.test(w) && /Trip pages/.test(w))
  })())

  // ---------- 13. 2000 pages, with the truncation notice ----------
  const manyTrips: Db = { tables: { affiliate_keywords: [], guides: [], posts: [], travel_packages: Array.from({ length: 2100 }, (_, i) => ({ id: `m${i}`, slug: `trip-${String(i).padStart(4, '0')}`, name: `Trip ${i}`, destination: `Place ${i}`, status: 'published', available_to: '2999-01-01', full_description: i % 2 === 0 ? `Great ${P}.` : 'Plain.', highlights: [] })) } }
  const big = await loadUsageDocs(fakeAdmin(manyTrips), new Date('2026-10-18T00:00:00Z'))
  expect('the document cap is 2000 (it was 500); the real total is kept', MAX_USAGE_DOCS === 2000 && big.docs.length === 2000 && big.totalDocs === 2100 + staticUsageDocs().length, `${big.docs.length}/${big.totalDocs}`)
  const bigPreview = previewRule(big.docs, { phrase: 'croatia tours', scope: 'all', max_per_page: 1 }, { totalDocs: big.totalDocs })
  expect('beyond the cap the preview says only the first 2000 of the total were checked', bigPreview.truncated && /Only the first 2000 of 2110 pages were checked\./.test(bigPreview.coverage) && bigPreview.pageCount > 900, bigPreview.coverage)
  expect('coverageSentence: singular and plural wording', coverageSentence({ checkedPages: 1, checkedPlaces: 1, truncated: false, scanned: 1, totalDocs: 1 }) === 'Checked 1 page in 1 place.')
  expect('up to 10 example pages are listed, each with a link (path) and a snippet; the page count stays true', bigPreview.pages.length === PREVIEW_SHOWN && PREVIEW_SHOWN === 10 && bigPreview.pages.every((p) => p.path.startsWith('/') && p.snippet.match.toLowerCase() === 'croatia tours' && p.snippet.before.length > 0) && bigPreview.shown === 10)
  const reportBig = buildUsageReport(big.docs, [{ id: 'k1', phrase: 'croatia tours', scope: 'all', status: 'on' }], { totalDocs: big.totalDocs })
  expect('the stored report keeps 10 example pages and the true counts', reportBig.phrases[0].examples.length === 10 && reportBig.phrases[0].pages === bigPreview.pageCount && reportBig.truncated)

  // ---------- 14. a database that fails never throws and never blocks a page ----------
  const errDb = { from: () => { const q: unknown = new Proxy({}, { get: (_t, p) => (p === 'then' ? (res: (v: unknown) => unknown) => res({ data: null, error: { message: 'boom' } }) : () => q) }); return q } } as never
  const failed = await loadUsageDocs(errDb)
  const failedScan = await rescanSite(errDb)
  expect('a database that fails everywhere gives an error message, not an exception', !!failed.error && failed.docs.length === 0 && failedScan.ok === false)
  const partial: Db = { tables: { guides: [], posts: [] } }
  const part = await loadUsageDocs(fakeAdmin(partial))
  expect('missing tables (trips, blurbs, copy) just add nothing: the fixed pages are still checked', !part.error && part.docs.length === staticUsageDocs().length)

  // ---------- 14b. QA fixes: a page with NO rules renders exactly what it rendered before WP23 ----------
  const noRules = (fields: TextField[], ctx: PageContext) => linkPageFields(fields, [], ctx)
  expect('no links: the disclosure wrapper does not exist (no empty space on the home or compare page)', renderToStaticMarkup(React.createElement(AffiliateAutoDisclosure, { count: 0, language: 'en', wrapperClassName: 'mx-auto mt-6 max-w-2xl text-center' })) === '' && /^<div class="mx-auto mt-6 max-w-2xl text-center"><p /.test(renderToStaticMarkup(React.createElement(AffiliateAutoDisclosure, { count: 1, language: 'en', wrapperClassName: 'mx-auto mt-6 max-w-2xl text-center' }))))
  for (const f of ['app/page.tsx', 'app/compare/[pair]/page.tsx', 'app/best-time-to-visit/[destination]/page.tsx', 'app/who-we-are/page.tsx', 'app/packages/[slug]/page.tsx', 'app/blog/page.tsx', 'components/guide-index-page.tsx']) {
    expect(`${f}: no wrapper element is left around the disclosure line`, !/<div[^>]*>\s*<AffiliateAutoDisclosure/.test(read(f)))
  }
  // The trip description: with no rules, one <span> per text run and the same site links as before (captured from main).
  const descField = (value: string): TextField => ({ id: 'd', key: 'trip.description', format: 'linkified', value })
  const LINK_CLASS = 'class="text-primary underline underline-offset-2 hover:no-underline"'
  const d1 = descField('Hello [See](/packages/x) there')
  const d2 = descField('Related: [Spain](/packages/spain)')
  const d3 = descField('Just plain words.')
  expect('trip description, no rules: markup equals the old LinkifiedText output (spans per run, same site link)',
    renderField(d1, noRules([d1], 'trips')) === `<span>Hello </span><a ${LINK_CLASS} href="/packages/x">See</a><span> there</span>` &&
    renderField(d2, noRules([d2], 'trips')) === `<span>Related: </span><a ${LINK_CLASS} href="/packages/spain">Spain</a><span></span>` &&
    renderField(d3, noRules([d3], 'trips')) === '<span>Just plain words.</span>', renderField(d1, noRules([d1], 'trips')))
  const withRules = renderField(d1, link([d1], [rule('hello')], 'trips'))
  expect('trip description, with a rule: the phrase is linked and the site link is untouched', count(withRules) === 1 && withRules.includes(`href="/packages/x"`))
  const bullet = (child: unknown) => renderToStaticMarkup(React.createElement('li', { className: 'flex gap-2 text-muted-foreground' }, React.createElement('span', { className: 'mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary' }), child as React.ReactNode))
  const hl = text('Wine tasting', 'trip.highlights')
  expect('trip highlights and recap highlights, no rules: no extra <span> around the text', bullet(React.createElement(AffiliateParts, { parts: noRules([hl], 'trips').parts(hl) })) === bullet(hl.value) && !bullet(React.createElement(AffiliateParts, { parts: noRules([hl], 'trips').parts(hl) })).includes('<span>Wine'))
  const inc = text('Hotel', 'trip.included')
  const li = (child: unknown) => renderToStaticMarkup(React.createElement('li', null, '✓ ', child as React.ReactNode))
  expect('included lines, itinerary text and FAQ answers, no rules: same markup as plain text', li(React.createElement(AffiliateParts, { parts: noRules([inc], 'trips').parts(inc) })) === li(inc.value))
  // the hero sentence: plain text unless a link was really added
  let heroPlain = ''
  let heroNoRules = ''
  let heroLinked = ''
  try {
    const { HeroSection } = await import('../components/hero-section')
    const hf = homeFieldSet('en').hero
    heroPlain = renderToStaticMarkup(React.createElement(HeroSection, { language: 'en' }))
    heroNoRules = renderToStaticMarkup(React.createElement(HeroSection, { language: 'en', descriptionParts: noRules([hf], 'pages').parts(hf) }))
    heroLinked = renderToStaticMarkup(React.createElement(HeroSection, { language: 'en', descriptionParts: link([hf], [rule('group adventures')], 'pages').parts(hf) }))
  } catch (e) {
    heroPlain = `ERR ${(e as Error).message}`
  }
  expect('hero sentence, no rules: markup equals the old markup (no new span)', heroPlain.length > 100 && heroNoRules === heroPlain && !heroNoRules.includes('[&amp;_a]:text-white'), heroPlain.slice(0, 120))
  expect('hero sentence, with a link: the span that keeps the link readable on the dark photo is added', heroLinked.includes('[&amp;_a]:text-white') && count(heroLinked) === 1)

  // ---------- 14c. QA fixes: the rules read cannot hang or stampede a page ----------
  clearAffiliateRulesCache()
  let queries = 0
  const slowClient = (ms: number, rows: unknown[]) => ({
    from: () => {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, order: () => q, limit: () => (queries++, new Promise((res) => setTimeout(() => res({ data: rows, error: null }), ms))) }
      return q
    },
  }) as never
  const okRow = { id: 'k1', phrase: P, scope: 'all', max_per_page: 3, affiliate_links: { slug: 'viator', status: 'active', url: 'https://merchant.shopco.com/a' } }
  const tSlow = Date.now()
  const slowRules = await loadAffiliateRules({ client: slowClient(5000, [okRow]), timeoutMs: 100, now: 10 })
  expect('a slow rules read gives up after the timeout and the page renders with no links', slowRules.length === 0 && Date.now() - tSlow < 2000, `${Date.now() - tSlow} ms`)
  clearAffiliateRulesCache()
  queries = 0
  const shared = await Promise.all([1, 2, 3, 4, 5].map(() => loadAffiliateRules({ client: slowClient(50, [okRow]), now: 20 })))
  expect('five requests at the same moment share ONE query', queries === 1 && shared.every((r) => r.length === 1))
  clearAffiliateRulesCache()

  // ---------- 14d. QA fixes: what the scan could not read is never reported as "not found" ----------
  const gaps = previewRule(docs10, { phrase: 'zanzibar safaris', scope: 'all', max_per_page: 1 }, { notes: ['trips (boom)'] })
  expect('a table that could not be read: the coverage line names it and "not found anywhere" is not claimed', /Could not read all of: trips \(boom\)\./.test(gaps.coverage) && !/was not found in any of them/.test(gaps.explanation ?? '') && /cannot say that no page uses it/.test(gaps.explanation ?? '') && gaps.emptyNotice === null)
  expect('the hints say "a-b" and "a b" are one phrase, and short phrases get no plural', gaps.hints.some((h) => /one phrase/.test(h) && /croatia-tours/.test(h)) && previewRule(docs10, { phrase: 'us', scope: 'all', max_per_page: 1 }).hints.some((h) => /very short/.test(h) && /uses/.test(h)))
  const failingTrips: Db = { tables: { guides: [], posts: [] } }
  const flaky = fakeAdmin(failingTrips)
  const realFrom = flaky.from.bind(flaky)
  ;(flaky as unknown as { from: (t: string) => unknown }).from = (t: string) => (t === 'travel_packages' ? ((): unknown => { const q: unknown = new Proxy({}, { get: (_x, p) => (p === 'then' ? (res: (v: unknown) => unknown) => res({ data: null, error: { message: 'connection reset' } }) : () => q) }); return q })() : realFrom(t))
  const flakySite = await loadUsageDocs(flaky as never)
  expect('loadUsageDocs reports a failed table as a note, and the scan carries on with the rest', !flakySite.error && (flakySite.notes ?? []).some((x) => /trips \(connection reset\)/.test(x)) && flakySite.docs.length === staticUsageDocs().length)
  const cappedDb: Db = { tables: { guides: [], posts: [], travel_packages: Array.from({ length: 3100 }, (_, i) => ({ id: `c${i}`, slug: `t-${String(i).padStart(4, '0')}`, name: `T${i}`, destination: `P${i}`, status: 'published', available_to: '2999-01-01', full_description: 'x', highlights: [] })) } }
  const cappedSite = await loadUsageDocs(fakeAdmin(cappedDb))
  expect('more rows than one scan reads (3 x 1000): the scan says so', (cappedSite.notes ?? []).some((x) => /trips \(more than 3000 rows/.test(x)))
  expect('the 2000-page cut says which page types it dropped', (big.dropped?.['Trip pages'] ?? 0) === 110 && /Not checked: Trip pages 110\./.test(coverageSentence({ checkedPages: 2000, checkedPlaces: 5, truncated: true, scanned: 2000, totalDocs: 2110, dropped: big.dropped })))
  const reportGaps = buildUsageReport(big.docs.slice(0, 20), [{ id: 'k1', phrase: P, scope: 'all', status: 'on' }], { totalDocs: 2110, notes: ['trips (x)'], dropped: { 'Trip pages': 110 } })
  expect('the stored report keeps the notes and the dropped counts', reportGaps.notes?.[0] === 'trips (x)' && reportGaps.dropped?.['Trip pages'] === 110)
  const stale = (path: string, linked: string[]) => pageCopyIsUsable(path, linked, [
    { slug: 'cro-1', destination: 'Croatia', available_from: '2999-01-01', available_to: '2999-02-01' },
    { slug: 'gre-1', destination: 'Greece', available_from: '2999-03-01', available_to: '2999-03-09' },
    { slug: 'old-1', destination: 'Spain', available_from: '2020-01-01', available_to: '2020-01-09' },
    { slug: 'undated', destination: 'Italy', available_from: null, available_to: null },
  ], '2026-10-18')
  expect('best-time and compare copy: only copy the page would really show is scanned', stale('/best-time-to-visit/croatia', ['cro-1']) && !stale('/best-time-to-visit/croatia', ['gone-1']) && !stale('/best-time-to-visit/spain', []) && !stale('/best-time-to-visit/italy', []) && stale('/compare/croatia-vs-greece', ['cro-1', 'gre-1']) && !stale('/compare/croatia-vs-greece', ['cro-1', 'zzz']) && !stale('/compare/greece-vs-croatia', []) && !stale('/compare/croatia-vs-nowhere', []))
  const staleDb: Db = JSON.parse(JSON.stringify(wide))
  ;(staleDb.tables.page_copy as Record<string, unknown>[]).push({ path: '/best-time-to-visit/greece', intro: 'Greek copy', key_takeaways: [], faq: [], status: 'published', linked_slugs: ['gone'] })
  ;(staleDb.tables.page_copy as Record<string, unknown>[])[0].linked_slugs = ['t1']
  const staleSite = await loadUsageDocs(fakeAdmin(staleDb), new Date('2026-10-18T00:00:00Z'))
  expect('the scan drops copy that links to a trip the page no longer lists, and keeps copy whose trips are all still there', !staleSite.docs.some((d) => d.path === '/best-time-to-visit/greece') && staleSite.docs.some((d) => d.path === '/best-time-to-visit/croatia'))
  const qf = guideFieldSet({ ...guideBase, key_takeaways: ['One. a', 'Two. b', 'Three. c', 'Four. d', 'Five. e', 'Six. f'] }, 'guide', 'right').facts.length
  expect('quick facts are scanned for both layouts: up to five (four under the title are the same first four)', qf === 5 && guideFieldSet({ ...guideBase, key_takeaways: ['One. a', 'Two. b', 'Three. c', 'Four. d', 'Five. e'] }, 'guide', 'left').facts.length === 4)

  // ---------- 15. the written files hold no em dash ----------
  const newText = ['lib/affiliate-text-sources.ts', 'lib/affiliate-usage.ts', 'lib/path-links.ts', 'content/who-we-are.ts', 'components/affiliate-text.tsx', 'components/page-copy-parts.tsx', 'components/trip-journal.tsx', 'components/admin/affiliate-word-linker.tsx', 'scripts/check-affiliate-text-sources.ts']
  const EM = String.fromCharCode(0x2014)
  expect('no em dash in the new text', newText.every((f) => !read(f).includes(EM)), newText.filter((f) => read(f).includes(EM)).join(','))
  expect('no em dash in the new wording of the pages', ['app/who-we-are/page.tsx', 'app/packages/[slug]/page.tsx', 'content/who-we-are.ts'].every((f) => !read(f).includes(EM)))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}
void main()
