import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { readBingCoverage } from '@/lib/bing-coverage'
import { readOrphanAudit } from '@/lib/guide-orphans'
import { napCheck } from '@/lib/links-building-data'
import { isSearchConsoleConfigured, searchConsoleSiteUrl } from '@/lib/search-console'
import { SITE_URL } from '@/lib/site'
import { readCrawlState } from '@/lib/site-crawl-run'
import { MAX_STORED_FINDINGS, extractFacts, internalLinks, normUrl, parseSitemap, pathOf, realFetch, type CrawlState, type FetchLike, type PageFacts } from '@/lib/site-crawl'
import type { CheckResult, CheckStatus } from '@/lib/seo-playbook'

// Automated verification for the SEO playbook (lib/seo-playbook.ts). Every item with verify.kind 'check' points at one of the
// checks below by id. Each check is a pure function of an AuditInput, so scripts/check-seo-playbook.ts can feed it good and bad
// fixtures without a network or a database. gatherAuditInput() does the (read-only) fetching; runSeoPlaybookAudit() runs the lot
// inside a time budget and stores a compact result in app_settings.
//
// The rule that matters: a check that cannot read what it needs answers 'unknown', never 'pass'.

export const AUDIT_KEY = 'seo_playbook_audit'
export const GBP_EMBED_KEY = 'seo_gbp_embed_url'
export const CANNIBALIZATION_KEY = 'seo_cannibalization_state'
export const AUDIT_BUDGET_MS = 20_000
const MAX_TEXT = 160
/** The daily crawl result is trusted for this long. */
const CRAWL_MAX_AGE_DAYS = 7
const DAY = 864e5

// ---------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------

export interface Fetchedish {
  status: number
  body: string
  location?: string
  error?: string
}

export type SampleKind = 'home' | 'guide' | 'post' | 'trip'

export interface PageSample {
  kind: SampleKind
  url: string
  status: number
  html: string
}

export interface AuditInput {
  siteUrl: string
  now: Date
  sitemap: Fetchedish | null
  robots: Fetchedish | null
  llms: Fetchedish | null
  llmsFull: Fetchedish | null
  indexnow: Fetchedish | null
  /** The http:// version of the home page, first answer only (not followed). */
  httpProbe: Fetchedish | null
  /** The other host (www if the site is on the bare domain, and the reverse), first answer only. */
  altHostProbe: Fetchedish | null
  pages: PageSample[]
  images: { url: string; status: number; bytes: number | null }[]
  crawl: CrawlState | null
  orphans: { checked: number; orphans: number } | null
  gsc: { configured: boolean; verified: boolean | null; sitemaps: { path: string; errors: number }[] | null; error?: string }
  bing: { configured: boolean; indexed: number | null; crawlErrors: number | null; error?: string } | null
  nap: { total: number; bad: number; badFields: string[] } | null
  cannibalizationRaw: string | null
  gbpEmbedUrl: string | null
  env: { ga4: boolean }
  rankingDays: number | null
}

export function emptyInput(siteUrl: string, now: Date = new Date()): AuditInput {
  return {
    siteUrl, now, sitemap: null, robots: null, llms: null, llmsFull: null, indexnow: null, httpProbe: null, altHostProbe: null,
    pages: [], images: [], crawl: null, orphans: null, gsc: { configured: false, verified: null, sitemaps: null }, bing: null,
    nap: null, cannibalizationRaw: null, gbpEmbedUrl: null, env: { ga4: false }, rankingDays: null,
  }
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)
const mk = (status: CheckStatus, evidence: string, fixHint: string): CheckResult => ({ status, evidence: clip(evidence), fixHint: clip(fixHint) })
const unknown = (why: string, hint: string) => mk('unknown', why, hint)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The facts of each sample page that loaded, with its kind. */
function okPages(i: AuditInput): { p: PageSample; facts: PageFacts }[] {
  return i.pages.filter((p) => p.status === 200 && p.html.length > 200).map((p) => ({ p, facts: extractFacts(p.html) }))
}

/** Every JSON-LD node on a page, flattened out of arrays and @graph. */
export function jsonLdNodes(facts: PageFacts): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      out.push(o)
      if (Array.isArray(o['@graph'])) walk(o['@graph'])
    }
  }
  for (const raw of facts.jsonLd) {
    try {
      walk(JSON.parse(raw))
    } catch {
      // a broken block is reported by the jsonld-valid check
    }
  }
  return out
}

const typesOfNode = (n: Record<string, unknown>): string[] => (Array.isArray(n['@type']) ? (n['@type'] as unknown[]).filter((x): x is string => typeof x === 'string') : typeof n['@type'] === 'string' ? [n['@type'] as string] : [])
const hasType = (facts: PageFacts, ...want: string[]) => jsonLdNodes(facts).some((n) => typesOfNode(n).some((t) => want.includes(t)))

/** Reads the crawl state's stored findings. Unknown when the crawl never ran, is stale, or its short list is full. */
function fromCrawl(i: AuditInput, kinds: string[], label: string, hint: string): CheckResult {
  const c = i.crawl
  if (!c || !c.lastRun) return unknown('The daily site crawl has not run yet.', 'It runs once a day with the rankings job. Check System Health.')
  const age = (i.now.getTime() - Date.parse(c.lastRun)) / DAY
  if (!(age <= CRAWL_MAX_AGE_DAYS)) return unknown(`The last site crawl was ${Math.max(0, Math.floor(age))} days ago.`, 'The crawl has gone quiet. Check System Health.')
  const checked = Object.keys(c.pages ?? {}).length
  if (checked === 0) return unknown('The site crawl has not checked any page yet.', 'Wait for the next daily crawl.')
  const hits = (c.findings ?? []).filter((f) => kinds.includes(f.kind))
  if (hits.length) {
    const worst = hits.some((f) => f.severity === 'error') ? 'fail' : hits.some((f) => f.severity === 'warning') ? 'warn' : null
    if (worst) return mk(worst, `${plural(hits.length, 'page')} with ${label}. First: ${pathOf(hits[0].url)}.`, hint)
    return mk('pass', `Only minor notes (${hits.length}) for ${label}; ${checked} pages checked so far.`, hint)
  }
  if ((c.findings ?? []).length >= MAX_STORED_FINDINGS) return unknown(`The crawl list is full (${MAX_STORED_FINDINGS} items), so a missing ${label} may be hidden.`, 'Fix the errors already listed on System Health, then this check can be read.')
  return mk('pass', `No ${label} in the ${checked} pages checked so far (of ${c.total} in the sitemap).`, hint)
}

// ---------------------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------------------

export interface RobotsGroup {
  agents: string[]
  rules: { type: 'allow' | 'disallow'; path: string }[]
}

export function parseRobots(body: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []
  let cur: RobotsGroup | null = null
  let lastWasAgent = false
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'sitemap') {
      sitemaps.push(val)
      continue
    }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] }
        groups.push(cur)
      }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ type: key, path: val })
  }
  return { groups, sitemaps }
}

const blocksAll = (g: RobotsGroup) => g.rules.some((r) => r.type === 'disallow' && r.path === '/') && !g.rules.some((r) => r.type === 'allow' && r.path === '/')

export const AI_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'] as const

// ---------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------

type CheckFn = (i: AuditInput) => CheckResult

const isHttps = (u: string) => /^https:\/\//i.test(u)
const looksLikeFile = (f: Fetchedish | null) => !!f && !f.error && f.status === 200

const sampleUrls = (i: AuditInput) => (i.sitemap?.body ? parseSitemap(i.sitemap.body).urls : [])

function slugProblems(url: string): string[] {
  const out: string[] = []
  let p = ''
  try {
    p = new URL(url).pathname
  } catch {
    return ['not a web address']
  }
  if (p === '/' || p === '') return out
  const parts = p.split('/').filter(Boolean)
  for (const seg of parts) {
    if (seg !== seg.toLowerCase()) out.push('upper case letters')
    if (/_/.test(seg)) out.push('underscores')
    if (/%[0-9a-f]{2}/i.test(seg)) out.push('encoded characters')
    if (/--/.test(seg)) out.push('double hyphens')
    if (!/%/.test(seg) && /[^a-zA-Z0-9\-._~]/.test(seg)) out.push('odd characters')
    if (seg.length > 75) out.push('very long')
    const words = seg.toLowerCase().split('-')
    const stops = words.filter((w) => ['the', 'a', 'an', 'and', 'of', 'to', 'in', 'for', 'with', 'is', 'on', 'at'].includes(w)).length
    if (words.length >= 5 && stops / words.length > 0.4) out.push('too many filler words')
  }
  return out
}

export const CHECKS: Record<string, CheckFn> = {
  // ---- sitemap, robots, llms
  'sitemap-exists': (i) => {
    const s = i.sitemap
    if (!s) return unknown('The sitemap was not fetched.', 'Run the audit again.')
    if (s.error) return unknown(`The sitemap could not be fetched (${s.error}).`, 'Check the site is up, then run the audit again.')
    if (s.status !== 200) return mk('fail', `The sitemap returns ${s.status}.`, 'Make /sitemap.xml load. Tell Claude if it does not.')
    const p = parseSitemap(s.body)
    if (p.urls.length === 0 && p.children.length === 0) return mk('fail', 'The sitemap loads but lists no pages.', 'Check pages are published and the sitemap route has no error.')
    if (p.urls.length === 0) return mk('pass', `A sitemap index with ${plural(p.children.length, 'child sitemap')}.`, '')
    return mk(p.urls.length < 5 ? 'warn' : 'pass', `Lists ${plural(p.urls.length, 'page')}.`, p.urls.length < 5 ? 'Very few pages are listed. Check published pages appear.' : '')
  },
  'sitemap-lastmod': (i) => {
    const s = i.sitemap
    if (!s || s.error || s.status !== 200) return unknown('The sitemap could not be read.', 'Run the audit again.')
    const locs = (s.body.match(/<loc>/gi) ?? []).length
    const mods = (s.body.match(/<lastmod>/gi) ?? []).length
    if (locs === 0) return unknown('No page entries to check (index file or empty).', '')
    const share = mods / locs
    if (share >= 0.9) return mk('pass', `${mods} of ${locs} entries have a lastmod date.`, '')
    if (share > 0) return mk('warn', `Only ${mods} of ${locs} entries have a lastmod date.`, 'Add real last-changed dates to every sitemap entry.')
    return mk('warn', 'No sitemap entry has a lastmod date.', 'Add real last-changed dates so crawlers know what to re-read.')
  },
  'sitemap-no-noindex': (i) => fromCrawl(i, ['noindex-in-sitemap'], 'noindex-but-in-sitemap pages', 'Pick one: take the page off the sitemap or remove the noindex.'),
  'sitemap-submitted': (i) => {
    if (!i.gsc.configured) return unknown('Search Console is not connected (no Google service account key).', 'Connect Search Console, then run the audit again.')
    if (i.gsc.error || i.gsc.sitemaps === null) return unknown(`Search Console did not answer (${i.gsc.error ?? 'no data'}).`, 'Check the service account is a user on the property.')
    if (i.gsc.sitemaps.length === 0) return mk('fail', 'No sitemap is submitted in Search Console.', 'Open Search Console, Sitemaps, and add sitemap.xml.')
    const bad = i.gsc.sitemaps.filter((s) => s.errors > 0)
    if (bad.length) return mk('warn', `A sitemap is submitted but ${bad[0].path} reports ${bad[0].errors} error${bad[0].errors === 1 ? '' : 's'}.`, 'Open the Sitemaps report in Search Console and read the error.')
    return mk('pass', `${plural(i.gsc.sitemaps.length, 'sitemap')} submitted with no errors.`, '')
  },
  'gsc-verified': (i) => {
    if (!i.gsc.configured) return unknown('Search Console is not connected (no Google service account key).', 'Add GOOGLE_SERVICE_ACCOUNT_KEY and add the account as a user on the property.')
    if (i.gsc.verified === null) return unknown(`Search Console did not answer (${i.gsc.error ?? 'no data'}).`, 'Run the audit again in a few minutes.')
    return i.gsc.verified ? mk('pass', 'The service account can read the Search Console property.', '') : mk('fail', 'The service account cannot read the Search Console property.', 'Verify the property, then add the service account email as a user.')
  },
  'robots-ok': (i) => {
    const r = i.robots
    if (!r) return unknown('robots.txt was not fetched.', 'Run the audit again.')
    if (r.error) return unknown(`robots.txt could not be fetched (${r.error}).`, 'Check the site is up, then run the audit again.')
    if (r.status !== 200) return mk('fail', `robots.txt returns ${r.status}.`, 'Make /robots.txt load.')
    const p = parseRobots(r.body)
    const star = p.groups.filter((g) => g.agents.includes('*'))
    if (star.some(blocksAll)) return mk('fail', 'robots.txt blocks the whole site for all crawlers.', 'Remove "Disallow: /" under User-agent: *.')
    if (p.sitemaps.length === 0) return mk('warn', 'robots.txt has no Sitemap line.', 'Add a Sitemap: line with the sitemap address.')
    return mk('pass', `robots.txt loads and lists ${plural(p.sitemaps.length, 'sitemap')}.`, '')
  },
  'ai-crawlers-policy': (i) => {
    const r = i.robots
    if (!r || r.error || r.status !== 200) return unknown('robots.txt could not be read.', 'Run the audit again.')
    const p = parseRobots(r.body)
    if (p.groups.filter((g) => g.agents.includes('*')).some(blocksAll)) return mk('fail', 'All crawlers, including AI ones, are blocked.', 'Remove "Disallow: /" under User-agent: *.')
    const blocked = AI_BOTS.filter((b) => p.groups.some((g) => g.agents.includes(b.toLowerCase()) && blocksAll(g)))
    if (blocked.length === 0) return mk('pass', `None of ${AI_BOTS.join(', ')} is blocked, so AI engines may read and cite the site.`, 'This is a choice. Block them in robots.txt if you prefer.')
    if (blocked.length === AI_BOTS.length) return mk('warn', 'All AI crawlers are blocked, so AI answers will not cite the site.', 'Fine if on purpose. Otherwise remove the AI bot blocks from robots.txt.')
    return mk('warn', `Only some AI crawlers are blocked (${blocked.join(', ')}).`, 'Decide on one policy for all AI crawlers and make robots.txt match it.')
  },
  'llms-txt': (i) => llmsCheck(i.llms, '/llms.txt'),
  'llms-full': (i) => llmsCheck(i.llmsFull, '/llms-full.txt'),
  'indexnow-key': (i) => {
    const f = i.indexnow
    if (!f || f.error) return unknown('The IndexNow key file could not be fetched.', 'Run the audit again.')
    if (f.status === 200 && /^[a-zA-Z0-9-]{8,128}$/.test(f.body.trim())) return mk('pass', 'The IndexNow key file loads.', '')
    if (f.status === 404) return mk('warn', 'IndexNow is not set up (no key file).', 'Set INDEXNOW_KEY in Vercel so new pages ping Bing at once.')
    return mk('fail', `The IndexNow key file returns ${f.status} or an odd body.`, 'Check INDEXNOW_KEY is 8 to 128 letters, numbers or hyphens.')
  },
  'bing-coverage': (i) => {
    const b = i.bing
    if (!b) return unknown('The Bing snapshot could not be read.', 'Run the audit again.')
    if (b.error) return unknown(`The Bing snapshot could not be read (${b.error}).`, 'Run the audit again later.')
    if (!b.configured) return unknown('Bing Webmaster is not connected.', 'Set BING_WEBMASTER_API_KEY in Vercel.')
    if (b.indexed === null) return unknown('Bing gave no index count yet.', 'Wait for the next daily snapshot.')
    if (b.indexed === 0) return mk('fail', 'Bing reports 0 pages indexed.', 'Verify the site in Bing Webmaster Tools and submit the sitemap.')
    if ((b.crawlErrors ?? 0) > 0) return mk('warn', `Bing has indexed ${b.indexed} pages but reports ${b.crawlErrors} crawl errors.`, 'Open Bing Webmaster Tools, Crawl Information.')
    return mk('pass', `Bing reports ${b.indexed} pages indexed.`, '')
  },
  'crawl-fresh': (i) => {
    const c = i.crawl
    if (!c || !c.lastRun) return unknown('The daily site crawl has not run yet.', 'It runs once a day with the rankings job.')
    const age = (i.now.getTime() - Date.parse(c.lastRun)) / DAY
    if (!Number.isFinite(age)) return unknown('The crawl time could not be read.', '')
    if (age <= 3) return mk('pass', `The last site crawl was ${Math.max(0, Math.floor(age))} days ago.`, '')
    if (age <= 7) return mk('warn', `The last site crawl was ${Math.floor(age)} days ago.`, 'The crawl is late. Check System Health.')
    return mk('fail', `The last site crawl was ${Math.floor(age)} days ago.`, 'The daily crawl has stopped. Check System Health and the cron.')
  },

  // ---- addresses
  'https-redirect': (i) => {
    if (!isHttps(i.siteUrl)) return unknown('The site address is not https, so the redirect cannot be tested here.', '')
    const p = i.httpProbe
    if (!p || p.error) return unknown(`The http:// address did not answer (${p?.error ?? 'not tested'}).`, 'Run the audit again.')
    if (p.status === 200) return mk('fail', 'The http:// version loads without redirecting to https.', 'Redirect all http traffic to https (301).')
    if ([301, 308].includes(p.status) && p.location && isHttps(p.location)) return mk('pass', `http:// redirects to https:// (${p.status}).`, '')
    if ([302, 303, 307].includes(p.status) && p.location && isHttps(p.location)) return mk('warn', `http:// redirects to https:// but with a temporary ${p.status}.`, 'Use a permanent 301 or 308 redirect.')
    return unknown(`The http:// address answered ${p.status}, which this check cannot judge.`, 'Open http:// in a browser and see where it goes.')
  },
  'www-redirect': (i) => {
    const p = i.altHostProbe
    if (!p) return unknown('The other host (www or bare) was not tested.', 'Run the audit again.')
    let want = ''
    try {
      want = new URL(i.siteUrl).host
    } catch {
      return unknown('The site address could not be read.', '')
    }
    if (p.error) return mk('warn', `The other host did not answer (${p.error}).`, 'Point the other host (www or bare) at the site and redirect it, so visitors who type it still arrive.')
    if (p.status === 200) return mk('fail', 'Both the www and the bare address load, so Google sees two copies.', 'Redirect one host to the other with a 301.')
    if ([301, 308].includes(p.status) && p.location) {
      try {
        if (new URL(p.location).host === want) return mk('pass', `The other host redirects to ${want} (${p.status}).`, '')
      } catch {
        // fall through
      }
      return mk('warn', 'The other host redirects, but not to the main host.', 'Redirect it straight to the main host.')
    }
    if ([302, 303, 307].includes(p.status)) return mk('warn', `The other host redirects with a temporary ${p.status}.`, 'Use a permanent 301 or 308.')
    return unknown(`The other host answered ${p.status}.`, 'Open it in a browser and see where it goes.')
  },
  'slug-clean': (i) => {
    const urls = sampleUrls(i)
    if (urls.length === 0) return unknown('No sitemap addresses to read.', 'Run the audit again.')
    const bad: string[] = []
    for (const u of urls) {
      const probs = slugProblems(u)
      if (probs.length) bad.push(`${pathOf(u)} (${[...new Set(probs)].join(', ')})`)
    }
    if (bad.length === 0) return mk('pass', `All ${urls.length} sitemap addresses are lower case, hyphenated and a sensible length.`, '')
    const rate = bad.length / urls.length
    return mk(rate > 0.05 ? 'fail' : 'warn', `${plural(bad.length, 'address')} with messy slugs. First: ${bad[0]}.`, 'Use lower case words with single hyphens, no underscores, under about 75 characters. Add a 301 if you change a live address.')
  },
  'canonical-self': (i) => fromCrawl(i, ['canonical-mismatch', 'canonical-missing'], 'canonical problems', 'Make each page\'s canonical point at itself.'),
  'hreflang-self': (i) => fromCrawl(i, ['hreflang-no-self'], 'hreflang problems', 'Each language version must list itself as well as the others.'),
  'status-codes': (i) => fromCrawl(i, ['page-gone', 'server-error', 'client-error', 'unreachable'], 'error pages', 'Fix or remove pages that return an error and take them off the sitemap.'),
  'redirect-chains': (i) => fromCrawl(i, ['redirect-chain', 'redirect-loop', 'sitemap-redirect', 'link-redirect-chain', 'link-redirect-loop'], 'redirect chains', 'Point links and sitemap entries straight at the final page.'),
  'broken-links': (i) => fromCrawl(i, ['dead-link', 'link-server-error'], 'broken internal links', 'Remove each dead link or point it at a live page.'),
  'mixed-content': (i) => fromCrawl(i, ['mixed-content'], 'mixed-content pages', 'Change http:// items to https://.'),
  'page-speed': (i) => fromCrawl(i, ['slow', 'big-html'], 'slow or very large pages', 'Slim down the slow page: fewer scripts, smaller pictures.'),

  // ---- titles, descriptions, headings
  'titles-ok': (i) => fromCrawl(i, ['title-missing', 'title-short', 'title-long'], 'title problems', 'Give every page a title of 15 to 65 characters.'),
  'titles-unique': (i) => fromCrawl(i, ['title-duplicate'], 'duplicate titles', 'Give each page its own title.'),
  'meta-desc-ok': (i) => fromCrawl(i, ['description-missing', 'description-short', 'description-long'], 'meta description problems', 'Write a 70 to 165 character description for every page.'),
  'meta-desc-unique': (i) => fromCrawl(i, ['description-duplicate', 'title-duplicate'], 'duplicate titles or descriptions', 'Rewrite one of each pair so they differ.'),
  'h1-single': (i) => fromCrawl(i, ['h1-missing', 'h1-multiple'], 'H1 problems', 'Keep exactly one H1 per page.'),
  'alt-coverage': (i) => fromCrawl(i, ['img-alt-missing'], 'pictures without alt text', 'Add a short description to every meaningful picture.'),
  'jsonld-valid': (i) => fromCrawl(i, ['jsonld-invalid', 'jsonld-missing'], 'structured data problems', 'Fix the broken block or add the missing type.'),
  'orphan-pages': (i) => {
    const o = i.orphans
    if (!o) return unknown('The orphan audit could not be read.', 'Open Posts: Guides and run the audit there.')
    if (o.orphans === 0) return mk('pass', `No orphan guides among ${o.checked} checked.`, '')
    return mk(o.orphans > 5 ? 'fail' : 'warn', `${plural(o.orphans, 'guide')} with no links in, out of ${o.checked}.`, 'Link each orphan from a related post or guide.')
  },

  // ---- sample pages
  'heading-order': (i) => {
    const pages = okPages(i)
    if (pages.length === 0) return unknown('No sample page loaded.', 'Run the audit again.')
    const bad: string[] = []
    for (const { p } of pages) {
      const body = p.html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
      const levels = [...body.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]))
      for (let k = 1; k < levels.length; k++) {
        if (levels[k] - levels[k - 1] > 1) {
          bad.push(`${pathOf(p.url)} (h${levels[k - 1]} then h${levels[k]})`)
          break
        }
      }
    }
    return bad.length ? mk('warn', `Heading levels are skipped on ${bad.length} of ${pages.length} sample pages. First: ${bad[0]}.`, 'Step down one level at a time: H1, H2, H3.') : mk('pass', `Heading order is clean on ${pages.length} sample pages.`, '')
  },
  'og-image': (i) => {
    const pages = okPages(i)
    if (pages.length === 0) return unknown('No sample page loaded.', 'Run the audit again.')
    const bad: string[] = []
    for (const { p } of pages) {
      const m = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i.exec(p.html) ?? /<meta\b[^>]*content\s*=\s*["'][^"']*["'][^>]*property\s*=\s*["']og:image["'][^>]*>/i.exec(p.html)
      const content = m ? (/content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? '') : ''
      if (!content) bad.push(`${pathOf(p.url)} (no og:image)`)
      else if (/\.svg(\?|$)/i.test(content)) bad.push(`${pathOf(p.url)} (SVG)`)
    }
    return bad.length ? mk('fail', `${bad.length} of ${pages.length} sample pages have a missing or SVG og:image. First: ${bad[0]}.`, 'Use a JPG or PNG share picture, 1200 by 630 pixels.') : mk('pass', `All ${pages.length} sample pages have a real og:image.`, '')
  },
  'viewport-mobile': (i) => {
    const pages = okPages(i)
    if (pages.length === 0) return unknown('No sample page loaded.', 'Run the audit again.')
    const bad = pages.filter(({ p }) => !/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*width\s*=\s*device-width/i.test(p.html))
    return bad.length ? mk('fail', `${bad.length} of ${pages.length} sample pages have no mobile viewport tag.`, 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.') : mk('pass', `All ${pages.length} sample pages set the mobile viewport.`, '')
  },
  'org-schema': (i) => {
    const home = okPages(i).find(({ p }) => p.kind === 'home')
    if (!home) return unknown('The home page did not load.', 'Run the audit again.')
    return hasType(home.facts, 'Organization', 'TravelAgency', 'LocalBusiness') ? mk('pass', 'The home page has Organization or TravelAgency structured data.', '') : mk('fail', 'The home page has no Organization, TravelAgency or LocalBusiness structured data.', 'Add business schema with name, address, phone and logo.')
  },
  'website-schema': (i) => {
    const home = okPages(i).find(({ p }) => p.kind === 'home')
    if (!home) return unknown('The home page did not load.', 'Run the audit again.')
    return hasType(home.facts, 'WebSite') ? mk('pass', 'The home page has WebSite structured data.', '') : mk('warn', 'The home page has no WebSite structured data.', 'Add WebSite schema with the site name.')
  },
  'sameas-links': (i) => {
    const home = okPages(i).find(({ p }) => p.kind === 'home')
    if (!home) return unknown('The home page did not load.', 'Run the audit again.')
    let best = 0
    for (const n of jsonLdNodes(home.facts)) {
      const s = n.sameAs
      const count = Array.isArray(s) ? s.filter((x) => typeof x === 'string' && /^https?:\/\//i.test(x)).length : typeof s === 'string' ? 1 : 0
      best = Math.max(best, count)
    }
    if (best >= 2) return mk('pass', `The business schema links ${best} official profiles with sameAs.`, '')
    if (best === 1) return mk('warn', 'The business schema has only one sameAs link.', 'Add your Facebook, Instagram, YouTube and Google profiles.')
    return mk('fail', 'The business schema has no sameAs links.', 'Add sameAs with the addresses of your official profiles.')
  },
  'breadcrumb-schema': (i) => {
    const pages = okPages(i).filter(({ p }) => p.kind !== 'home')
    if (pages.length === 0) return unknown('No guide, post or trip sample page loaded.', 'Run the audit again.')
    const with_ = pages.filter(({ facts }) => hasType(facts, 'BreadcrumbList'))
    if (with_.length === pages.length) return mk('pass', `BreadcrumbList is on all ${pages.length} sample pages.`, '')
    if (with_.length === 0) return mk('fail', `No sample guide, post or trip page has BreadcrumbList (${pages.length} checked).`, 'Add breadcrumbs and BreadcrumbList schema to guides, posts and trips.')
    return mk('warn', `BreadcrumbList is on ${with_.length} of ${pages.length} sample pages.`, 'Add it to the page types that lack it.')
  },
  'faq-schema': (i) => {
    const pages = okPages(i).filter(({ p }) => p.kind === 'guide' || p.kind === 'trip')
    if (pages.length === 0) return unknown('No guide or trip sample page loaded.', 'Run the audit again.')
    const with_ = pages.filter(({ facts }) => hasType(facts, 'FAQPage'))
    if (with_.length === pages.length) return mk('pass', `FAQPage markup is on all ${pages.length} sample guide and trip pages.`, '')
    if (with_.length === 0) return mk('fail', `No sample guide or trip page has FAQPage markup (${pages.length} checked).`, 'Add a short FAQ section with matching markup.')
    return mk('warn', `FAQPage markup is on ${with_.length} of ${pages.length} sample guide and trip pages.`, 'Add FAQs to the pages that lack them.')
  },
  'article-dates': (i) => articleCheck(i, (n) => (typeof n.datePublished === 'string' && typeof n.dateModified === 'string' ? 2 : typeof n.datePublished === 'string' ? 1 : 0), 'dates', 'Add datePublished and dateModified to the Article markup.'),
  'article-author': (i) => articleCheck(i, (n) => {
    const a = n.author
    const name = Array.isArray(a) ? (a[0] as { name?: unknown } | undefined)?.name : (a as { name?: unknown } | undefined)?.name
    return typeof name === 'string' && name.trim() ? 2 : 0
  }, 'author', 'Add a real author name to the Article markup.'),
  'internal-links': (i) => {
    const pages = okPages(i).filter(({ p }) => p.kind !== 'home')
    if (pages.length === 0) return unknown('No guide, post or trip sample page loaded.', 'Run the audit again.')
    const counts = pages.map(({ p, facts }) => ({ path: pathOf(p.url), n: internalLinks(facts, p.url, i.siteUrl, 200).length }))
    const none = counts.filter((c) => c.n === 0)
    const few = counts.filter((c) => c.n > 0 && c.n < 3)
    if (none.length) return mk('fail', `${none[0].path} has no internal links (${none.length} of ${counts.length} sample pages).`, 'Add at least 3 links to related pages.')
    if (few.length) return mk('warn', `${few[0].path} has only ${few[0].n} internal links (${few.length} of ${counts.length} sample pages are under 3).`, 'Add links to related posts, guides and trips.')
    return mk('pass', `Every sample page links to at least 3 other pages (lowest ${Math.min(...counts.map((c) => c.n))}).`, '')
  },
  'thin-content': (i) => {
    const pages = okPages(i).filter(({ p }) => p.kind !== 'home')
    if (pages.length === 0) return unknown('No guide, post or trip sample page loaded.', 'Run the audit again.')
    const thin: string[] = []
    for (const { p } of pages) {
      const main = /<main\b[\s\S]*?<\/main>/i.exec(p.html)?.[0] ?? p.html
      const text = main.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
      const words = text.split(/\s+/).filter(Boolean).length
      if (words < 250) thin.push(`${pathOf(p.url)} (${words} words)`)
    }
    return thin.length ? mk('warn', `${thin.length} of ${pages.length} sample pages are thin. First: ${thin[0]}.`, 'Add real detail or merge the page into a stronger one.') : mk('pass', `All ${pages.length} sample pages have at least 250 words of content.`, '')
  },
  'image-weight': (i) => {
    const known = i.images.filter((m) => m.status === 200 && m.bytes !== null)
    if (known.length === 0) return unknown('No picture size could be read.', 'Run the audit again.')
    const heavy = known.filter((m) => (m.bytes as number) > 300_000)
    const veryHeavy = known.filter((m) => (m.bytes as number) > 500_000)
    if (veryHeavy.length * 2 >= known.length) return mk('fail', `${veryHeavy.length} of ${known.length} sample pictures are over 500 KB.`, 'Compress pictures and use WebP or AVIF.')
    if (heavy.length) return mk('warn', `${heavy.length} of ${known.length} sample pictures are over 300 KB (largest ${Math.round(Math.max(...known.map((m) => m.bytes as number)) / 1000)} KB).`, 'Compress the heavy pictures.')
    return mk('pass', `All ${known.length} sample pictures are under 300 KB.`, '')
  },
  'gbp-embed': (i) => {
    if (!i.gbpEmbedUrl) return unknown('No Google Business Profile map embed is set up.', `Save the embed address under the setting ${GBP_EMBED_KEY}, add the map to the site, or tick the item by hand.`)
    const pages = okPages(i)
    if (pages.length === 0) return unknown('No sample page loaded.', 'Run the audit again.')
    const found = pages.some(({ p }) => /google\.[a-z.]+\/maps\/embed/i.test(p.html))
    return found ? mk('pass', 'A Google Maps embed is on a sample page.', '') : mk('warn', 'A map embed is set up, but none of the sampled pages (home, one guide, post, trip) shows it.', 'Add the embed to the contact page. If it is only there, tick the item by hand.')
  },
  'nap-consistent': (i) => {
    if (!i.nap) return unknown('The name, address and phone check could not run.', 'Open Link building and read the NAP check.')
    return i.nap.bad === 0 ? mk('pass', `All ${i.nap.total} name, address and phone checks match across the site's own surfaces.`, '') : mk('fail', `${i.nap.bad} of ${i.nap.total} name, address or phone checks do not match (${i.nap.badFields.slice(0, 3).join('; ')}).`, 'Open Link building and fix the surfaces it lists.')
  },
  'cannibalization-signals': (i) => {
    if (!i.cannibalizationRaw) return unknown('The cannibalisation scan has not run yet.', 'It is produced by the SEO engines job. Check back after its next run.')
    let n: number | null = null
    try {
      const j = JSON.parse(i.cannibalizationRaw) as Record<string, unknown>
      for (const k of ['groups', 'clusters', 'items', 'pairs', 'findings', 'conflicts']) {
        if (Array.isArray(j[k])) {
          n = (j[k] as unknown[]).length
          break
        }
      }
      if (n === null) for (const k of ['count', 'total', 'conflicts']) if (typeof j[k] === 'number') n = j[k] as number
    } catch {
      return unknown('The cannibalisation result could not be read.', '')
    }
    if (n === null) return unknown('The cannibalisation result has a shape this check does not know.', '')
    return n === 0 ? mk('pass', 'No pages found competing for the same search.', '') : mk('warn', `${plural(n, 'search')} where two or more of your pages compete.`, 'Pick one primary page per search and link the others to it.')
  },
  'analytics-configured': (i) => (i.env.ga4 ? mk('pass', 'GA4 is connected (property id set).', '') : mk('fail', 'GA4 is not connected (GA4_PROPERTY_ID is not set).', 'Add GA4_PROPERTY_ID in Vercel and add the service account to the property.')),
  'rank-tracking': (i) => {
    if (i.rankingDays === null) return unknown('The ranking history could not be read.', 'Run the audit again.')
    if (i.rankingDays >= 7) return mk('pass', `${i.rankingDays} days of ranking history are stored.`, '')
    if (i.rankingDays > 0) return mk('warn', `Only ${i.rankingDays} days of ranking history so far.`, 'Keep the daily snapshot on; the trend fills in over time.')
    return mk('fail', 'No ranking history is stored.', 'Connect Search Console so the daily snapshot can save rankings.')
  },
}

export const CHECK_IDS: string[] = Object.keys(CHECKS)

function llmsCheck(f: Fetchedish | null, path: string): CheckResult {
  if (!f) return unknown(`${path} was not fetched.`, 'Run the audit again.')
  if (f.error) return unknown(`${path} could not be fetched (${f.error}).`, 'Run the audit again.')
  if (f.status === 404) return mk('fail', `${path} does not exist.`, `Publish ${path} so AI tools can find your best pages.`)
  if (f.status !== 200) return mk('fail', `${path} returns ${f.status}.`, `Make ${path} load.`)
  if (f.body.trim().length < 50) return mk('warn', `${path} loads but is almost empty.`, 'It should list your key pages.')
  const links = (f.body.match(/\]\(/g) ?? []).length + (f.body.match(/https?:\/\//g) ?? []).length
  if (path === '/llms.txt' && links < 3) return mk('warn', `${path} loads but links to fewer than 3 pages.`, 'List your key pages with short descriptions.')
  return mk('pass', `${path} loads (${Math.round(f.body.length / 1000) || 1} KB).`, '')
}

/** 2 = fully there, 1 = partly, 0 = missing. */
function articleCheck(i: AuditInput, score: (n: Record<string, unknown>) => number, what: string, hint: string): CheckResult {
  const posts = okPages(i).filter(({ p }) => p.kind === 'post')
  if (posts.length === 0) return unknown('No blog post sample page loaded.', 'Run the audit again.')
  const scores = posts.map(({ facts }) => {
    const nodes = jsonLdNodes(facts).filter((n) => typesOfNode(n).some((t) => ['Article', 'BlogPosting', 'NewsArticle'].includes(t)))
    return nodes.length ? Math.max(...nodes.map(score)) : -1
  })
  if (scores.every((s) => s === -1)) return mk('fail', 'The sample post has no Article markup.', 'Add BlogPosting markup with author and dates.')
  if (scores.every((s) => s === 2)) return mk('pass', `Article ${what} are present on ${posts.length} sample post${posts.length === 1 ? '' : 's'}.`, '')
  return mk(scores.some((s) => s <= 0) ? 'fail' : 'warn', `Article ${what} are missing or partial on a sample post.`, hint)
}

export function runChecks(input: AuditInput): Record<string, CheckResult> {
  const out: Record<string, CheckResult> = {}
  for (const [id, fn] of Object.entries(CHECKS)) {
    try {
      out[id] = fn(input)
    } catch (e) {
      out[id] = unknown(`The check itself failed (${e instanceof Error ? e.message : 'error'}).`, 'Tell Claude.')
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Stored form (small on purpose: one setting, about 50 short rows)
// ---------------------------------------------------------------------------------------------------

type Code = 'p' | 'w' | 'f' | 'u'
const TO_CODE: Record<CheckStatus, Code> = { pass: 'p', warn: 'w', fail: 'f', unknown: 'u' }
const FROM_CODE: Record<Code, CheckStatus> = { p: 'pass', w: 'warn', f: 'fail', u: 'unknown' }

export interface StoredAudit {
  v: 1
  at: string
  ms: number
  results: Record<string, { s: Code; e: string; h: string }>
}

export function toStored(results: Record<string, CheckResult>, at: Date, ms: number): StoredAudit {
  const r: StoredAudit['results'] = {}
  for (const [id, v] of Object.entries(results)) r[id] = { s: TO_CODE[v.status], e: clip(v.evidence), h: clip(v.fixHint) }
  return { v: 1, at: at.toISOString(), ms, results: r }
}

export interface AuditView {
  at: string | null
  ms: number
  results: Record<string, CheckResult>
}

export function parseStored(raw: string | null | undefined): AuditView {
  const empty: AuditView = { at: null, ms: 0, results: {} }
  if (!raw) return empty
  try {
    const p = JSON.parse(raw) as Partial<StoredAudit>
    if (!p || p.v !== 1 || typeof p.at !== 'string' || !p.results || typeof p.results !== 'object') return empty
    const results: Record<string, CheckResult> = {}
    for (const [id, v] of Object.entries(p.results)) {
      if (!v || !(v.s in FROM_CODE)) continue
      results[id] = { status: FROM_CODE[v.s], evidence: String(v.e ?? '').slice(0, MAX_TEXT), fixHint: String(v.h ?? '').slice(0, MAX_TEXT) }
    }
    return { at: p.at, ms: typeof p.ms === 'number' ? p.ms : 0, results }
  } catch {
    return empty
  }
}

export async function readAudit(admin: SupabaseClient): Promise<AuditView> {
  try {
    return parseStored(await getSetting(admin, AUDIT_KEY))
  } catch {
    return { at: null, ms: 0, results: {} }
  }
}

// ---------------------------------------------------------------------------------------------------
// Gathering (read-only; every request has a short timeout and a failure becomes "unknown", never a throw)
// ---------------------------------------------------------------------------------------------------

const GUIDE_PREFIXES = ['/destinations/', '/hotels/', '/resorts/', '/cruise-lines/', '/ships/', '/river-cruises/', '/yachts/']

/** A stable pick that rotates by day, so different pages are sampled on different days. */
export function pickRotating<T>(list: readonly T[], now: Date): T | undefined {
  if (list.length === 0) return undefined
  return list[Math.floor(now.getTime() / DAY) % list.length]
}

export function chooseSamples(urls: readonly string[], siteUrl: string, now: Date): { kind: SampleKind; url: string }[] {
  const paths = urls.map((u) => ({ u, p: pathOf(u) }))
  const out: { kind: SampleKind; url: string }[] = [{ kind: 'home', url: `${siteUrl.replace(/\/$/, '')}/` }]
  const post = pickRotating(paths.filter((x) => /^\/blog\/[^/]+$/.test(x.p)), now)
  const guide = pickRotating(paths.filter((x) => GUIDE_PREFIXES.some((g) => x.p.startsWith(g) && x.p.length > g.length)), now)
  const trip = pickRotating(paths.filter((x) => /^\/packages\/[^/]+$/.test(x.p)), now)
  if (post) out.push({ kind: 'post', url: post.u })
  if (guide) out.push({ kind: 'guide', url: guide.u })
  if (trip) out.push({ kind: 'trip', url: trip.u })
  return out
}

export interface GscProbe {
  (siteUrl: string): Promise<AuditInput['gsc']>
}

/** Read-only: can the service account see the property, and which sitemaps are submitted. */
export const realGscProbe: GscProbe = async () => {
  if (!isSearchConsoleConfigured()) return { configured: false, verified: null, sitemaps: null }
  try {
    const token = await getGoogleAccessToken('https://www.googleapis.com/auth/webmasters.readonly')
    const site = encodeURIComponent(searchConsoleSiteUrl())
    const headers = { Authorization: `Bearer ${token}` }
    const siteRes = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${site}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(6000) })
    if (siteRes.status === 403 || siteRes.status === 404) return { configured: true, verified: false, sitemaps: null }
    if (!siteRes.ok) return { configured: true, verified: null, sitemaps: null, error: `status ${siteRes.status}` }
    const smRes = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${site}/sitemaps`, { headers, cache: 'no-store', signal: AbortSignal.timeout(6000) })
    if (!smRes.ok) return { configured: true, verified: true, sitemaps: null, error: `sitemaps status ${smRes.status}` }
    const body = (await smRes.json().catch(() => ({}))) as { sitemap?: { path?: string; errors?: string | number }[] }
    return { configured: true, verified: true, sitemaps: (body.sitemap ?? []).map((s) => ({ path: String(s.path ?? ''), errors: Number(s.errors ?? 0) || 0 })) }
  } catch (e) {
    return { configured: true, verified: null, sitemaps: null, error: e instanceof Error ? e.message : 'failed' }
  }
}

export interface GatherOptions {
  fetch?: FetchLike
  now?: Date
  siteUrl?: string
  deadlineMs?: number
  gsc?: GscProbe
}

/** Rejects after `ms` even when the underlying call ignores its abort signal, so one stuck request can never hold the run. */
function withTimeout<T>(p: Promise<T>, ms: number, ctl?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<never>((_r, rej) => {
    timer = setTimeout(() => {
      ctl?.abort()
      rej(new Error('no answer in time'))
    }, Math.max(500, ms))
  })
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function simpleGet(f: FetchLike, url: string, timeoutMs: number, opts: { body?: boolean; follow?: boolean } = {}): Promise<Fetchedish> {
  const ctl = new AbortController()
  const work = async (): Promise<Fetchedish> => {
    let cur = url
    for (let hop = 0; hop < 6; hop++) {
      const res = await f(cur, { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'TravelFunBizHealthBot', accept: '*/*' }, signal: ctl.signal })
      const loc = res.headers.get('location')
      if (opts.follow && res.status >= 300 && res.status < 400 && loc) {
        const next = normUrl(loc, cur)
        if (!next) break
        cur = next
        continue
      }
      const body = opts.body !== false && res.status < 400 ? await res.text() : ''
      return { status: res.status, body, ...(loc ? { location: loc } : {}) }
    }
    return { status: 0, body: '', error: 'too many redirects' }
  }
  try {
    return await withTimeout(work(), timeoutMs, ctl)
  } catch (e) {
    return { status: 0, body: '', error: e instanceof Error ? e.message : 'failed' }
  }
}

function altHost(siteUrl: string): string | null {
  try {
    const u = new URL(siteUrl)
    u.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`
    return `${u.protocol}//${u.host}/`
  } catch {
    return null
  }
}

function imageUrls(pages: PageSample[], max: number): string[] {
  const seen = new Set<string>()
  for (const p of pages) {
    if (p.status !== 200) continue
    for (const m of p.html.matchAll(/<(?:img|meta)\b[^>]*>/gi)) {
      const tag = m[0]
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? (/property\s*=\s*["']og:image["']/i.test(tag) ? /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] : undefined)
      if (!src || src.startsWith('data:')) continue
      const abs = normUrl(src.replace(/&amp;/g, '&'), p.url)
      if (abs) seen.add(abs)
      if (seen.size >= max) return [...seen]
    }
  }
  return [...seen]
}

async function safe<T>(p: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await p()
  } catch {
    return fallback
  }
}

export async function gatherAuditInput(admin: SupabaseClient, opts: GatherOptions = {}): Promise<AuditInput> {
  const now = opts.now ?? new Date()
  const siteUrl = (opts.siteUrl ?? SITE_URL).replace(/\/$/, '')
  const f = opts.fetch ?? realFetch
  const deadline = opts.deadlineMs ?? Date.now() + AUDIT_BUDGET_MS
  const left = () => Math.max(800, Math.min(6000, deadline - Date.now()))
  const input = emptyInput(siteUrl, now)

  const [sitemap, robots, llms, llmsFull, indexnow, httpProbe, alt, gsc] = await Promise.all([
    simpleGet(f, `${siteUrl}/sitemap.xml`, left(), { follow: true }),
    simpleGet(f, `${siteUrl}/robots.txt`, left(), { follow: true }),
    simpleGet(f, `${siteUrl}/llms.txt`, left(), { follow: true }),
    simpleGet(f, `${siteUrl}/llms-full.txt`, left(), { follow: true }),
    simpleGet(f, `${siteUrl}/indexnow-key.txt`, left(), { follow: true }),
    isHttps(siteUrl) ? simpleGet(f, siteUrl.replace(/^https:/i, 'http:') + '/', left(), { body: false }) : Promise.resolve(null),
    (() => { const a = altHost(siteUrl); return a ? simpleGet(f, a, left(), { body: false }) : Promise.resolve(null) })(),
    safe(() => withTimeout((opts.gsc ?? realGscProbe)(siteUrl), left() + 4000), { configured: false, verified: null, sitemaps: null, error: 'probe failed' } as AuditInput['gsc']),
  ])
  Object.assign(input, { sitemap, robots, llms, llmsFull, indexnow, httpProbe, altHostProbe: alt, gsc })

  // Sample pages: home plus one post, one guide, one trip (rotating by day).
  const samples = chooseSamples(sitemap.status === 200 ? parseSitemap(sitemap.body).urls : [], siteUrl, now)
  input.pages = await Promise.all(samples.map(async (s): Promise<PageSample> => {
    const r = await simpleGet(f, s.url, left(), { follow: true })
    return { kind: s.kind, url: s.url, status: r.status, html: r.body }
  }))

  // Picture weights (HEAD-like: we only read the headers, not the body).
  const imgs = imageUrls(input.pages, 6)
  input.images = await Promise.all(imgs.map(async (u) => {
    const ctl = new AbortController()
    try {
      const res = await withTimeout(f(u, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'TravelFunBizHealthBot' }, signal: ctl.signal }), left(), ctl)
      const len = res.headers.get('content-length')
      const n = len !== null && len !== '' ? Number(len) : NaN
      return { url: u, status: res.status, bytes: Number.isFinite(n) ? n : null }
    } catch {
      return { url: u, status: 0, bytes: null }
    }
  }))

  // Stored state (read-only database reads; each fails open).
  const [crawl, orphans, bing, cannibal, gbp, rankingDays] = await Promise.all([
    safe(() => readCrawlState(admin), null),
    safe(async () => {
      const o = await readOrphanAudit(admin, now)
      return o ? { checked: o.checked, orphans: o.orphans.length } : null
    }, null),
    safe(async () => {
      const r = await readBingCoverage(admin)
      if (r.error) return { configured: true, indexed: null, crawlErrors: null, error: r.error }
      if (!r.coverage || r.coverage.status === 'not_configured') return { configured: false, indexed: null, crawlErrors: null }
      return { configured: true, indexed: r.coverage.indexed, crawlErrors: r.coverage.crawlErrors }
    }, null),
    safe(() => getSetting(admin, CANNIBALIZATION_KEY), null),
    safe(() => getSetting(admin, GBP_EMBED_KEY), null),
    safe(async () => {
      const { count, error } = await admin.from('gsc_ranking_days').select('*', { count: 'exact', head: true })
      return error || typeof count !== 'number' ? null : count
    }, null),
  ])
  input.crawl = crawl
  input.orphans = orphans
  input.bing = bing
  input.cannibalizationRaw = cannibal
  input.gbpEmbedUrl = gbp && gbp.trim() ? gbp.trim() : null
  input.rankingDays = rankingDays
  input.env = { ga4: !!process.env.GA4_PROPERTY_ID }
  const nap = safe(async () => {
    const n = napCheck()
    return { total: n.total, bad: n.bad, badFields: n.findings.filter((x) => !x.ok).map((x) => `${x.surface}: ${x.field}`) }
  }, null)
  input.nap = await nap
  return input
}

export interface AuditRunResult {
  ok: boolean
  note: string
  ms: number
}

/** The daily step (and the on-demand button). Never throws; a failure here never fails the cron that calls it. */
export async function runSeoPlaybookAudit(admin: SupabaseClient, opts: GatherOptions = {}): Promise<AuditRunResult> {
  const started = Date.now()
  try {
    const now = opts.now ?? new Date()
    const input = await gatherAuditInput(admin, { ...opts, now })
    const results = runChecks(input)
    const ms = Date.now() - started
    const saved = await setSetting(admin, AUDIT_KEY, JSON.stringify(toStored(results, now, ms)))
    const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 }
    for (const r of Object.values(results)) counts[r.status]++
    const note = `SEO playbook audit: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.unknown} unknown (${Math.round(ms / 100) / 10}s)${saved.error ? `; but the result could not be saved (${saved.error})` : ''}`
    return { ok: !saved.error, note, ms }
  } catch (e) {
    return { ok: false, note: `SEO playbook audit failed: ${e instanceof Error ? e.message : 'unknown error'}`, ms: Date.now() - started }
  }
}
