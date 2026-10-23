// Offline check for the site health crawl (lib/site-crawl.ts, lib/site-crawl-run.ts). No network, no database, no AI call:
// the web is a fake fetch, the database is the in-memory fake (scripts/fake-admin.ts).
// Run: pnpm dlx tsx scripts/check-site-crawl.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Nothing in this file may reach a paid API or a search engine ping, whatever the shell has set.
process.env.ANTHROPIC_API_KEY = ''
process.env.INDEXNOW_KEY = ''

import { fakeAdmin, type Db } from './fake-admin'
import {
  BOT_NAME,
  CONCURRENCY,
  MAX_LINKS_PER_PAGE,
  analyzeContent,
  analyzeHreflang,
  analyzeIndexability,
  analyzeJsonLd,
  analyzeLink,
  analyzeMeta,
  analyzeMixedContent,
  analyzePage,
  analyzeResponse,
  analyzeUniqueness,
  crawlWindow,
  emptyState,
  extractFacts,
  fetchFollow,
  fetchSitemap,
  hash,
  internalLinks,
  mergeState,
  normUrl,
  parseSitemap,
  parseState,
  pathOf,
  pickWindow,
  summarize,
  undismissedErrors,
  windowSize,
  MAX_STORED_FINDINGS,
  type FetchLike,
  type Finding,
  type PageRecord,
} from '../lib/site-crawl'
import { MAX_FIXES_PER_RUN, healCrawlFindings, runSiteCrawl, dismissCrawlErrors, readCrawlState } from '../lib/site-crawl-run'
import { revertEdit } from '../lib/content-edits'
import { STATE_KEY } from '../lib/site-crawl'
import { collectIssues, resolveIssue } from '../lib/issues'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const kinds = (fs: Finding[]) => fs.map((f) => f.kind).sort()
const has = (fs: Finding[], kind: string, sev?: string) => fs.some((f) => f.kind === kind && (!sev || f.severity === sev))

const SITE = 'https://www.travelfunbiz.ca'
const BLOG_LD = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'x' })

interface PageOpts {
  title?: string | null
  description?: string | null
  h1?: number
  canonical?: string | null
  robots?: string
  imgs?: string
  ld?: string[]
  links?: string[]
  extraHead?: string
  extraBody?: string
}
/** A page of HTML. The defaults are a clean page; each option breaks one thing. */
function html(url: string, o: PageOpts = {}): string {
  const title = o.title === undefined ? 'A good clear page title for travel' : o.title
  const description = o.description === undefined ? 'A good description that says what this page offers to a traveller who is planning a group trip with us.' : o.description
  const canonical = o.canonical === undefined ? url : o.canonical
  const h1 = o.h1 ?? 1
  return `<!doctype html><html><head>${title === null ? '' : `<title>${title}</title>`}${description === null ? '' : `<meta name="description" content="${description}"/>`}${canonical === null ? '' : `<link rel="canonical" href="${canonical}"/>`}${o.robots ? `<meta name="robots" content="${o.robots}"/>` : '<meta name="robots" content="index, follow"/>'}${(o.ld ?? []).map((j) => `<script type="application/ld+json">${j}</script>`).join('')}${o.extraHead ?? ''}</head><body>${'<h1>Main heading</h1>'.repeat(h1)}${o.imgs ?? '<img src="/a.jpg" alt="A beach">'}${(o.links ?? []).map((l) => `<a href="${l}">link</a>`).join('')}<script>self.__next_f.push(["<h1>not real</h1>"])</script>${o.extraBody ?? ''}</body></html>`
}
function rec(url: string, o: PageOpts = {}, extra: Partial<PageRecord> = {}): PageRecord {
  const body = html(url, o)
  return { url, finalUrl: url, status: 200, hops: 0, ms: 300, contentType: 'text/html', xRobots: '', facts: extractFacts(body), inSitemap: true, ...extra }
}

// ---------------------------------------------------------------------------------------------------
// 1. Pure parsers and analysers, good and bad fixtures
// ---------------------------------------------------------------------------------------------------
const U = `${SITE}/destinations/italy`
const good = rec(U, { ld: [JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage' })] })
expect('a clean page has no findings at all', analyzePage(good).length === 0, kinds(analyzePage(good)).join(','))
expect('a script holding "<h1" text is not counted as a heading', good.facts?.h1Count === 1)
expect('home page canonical without a trailing slash equals the home address', analyzeIndexability(rec(`${SITE}/`, { canonical: SITE })).length === 0)

expect('missing h1 is flagged', has(analyzeContent(rec(U, { h1: 0 })), 'h1-missing', 'warning'))
expect('two h1 are flagged', has(analyzeContent(rec(U, { h1: 2 })), 'h1-multiple', 'warning'))
expect('a picture with no alt attribute is flagged', has(analyzeContent(rec(U, { imgs: '<img src="/a.jpg"><img src="/b.jpg" alt="ok">' })), 'img-alt-missing'))
expect('a decorative alt="" is not flagged', !has(analyzeContent(rec(U, { imgs: '<img src="/a.jpg" alt="">' })), 'img-alt-missing'))
expect('data-alt is not mistaken for alt', has(analyzeContent(rec(U, { imgs: '<img src="/a.jpg" data-alt="x">' })), 'img-alt-missing'))

expect('a canonical pointing at another page is an error', has(analyzeIndexability(rec(U, { canonical: `${SITE}/destinations/spain` })), 'canonical-mismatch', 'error'))
expect('a trailing slash or #fragment in the canonical is not a mismatch', analyzeIndexability(rec(U, { canonical: `${U}/#top` })).length === 0)
expect('a missing canonical is a warning', has(analyzeIndexability(rec(U, { canonical: null })), 'canonical-missing', 'warning'))
expect('canonical is compared with the final address after a redirect', analyzeIndexability(rec(U, { canonical: `${SITE}/new` }, { finalUrl: `${SITE}/new`, hops: 1 })).length === 0)
expect('noindex on a page the sitemap lists is an error', has(analyzeIndexability(rec(U, { robots: 'noindex, follow' })), 'noindex-in-sitemap', 'error'))
expect('an X-Robots-Tag noindex header counts too', has(analyzeIndexability(rec(U, {}, { xRobots: 'noindex' })), 'noindex-in-sitemap', 'error'))
expect('an indexable page missing from the sitemap is reported as info only', has(analyzeIndexability(rec(`${SITE}/extra`, {}, { inSitemap: false })), 'indexable-not-in-sitemap', 'info'))
expect('a noindex page that is not in the sitemap is fine', analyzeIndexability(rec(`${SITE}/extra`, { robots: 'noindex' }, { inSitemap: false })).length === 0)

expect('missing title is an error', has(analyzeMeta(rec(U, { title: null })), 'title-missing', 'error'))
expect('a too long title is a warning', has(analyzeMeta(rec(U, { title: 'T'.repeat(80) })), 'title-long', 'warning'))
expect('a too short title is a warning', has(analyzeMeta(rec(U, { title: 'Hi' })), 'title-short', 'warning'))
expect('missing description is a warning', has(analyzeMeta(rec(U, { description: null })), 'description-missing', 'warning'))
expect('a too long description is info', has(analyzeMeta(rec(U, { description: 'D'.repeat(200) })), 'description-long', 'info'))

const a = rec(`${SITE}/a`, { title: 'Same title for two pages here', description: 'One description here that is long enough to pass the length check for sure, yes.' })
const b = rec(`${SITE}/b`, { title: 'Same title for two pages here', description: 'A different description that is also long enough to pass the length check for sure.' })
const dups = analyzeUniqueness([a, b])
expect('duplicate titles are flagged on both pages', dups.filter((f) => f.kind === 'title-duplicate').length === 2)
expect('different descriptions are not flagged', !has(dups, 'description-duplicate'))
expect('a duplicate against a page checked earlier is found through the stored hash', has(analyzeUniqueness([a], { '/old': [hash('Same title for two pages here'), 'x'] }), 'title-duplicate'))
expect('a stored hash of the same page is ignored', !has(analyzeUniqueness([a], { '/a': [hash('Same title for two pages here'), 'x'] }), 'title-duplicate'))
expect('titles compare ignoring case and spacing', hash('Hello  World') === hash('hello world'))

expect('broken JSON-LD is an error', has(analyzeJsonLd(rec(U, { ld: ['{"@type": "Place", '] })), 'jsonld-invalid', 'error'))
expect('JSON-LD with no type is an error', has(analyzeJsonLd(rec(U, { ld: ['{"name":"x"}'] })), 'jsonld-invalid', 'error'))
expect('a blog post without BlogPosting JSON-LD is a warning', has(analyzeJsonLd(rec(`${SITE}/blog/x`, { ld: [JSON.stringify({ '@type': 'FAQPage' })] })), 'jsonld-missing', 'warning'))
expect('a blog post with BlogPosting (also inside @graph) is fine', analyzeJsonLd(rec(`${SITE}/blog/x`, { ld: [BLOG_LD] })).length === 0 && analyzeJsonLd(rec(`${SITE}/blog/x`, { ld: [JSON.stringify({ '@graph': [{ '@type': 'BlogPosting' }] })] })).length === 0)
expect('a page kind with no required type needs no JSON-LD', analyzeJsonLd(rec(`${SITE}/packages`, {})).length === 0)
expect('a trip page without TouristTrip is a warning', has(analyzeJsonLd(rec(`${SITE}/packages/x`, {})), 'jsonld-missing'))

expect('an http picture on an https page is mixed content (warning)', has(analyzeMixedContent(rec(U, { imgs: '<img src="http://x.test/a.jpg" alt="a">' })), 'mixed-content', 'warning'))
expect('an http script is mixed content (error)', has(analyzeMixedContent(rec(U, { extraBody: '<script src="http://x.test/a.js"></script>' })), 'mixed-content', 'error'))
expect('https items are not mixed content', analyzeMixedContent(rec(U, { imgs: '<img src="https://x.test/a.jpg" alt="a">' })).length === 0)
expect('hreflang without the page itself is flagged', has(analyzeHreflang(rec(U, { extraHead: `<link rel="alternate" hreflang="en-ca" href="${SITE}/other"/>` })), 'hreflang-no-self', 'warning'))
expect('hreflang that includes the page is fine', analyzeHreflang(rec(U, { extraHead: `<link rel="alternate" hreflang="en-ca" href="${U}"/><link rel="alternate" hreflang="x-default" href="${U}"/>` })).length === 0)

expect('404 on a sitemap page is an error', has(analyzeResponse(rec(U, {}, { status: 404 })), 'page-gone', 'error'))
expect('500 is an error', has(analyzeResponse(rec(U, {}, { status: 500 })), 'server-error', 'error'))
expect('a timeout is a warning, not an error', has(analyzeResponse(rec(U, {}, { status: 0, error: 'no answer after 6s', facts: null })), 'unreachable', 'warning'))
expect('one redirect from a sitemap address is a warning', has(analyzeResponse(rec(U, {}, { hops: 1, finalUrl: `${SITE}/b` })), 'sitemap-redirect', 'warning'))
expect('two redirects is a chain warning', has(analyzeResponse(rec(U, {}, { hops: 2, finalUrl: `${SITE}/b` })), 'redirect-chain', 'warning'))
expect('three redirects is a chain error', has(analyzeResponse(rec(U, {}, { hops: 3, finalUrl: `${SITE}/b` })), 'redirect-chain', 'error'))
expect('a slow answer is a warning', has(analyzeResponse(rec(U, {}, { ms: 5000 })), 'slow', 'warning'))
expect('a huge page is a warning', has(analyzeResponse({ ...good, facts: { ...good.facts!, htmlBytes: 900_000 } }), 'big-html', 'warning'))
expect('every finding carries a plain-English fix hint', [dups, analyzeMeta(rec(U, { title: null })), analyzeLink(U, `${SITE}/gone`, { status: 404, hops: 0, finalUrl: `${SITE}/gone` })].flat().every((f) => f.hint.length > 20))
expect('no analyser text uses an em dash', !/—/.test(read('lib/site-crawl.ts') + read('lib/site-crawl-run.ts')))

expect('parseSitemap reads <loc> entries', parseSitemap('<urlset><url><loc>https://a.test/x</loc></url><url><loc> https://a.test/y&amp;z </loc></url></urlset>').urls.join() === 'https://a.test/x,https://a.test/y&z')
expect('parseSitemap reads an index', parseSitemap('<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>').children.length === 1)
expect('normUrl drops fragment and trailing slash', normUrl('https://WWW.x.test/a/#b') === 'https://www.x.test/a' && normUrl('/a/', 'https://x.test') === 'https://x.test/a' && normUrl('mailto:a@b.c') === null)

// ---------------------------------------------------------------------------------------------------
// 2. The fetch layer against a fake web
// ---------------------------------------------------------------------------------------------------
interface FakePage {
  status?: number
  body?: string
  location?: string
  headers?: Record<string, string>
  hang?: boolean
}
function fakeWeb(pages: Record<string, FakePage>, log: { method: string; url: string; ua: string }[] = [], tracker = { inflight: 0, max: 0 }): FetchLike {
  return async (url, init) => {
    log.push({ method: init.method, url, ua: init.headers['user-agent'] })
    tracker.inflight++
    tracker.max = Math.max(tracker.max, tracker.inflight)
    try {
      await new Promise((r) => setTimeout(r, 2))
      const p = pages[pathOf(url)] ?? { status: 404, body: 'not found' }
      if (p.hang) return await new Promise(() => undefined)
      const headers = new Map(Object.entries({ 'content-type': 'text/html', ...(p.location ? { location: p.location } : {}), ...(p.headers ?? {}) }))
      return { status: p.status ?? 200, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => p.body ?? '' }
    } finally {
      tracker.inflight--
    }
  }
}
const sitemapXml = (paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`
const page = (path: string, o: PageOpts = {}) => ({ body: html(`${SITE}${path}`, o) })

async function main() {
  // Redirect following by hand, hop counting, and the identity of the bot.
  {
    const log: { method: string; url: string; ua: string }[] = []
    const f = fakeWeb({ '/r1': { status: 301, location: '/r2' }, '/r2': { status: 301, location: `${SITE}/r3` }, '/r3': { status: 301, location: '/final' }, '/final': page('/final'), '/loop': { status: 302, location: '/loop' } }, log)
    const got = await fetchFollow(`${SITE}/r1`, f, { readBody: true })
    expect('a 3-hop chain is followed and counted', got.status === 200 && got.hops === 3 && got.finalUrl === `${SITE}/final`, JSON.stringify({ ...got, body: '' }))
    expect('every request carries the bot user agent', log.length > 0 && log.every((l) => l.ua === BOT_NAME) && BOT_NAME === 'TravelFunBizHealthBot')
    const loop = await fetchFollow(`${SITE}/loop`, f, {})
    expect('a redirect loop stops (no endless chase)', loop.hops > 5 && log.length < 20)
    const hang = await fetchFollow(`${SITE}/x`, fakeWeb({ '/x': { hang: true } }), { timeoutMs: 80 })
    expect('a request that never answers times out and reports an error', hang.status === 0 && !!hang.error && /no answer/.test(hang.error))
  }

  // The sitemap
  {
    const f = fakeWeb({ '/sitemap.xml': { body: sitemapXml(['/', '/a', '/b/', '/a']) } })
    const sm = await fetchSitemap(SITE, f)
    expect('the sitemap is read, de-duplicated and normalised', sm.urls.length === 3 && sm.urls.includes(`${SITE}/b`), sm.urls.join())
    expect('a missing sitemap is reported, not thrown', !!(await fetchSitemap(SITE, fakeWeb({}))).error)
  }

  // A whole window: dead link, redirect chain, redirect, missing alt, duplicate titles, noindex page, extra page.
  {
    const pages: Record<string, FakePage> = {
      '/a': page('/a', { title: 'The very same title on two pages', links: ['/gone', '/old1', '/old-single', '/ok', '/unlisted', '/admin/x', '/go/partner', '/pic.jpg', 'mailto:x@y.z', 'https://other.test/x', '#top'], imgs: '<img src="/a.jpg">' }),
      '/b': page('/b', { title: 'The very same title on two pages', links: ['/gone', '/ok'] }),
      '/c': page('/c', { robots: 'noindex' }),
      '/d': page('/d', { canonical: `${SITE}/elsewhere`, h1: 2 }),
      '/ok': page('/ok'),
      '/gone': { status: 404, body: 'x' },
      '/old1': { status: 301, location: '/old2' },
      '/old2': { status: 301, location: '/landing' },
      '/landing': page('/landing'),
      '/old-single': { status: 301, location: '/landing' },
      '/unlisted': page('/unlisted'),
    }
    const log: { method: string; url: string; ua: string }[] = []
    const tracker = { inflight: 0, max: 0 }
    const f = fakeWeb(pages, log, tracker)
    const win = [`${SITE}/a`, `${SITE}/b`, `${SITE}/c`, `${SITE}/d`, `${SITE}/ok`]
    const res = await crawlWindow({ siteUrl: SITE, sitemapUrls: [...win, `${SITE}/gone`], window: win, fetch: f, delayMs: 0 })
    const fs = res.findings
    expect('the crawl checked every page of the window', res.checked.length === 5 && res.skipped.length === 0)
    expect('a dead internal link is an error on the page that has it', fs.some((x) => x.kind === 'dead-link' && x.severity === 'error' && pathOf(x.url) === '/a' && pathOf(x.target ?? '') === '/gone' && x.status === 404))
    expect('a dead link is asked about once, shared by the pages that have it', log.filter((l) => pathOf(l.url) === '/gone').length === 1 && fs.filter((x) => x.kind === 'dead-link').length === 2)
    expect('a link through a 2-hop redirect chain is a warning', fs.some((x) => x.kind === 'link-redirect-chain' && x.severity === 'warning' && pathOf(x.target ?? '') === '/old1'))
    expect('a link through one redirect is info', fs.some((x) => x.kind === 'link-redirect' && x.severity === 'info' && pathOf(x.target ?? '') === '/old-single'))
    expect('duplicate titles across the window are found', fs.filter((x) => x.kind === 'title-duplicate' && ['/a', '/b'].includes(pathOf(x.url))).length === 2)
    expect('a noindex page in the sitemap is an error', fs.some((x) => x.kind === 'noindex-in-sitemap' && pathOf(x.url) === '/c'))
    expect('a wrong canonical is an error and two h1 a warning', fs.some((x) => x.kind === 'canonical-mismatch' && pathOf(x.url) === '/d') && fs.some((x) => x.kind === 'h1-multiple' && pathOf(x.url) === '/d'))
    expect('a missing alt is found', fs.some((x) => x.kind === 'img-alt-missing' && pathOf(x.url) === '/a'))
    expect('a linked indexable page that the sitemap lacks is reported as info', fs.some((x) => x.kind === 'indexable-not-in-sitemap' && x.severity === 'info' && pathOf(x.url) === '/unlisted'))
    expect('admin, affiliate hop, files, mail, other sites and anchors are never checked as links', !log.some((l) => /\/admin|\/go\/|\.jpg|other\.test/.test(l.url) && l.method === 'HEAD'))
    expect('links are checked with HEAD', log.some((l) => l.method === 'HEAD' && pathOf(l.url) === '/gone'))
    expect('a good page that the window covers is not asked about as a link twice', log.filter((l) => pathOf(l.url) === '/ok' && l.method === 'HEAD').length === 0)
    expect('requests never run more than 4 at once', tracker.max <= CONCURRENCY && tracker.max >= 2, `max ${tracker.max}`)
    expect('every request used the bot user agent', log.every((l) => l.ua === BOT_NAME))
    expect('the cursor is the last page of the window', res.cursor === win[win.length - 1])
  }

  // Caps: at most 30 links a page, at most the link-check budget in total.
  {
    const links = Array.from({ length: 80 }, (_v, i) => `/l${i}`)
    const pages: Record<string, FakePage> = { '/p': page('/p', { links }) }
    for (const l of links) pages[l] = page(l)
    const log: { method: string; url: string; ua: string }[] = []
    const res = await crawlWindow({ siteUrl: SITE, sitemapUrls: [`${SITE}/p`], window: [`${SITE}/p`], fetch: fakeWeb(pages, log), delayMs: 0, maxExtraPages: 0 })
    expect('at most 30 links of a page are checked', log.filter((l) => l.method === 'HEAD').length === MAX_LINKS_PER_PAGE && MAX_LINKS_PER_PAGE === 30, String(log.length))
    const capped = await crawlWindow({ siteUrl: SITE, sitemapUrls: [`${SITE}/p`], window: [`${SITE}/p`], fetch: fakeWeb(pages), delayMs: 0, maxLinkChecks: 7, maxExtraPages: 0 })
    expect('the per-run link check cap is respected', capped.linkChecks === 7 && res.linkChecks === 30)
    expect('internalLinks de-duplicates and caps', internalLinks({ ...(good.facts!), links: ['/a', '/a/', '/b', `${SITE}/c#x`] }, `${SITE}/p`, SITE, 2).length === 2)
  }

  // Budget guard: past the deadline nothing new starts, the cursor stops at the first gap, the run says the budget was used.
  {
    const pages: Record<string, FakePage> = {}
    const win: string[] = []
    for (let i = 0; i < 12; i++) {
      pages[`/p${i}`] = page(`/p${i}`)
      win.push(`${SITE}/p${i}`)
    }
    const log: { method: string; url: string; ua: string }[] = []
    const res = await crawlWindow({ siteUrl: SITE, sitemapUrls: win, window: win, fetch: fakeWeb(pages, log), delayMs: 0, deadlineMs: Date.now() - 1 })
    expect('with the deadline already passed no request is sent', log.length === 0 && res.checked.length === 0 && res.skipped.length === 12 && res.budgetUsed && res.cursor === null)
    let n = 0
    const slowStop = fakeWeb(pages, log)
    const partial = await crawlWindow({ siteUrl: SITE, sitemapUrls: win, window: win, fetch: async (u, i) => ((n++, slowStop(u, i))), delayMs: 0, concurrency: 1, deadlineMs: Date.now() + 25 })
    expect('a deadline in the middle checks some pages, skips the rest and reports it', partial.checked.length > 0 && partial.skipped.length > 0 && partial.budgetUsed && partial.cursor === partial.checked[partial.checked.length - 1], `${partial.checked.length}/${partial.skipped.length}`)
  }

  // ---------------------------------------------------------------------------------------------------
  // 3. Rotation: every page is checked at least weekly
  // ---------------------------------------------------------------------------------------------------
  {
    expect('window size is 10 to 40 and about total/7', windowSize(5) === 10 && windowSize(86) === 13 && windowSize(280) === 40 && windowSize(5000) === 40)
    let all = true
    for (const total of [1, 9, 10, 40, 86, 100, 133, 200, 279, 280]) {
      const urls = Array.from({ length: total }, (_v, i) => `${SITE}/p${String(i).padStart(4, '0')}`)
      let cursor: string | null = null
      const seen = new Set<string>()
      for (let day = 0; day < 7; day++) {
        const w = pickWindow(urls, cursor, windowSize(total))
        if (w.length > 40) all = false
        w.forEach((u) => seen.add(u))
        cursor = w[w.length - 1] ?? cursor
      }
      if (seen.size !== total) {
        all = false
        console.log(`  total ${total}: covered ${seen.size}`)
      }
    }
    expect('7 daily windows cover every page (up to 280 pages) and none is over 40', all)
    // New pages appearing and old pages going away between runs do not break the rotation.
    const w1 = pickWindow(['a', 'b', 'c', 'd'], 'b', 2)
    expect('the window starts after the cursor and wraps round', w1.join() === 'c,d' && pickWindow(['a', 'b', 'c'], 'c', 2).join() === 'a,b' && pickWindow(['a', 'c'], 'b', 1).join() === 'c' && pickWindow([], 'x', 5).length === 0)
  }

  // ---------------------------------------------------------------------------------------------------
  // 4. The stored state: bounded, first-seen kept, counts per page
  // ---------------------------------------------------------------------------------------------------
  {
    const now = new Date('2026-10-22T14:00:00Z')
    const mk = (path: string, kind: string, sev: 'error' | 'warning' | 'info', target?: string): Finding => ({ url: `${SITE}${path}`, kind, severity: sev, message: `m ${kind}`, hint: 'fix it now please', ...(target ? { target: `${SITE}${target}` } : {}) })
    const recs = [rec(`${SITE}/a`), rec(`${SITE}/b`)]
    let st = mergeState(emptyState(), { checkedUrls: [`${SITE}/a`, `${SITE}/b`], records: recs, findings: [mk('/a', 'dead-link', 'error', '/gone'), mk('/b', 'h1-missing', 'warning')], totalUrls: 86, cursor: `${SITE}/b`, budgetUsed: false, fixed: 0, note: 'n', sitemapPaths: ['/a', '/b', '/c'] }, now)
    expect('state counts errors and warnings per page', summarize(st, now).errors === 1 && summarize(st, now).warnings === 1 && summarize(st, now).checked7d === 2 && st.cursor === `${SITE}/b`)
    const later = new Date('2026-10-23T14:00:00Z')
    st = mergeState(st, { checkedUrls: [`${SITE}/a`], records: [recs[0]], findings: [mk('/a', 'dead-link', 'error', '/gone')], totalUrls: 86, cursor: `${SITE}/a`, budgetUsed: false, fixed: 0, note: 'n', sitemapPaths: ['/a', '/b', '/c'] }, later)
    expect('first-seen date is kept when the same problem is found again', st.findings.find((f) => f.kind === 'dead-link')?.firstSeen === now.toISOString())
    expect('findings of pages not checked this time are kept until their turn', st.findings.some((f) => f.kind === 'h1-missing'))
    st = mergeState(st, { checkedUrls: [`${SITE}/b`], records: [recs[1]], findings: [], totalUrls: 86, cursor: `${SITE}/b`, budgetUsed: false, fixed: 0, note: 'n', sitemapPaths: ['/a', '/b'] }, later)
    expect('a problem that is gone when the page is checked again disappears', !st.findings.some((f) => f.kind === 'h1-missing'))
    st = mergeState(st, { checkedUrls: [`${SITE}/a`], records: [recs[0]], findings: [mk('/a', 'dead-link', 'error', '/gone')], totalUrls: 86, cursor: null, budgetUsed: false, fixed: 1, note: 'n', sitemapPaths: ['/a', '/b'] }, later, new Set(['/a|dead-link|/gone']))
    expect('a healed finding is dropped from the state', !st.findings.some((f) => f.kind === 'dead-link') && summarize(st, later).errors === 0 && st.fixed === 1)
    const many = Array.from({ length: 100 }, (_v, i) => mk(`/p${i}`, 'h1-missing', 'warning'))
    const big = mergeState(emptyState(), { checkedUrls: many.map((f) => f.url), records: many.map((f) => rec(f.url)), findings: many, totalUrls: 100, cursor: null, budgetUsed: false, fixed: 0, note: 'n', sitemapPaths: many.map((f) => pathOf(f.url)) }, now)
    expect('only the top 30 findings are stored, the counts still cover every page', big.findings.length === MAX_STORED_FINDINGS && summarize(big, now).warnings === 100)
    expect('the stored state stays small', JSON.stringify(big).length < 25_000, String(JSON.stringify(big).length))
    const sorted = mergeState(emptyState(), { checkedUrls: [`${SITE}/a`], records: [rec(`${SITE}/a`)], findings: [mk('/a', 'x', 'info'), mk('/a', 'y', 'error'), mk('/a', 'z', 'warning')], totalUrls: 1, cursor: null, budgetUsed: false, fixed: 0, note: 'n', sitemapPaths: ['/a'] }, now)
    expect('errors come first in the stored list', sorted.findings.map((f) => f.severity).join() === 'error,warning,info')
    expect('a broken or old state reads as empty', parseState('not json').lastRun === null && parseState(JSON.stringify({ v: 2 })).findings.length === 0 && parseState(null).total === 0)
    const dismissed = { ...sorted, dismissedAt: '2026-10-22T15:00:00.000Z' }
    expect('a dismissed error stays hidden, a newer one shows again', undismissedErrors(dismissed).length === 0 && undismissedErrors({ ...dismissed, dismissedAt: '2026-10-22T13:00:00.000Z' }).length === 1)
  }

  // ---------------------------------------------------------------------------------------------------
  // 5. Self-heal against the fake database
  // ---------------------------------------------------------------------------------------------------
  const BODY_LINKED = 'Intro text about the trip.\n\nRead [our old guide](/blog/gone-post) and also [a live one](/blog/alive-post) before you go.'
  const deadFinding = (path: string, target: string): Finding => ({ url: `${SITE}${path}`, kind: 'dead-link', severity: 'error', message: 'm', hint: 'fix it now please', target: `${SITE}${target}`, status: 404 })
  const web = (): FetchLike => fakeWeb({ '/blog/gone-post': { status: 404 }, '/blog/alive-post': page('/blog/alive-post'), '/gone2': { status: 404 }, '/gone3': { status: 404 } })
  const newDb = (): Db => ({
    tables: {
      app_settings: [],
      content_edits: [],
      posts: [
        { id: 'p1', slug: 'my-post', title: 'My Post Title', primary_keyword: 'italy group trip', body: BODY_LINKED, status: 'published', cover_image_url: 'https://img.test/c.jpg', alt_text: '', updated_at: '2026-10-01T00:00:00Z' },
        { id: 'p2', slug: 'draft-post', title: 'Draft', body: BODY_LINKED, status: 'draft', updated_at: '2026-10-01T00:00:00Z' },
      ],
      guides: [{ id: 'g1', kind: 'destinations', slug: 'italy', name: 'Italy', summary: 'Italy summary [gone](/blog/gone-post) text.', body: '## Where\n\nSee [the post](/blog/gone-post) for more.', sections: [], status: 'published', hero_image_url: 'https://img.test/h.jpg', hero_alt: 'image', updated_at: '2026-10-01T00:00:00Z' }],
    },
  })
  const sitemapPaths = new Set(['/blog/my-post', '/destinations/italy', '/blog/alive-post'])

  {
    const db = newDb()
    const admin = fakeAdmin(db)
    const r = await healCrawlFindings(admin, [deadFinding('/blog/my-post', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    const post = db.tables.posts.find((p) => p.id === 'p1')!
    expect('a dead link in a post body is removed and the words stay', r.fixed === 1 && String(post.body).includes('Read our old guide and also [a live one](/blog/alive-post)') && !String(post.body).includes('gone-post'), String(post.body))
    const edit = db.tables.content_edits[0]
    expect('the fix is logged with before and after text, the path, a reason and published_after', !!edit && edit.before === BODY_LINKED && edit.after === post.body && edit.path === '/blog/my-post' && edit.field === 'links' && edit.content_type === 'post' && /Site crawl/.test(String(edit.reason)) && edit.published_after === true && edit.content_id === 'p1')
    expect('the healed finding is reported back so the state drops it', r.healedKeys.has('/blog/my-post|dead-link|/blog/gone-post') && r.changedPaths.join() === '/blog/my-post')
    const undo = await revertEdit(admin, String(edit.id), { skipSiblingUnpublish: true })
    expect('Undo puts the original text back', undo.ok && post.body === BODY_LINKED && !!db.tables.content_edits[0].reverted_at, JSON.stringify(undo))
  }
  {
    // A guide: the link inside the summary and in a section both go, the article still parses.
    const db = newDb()
    const admin = fakeAdmin(db)
    const r = await healCrawlFindings(admin, [deadFinding('/destinations/italy', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    const g = db.tables.guides[0]
    expect('a dead link in a guide (summary and sections) is removed', r.fixed === 1 && !String(g.body).includes('gone-post') && !String(g.summary).includes('gone-post') && String(g.body).includes('See the post for more') && String(g.summary).includes('gone text'), JSON.stringify({ s: g.summary, b: g.body, notes: r.notes }))
    const undo = await revertEdit(admin, String(db.tables.content_edits[0].id), { skipSiblingUnpublish: true })
    expect('a guide fix can be undone too', undo.ok && String(db.tables.guides[0].body).includes('(/blog/gone-post)'), JSON.stringify(undo))
  }
  {
    const db = newDb()
    const admin = fakeAdmin(db)
    // Cases that must NOT change anything.
    const r1 = await healCrawlFindings(admin, [deadFinding('/blog/my-post', '/blog/alive-post')], { fetch: web(), sitemapPaths })
    expect('a link whose page is alive again on the re-check is kept', r1.fixed === 0 && db.tables.content_edits.length === 0)
    const r2 = await healCrawlFindings(admin, [deadFinding('/blog/my-post', '/blog/gone-post')], { fetch: web(), sitemapPaths: new Set([...sitemapPaths, '/blog/gone-post']) })
    expect('a link to a page that the sitemap lists is never removed', r2.fixed === 0)
    const r3 = await healCrawlFindings(admin, [deadFinding('/blog/draft-post', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    expect('a draft is never edited', r3.fixed === 0)
    const r4 = await healCrawlFindings(admin, [deadFinding('/packages/some-trip', '/blog/gone-post'), deadFinding('/', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    expect('a link on a template or trip page (not a post or guide body) is reported only', r4.fixed === 0)
    const r5 = await healCrawlFindings(admin, [{ ...deadFinding('/blog/my-post', '/gone2'), status: 500 }], { fetch: web(), sitemapPaths })
    expect('a 5xx link is not removed (only 404 and 410)', r5.fixed === 0)
    const r6 = await healCrawlFindings(admin, [deadFinding('/blog/my-post', '/gone2')], { fetch: web(), sitemapPaths })
    expect('a dead link that is not in the stored text is left alone', r6.fixed === 0 && db.tables.content_edits.length === 0)
    expect('nothing in the post changed in all those cases', db.tables.posts[0].body === BODY_LINKED)
  }
  {
    // Fail closed: the audit log cannot be written, so the page is not touched.
    const db = newDb()
    db.failWrites = { content_edits: 'check constraint violated' }
    const r = await healCrawlFindings(fakeAdmin(db), [deadFinding('/blog/my-post', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    expect('if the audit log cannot be written nothing is changed (log, then apply)', r.fixed === 0 && db.tables.posts[0].body === BODY_LINKED && r.notes.some((n) => /audit log/.test(n)))
    // The page cannot be written: the log row is taken back out.
    const db2 = newDb()
    db2.failWrites = { posts: 'write refused' }
    const r2 = await healCrawlFindings(fakeAdmin(db2), [deadFinding('/blog/my-post', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    expect('if the page cannot be written the log row is taken back', r2.fixed === 0 && db2.tables.content_edits.length === 0)
    // A person edited the page between the read and the write.
    const db3 = newDb()
    const admin3 = fakeAdmin(db3)
    const racing: FetchLike = async (u, i) => {
      db3.tables.posts[0].updated_at = '2026-10-22T10:00:00Z' // an edit lands while we re-check the link
      return web()(u, i)
    }
    const r3 = await healCrawlFindings(admin3, [deadFinding('/blog/my-post', '/blog/gone-post')], { fetch: racing, sitemapPaths })
    expect('a page that changed since it was read is left alone', r3.fixed === 0 && db3.tables.content_edits.length === 0 && db3.tables.posts[0].body === BODY_LINKED, JSON.stringify(r3.notes))
  }
  {
    // Kill switch: paused means no repairs, an unreadable switch means no repairs.
    const db = newDb()
    db.tables.app_settings.push({ key: 'automation_paused', value: 'true' })
    const r = await healCrawlFindings(fakeAdmin(db), [deadFinding('/blog/my-post', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    expect('nothing is repaired while automation is paused', r.fixed === 0 && r.skippedBecause === 'automation is paused' && db.tables.posts[0].body === BODY_LINKED && db.tables.content_edits.length === 0)
    const bad = fakeAdmin(newDb())
    const realFrom = bad.from.bind(bad)
    ;(bad as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'app_settings') throw new Error('settings unreadable')
      return realFrom(t)
    }
    const r2 = await healCrawlFindings(bad, [deadFinding('/blog/my-post', '/blog/gone-post')], { fetch: web(), sitemapPaths })
    expect('nothing is repaired when the pause switch cannot be read, and it does not throw', r2.fixed === 0)
  }
  {
    // The cap: 9 posts with a dead link, at most 5 fixed in one run.
    const db = newDb()
    for (let i = 0; i < 9; i++) db.tables.posts.push({ id: `x${i}`, slug: `bulk-${i}`, title: `Bulk ${i}`, body: BODY_LINKED, status: 'published', cover_image_url: null, alt_text: 'fine alt text for this', updated_at: '2026-10-01T00:00:00Z' })
    const findings = Array.from({ length: 9 }, (_v, i) => deadFinding(`/blog/bulk-${i}`, '/blog/gone-post'))
    const r = await healCrawlFindings(fakeAdmin(db), findings, { fetch: web(), sitemapPaths })
    expect('at most 5 automatic fixes per run', r.fixed === MAX_FIXES_PER_RUN && MAX_FIXES_PER_RUN === 5 && db.tables.content_edits.length === 5, `fixed ${r.fixed}`)
    const r2 = await healCrawlFindings(fakeAdmin(db), findings, { fetch: web(), sitemapPaths, cap: 2 })
    expect('a lower cap is respected too', r2.fixed <= 2)
    const r3 = await healCrawlFindings(fakeAdmin(db), findings, { fetch: web(), sitemapPaths, deadlineMs: Date.now() + 100 })
    expect('no repair starts when the time budget is nearly used', r3.fixed === 0)
  }
  {
    // Missing alt text on a cover or hero.
    const db = newDb()
    const admin = fakeAdmin(db)
    const altFinding = (path: string): Finding => ({ url: `${SITE}${path}`, kind: 'img-alt-missing', severity: 'warning', message: 'm', hint: 'fix it now please' })
    const r = await healCrawlFindings(admin, [altFinding('/blog/my-post'), altFinding('/destinations/italy')], { fetch: web(), sitemapPaths })
    const post = db.tables.posts[0]
    const guide = db.tables.guides[0]
    expect('an empty cover alt gets a descriptive one from the title', r.fixed === 2 && typeof post.alt_text === 'string' && post.alt_text.length > 10 && /italy group trip|My Post/i.test(String(post.alt_text)), String(post.alt_text))
    expect('a generic hero alt gets a descriptive one from the guide name', /Italy/.test(String(guide.hero_alt)) && String(guide.hero_alt).length > 10, String(guide.hero_alt))
    const e = db.tables.content_edits.find((x) => x.field === 'alt_text')!
    expect('the alt fix is logged with before and after', !!e && e.before === '' && e.after === post.alt_text && e.content_type === 'post')
    const undo = await revertEdit(admin, String(e.id), { skipSiblingUnpublish: true })
    expect('Undo puts the empty cover alt back', undo.ok && post.alt_text === null, JSON.stringify(undo))
    const undo2 = await revertEdit(admin, String(db.tables.content_edits.find((x) => x.field === 'hero_alt')!.id), { skipSiblingUnpublish: true })
    expect('Undo puts the old hero alt back', undo2.ok && guide.hero_alt === 'image', JSON.stringify(undo2))
    const db2 = newDb()
    db2.tables.posts[0].alt_text = 'A good descriptive alt text for this cover picture'
    const r2 = await healCrawlFindings(fakeAdmin(db2), [altFinding('/blog/my-post')], { fetch: web(), sitemapPaths })
    expect('a good existing alt is never overwritten', r2.fixed === 0 && db2.tables.content_edits.length === 0)
    const db3 = newDb()
    db3.tables.posts[0].cover_image_url = null
    const r3 = await healCrawlFindings(fakeAdmin(db3), [altFinding('/blog/my-post')], { fetch: web(), sitemapPaths })
    expect('a post with no cover is not given an alt', r3.fixed === 0)
  }

  // ---------------------------------------------------------------------------------------------------
  // 6. The whole daily step, the stored state, Needs attention, dismiss
  // ---------------------------------------------------------------------------------------------------
  {
    const pages: Record<string, FakePage> = {
      '/sitemap.xml': { body: sitemapXml(['/blog/my-post', '/destinations/italy', '/blog/alive-post']) },
      '/blog/my-post': page('/blog/my-post', { ld: [BLOG_LD], links: ['/blog/gone-post', '/blog/alive-post'], imgs: '<img src="/c.jpg">' }),
      '/destinations/italy': page('/destinations/italy', { ld: [JSON.stringify({ '@type': 'CollectionPage' })], links: ['/blog/gone-post'] }),
      '/blog/alive-post': page('/blog/alive-post', { ld: [BLOG_LD], title: 'The alive post has its own title' }),
      '/blog/gone-post': { status: 404, body: 'nf' },
    }
    const db = newDb()
    const admin = fakeAdmin(db)
    const run = await runSiteCrawl(admin, { fetch: fakeWeb(pages), delayMs: 0, now: new Date('2026-10-22T14:00:00Z'), siteUrl: SITE })
    const st = parseState(String(db.tables.app_settings.find((r) => r.key === STATE_KEY)?.value))
    expect('the daily step runs, repairs and stores a compact result in site_crawl_state', run.ok && run.fixed >= 1 && st.lastRun === '2026-10-22T14:00:00.000Z' && st.total === 3 && st.lastChecked === 3 && st.cursor !== null, run.note)
    expect('the note says what happened in plain words', /checked 3 of 3 pages/.test(run.note) && /fixed/.test(run.note))
    expect('the healed dead link is gone from the stored findings', !st.findings.some((f) => f.kind === 'dead-link' && /gone-post/.test(f.target ?? '')), JSON.stringify(st.findings.map((f) => f.kind)))
    expect('the step never writes to a page it was only asked to look at (no page edit beyond the logged fixes)', db.tables.content_edits.every((e) => e.field === 'links' || e.field === 'alt_text'))

    // Paused: the same crawl runs read only.
    const db2 = newDb()
    db2.tables.app_settings.push({ key: 'automation_paused', value: 'true' })
    const run2 = await runSiteCrawl(fakeAdmin(db2), { fetch: fakeWeb(pages), delayMs: 0, siteUrl: SITE })
    const st2 = parseState(String(db2.tables.app_settings.find((r) => r.key === STATE_KEY)?.value))
    expect('while paused the crawl still reports but changes nothing', run2.ok && run2.fixed === 0 && db2.tables.posts[0].body === BODY_LINKED && db2.tables.content_edits.length === 0 && st2.findings.some((f) => f.kind === 'dead-link'), run2.note)
    expect('the note says why there were no repairs', /automation is paused/.test(run2.note))

    // Needs attention: errors show, Dismiss hides, a NEW error shows again.
    const issues = await collectIssues(fakeAdmin(db2)).catch(() => null)
    if (issues) {
      const item = issues.find((i) => i.id === 'system:site-crawl')
      expect('error findings appear in Needs attention with a Dismiss action', !!item && !!item.actions?.some((x) => x.kind === 'dismiss-site-crawl'))
      const err = await resolveIssue(fakeAdmin(db2), 'dismiss-site-crawl')
      const again = await collectIssues(fakeAdmin(db2)).catch(() => null)
      expect('Dismiss hides it', err === null && !!again && !again.some((i) => i.id === 'system:site-crawl'))
    } else {
      expect('Needs attention can be built on the fake database', false, 'collectIssues threw')
    }

    // The sitemap is down: the old state is kept and the step says why.
    const db3 = newDb()
    db3.tables.app_settings.push({ key: STATE_KEY, value: JSON.stringify({ ...st, note: 'old' }) })
    const run3 = await runSiteCrawl(fakeAdmin(db3), { fetch: fakeWeb({}), delayMs: 0, siteUrl: SITE })
    const st3 = parseState(String(db3.tables.app_settings.find((r) => r.key === STATE_KEY)?.value))
    expect('a missing sitemap fails open: it says so and keeps the earlier findings', !run3.ok && /sitemap/.test(run3.note) && st3.findings.length === st.findings.length && st3.total === st.total)

    // The state cannot be read: the step skips, does not throw, and does not overwrite.
    const db4 = newDb()
    const broken = fakeAdmin(db4)
    const from = broken.from.bind(broken)
    ;(broken as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'app_settings') throw new Error('db down')
      return from(t)
    }
    const run4 = await runSiteCrawl(broken, { fetch: fakeWeb(pages), delayMs: 0, siteUrl: SITE })
    expect('a database failure never throws out of the step', !run4.ok && /site crawl/.test(run4.note))

    // Budget guard: with no time left the step checks nothing, repairs nothing, and says the budget was used.
    const db5 = newDb()
    const run5 = await runSiteCrawl(fakeAdmin(db5), { fetch: fakeWeb(pages), delayMs: 0, siteUrl: SITE, deadlineMs: Date.now() - 1 })
    const st5 = parseState(String(db5.tables.app_settings.find((r) => r.key === STATE_KEY)?.value))
    expect('with the time budget used up it checks no page, repairs nothing and reports it', run5.fixed === 0 && /time budget/.test(run5.note) && st5.lastChecked === 0 && st5.budgetUsed && db5.tables.content_edits.length === 0, run5.note)
    expect('the cursor does not move when nothing was checked', st5.cursor === null)

    const rotating = newDb()
    const first = await runSiteCrawl(fakeAdmin(rotating), { fetch: fakeWeb(pages), delayMs: 0, siteUrl: SITE })
    const s1 = await readCrawlState(fakeAdmin(rotating))
    expect('readCrawlState reads back the stored result and dismiss records the time', first.ok && !!s1 && (await dismissCrawlErrors(fakeAdmin(rotating))) === null && !!(await readCrawlState(fakeAdmin(rotating)))?.dismissedAt)
  }

  // ---------------------------------------------------------------------------------------------------
  // 7. Wiring: no new cron, inside the daily snapshot, with its own budget; digest line; visible on System Health
  // ---------------------------------------------------------------------------------------------------
  {
    const cron = read('app/api/cron/gsc-snapshot/route.ts')
    expect('the crawl runs inside the existing gsc-snapshot cron, with a time budget guard and a try/catch', /runSiteCrawl/.test(cron) && /CRAWL_BUDGET_MS/.test(cron) && /time budget already used/.test(cron) && /site crawl failed/.test(cron))
    expect('there is no new cron entry', !/site-crawl/.test(read('vercel.json')))
    expect('the budget is 40 seconds', /CRAWL_BUDGET_MS = 40_000/.test(read('lib/site-crawl-run.ts')))
    expect('System Health shows the card', /Site health crawl/.test(read('app/admin/system-health/page.tsx')) && /api\/admin\/site-crawl/.test(read('app/admin/system-health/page.tsx')))
    expect('the admin route checks isAuthorized first and only reads', /isAuthorized/.test(read('app/api/admin/site-crawl/route.ts')) && !/setSetting|\.update\(|\.insert\(/.test(read('app/api/admin/site-crawl/route.ts')))
    const { buildGrowthDigest } = await import('../lib/growth-digest')
    expect('the growth digest line is present in the source', /Site health: \$\{plural/.test(read('lib/growth-digest.ts')) && typeof buildGrowthDigest === 'function')
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
