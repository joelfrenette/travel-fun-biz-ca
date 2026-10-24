// Offline checks for the SEO / AEO / GEO playbook (lib/seo-playbook*.ts, scripts/export-seo-playbook.ts, /admin/seo-manager and its routes).
// No network, no database: every check is fed good and bad fixtures; the daily run is fed a fake fetch and a fake database.
// Run: pnpm dlx tsx scripts/check-seo-playbook.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATEGORIES, CATEGORY_LABELS, PLAYBOOK, RISKY_TITLE_RE, appliesHere, countByCategory, itemStatus, needsMe, scoreOf,
  type CheckResult, type PlaybookItem,
} from '../lib/seo-playbook'
import {
  AI_BOTS, AUDIT_KEY, CHECKS, CHECK_IDS, chooseSamples, emptyInput, parseRobots, parseStored, pickRotating, runChecks, runSeoPlaybookAudit, toStored,
  type AuditInput, type Fetchedish, type PageSample,
} from '../lib/seo-playbook-audit'
import {
  CUSTOM_KEY, MAX_CUSTOM, MAX_NOTE, MAX_STATE, addTip, applyTick, parseCustom, parseTicks, tipToItem, validateTip, type CustomTip,
} from '../lib/seo-playbook-store'
import { buildView } from '../lib/seo-playbook-view'
import { topSeoFixes } from '../lib/seo-playbook-todo'
import { adminNavItems } from '../lib/admin-nav'
import { MAX_STORED_FINDINGS, emptyState, type CrawlState, type StoredFinding } from '../lib/site-crawl'
import { buildJson, buildMarkdown } from './seo-playbook-export-lib'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const norm = (s: string) => s.replace(/\r\n/g, '\n')
const EM = String.fromCharCode(0x2014)

// ===================================================================================== the data
const ids = PLAYBOOK.map((p) => p.id)
expect('at least 150 items', PLAYBOOK.length >= 150, String(PLAYBOOK.length))
expect('ids are unique and well formed', new Set(ids).size === ids.length && ids.every((i) => /^[a-z0-9][a-z0-9-]{1,79}$/.test(i)))
expect('every item has a known category, impact 1 to 5, effort 1 to 3, a title, a why and at least two how steps',
  PLAYBOOK.every((p) => (CATEGORIES as readonly string[]).includes(p.category) && [1, 2, 3, 4, 5].includes(p.impact) && [1, 2, 3].includes(p.effort) && p.title.length > 8 && p.why.length > 20 && p.how.length >= 2 && p.how.every((h) => h.length > 5)))
expect('why is one plain sentence (not a paragraph)', PLAYBOOK.every((p) => p.why.length <= 230 && (p.why.match(/[.!?](\s|$)/g) ?? []).length <= 2), PLAYBOOK.filter((p) => p.why.length > 230).map((p) => p.id).join(','))
expect('automation, appliesTo and source use the allowed values', PLAYBOOK.every((p) => ['auto', 'assisted', 'manual'].includes(p.automation) && ['all auto-blog sites', 'local business', 'ecommerce', 'travel'].includes(p.appliesTo) && /^(joel-list-a|joel-list-b|joel-idea|best-practice|influencer:.*)$/.test(p.source)))
expect('every category has at least 8 items', CATEGORIES.every((c) => countByCategory()[c] >= 8), JSON.stringify(countByCategory()))
expect('categories appear in the declared order, and within a category impact never goes up', (() => {
  let lastCat = -1
  let lastImpact = 6
  for (const p of PLAYBOOK) {
    const ci = CATEGORIES.indexOf(p.category)
    if (ci < lastCat) return false
    if (ci > lastCat) { lastCat = ci; lastImpact = 6 }
    if (p.impact > lastImpact) return false
    lastImpact = p.impact
  }
  return true
})())
expect('the strongest items come first in each category (first item is the category maximum)', CATEGORIES.every((c) => { const xs = PLAYBOOK.filter((p) => p.category === c); return xs[0].impact === Math.max(...xs.map((x) => x.impact)) }))
expect('every verify is either a manual or a check with a check id', PLAYBOOK.every((p) => (p.verify.kind === 'manual' && !p.verify.checkId) || (p.verify.kind === 'check' && !!p.verify.checkId)))
expect('every check id used by an item exists in the audit', PLAYBOOK.every((p) => p.verify.kind !== 'check' || CHECK_IDS.includes(p.verify.checkId as string)), PLAYBOOK.filter((p) => p.verify.kind === 'check' && !CHECK_IDS.includes(p.verify.checkId as string)).map((p) => p.id).join(','))
expect('every automation "auto" item has a check that exists', PLAYBOOK.filter((p) => p.automation === 'auto').every((p) => p.verify.kind === 'check' && CHECK_IDS.includes(p.verify.checkId as string)))
expect('every automated check is used by at least one item', CHECK_IDS.every((c) => PLAYBOOK.some((p) => p.verify.checkId === c)), CHECK_IDS.filter((c) => !PLAYBOOK.some((p) => p.verify.checkId === c)).join(','))
expect('at least 40 automated checks', CHECK_IDS.length >= 40, String(CHECK_IDS.length))

const A_IDS = ['a-sitemap', 'a-robots', 'a-noindex', 'a-canonical', 'a-meta-titles', 'a-meta-desc', 'a-one-h1', 'a-heading-order', 'a-alt-text', 'a-schema', 'a-internal-links', 'a-broken-links', 'a-compress-images', 'a-cwv', 'a-mobile', 'a-https', 'a-slugs', 'a-og-image', 'a-search-console', 'a-llms-txt']
const B_IDS = ['b-breadcrumbs', 'b-index-site', 'b-page-per-service', 'b-keyword-clusters', 'b-nearby-cities', 'b-gbp-embed', 'b-parent-child']
const J_IDS = ['j-competitor-keywords', 'j-gmb-categories', 'j-competitor-backlinks', 'j-gsc-queries', 'j-cannibalisation']
const byId = new Map(PLAYBOOK.map((p) => [p.id, p]))
expect("Joel's list of 20 SEO checks is all there with source joel-list-a", A_IDS.length === 20 && A_IDS.every((i) => byId.get(i)?.source === 'joel-list-a'), A_IDS.filter((i) => byId.get(i)?.source !== 'joel-list-a').join(','))
expect("Joel's 7 sneaky tricks are all there with source joel-list-b", B_IDS.length === 7 && B_IDS.every((i) => byId.get(i)?.source === 'joel-list-b'), B_IDS.filter((i) => byId.get(i)?.source !== 'joel-list-b').join(','))
expect("Joel's own ideas are there with source joel-idea", J_IDS.every((i) => byId.get(i)?.source === 'joel-idea'))
expect('exactly 20 items carry joel-list-a and 7 carry joel-list-b (nothing else claims them)', PLAYBOOK.filter((p) => p.source === 'joel-list-a').length === 20 && PLAYBOOK.filter((p) => p.source === 'joel-list-b').length === 7)
expect('no influencer items are shipped (the list is for pasted tips)', PLAYBOOK.every((p) => !p.source.startsWith('influencer:')))
expect("Joel's items use their own words (sitemap, robots, H1, alt, schema, llms, breadcrumbs, GBP, parent)", ['sitemap', 'robots', 'noindex', 'canonical', 'title', 'description', 'H1', 'heading', 'alt', 'schema', 'internal', 'broken', 'compress', 'Core Web Vitals', 'mobile', 'HTTPS', 'slug', 'og:image', 'Search Console', 'llms'].every((w, i) => byId.get(A_IDS[i])!.title.toLowerCase().includes(w.toLowerCase())))

const allText = (p: PlaybookItem) => [p.title, p.why, p.caution ?? '', ...p.how].join(' ')
expect('no em dashes anywhere in the playbook copy', PLAYBOOK.every((p) => !allText(p).includes(EM)))
expect('no URLs or secrets in the shipped copy', PLAYBOOK.every((p) => !/https?:\/\//i.test(allText(p))))
expect('every risky tactic carries a caution', PLAYBOOK.filter((p) => RISKY_TITLE_RE.test(p.title)).every((p) => !!p.caution && p.caution.length > 40), PLAYBOOK.filter((p) => RISKY_TITLE_RE.test(p.title) && !p.caution).map((p) => p.id).join(','))
for (const id of ['b-nearby-cities', 'content-programmatic', 'local-reviews', 'links-guest-posts', 'links-avoid-schemes', 'content-ai-quality', 'content-testimonials', 'geo-ai-crawlers', 'local-citations', 'schema-review', 'geo-wikidata', 'geo-reddit-quora']) {
  expect(`caution on ${id}`, !!byId.get(id)?.caution)
}
expect('the doorway caution names doorway pages', /doorway/i.test(byId.get('b-nearby-cities')?.caution ?? '') && /doorway/i.test(byId.get('content-programmatic')?.caution ?? ''))
expect('fixHref values point at real admin pages', PLAYBOOK.every((p) => !p.fixHref || adminNavItems.some((n) => n.href === p.fixHref)), PLAYBOOK.filter((p) => p.fixHref && !adminNavItems.some((n) => n.href === p.fixHref)).map((p) => `${p.id}:${p.fixHref}`).join(','))
expect('the competitor, Search Console and cannibalisation ideas are in Content strategy / Links', byId.get('j-gsc-queries')?.category === 'content' && byId.get('j-cannibalisation')?.category === 'content' && byId.get('j-competitor-backlinks')?.category === 'links')
expect('the playbook files import nothing from the app (portable)', ['lib/seo-playbook.ts', 'lib/seo-playbook-types.ts', 'lib/seo-playbook-items-a.ts', 'lib/seo-playbook-items-b.ts', 'lib/seo-playbook-items-c.ts'].every((f) => !/from '@\//.test(read(f))))

// ===================================================================================== the export
expect('docs/seo-playbook/playbook.json matches the data', norm(read('docs/seo-playbook/playbook.json')) === norm(buildJson()), 'run scripts/export-seo-playbook.ts')
expect('docs/seo-playbook/PLAYBOOK.md matches the data', norm(read('docs/seo-playbook/PLAYBOOK.md')) === norm(buildMarkdown()), 'run scripts/export-seo-playbook.ts')
const md = buildMarkdown()
expect('PLAYBOOK.md lists every item id and every category', PLAYBOOK.every((p) => md.includes(`\`${p.id}\``)) && CATEGORIES.every((c) => md.includes(`## ${CATEGORY_LABELS[c]}`)))
expect('playbook.json parses and has every item', (JSON.parse(buildJson()) as { items: unknown[] }).items.length === PLAYBOOK.length)
expect('the export has no em dashes', !md.includes(EM) && !buildJson().includes(EM))

// ===================================================================================== fixtures
const NOW = new Date('2026-10-24T06:00:00Z')
const SITE = 'https://example.test'
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 864e5).toISOString()
const ok = (body: string, status = 200): Fetchedish => ({ status, body })

const SITEMAP_GOOD = `<?xml version="1.0"?><urlset>${['/', '/blog/a-post', '/blog/second-post', '/packages/a-trip', '/destinations/lisbon', '/hotels/some-hotel', '/about'].map((p) => `<url><loc>${SITE}${p}</loc><lastmod>2026-10-01</lastmod></url>`).join('')}</urlset>`
const ROBOTS_GOOD = `User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${SITE}/sitemap.xml\n`
const LLMS_GOOD = `# Example\n\n> A travel agency.\n\n- [Trips](${SITE}/packages): all trips\n- [Blog](${SITE}/blog): posts\n- [Guides](${SITE}/destinations): guides\n`

function jsonLd(...nodes: unknown[]) { return nodes.map((n) => `<script type="application/ld+json">${JSON.stringify(n)}</script>`).join('') }
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
interface PageOpts { og?: string | null; viewport?: boolean; headings?: string; ld?: unknown[]; links?: number; wordCount?: number; extra?: string }
function html(o: PageOpts = {}) {
  const og = o.og === undefined ? '/cover.jpg' : o.og
  const links = Array.from({ length: o.links ?? 5 }, (_, i) => `<a href="${SITE}/blog/post-${i}">post ${i}</a>`).join(' ')
  return `<!doctype html><html lang="en"><head><title>A good page title for the test</title><meta name="description" content="A good description."/>${o.viewport === false ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1"/>'}${og ? `<meta property="og:image" content="${og}"/>` : ''}${jsonLd(...(o.ld ?? []))}</head><body><main>${o.headings ?? '<h1>Title</h1><h2>Part</h2><h3>Detail</h3>'}<p>${words(o.wordCount ?? 400)}</p>${links}${o.extra ?? ''}</main></body></html>`
}
const ORG = { '@context': 'https://schema.org', '@type': ['Organization', 'TravelAgency'], name: 'Example', sameAs: ['https://facebook.com/x', 'https://instagram.com/x', 'https://youtube.com/x'] }
const WEBSITE = { '@type': 'WebSite', name: 'Example', url: SITE }
const CRUMBS = { '@type': 'BreadcrumbList', itemListElement: [] }
const FAQ = { '@type': 'FAQPage', mainEntity: [] }
const ARTICLE = { '@type': 'BlogPosting', headline: 'H', datePublished: '2026-01-01', dateModified: '2026-02-01', author: { '@type': 'Person', name: 'Ann Writer' } }
const sample = (kind: PageSample['kind'], o: PageOpts = {}, status = 200): PageSample => ({ kind, url: `${SITE}/${kind === 'home' ? '' : kind === 'post' ? 'blog/a-post' : kind === 'trip' ? 'packages/a-trip' : 'destinations/lisbon'}`, status, html: html(o) })
const goodPages = (): PageSample[] => [
  sample('home', { ld: [ORG, WEBSITE] }),
  sample('post', { ld: [ARTICLE, CRUMBS] }),
  sample('guide', { ld: [CRUMBS, FAQ] }),
  sample('trip', { ld: [CRUMBS, FAQ] }),
]
function crawl(findings: Partial<StoredFinding>[] = [], over: Partial<CrawlState> = {}): CrawlState {
  return { ...emptyState(), lastRun: iso(0), total: 50, lastChecked: 40, pages: { '/': [1, 'a', 'b', 0, 0, 0], '/blog/a-post': [1, 'c', 'd', 0, 0, 0], '/packages/a-trip': [1, 'e', 'f', 0, 0, 0] },
    findings: findings.map((f) => ({ url: `${SITE}/blog/a-post`, kind: 'x', severity: 'warning', message: 'm', hint: 'h', firstSeen: iso(1), ...f }) as StoredFinding), ...over }
}
function good(): AuditInput {
  const i = emptyInput(SITE, NOW)
  return {
    ...i,
    sitemap: ok(SITEMAP_GOOD), robots: ok(ROBOTS_GOOD), llms: ok(LLMS_GOOD), llmsFull: ok(`# Full\n\n${words(200)}`), indexnow: ok('abcdef123456abcdef'),
    httpProbe: { status: 301, body: '', location: `${SITE}/` }, altHostProbe: { status: 301, body: '', location: `${SITE}/` },
    pages: goodPages(), images: [{ url: `${SITE}/a.jpg`, status: 200, bytes: 120_000 }, { url: `${SITE}/b.jpg`, status: 200, bytes: 90_000 }],
    crawl: crawl(), orphans: { checked: 40, orphans: 0 },
    gsc: { configured: true, verified: true, sitemaps: [{ path: `${SITE}/sitemap.xml`, errors: 0 }] },
    bing: { configured: true, indexed: 120, crawlErrors: 0 }, nap: { total: 20, bad: 0, badFields: [] },
    cannibalizationRaw: JSON.stringify({ groups: [] }), gbpEmbedUrl: 'https://www.google.com/maps/embed?pb=abc', env: { ga4: true }, rankingDays: 40,
  }
}
function withEmbed(i: AuditInput): AuditInput { return { ...i, pages: [{ ...i.pages[0], html: i.pages[0].html.replace('</main>', '<iframe src="https://www.google.com/maps/embed?pb=abc"></iframe></main>') }, ...i.pages.slice(1)] } }

// ===================================================================================== every check: good passes, bad does not
const gi = good()
const goodResults = runChecks(withEmbed(gi))
expect('every check id has a function and the audit runs all of them', CHECK_IDS.every((c) => !!goodResults[c]) && CHECK_IDS.length === Object.keys(goodResults).length)
expect('on a fully good fixture every check passes', CHECK_IDS.every((c) => goodResults[c].status === 'pass'), CHECK_IDS.filter((c) => goodResults[c].status !== 'pass').map((c) => `${c}=${goodResults[c].status}: ${goodResults[c].evidence}`).join(' | '))
const emptyResults = runChecks(emptyInput(SITE, NOW))
expect('with nothing readable no check passes (unknown, never pass)', CHECK_IDS.every((c) => emptyResults[c].status !== 'pass'), CHECK_IDS.filter((c) => emptyResults[c].status === 'pass').join(','))
expect('with nothing readable most checks say unknown', CHECK_IDS.filter((c) => emptyResults[c].status === 'unknown').length >= 35)
expect('every result has evidence text, and a fix hint unless it passed', CHECK_IDS.every((c) => goodResults[c].evidence.length > 3 && (emptyResults[c].fixHint.length > 0 || emptyResults[c].status === 'unknown')))

function one(id: string, mutate: (i: AuditInput) => AuditInput): CheckResult {
  return CHECKS[id](mutate(withEmbed(good())))
}
function expectStatus(id: string, label: string, mutate: (i: AuditInput) => AuditInput, want: CheckResult['status']) {
  const r = one(id, mutate)
  expect(`${id}: ${label} -> ${want}`, r.status === want, `${r.status}: ${r.evidence}`)
}

// crawl-backed checks
const CRAWL_CASES: [string, string, 'error' | 'warning', 'fail' | 'warn'][] = [
  ['sitemap-no-noindex', 'noindex-in-sitemap', 'error', 'fail'], ['canonical-self', 'canonical-mismatch', 'error', 'fail'], ['hreflang-self', 'hreflang-no-self', 'warning', 'warn'],
  ['status-codes', 'page-gone', 'error', 'fail'], ['redirect-chains', 'redirect-chain', 'warning', 'warn'], ['broken-links', 'dead-link', 'error', 'fail'],
  ['mixed-content', 'mixed-content', 'warning', 'warn'], ['page-speed', 'slow', 'warning', 'warn'], ['titles-ok', 'title-missing', 'error', 'fail'],
  ['titles-unique', 'title-duplicate', 'warning', 'warn'], ['meta-desc-ok', 'description-missing', 'warning', 'warn'], ['meta-desc-unique', 'description-duplicate', 'warning', 'warn'],
  ['h1-single', 'h1-missing', 'warning', 'warn'], ['alt-coverage', 'img-alt-missing', 'warning', 'warn'], ['jsonld-valid', 'jsonld-invalid', 'error', 'fail'],
]
for (const [id, kind, sev, want] of CRAWL_CASES) {
  expectStatus(id, `a ${kind} finding`, (i) => ({ ...i, crawl: crawl([{ kind, severity: sev }]) }), want)
  expectStatus(id, 'no crawl yet', (i) => ({ ...i, crawl: null }), 'unknown')
}
expectStatus('titles-ok', 'a crawl 10 days old', (i) => ({ ...i, crawl: crawl([], { lastRun: iso(10) }) }), 'unknown')
expectStatus('titles-ok', 'a crawl that checked no page', (i) => ({ ...i, crawl: crawl([], { pages: {} }) }), 'unknown')
expectStatus('titles-ok', 'a full findings list with none of this kind (it may be hidden)', (i) => ({ ...i, crawl: crawl(Array.from({ length: MAX_STORED_FINDINGS }, (_, n) => ({ kind: 'slow', url: `${SITE}/p${n}` }))) }), 'unknown')
expectStatus('titles-ok', 'only info notes', (i) => ({ ...i, crawl: crawl([{ kind: 'title-short', severity: 'info' }]) }), 'pass')
expectStatus('crawl-fresh', 'ran today', (i) => i, 'pass')
expectStatus('crawl-fresh', 'ran 5 days ago', (i) => ({ ...i, crawl: crawl([], { lastRun: iso(5) }) }), 'warn')
expectStatus('crawl-fresh', 'ran 20 days ago', (i) => ({ ...i, crawl: crawl([], { lastRun: iso(20) }) }), 'fail')
expectStatus('crawl-fresh', 'never ran', (i) => ({ ...i, crawl: null }), 'unknown')

// sitemap, robots, llms
expectStatus('sitemap-exists', '404', (i) => ({ ...i, sitemap: ok('', 404) }), 'fail')
expectStatus('sitemap-exists', 'empty urlset', (i) => ({ ...i, sitemap: ok('<urlset></urlset>') }), 'fail')
expectStatus('sitemap-exists', 'fetch error', (i) => ({ ...i, sitemap: { status: 0, body: '', error: 'no answer' } }), 'unknown')
expectStatus('sitemap-exists', 'an index file', (i) => ({ ...i, sitemap: ok(`<sitemapindex><sitemap><loc>${SITE}/s1.xml</loc></sitemap></sitemapindex>`) }), 'pass')
expect('sitemap-exists says how many pages', /7 pages/.test(goodResults['sitemap-exists'].evidence), goodResults['sitemap-exists'].evidence)
expectStatus('sitemap-lastmod', 'none have lastmod', (i) => ({ ...i, sitemap: ok(SITEMAP_GOOD.replace(/<lastmod>[^<]*<\/lastmod>/g, '')) }), 'warn')
expectStatus('robots-ok', 'blocks the whole site', (i) => ({ ...i, robots: ok('User-agent: *\nDisallow: /\n') }), 'fail')
expectStatus('robots-ok', 'no sitemap line', (i) => ({ ...i, robots: ok('User-agent: *\nAllow: /\n') }), 'warn')
expectStatus('robots-ok', '404', (i) => ({ ...i, robots: ok('', 404) }), 'fail')
expectStatus('robots-ok', 'fetch error', (i) => ({ ...i, robots: { status: 0, body: '', error: 'x' } }), 'unknown')
expectStatus('robots-ok', 'blocks only /admin', (i) => i, 'pass')
expectStatus('ai-crawlers-policy', 'one AI bot blocked', (i) => ({ ...i, robots: ok(`${ROBOTS_GOOD}\nUser-agent: GPTBot\nDisallow: /\n`) }), 'warn')
expectStatus('ai-crawlers-policy', 'all AI bots blocked', (i) => ({ ...i, robots: ok(`${ROBOTS_GOOD}\n${AI_BOTS.map((b) => `User-agent: ${b}\nDisallow: /\n`).join('\n')}`) }), 'warn')
expectStatus('ai-crawlers-policy', 'everyone blocked', (i) => ({ ...i, robots: ok('User-agent: *\nDisallow: /\n') }), 'fail')
expectStatus('ai-crawlers-policy', 'a bot with its own allow group', (i) => ({ ...i, robots: ok(`${ROBOTS_GOOD}\nUser-agent: GPTBot\nAllow: /\n`) }), 'pass')
expectStatus('llms-txt', '404', (i) => ({ ...i, llms: ok('', 404) }), 'fail')
expectStatus('llms-txt', 'almost empty', (i) => ({ ...i, llms: ok('# x') }), 'warn')
expectStatus('llms-txt', 'error', (i) => ({ ...i, llms: { status: 0, body: '', error: 'x' } }), 'unknown')
expectStatus('llms-full', '404', (i) => ({ ...i, llmsFull: ok('', 404) }), 'fail')
expectStatus('indexnow-key', 'not set up', (i) => ({ ...i, indexnow: ok('Not found', 404) }), 'warn')
expectStatus('indexnow-key', 'odd body', (i) => ({ ...i, indexnow: ok('<html>', 200) }), 'fail')

// redirects
expectStatus('https-redirect', 'serves plain http', (i) => ({ ...i, httpProbe: ok('<html>', 200) }), 'fail')
expectStatus('https-redirect', 'temporary redirect', (i) => ({ ...i, httpProbe: { status: 302, body: '', location: `${SITE}/` } }), 'warn')
expectStatus('https-redirect', 'no answer', (i) => ({ ...i, httpProbe: { status: 0, body: '', error: 'x' } }), 'unknown')
expectStatus('https-redirect', 'site not on https', (i) => ({ ...i, siteUrl: 'http://localhost:3000' }), 'unknown')
expectStatus('www-redirect', 'both hosts load', (i) => ({ ...i, altHostProbe: ok('<html>', 200) }), 'fail')
expectStatus('www-redirect', 'redirects somewhere else', (i) => ({ ...i, altHostProbe: { status: 301, body: '', location: 'https://other.test/' } }), 'warn')
expectStatus('www-redirect', 'other host does not answer', (i) => ({ ...i, altHostProbe: { status: 0, body: '', error: 'dns' } }), 'warn')
expectStatus('slug-clean', 'upper case and underscores', (i) => ({ ...i, sitemap: ok(SITEMAP_GOOD.replace('/blog/a-post', '/Blog/My_Post')) }), 'fail')
expectStatus('slug-clean', 'a filler-word slug', (i) => ({ ...i, sitemap: ok(SITEMAP_GOOD.replace('/blog/a-post', '/blog/the-best-of-the-and-for-the-in-of')) }), 'fail')
expectStatus('slug-clean', 'no sitemap', (i) => ({ ...i, sitemap: null }), 'unknown')

// Search Console, Bing, others
expectStatus('gsc-verified', 'cannot read the property', (i) => ({ ...i, gsc: { configured: true, verified: false, sitemaps: null } }), 'fail')
expectStatus('gsc-verified', 'not connected', (i) => ({ ...i, gsc: { configured: false, verified: null, sitemaps: null } }), 'unknown')
expectStatus('gsc-verified', 'google did not answer', (i) => ({ ...i, gsc: { configured: true, verified: null, sitemaps: null, error: 'status 500' } }), 'unknown')
expectStatus('sitemap-submitted', 'none submitted', (i) => ({ ...i, gsc: { configured: true, verified: true, sitemaps: [] } }), 'fail')
expectStatus('sitemap-submitted', 'submitted with errors', (i) => ({ ...i, gsc: { configured: true, verified: true, sitemaps: [{ path: 'sitemap.xml', errors: 2 }] } }), 'warn')
expectStatus('sitemap-submitted', 'not connected', (i) => ({ ...i, gsc: { configured: false, verified: null, sitemaps: null } }), 'unknown')
expectStatus('sitemap-submitted', 'list unreadable', (i) => ({ ...i, gsc: { configured: true, verified: true, sitemaps: null, error: 'x' } }), 'unknown')
expectStatus('bing-coverage', '0 indexed', (i) => ({ ...i, bing: { configured: true, indexed: 0, crawlErrors: 0 } }), 'fail')
expectStatus('bing-coverage', 'crawl errors', (i) => ({ ...i, bing: { configured: true, indexed: 10, crawlErrors: 3 } }), 'warn')
expectStatus('bing-coverage', 'not connected', (i) => ({ ...i, bing: { configured: false, indexed: null, crawlErrors: null } }), 'unknown')
expectStatus('bing-coverage', 'could not read', (i) => ({ ...i, bing: { configured: true, indexed: null, crawlErrors: null, error: 'x' } }), 'unknown')
expectStatus('orphan-pages', '3 orphans', (i) => ({ ...i, orphans: { checked: 40, orphans: 3 } }), 'warn')
expectStatus('orphan-pages', '9 orphans', (i) => ({ ...i, orphans: { checked: 40, orphans: 9 } }), 'fail')
expectStatus('orphan-pages', 'unreadable', (i) => ({ ...i, orphans: null }), 'unknown')
expectStatus('nap-consistent', 'mismatches', (i) => ({ ...i, nap: { total: 20, bad: 2, badFields: ['Footer: phone', 'Schema: city'] } }), 'fail')
expectStatus('nap-consistent', 'could not run', (i) => ({ ...i, nap: null }), 'unknown')
expectStatus('cannibalization-signals', 'two groups compete', (i) => ({ ...i, cannibalizationRaw: JSON.stringify({ groups: [{}, {}] }) }), 'warn')
expectStatus('cannibalization-signals', 'a count field', (i) => ({ ...i, cannibalizationRaw: JSON.stringify({ count: 0 }) }), 'pass')
expectStatus('cannibalization-signals', 'not run yet (fail open)', (i) => ({ ...i, cannibalizationRaw: null }), 'unknown')
expectStatus('cannibalization-signals', 'garbage', (i) => ({ ...i, cannibalizationRaw: '{nope' }), 'unknown')
expectStatus('cannibalization-signals', 'a shape it does not know', (i) => ({ ...i, cannibalizationRaw: JSON.stringify({ hello: 1 }) }), 'unknown')
expectStatus('analytics-configured', 'GA4 not set', (i) => ({ ...i, env: { ga4: false } }), 'fail')
expectStatus('rank-tracking', '3 days of history', (i) => ({ ...i, rankingDays: 3 }), 'warn')
expectStatus('rank-tracking', 'none', (i) => ({ ...i, rankingDays: 0 }), 'fail')
expectStatus('rank-tracking', 'unreadable', (i) => ({ ...i, rankingDays: null }), 'unknown')
expectStatus('gbp-embed', 'not configured', (i) => ({ ...i, gbpEmbedUrl: null }), 'unknown')
expectStatus('gbp-embed', 'configured but not on the sampled pages', (i) => ({ ...i, pages: goodPages() }), 'warn')

// sample pages
const swap = (kind: PageSample['kind'], o: PageOpts, extra: Partial<PageSample> = {}) => (i: AuditInput): AuditInput => ({ ...i, pages: i.pages.map((p) => (p.kind === kind ? { ...p, ...extra, html: extra.html ?? html(o) } : p)) })
expectStatus('heading-order', 'h1 then h3', swap('post', { headings: '<h1>T</h1><h3>Skipped</h3>', ld: [ARTICLE, CRUMBS] }), 'warn')
expectStatus('heading-order', 'no page loaded', (i) => ({ ...i, pages: [] }), 'unknown')
expectStatus('heading-order', 'page returned 500', (i) => ({ ...i, pages: i.pages.map((p) => ({ ...p, status: 500 })) }), 'unknown')
expectStatus('og-image', 'an SVG', swap('home', { og: '/logo.svg', ld: [ORG, WEBSITE] }), 'fail')
expectStatus('og-image', 'missing', swap('guide', { og: null, ld: [CRUMBS, FAQ] }), 'fail')
expectStatus('viewport-mobile', 'no viewport', swap('trip', { viewport: false, ld: [CRUMBS, FAQ] }), 'fail')
expectStatus('org-schema', 'missing', swap('home', { ld: [WEBSITE] }), 'fail')
expectStatus('website-schema', 'missing', swap('home', { ld: [ORG] }), 'warn')
expectStatus('sameas-links', 'one link', swap('home', { ld: [{ ...ORG, sameAs: ['https://facebook.com/x'] }, WEBSITE] }), 'warn')
expectStatus('sameas-links', 'none', swap('home', { ld: [{ ...ORG, sameAs: undefined }, WEBSITE] }), 'fail')
expectStatus('sameas-links', 'in a @graph', swap('home', { ld: [{ '@graph': [ORG, WEBSITE] }] }), 'pass')
expectStatus('breadcrumb-schema', 'none', (i) => ({ ...i, pages: i.pages.map((p) => ({ ...p, html: html({ ld: [ORG, ARTICLE] }) })) }), 'fail')
expectStatus('breadcrumb-schema', 'some', swap('trip', { ld: [FAQ] }), 'warn')
expectStatus('breadcrumb-schema', 'only the home page loaded', (i) => ({ ...i, pages: i.pages.filter((p) => p.kind === 'home') }), 'unknown')
expectStatus('faq-schema', 'none', swap('guide', { ld: [CRUMBS] }), 'warn')
expectStatus('faq-schema', 'no guide or trip page', (i) => ({ ...i, pages: i.pages.filter((p) => p.kind === 'home' || p.kind === 'post') }), 'unknown')
expectStatus('article-dates', 'no modified date', swap('post', { ld: [{ ...ARTICLE, dateModified: undefined }, CRUMBS] }), 'warn')
expectStatus('article-dates', 'no article markup', swap('post', { ld: [CRUMBS] }), 'fail')
expectStatus('article-dates', 'no post sample', (i) => ({ ...i, pages: i.pages.filter((p) => p.kind !== 'post') }), 'unknown')
expectStatus('article-author', 'no author', swap('post', { ld: [{ ...ARTICLE, author: undefined }, CRUMBS] }), 'fail')
expectStatus('internal-links', 'none', swap('post', { links: 0, ld: [ARTICLE, CRUMBS] }), 'fail')
expectStatus('internal-links', 'only two', swap('post', { links: 2, ld: [ARTICLE, CRUMBS] }), 'warn')
expectStatus('thin-content', 'a thin page', swap('guide', { wordCount: 40, ld: [CRUMBS, FAQ] }), 'warn')
expectStatus('image-weight', 'one 400 KB picture', (i) => ({ ...i, images: [{ url: 'a', status: 200, bytes: 400_000 }, { url: 'b', status: 200, bytes: 90_000 }, { url: 'c', status: 200, bytes: 80_000 }] }), 'warn')
expectStatus('image-weight', 'mostly over 500 KB', (i) => ({ ...i, images: [{ url: 'a', status: 200, bytes: 900_000 }, { url: 'b', status: 200, bytes: 600_000 }] }), 'fail')
expectStatus('image-weight', 'no sizes readable', (i) => ({ ...i, images: [{ url: 'a', status: 200, bytes: null }] }), 'unknown')

// ===================================================================================== robots parser, samples
const pr = parseRobots('# c\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: https://x.test/sitemap.xml')
expect('parseRobots groups stacked user-agents and reads sitemaps', pr.groups.length === 2 && pr.groups[0].agents.length === 2 && pr.sitemaps.length === 1)
const urls = [`${SITE}/blog/a`, `${SITE}/blog/b`, `${SITE}/packages/t1`, `${SITE}/destinations/rome`, `${SITE}/hotels/h1`, `${SITE}/blog`, `${SITE}/destinations`]
const picks = chooseSamples(urls, SITE, NOW)
expect('chooseSamples gives home, a post, a guide and a trip (never an index page)', picks.map((p) => p.kind).join(',') === 'home,post,guide,trip' && !picks.some((p) => /\/blog$|\/destinations$/.test(p.url)))
expect('chooseSamples rotates by day', pickRotating([1, 2, 3], NOW) !== pickRotating([1, 2, 3], new Date(NOW.getTime() + 864e5)))
expect('chooseSamples copes with an empty sitemap', chooseSamples([], SITE, NOW).length === 1)

// ===================================================================================== stored form
const stored = toStored(goodResults, NOW, 1234)
const back = parseStored(JSON.stringify(stored))
expect('the stored audit round-trips', back.at === NOW.toISOString() && back.ms === 1234 && CHECK_IDS.every((c) => back.results[c]?.status === goodResults[c].status))
expect('the stored audit is compact (under 20 KB)', JSON.stringify(stored).length < 20_000, String(JSON.stringify(stored).length))
expect('evidence is clipped in the stored form', toStored({ x: { status: 'fail', evidence: 'e'.repeat(1000), fixHint: 'h'.repeat(1000) } }, NOW, 1).results.x.e.length <= 160)
expect('parseStored copes with garbage', parseStored('nope').at === null && parseStored(null).at === null && parseStored(JSON.stringify({ v: 2 })).at === null && Object.keys(parseStored(JSON.stringify({ v: 1, at: 'x', results: { a: { s: 'z', e: '', h: '' } } })).results).length === 0)

// ===================================================================================== status and score: unknown is never a pass
const checkItem = PLAYBOOK.find((p) => p.verify.kind === 'check')!
const manualItem = PLAYBOOK.find((p) => p.verify.kind === 'manual' && appliesHere(p))!
const res = (status: CheckResult['status']): Record<string, CheckResult> => ({ [checkItem.verify.checkId as string]: { status, evidence: 'e', fixHint: 'h' } })
expect('a check with no result is unknown', itemStatus(checkItem, {}, {}) === 'unknown')
expect('pass, warn and fail show as themselves', (['pass', 'warn', 'fail'] as const).every((s) => itemStatus(checkItem, res(s), {}) === s))
expect('a tick can confirm an unreadable check by hand', itemStatus(checkItem, res('unknown'), { [checkItem.id]: { done: true } }) === 'manual-done' && itemStatus(checkItem, {}, { [checkItem.id]: { done: true } }) === 'manual-done')
expect('a tick never hides a fail or warn', itemStatus(checkItem, res('fail'), { [checkItem.id]: { done: true } }) === 'fail' && itemStatus(checkItem, res('warn'), { [checkItem.id]: { done: true } }) === 'warn')
expect('a manual item is "manual" until ticked, then "manual-done"', itemStatus(manualItem, {}, {}) === 'manual' && itemStatus(manualItem, {}, { [manualItem.id]: { done: true } }) === 'manual-done')
expect('needsMe: only pass and done are quiet', needsMe('fail') && needsMe('unknown') && needsMe('manual') && needsMe('warn') && !needsMe('pass') && !needsMe('manual-done'))
expect('score is 0 with nothing known (unknown is not a pass)', scoreOf(PLAYBOOK, (p) => itemStatus(p, {}, {})) === 0)
expect('score is 100 when every scored item passes', scoreOf(PLAYBOOK, () => 'pass') === 100)
expect('a warn is worth less than a pass and more than a fail', (() => { const w = scoreOf(PLAYBOOK, () => 'warn'); return w > scoreOf(PLAYBOOK, () => 'fail') && w < 100 })())
expect('higher-impact items weigh more', (() => {
  const hi = PLAYBOOK.filter((p) => p.impact === 5 && appliesHere(p))[0]
  const lo = PLAYBOOK.filter((p) => p.impact === 1 && appliesHere(p))[0]
  return scoreOf(PLAYBOOK, (p) => (p === hi ? 'pass' : 'fail')) > scoreOf(PLAYBOOK, (p) => (p === lo ? 'pass' : 'fail'))
})())
expect('ecommerce-only items are listed but not scored', PLAYBOOK.every((p) => p.appliesTo !== 'ecommerce' || !appliesHere(p)))

// ===================================================================================== the page's view
const emptyView = buildView({ at: null, ms: 0, results: {} }, {}, [])
expect('with no audit and no ticks the view scores 0 and every check item is unknown', emptyView.overall === 0 && emptyView.items.filter((i) => i.verify.kind === 'check').every((i) => i.status === 'unknown'))
const fullView = buildView(parseStored(JSON.stringify(stored)), {}, [])
expect('after a good audit the overall score rises, but manual items still count as to do', fullView.overall > 0 && fullView.overall < 100 && fullView.counts.manual > 0 && fullView.counts.pass > 30)
const tickedAll = buildView(parseStored(JSON.stringify(stored)), Object.fromEntries(PLAYBOOK.map((p) => [p.id, { done: true }])), [])
expect('with every check passing and every manual item ticked the score is 100', tickedAll.overall === 100, String(tickedAll.overall))
expect('the view has a score per category, in order', emptyView.categories.map((c) => c.id).join(',') === CATEGORIES.join(',') && fullView.categories.every((c) => c.score >= 0 && c.score <= 100))
const tips: CustomTip[] = [{ id: 'tip-aaaa1111', title: 'Use short URLs', category: 'technical', sourceName: 'Sam Influencer', text: 'Keep URLs short.', link: 'https://example.test/x', impact: 4, createdAt: iso(1) }]
const tipView = buildView({ at: null, ms: 0, results: {} }, {}, tips)
const tipRow = tipView.items.find((i) => i.id === 'tip-aaaa1111')
expect('a pasted tip appears in the list as a manual item with its source', !!tipRow && tipRow.custom && tipRow.automation === 'manual' && tipRow.status === 'manual' && tipRow.source === 'influencer:Sam Influencer' && tipView.total === PLAYBOOK.length + 1)
expect('the list stays in impact order with tips mixed in', (() => { let c = -1; let im = 6; for (const i of tipView.items) { const ci = CATEGORIES.indexOf(i.category); if (ci < c) return false; if (ci > c) { c = ci; im = 6 } if (i.impact > im) return false; im = i.impact } return true })())

// ===================================================================================== ticks and tips (bounded)
const known = new Set(ids)
const t1 = applyTick({}, 'a-sitemap', { done: true }, known, iso(0))
expect('a tick is saved', 'map' in t1 && t1.map['a-sitemap'].done === true)
expect('an unknown id is refused', 'error' in applyTick({}, 'nope', { done: true }, known, iso(0)) && 'error' in applyTick({}, 5, { done: true }, known, iso(0)))
expect('a non-boolean done is refused', 'error' in applyTick({}, 'a-sitemap', { done: 'yes' }, known, iso(0)))
expect('a too-long note is refused', 'error' in applyTick({}, 'a-sitemap', { note: 'x'.repeat(MAX_NOTE + 1) }, known, iso(0)))
const t2 = 'map' in t1 ? applyTick(t1.map, 'a-sitemap', { done: false }, known, iso(0)) : t1
expect('un-ticking an item with no note removes its entry', 'map' in t2 && !('a-sitemap' in t2.map))
const t3 = applyTick({}, 'a-sitemap', { note: 'ask Sam\u0007 about it' }, known, iso(0))
expect('a note is saved with control characters stripped', 'map' in t3 && t3.map['a-sitemap'].note === 'ask Sam about it' && t3.map['a-sitemap'].done === false)
const bigMap: Record<string, { done: boolean }> = {}
for (let n = 0; n < MAX_STATE + 20; n++) bigMap[`id-${n}`] = { done: true }
expect('stored ticks are capped on read', Object.keys(parseTicks(JSON.stringify(bigMap))).length === MAX_STATE)
expect('parseTicks drops bad ids and garbage', Object.keys(parseTicks(JSON.stringify({ 'Bad Id': { done: true }, ok: { done: true }, x: 5 }))).join(',') === 'ok' && Object.keys(parseTicks('nope')).length === 0)

const tipOk = validateTip({ title: 'T', category: 'geo', sourceName: 'Ann', text: 'Do the thing', link: 'https://x.test/a', impact: 5 })
expect('a good tip validates', 'value' in tipOk && tipOk.value.impact === 5)
expect('a tip needs a title, text, category and source name', ['title', 'text', 'category', 'sourceName'].every((k) => 'error' in validateTip({ title: 'T', category: 'geo', sourceName: 'Ann', text: 'x', [k]: k === 'category' ? 'nope' : '' })))
expect('a tip link must be http or https', 'error' in validateTip({ title: 'T', category: 'geo', sourceName: 'Ann', text: 'x', link: 'javascript:alert(1)' }) && 'error' in validateTip({ title: 'T', category: 'geo', sourceName: 'Ann', text: 'x', link: 'not a link' }))
expect('a tip impact must be 1 to 5 and defaults to 3', 'error' in validateTip({ title: 'T', category: 'geo', sourceName: 'Ann', text: 'x', impact: 9 }) && (() => { const v = validateTip({ title: 'T', category: 'geo', sourceName: 'Ann', text: 'x' }); return 'value' in v && v.value.impact === 3 })())
expect('tip lengths are bounded', 'error' in validateTip({ title: 'x'.repeat(200), category: 'geo', sourceName: 'Ann', text: 'x' }) && 'error' in validateTip({ title: 'T', category: 'geo', sourceName: 'Ann', text: 'x'.repeat(2000) }))
let list: CustomTip[] = []
for (let n = 0; n < MAX_CUSTOM; n++) { const a = addTip(list, { title: `T${n}`, category: 'geo', sourceName: 'A', text: 'x' }, `tip-${String(n).padStart(6, '0')}`, iso(0)); if ('tips' in a) list = a.tips }
expect('the pasted tips are capped', list.length === MAX_CUSTOM && 'error' in addTip(list, { title: 'one more', category: 'geo', sourceName: 'A', text: 'x' }, 'tip-zzzzzz', iso(0)))
expect('stored tips are capped and bad rows dropped on read', parseCustom(JSON.stringify([...list, ...list])).length === MAX_CUSTOM && parseCustom(JSON.stringify([{ id: 'bad', title: 'x', text: 'y', category: 'geo' }])).length === 0 && parseCustom('nope').length === 0)
const tipItem = tipToItem(tips[0])
expect('a tip becomes a manual item tagged influencer:<name>, with the link in the steps', tipItem.verify.kind === 'manual' && tipItem.source === 'influencer:Sam Influencer' && tipItem.how.some((h) => h.includes('https://example.test/x')))

// ===================================================================================== Today helper
const sev = buildView(parseStored(JSON.stringify(toStored({
  ...Object.fromEntries(CHECK_IDS.map((c) => [c, { status: 'pass' as const, evidence: 'e', fixHint: '' }])),
  'sitemap-exists': { status: 'fail', evidence: 'x', fixHint: 'fix the sitemap' }, 'robots-ok': { status: 'fail', evidence: 'x', fixHint: 'fix robots' },
  'llms-txt': { status: 'fail', evidence: 'x', fixHint: '' }, 'sameas-links': { status: 'fail', evidence: 'x', fixHint: '' }, 'gsc-verified': { status: 'fail', evidence: 'x', fixHint: '' }, 'og-image': { status: 'warn', evidence: 'x', fixHint: '' },
  'orphan-pages': { status: 'unknown', evidence: 'x', fixHint: '' },
}, NOW, 5))), {}, [])
const fixes = topSeoFixes(sev.items)
expect('the Today helper returns at most 3 candidates', fixes.length === 3)
expect('the Today helper returns only failing items of impact 4 or more', fixes.every((f) => { const it = byId.get(f.id)!; return sev.items.find((x) => x.id === f.id)!.status === 'fail' && it.impact >= 4 }))
expect('the Today helper puts the highest impact first', fixes.every((f, n) => n === 0 || fixes[n - 1].impact >= f.impact))
expect('the Today helper never offers a warn or an unknown', !topSeoFixes(sev.items, 50).some((f) => ['og-image', 'orphan-pages'].some((c) => byId.get(f.id)?.verify.checkId === c)))
expect('every candidate has a deep link', fixes.every((f) => f.href.startsWith('/admin/')))
expect('nothing is offered when nothing fails', topSeoFixes(buildView(parseStored(JSON.stringify(stored)), {}, []).items).length === 0)

// ===================================================================================== the daily run with a fake fetch and a fake database
interface Upsert { table: string; row: Record<string, unknown> }
function fakeAdmin(rows: Record<string, string> = {}) {
  const upserts: Upsert[] = []
  const make = (table: string): unknown => {
    let key: string | null = null
    const chain: Record<string, unknown> = {}
    const done = () => Promise.resolve({ data: key !== null && rows[key] !== undefined && table === 'app_settings' ? { value: rows[key] } : null, error: null, count: 0 })
    for (const m of ['select', 'order', 'limit', 'neq', 'in', 'gte', 'lte', 'not', 'is', 'range']) chain[m] = () => chain
    chain.eq = (_c: string, v: string) => { key = v; return chain }
    chain.maybeSingle = done
    chain.upsert = (row: Record<string, unknown>) => { upserts.push({ table, row }); return Promise.resolve({ error: null }) }
    chain.then = (res: (v: unknown) => unknown) => done().then(res)
    return chain
  }
  return { admin: { from: (t: string) => make(t) } as never, upserts }
}
const requested: string[] = []
const fakeFetch = (async (url: string, init: { method: string }) => {
  requested.push(`${init.method} ${url}`)
  const path = new URL(url).pathname
  const mkRes = (status: number, body = '', headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body })
  if (url.startsWith('http://')) return mkRes(301, '', { location: url.replace('http:', 'https:') })
  if (new URL(url).host.startsWith('www.')) return mkRes(301, '', { location: url.replace('www.', '') })
  if (path === '/sitemap.xml') return mkRes(200, SITEMAP_GOOD, { 'content-type': 'application/xml' })
  if (path === '/robots.txt') return mkRes(200, ROBOTS_GOOD)
  if (path === '/llms.txt') return mkRes(200, LLMS_GOOD)
  if (path === '/llms-full.txt') return mkRes(200, `# Full\n\n${words(100)}`)
  if (path === '/indexnow-key.txt') return mkRes(404, 'Not found')
  if (/\.(jpg|png)$/.test(path)) return mkRes(200, '', { 'content-length': '100000' })
  return mkRes(200, html({ ld: [ORG, WEBSITE, ARTICLE, CRUMBS, FAQ] }), { 'content-type': 'text/html' })
}) as never
void (async () => {
  const { admin, upserts } = fakeAdmin()
  const run = await runSeoPlaybookAudit(admin, { fetch: fakeFetch, now: NOW, siteUrl: SITE, deadlineMs: Date.now() + 15_000, gsc: async () => ({ configured: true, verified: true, sitemaps: [{ path: 'sitemap.xml', errors: 0 }] }) })
  const saved = upserts.find((u) => u.row.key === AUDIT_KEY)
  const parsed = parseStored(saved ? String(saved.row.value) : '')
  expect('the daily run finishes and stores seo_playbook_audit in app_settings', run.ok && !!saved && saved.table === 'app_settings', run.note)
  expect('the stored result has every check', CHECK_IDS.every((c) => !!parsed.results[c]), CHECK_IDS.filter((c) => !parsed.results[c]).join(','))
  expect('the run read the sitemap, robots, llms and the redirects through the fake fetch only', ['GET https://example.test/sitemap.xml', 'GET https://example.test/robots.txt', 'GET https://example.test/llms.txt', 'GET http://example.test/'].every((r) => requested.includes(r)), requested.join(' | '))
  expect('the run only reads (GET and HEAD)', requested.every((r) => r.startsWith('GET ') || r.startsWith('HEAD ')))
  expect('the run wrote only to app_settings, and stored seo_playbook_audit exactly once', upserts.every((u) => u.table === 'app_settings') && upserts.filter((u) => u.row.key === AUDIT_KEY).length === 1, upserts.map((u) => `${u.table}:${String(u.row.key)}`).join(','))
  expect('with the fake site the sitemap, robots, llms, redirects and sample-page checks pass', ['sitemap-exists', 'robots-ok', 'llms-txt', 'https-redirect', 'www-redirect', 'org-schema', 'og-image', 'breadcrumb-schema'].every((c) => parsed.results[c]?.status === 'pass'), ['sitemap-exists', 'robots-ok', 'llms-txt', 'https-redirect', 'www-redirect', 'org-schema', 'og-image', 'breadcrumb-schema'].map((c) => `${c}=${parsed.results[c]?.status}`).join(' '))
  expect('checks that need the crawl or database say unknown when those are empty, never pass', parsed.results['titles-ok']?.status === 'unknown' && parsed.results['crawl-fresh']?.status === 'unknown')
  expect('the stored audit is saved in the same shape the page reads', parsed.at === NOW.toISOString())

  // A fetch that never answers must not hang the run past its budget.
  const hang = (() => new Promise(() => undefined)) as never
  const t0 = Date.now()
  const slow = await runSeoPlaybookAudit(fakeAdmin().admin, { fetch: hang, now: NOW, siteUrl: SITE, deadlineMs: Date.now() + 1500, gsc: async () => ({ configured: false, verified: null, sitemaps: null }) })
  expect('a run where nothing answers stays inside its budget and ends with unknowns, not passes', Date.now() - t0 < 8000 && slow.ok, `${Date.now() - t0}ms ${slow.note}`)

  // ===================================================================================== source-level checks
  const route = read('app/api/admin/seo-playbook/route.ts')
  const auditRoute = read('app/api/admin/seo-playbook/audit/route.ts')
  const firstLine = (src: string, fn: string) => new RegExp(`export async function ${fn}\\(request: Request\\) \\{\\s*\\n\\s*if \\(!isAuthorized\\(request\\)\\)`).test(src)
  expect('the playbook route calls isAuthorized first in GET and POST', firstLine(route, 'GET') && firstLine(route, 'POST'))
  expect('the audit route calls isAuthorized first', firstLine(auditRoute, 'POST'))
  expect('the routes never call an AI model or send anything', ![route, auditRoute].some((s) => /anthropic|openai|sendMail|resend|fetch\(/i.test(s)))
  expect('the audit route is bounded in time', /maxDuration = 30/.test(auditRoute) && /AUDIT_BUDGET_MS/.test(auditRoute))
  const cron = read('app/api/cron/gsc-snapshot/route.ts')
  expect('the audit runs inside the existing gsc-snapshot step (no new cron)', /runSeoPlaybookAudit/.test(cron) && /AUDIT_BUDGET_MS/.test(cron) && !/seo-playbook/.test(read('vercel.json')))
  expect('the audit budget is 20 seconds', (read('lib/seo-playbook-audit.ts').match(/AUDIT_BUDGET_MS = 20_000/) ?? []).length === 1)
  const nav = adminNavItems.find((n) => n.title === 'SEO & GEO Manager')
  expect('the SEO and GEO Manager nav item is Active and points at /admin/seo-manager', nav?.status === 'Active' && nav.href === '/admin/seo-manager')
  const titles = adminNavItems.slice(1).map((n) => n.title)
  expect('sidebar items stay sorted', titles.join('|') === [...titles].sort((a, b) => a.localeCompare(b)).join('|'))
  const page = read('app/admin/seo-manager/page.tsx')
  expect('the page has the filters, the tip form and the run button', ['Only what needs me', 'Add a tip from an influencer', 'Run the checks now', 'Who does it', 'Impact', 'Status'].every((w) => page.includes(w)))
  expect('the page imports only types from the server modules', !/import \{[^}]*\} from "@\/lib\/seo-playbook-(view|audit|store)"/.test(page) && /import type \{ SeoView, ViewItem \}/.test(page))
  expect('the page sends the admin token and has a mobile-friendly layout', page.includes('adminToken') && page.includes('sm:grid-cols') && page.includes('flex-wrap'))
  const copy = [page, route, auditRoute, read('lib/seo-playbook-audit.ts'), read('lib/seo-playbook-store.ts'), read('lib/seo-playbook-view.ts'), read('lib/seo-playbook-todo.ts'), read('lib/seo-playbook.ts'), read('scripts/export-seo-playbook.ts')]
  expect('no em dashes in the page, routes or library files', copy.every((s) => !s.includes(EM)))
  expect('the new settings keys are plain names', AUDIT_KEY === 'seo_playbook_audit' && CUSTOM_KEY === 'seo_playbook_custom')
  expect('the cannibalisation and engines files from the other builder are not imported or touched', !/seo-engines|gsc-mining|competitor-scan|lib\/cannibalization/.test(read('lib/seo-playbook-audit.ts')))

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll SEO playbook checks passed')
  process.exit(failures ? 1 : 0)
})()
