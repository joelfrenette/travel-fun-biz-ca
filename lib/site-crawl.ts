// Site health crawl: look at the live site the way a search engine does and list what is broken.
//
// This file has two halves. The PURE half (parsers, analysers, the rotating window, the stored state) has no network and no
// database. The THIN FETCH half (fetchSitemap, crawlWindow) takes the fetch function as an argument, so the offline check
// (scripts/check-site-crawl.ts) runs every analyser against fake HTML. The database side (self-heal, the stored state, the
// cron step) is in lib/site-crawl-run.ts.
//
// Every analyser returns typed findings: a severity (error, warning, info), a short message and a plain-English fix hint.

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  /** The page the problem is on (a full address). */
  url: string
  kind: string
  severity: Severity
  message: string
  /** What to do about it, in plain words. */
  hint: string
  /** For a link problem: the address the link points at. */
  target?: string
  /** For a link problem: the status the target answered with (404, 410, 500 ...). */
  status?: number
}

export const BOT_NAME = 'TravelFunBizHealthBot'
export const MAX_URLS_PER_RUN = 40
export const MIN_URLS_PER_RUN = 10
export const REQUEST_TIMEOUT_MS = 6_000
export const CONCURRENCY = 4
export const MAX_LINKS_PER_PAGE = 30
/** Link checks (HEAD) in one run, in total, so one run stays inside its time budget. */
export const MAX_LINK_CHECKS_PER_RUN = 120
export const MAX_EXTRA_PAGES_PER_RUN = 6
export const MAX_REDIRECT_HOPS = 6
export const POLITE_DELAY_MS = 120

export const TITLE_MIN = 15
export const TITLE_MAX = 65
export const DESC_MIN = 70
export const DESC_MAX = 165
export const SLOW_MS = 3_000
export const BIG_HTML_BYTES = 600_000

// ---------------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------------

/** One form of an address for comparing: no #fragment, host in lower case, no trailing slash (except the home page). Null when it is not a web address. */
export function normUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw.trim(), base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    let path = u.pathname
    if (path.length > 1) path = path.replace(/\/+$/, '')
    return `${u.protocol}//${u.host}${path}${u.search}`
  } catch {
    return null
  }
}

/** The path (and query) of an address on the site, for the stored state. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '/'}${u.search}`
  } catch {
    return url
  }
}

const sameHost = (a: string, b: string) => {
  try {
    const strip = (h: string) => h.toLowerCase().replace(/^www\./, '')
    return strip(new URL(a).hostname) === strip(new URL(b).hostname)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------------------------------

export function parseSitemap(xml: string): { urls: string[]; children: string[] } {
  const isIndex = /<sitemapindex\b/i.test(xml)
  const locs = [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean)
  return isIndex ? { urls: [], children: locs } : { urls: locs, children: [] }
}

// ---------------------------------------------------------------------------------------------------
// The rotating window
// ---------------------------------------------------------------------------------------------------

/** How many pages one run looks at: enough that every page is checked at least once a week, never more than 40, never fewer than 10. */
export function windowSize(total: number): number {
  return Math.max(MIN_URLS_PER_RUN, Math.min(MAX_URLS_PER_RUN, Math.ceil(total / 7)))
}

/** The next `n` pages after `cursor` (the last page checked), in sorted order, wrapping round. Pure. */
export function pickWindow(urls: readonly string[], cursor: string | null, n: number): string[] {
  const sorted = [...new Set(urls)].sort()
  if (sorted.length === 0 || n <= 0) return []
  let start = 0
  if (cursor) {
    const after = sorted.findIndex((u) => u > cursor)
    start = after === -1 ? 0 : after
  }
  const take = Math.min(n, sorted.length)
  const out: string[] = []
  for (let i = 0; i < take; i++) out.push(sorted[(start + i) % sorted.length])
  return out
}

// ---------------------------------------------------------------------------------------------------
// Reading one page's HTML
// ---------------------------------------------------------------------------------------------------

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The value of one attribute of a tag, or null when the tag does not have it. */
export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  if (!m) return null
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '')
}

/** True when the tag has the attribute at all (an empty alt="" is a deliberate "decorative picture", not a missing alt). */
export function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`(?:^|[\\s"'/])${name}(?:\\s*=|[\\s/>]|$)`, 'i').test(tag)
}

export interface PageFacts {
  title: string | null
  description: string | null
  h1Count: number
  canonical: string | null
  /** Lower-case robots directives from every robots / googlebot meta tag. */
  robots: string[]
  hreflangs: { lang: string; href: string }[]
  imgTotal: number
  imgNoAlt: number
  /** The text of every application/ld+json script. */
  jsonLd: string[]
  /** Every link href on the page, as written. */
  links: string[]
  /** Pictures, scripts, styles and frames loaded over plain http on an https page. */
  mixed: { tag: string; url: string }[]
  htmlBytes: number
}

export function extractFacts(html: string): PageFacts {
  const jsonLd = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim())
  // Scripts, styles and templates hold text such as "<h1" inside strings; they are not part of the page's markup.
  const body = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<template\b[\s\S]*?<\/template>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const titleM = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)
  const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, ' ').trim() : null

  let description: string | null = null
  let canonical: string | null = null
  const robots: string[] = []
  const hreflangs: { lang: string; href: string }[] = []
  const mixed: { tag: string; url: string }[] = []
  for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], 'name') ?? '').toLowerCase()
    const content = attr(m[0], 'content') ?? ''
    if (name === 'description' && description === null) description = content.replace(/\s+/g, ' ').trim()
    if (name === 'robots' || name === 'googlebot') robots.push(...content.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))
  }
  for (const m of body.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/)
    const href = attr(m[0], 'href') ?? ''
    if (rel.includes('canonical') && canonical === null) canonical = href
    if (rel.includes('alternate') && hasAttr(m[0], 'hreflang')) hreflangs.push({ lang: (attr(m[0], 'hreflang') ?? '').toLowerCase(), href })
    if (rel.includes('stylesheet') && /^http:\/\//i.test(href)) mixed.push({ tag: 'link', url: href })
  }
  let imgTotal = 0
  let imgNoAlt = 0
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    imgTotal++
    if (!hasAttr(m[0], 'alt')) imgNoAlt++
    const src = attr(m[0], 'src') ?? ''
    if (/^http:\/\//i.test(src)) mixed.push({ tag: 'img', url: src })
  }
  for (const m of body.matchAll(/<(script|iframe|source|video|audio|embed)\b[^>]*>/gi)) {
    const src = attr(m[0], 'src') ?? ''
    if (/^http:\/\//i.test(src)) mixed.push({ tag: m[1].toLowerCase(), url: src })
  }
  // Scripts were stripped from `body`; their src is in the original html.
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], 'src') ?? ''
    if (/^http:\/\//i.test(src) && !mixed.some((x) => x.url === src)) mixed.push({ tag: 'script', url: src })
  }
  const links = [...body.matchAll(/<a\b[^>]*>/gi)].map((m) => attr(m[0], 'href') ?? '').filter(Boolean)
  return {
    title,
    description,
    h1Count: [...body.matchAll(/<h1\b/gi)].length,
    canonical,
    robots,
    hreflangs,
    imgTotal,
    imgNoAlt,
    jsonLd,
    links,
    mixed,
    htmlBytes: html.length,
  }
}

// ---------------------------------------------------------------------------------------------------
// The analysers
// ---------------------------------------------------------------------------------------------------

export interface PageRecord {
  /** The address from the sitemap (or the link, for an extra page). */
  url: string
  /** Where the page really ended after redirects. */
  finalUrl: string
  status: number
  /** Redirects followed to get there. */
  hops: number
  ms: number
  contentType: string
  xRobots: string
  /** Set when the request failed (timeout, network). */
  error?: string
  facts: PageFacts | null
  inSitemap: boolean
}

const mk = (url: string, kind: string, severity: Severity, message: string, hint: string, extra: Partial<Finding> = {}): Finding => ({ url, kind, severity, message, hint, ...extra })

/** Status, redirects, speed, size. */
export function analyzeResponse(r: PageRecord): Finding[] {
  const out: Finding[] = []
  if (r.error) {
    out.push(mk(r.url, 'unreachable', 'warning', `The page did not answer (${r.error}).`, 'Open the page in your browser. If it loads, this was a slow moment and it clears by itself. If it does not load, the page is down: tell Claude.'))
    return out
  }
  if (r.status === 404 || r.status === 410) out.push(mk(r.url, 'page-gone', 'error', `The page returns ${r.status} (not found) but it is listed in the sitemap.`, 'Either bring the page back or take it off the sitemap. Search engines drop a listed page that is not there.'))
  else if (r.status >= 500) out.push(mk(r.url, 'server-error', 'error', `The page returns a server error (${r.status}).`, 'Open the page. If it still fails, the site has a bug on that page: tell Claude and give the address.'))
  else if (r.status >= 400) out.push(mk(r.url, 'client-error', 'error', `The page returns ${r.status}.`, 'The page cannot be opened by a search engine. Check that it is public, and tell Claude if it should be.'))
  else if (r.status >= 300) out.push(mk(r.url, 'redirect-loop', 'error', `The page keeps redirecting (${r.hops} jumps) and never lands on a page.`, 'A redirect loop: tell Claude the address.'))
  if (r.hops >= 3) out.push(mk(r.url, 'redirect-chain', 'error', `The sitemap address goes through ${r.hops} redirects before the page (ends at ${r.finalUrl}).`, 'List the final address in the sitemap. Long redirect chains waste a search engine\'s visit.'))
  else if (r.hops === 2) out.push(mk(r.url, 'redirect-chain', 'warning', `The sitemap address goes through 2 redirects (ends at ${r.finalUrl}).`, 'List the final address in the sitemap instead.'))
  else if (r.hops === 1 && r.status < 400) out.push(mk(r.url, 'sitemap-redirect', 'warning', `The sitemap lists an address that redirects to ${r.finalUrl}.`, 'List the final address in the sitemap, not one that redirects.'))
  if (r.status < 400 && r.ms > SLOW_MS) out.push(mk(r.url, 'slow', 'warning', `The page took ${(r.ms / 1000).toFixed(1)} seconds to answer.`, 'Slow pages rank worse. One slow answer can be a cold start; if it stays slow in the next check, tell Claude.'))
  if (r.facts && r.facts.htmlBytes > BIG_HTML_BYTES) out.push(mk(r.url, 'big-html', 'warning', `The page is ${Math.round(r.facts.htmlBytes / 1000)} KB of HTML.`, 'A very large page is slow on phones. Tell Claude if this page is not meant to be that long.'))
  return out
}

const robotsNoindex = (r: PageRecord) => !!r.facts?.robots.some((d) => d === 'noindex' || d === 'none') || /noindex|none/i.test(r.xRobots)

/** Canonical address, and noindex against the sitemap. */
export function analyzeIndexability(r: PageRecord): Finding[] {
  const out: Finding[] = []
  if (!r.facts || r.status >= 400) return out
  const noindex = robotsNoindex(r)
  if (noindex && r.inSitemap) out.push(mk(r.url, 'noindex-in-sitemap', 'error', 'The page tells search engines not to index it, but the sitemap lists it.', 'Pick one. Either take the page off the sitemap, or remove the "noindex" so it can show in search.'))
  if (!noindex && !r.inSitemap) out.push(mk(r.url, 'indexable-not-in-sitemap', 'info', 'The page can be indexed but the sitemap does not list it.', 'If it should show in search, add it to the sitemap. If not, mark it noindex. (Report only: nothing was changed.)'))
  const want = normUrl(r.finalUrl) ?? normUrl(r.url)
  if (!r.facts.canonical) {
    if (!noindex) out.push(mk(r.url, 'canonical-missing', 'warning', 'The page has no canonical address.', 'Add a canonical link so search engines know which address is the main one.'))
  } else {
    const c = normUrl(r.facts.canonical, r.finalUrl)
    if (c && want && c !== want) out.push(mk(r.url, 'canonical-mismatch', 'error', `The canonical address is ${c}, not the page's own address.`, 'The page says another page is the main one, so Google may ignore this one. Make the canonical point at the page itself (unless this page is meant to be a copy).'))
  }
  return out
}

/** Title and description: present, a sensible length. (Duplicates are in analyzeUniqueness: they need other pages.) */
export function analyzeMeta(r: PageRecord): Finding[] {
  const out: Finding[] = []
  if (!r.facts || r.status >= 400) return out
  const { title, description } = r.facts
  if (!title) out.push(mk(r.url, 'title-missing', 'error', 'The page has no title.', 'Every page needs a title: it is the blue headline in Google.'))
  else if (title.length > TITLE_MAX) out.push(mk(r.url, 'title-long', 'warning', `The title is ${title.length} characters (about ${TITLE_MAX} is the most Google shows).`, 'Shorten the title so it is not cut off in search results.'))
  else if (title.length < TITLE_MIN) out.push(mk(r.url, 'title-short', 'warning', `The title is only ${title.length} characters.`, 'A short title wastes space in search. Say what the page is about.'))
  if (!description) out.push(mk(r.url, 'description-missing', 'warning', 'The page has no meta description.', 'Add a short summary (about 120 to 160 characters). It is the grey text under the headline in Google.'))
  else if (description.length > DESC_MAX) out.push(mk(r.url, 'description-long', 'info', `The description is ${description.length} characters (about ${DESC_MAX} is the most Google shows).`, 'Shorten it so the end is not cut off.'))
  else if (description.length < DESC_MIN) out.push(mk(r.url, 'description-short', 'info', `The description is only ${description.length} characters.`, 'Add a bit more detail about what the page offers.'))
  return out
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/** A short fixed-length hash of a text, for the stored state (so the state stays small). */
export function hash(s: string): string {
  let h = 0x811c9dc5
  const t = norm(s)
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** Titles and descriptions that two or more pages share. `known` holds the hashes of pages checked earlier (path -> [title hash, description hash]). */
export function analyzeUniqueness(records: readonly PageRecord[], known: Record<string, [string, string]> = {}): Finding[] {
  const out: Finding[] = []
  const current = new Set(records.map((r) => pathOf(r.url)))
  const titleBy = new Map<string, string[]>()
  const descBy = new Map<string, string[]>()
  const add = (m: Map<string, string[]>, h: string, p: string) => m.set(h, [...(m.get(h) ?? []), p])
  for (const [p, fp] of Object.entries(known)) {
    if (current.has(p)) continue
    if (fp[0]) add(titleBy, fp[0], p)
    if (fp[1]) add(descBy, fp[1], p)
  }
  for (const r of records) {
    if (!r.facts || r.status >= 400) continue
    if (r.facts.title) add(titleBy, hash(r.facts.title), pathOf(r.url))
    if (r.facts.description) add(descBy, hash(r.facts.description), pathOf(r.url))
  }
  for (const r of records) {
    if (!r.facts || r.status >= 400) continue
    const me = pathOf(r.url)
    const t = r.facts.title ? (titleBy.get(hash(r.facts.title)) ?? []).filter((p) => p !== me) : []
    if (t.length) out.push(mk(r.url, 'title-duplicate', 'warning', `Another page has the same title (${t[0]}${t.length > 1 ? ` and ${t.length - 1} more` : ''}).`, 'Give each page its own title. Two pages with one title compete with each other in search.'))
    const d = r.facts.description ? (descBy.get(hash(r.facts.description)) ?? []).filter((p) => p !== me) : []
    if (d.length) out.push(mk(r.url, 'description-duplicate', 'warning', `Another page has the same meta description (${d[0]}${d.length > 1 ? ` and ${d.length - 1} more` : ''}).`, 'Write a different description for each page.'))
  }
  return out
}

/** Exactly one h1, and pictures with no alt attribute. */
export function analyzeContent(r: PageRecord): Finding[] {
  const out: Finding[] = []
  if (!r.facts || r.status >= 400) return out
  if (r.facts.h1Count === 0) out.push(mk(r.url, 'h1-missing', 'warning', 'The page has no main heading (h1).', 'Add one h1: the page\'s main headline. It tells Google and screen readers what the page is.'))
  else if (r.facts.h1Count > 1) out.push(mk(r.url, 'h1-multiple', 'warning', `The page has ${r.facts.h1Count} main headings (h1).`, 'Keep one h1 per page; make the others h2 or h3.'))
  if (r.facts.imgNoAlt > 0) out.push(mk(r.url, 'img-alt-missing', 'warning', `${r.facts.imgNoAlt} picture${r.facts.imgNoAlt === 1 ? ' has' : 's have'} no alt text.`, 'Add a short description of each picture. It helps blind visitors and image search.'))
  return out
}

/** The schema.org types a page of this kind is expected to carry (empty: no particular type is required). */
export function expectedJsonLdTypes(path: string): string[] {
  if (path === '/') return ['Organization', 'TravelAgency', 'WebSite']
  if (/^\/blog\/[^/]+$/.test(path)) return ['BlogPosting', 'Article', 'NewsArticle']
  if (/^\/packages\/[^/]+$/.test(path)) return ['TouristTrip', 'Product', 'Trip', 'Offer', 'Event']
  return []
}

function typesOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) typesOf(n, out)
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    const t = o['@type']
    if (typeof t === 'string') out.push(t)
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.push(x)
    if (Array.isArray(o['@graph'])) typesOf(o['@graph'], out)
  }
  return out
}

/** Every JSON-LD block must be valid JSON with a type, and the page kinds above must carry their expected type. */
export function analyzeJsonLd(r: PageRecord): Finding[] {
  const out: Finding[] = []
  if (!r.facts || r.status >= 400) return out
  const seen: string[] = []
  let bad = 0
  for (const raw of r.facts.jsonLd) {
    try {
      const parsed = JSON.parse(raw) as unknown
      const t = typesOf(parsed)
      if (t.length === 0) bad++
      seen.push(...t)
    } catch {
      bad++
    }
  }
  if (bad > 0) out.push(mk(r.url, 'jsonld-invalid', 'error', `${bad} structured-data block${bad === 1 ? ' is' : 's are'} broken (not valid JSON, or no type).`, 'Google ignores broken structured data, so rich results (FAQ, stars) are lost. Tell Claude the address.'))
  const want = expectedJsonLdTypes(pathOf(r.finalUrl || r.url))
  if (want.length && bad === 0 && !seen.some((t) => want.includes(t))) out.push(mk(r.url, 'jsonld-missing', 'warning', `No structured data of the expected kind (${want.slice(0, 2).join(' or ')}).`, 'This kind of page should say what it is to search engines. Tell Claude the address.'))
  return out
}

/** Pictures, scripts, styles or frames loaded over plain http. */
export function analyzeMixedContent(r: PageRecord): Finding[] {
  if (!r.facts || r.status >= 400 || !/^https:/i.test(r.finalUrl)) return []
  const m = r.facts.mixed
  if (m.length === 0) return []
  const active = m.some((x) => x.tag !== 'img' && x.tag !== 'source' && x.tag !== 'video' && x.tag !== 'audio')
  return [mk(r.url, 'mixed-content', active ? 'error' : 'warning', `${m.length} item${m.length === 1 ? ' loads' : 's load'} over plain http on a secure page (first: ${m[0].url}).`, 'Change the address to https. Browsers block or warn about insecure items on a secure page.', { target: m[0].url })]
}

/** If a page lists language versions, one of them must be the page itself. */
export function analyzeHreflang(r: PageRecord): Finding[] {
  if (!r.facts || r.status >= 400 || r.facts.hreflangs.length === 0) return []
  const me = normUrl(r.facts.canonical ?? '', r.finalUrl) ?? normUrl(r.finalUrl)
  const self = r.facts.hreflangs.some((h) => normUrl(h.href, r.finalUrl) === me || normUrl(h.href, r.finalUrl) === normUrl(r.finalUrl))
  return self ? [] : [mk(r.url, 'hreflang-no-self', 'warning', 'The page lists language versions but does not list itself.', 'Each language version must list itself as well as the others, or Google ignores the set.')]
}

/** All the single-page analysers together (not the link check and not duplicates: those need more than one page). */
export function analyzePage(r: PageRecord): Finding[] {
  return [...analyzeResponse(r), ...analyzeIndexability(r), ...analyzeMeta(r), ...analyzeContent(r), ...analyzeJsonLd(r), ...analyzeMixedContent(r), ...analyzeHreflang(r)]
}

// ---------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------

export interface LinkResult {
  status: number
  hops: number
  finalUrl: string
  error?: string
}

const SKIP_LINK = /^\/(admin|api|go|_next)(\/|$)|\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|xml|txt|css|js|mp4|webm|woff2?)(\?|$)/i

/** The internal links of a page worth checking: same site, not an asset or admin or affiliate hop, de-duplicated, at most `max`. Pure. */
export function internalLinks(facts: PageFacts, pageUrl: string, siteUrl: string, max = MAX_LINKS_PER_PAGE): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const self = normUrl(pageUrl)
  for (const href of facts.links) {
    if (/^(mailto|tel|sms|javascript):/i.test(href) || href.startsWith('#')) continue
    const n = normUrl(href, pageUrl)
    if (!n || !sameHost(n, siteUrl) || n === self || seen.has(n)) continue
    if (SKIP_LINK.test(pathOf(n))) continue
    seen.add(n)
    out.push(n)
    if (out.length >= max) break
  }
  return out
}

/** The finding (if any) for one link and what its target answered. Pure. */
export function analyzeLink(pageUrl: string, target: string, res: LinkResult): Finding[] {
  const p = pathOf(target)
  if (res.error) return []
  if (res.status === 404 || res.status === 410) return [mk(pageUrl, 'dead-link', 'error', `Links to ${p}, which returns ${res.status} (not found).`, 'Remove the link or point it at a page that exists. For a blog post or guide, the daily clean-up removes the link for you (the words stay).', { target, status: res.status })]
  if (res.status >= 500) return [mk(pageUrl, 'link-server-error', 'error', `Links to ${p}, which returns a server error (${res.status}).`, 'The page that is linked to is broken. Open it; if it still fails, tell Claude.', { target, status: res.status })]
  if (res.status >= 300) return [mk(pageUrl, 'link-redirect-loop', 'error', `Links to ${p}, which redirects over and over.`, 'A redirect loop: tell Claude the address.', { target, status: res.status })]
  if (res.hops >= 2) return [mk(pageUrl, 'link-redirect-chain', 'warning', `Links to ${p}, which goes through ${res.hops} redirects (ends at ${pathOf(res.finalUrl)}).`, 'Point the link at the final address.', { target, status: res.status })]
  if (res.hops === 1) return [mk(pageUrl, 'link-redirect', 'info', `Links to ${p}, which redirects to ${pathOf(res.finalUrl)}.`, 'Point the link at the final address to save visitors a jump.', { target, status: res.status })]
  return []
}

// ---------------------------------------------------------------------------------------------------
// The thin fetch layer
// ---------------------------------------------------------------------------------------------------

export interface FetchResponseLike {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}
export type FetchLike = (url: string, init: { method: string; redirect: 'manual'; headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>

/** The real fetch, as a FetchLike. */
export const realFetch: FetchLike = (url, init) => fetch(url, init)

export interface Fetched {
  status: number
  finalUrl: string
  hops: number
  ms: number
  contentType: string
  xRobots: string
  body: string
  error?: string
}

async function timed<T>(p: Promise<T>, ms: number, ctl: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<never>((_r, rej) => {
    timer = setTimeout(() => {
      ctl.abort()
      rej(new Error(`no answer after ${Math.round(ms / 1000)}s`))
    }, ms)
  })
  try {
    return await Promise.race([p, t])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** One address, following redirects by hand so the number of jumps is known. Never throws. */
export async function fetchFollow(url: string, f: FetchLike, opts: { method?: 'GET' | 'HEAD'; timeoutMs?: number; readBody?: boolean } = {}): Promise<Fetched> {
  const method = opts.method ?? 'GET'
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  const started = Date.now()
  let cur = url
  let hops = 0
  let last: FetchResponseLike | null = null
  try {
    for (;;) {
      const ctl = new AbortController()
      const left = Math.max(500, timeoutMs - (Date.now() - started))
      last = await timed(f(cur, { method, redirect: 'manual', headers: { 'user-agent': BOT_NAME, accept: method === 'GET' ? 'text/html,application/xhtml+xml' : '*/*' }, signal: ctl.signal }), left, ctl)
      const loc = last.headers.get('location')
      if (last.status >= 300 && last.status < 400 && loc) {
        const next = normUrl(loc, cur)
        if (!next) break
        hops++
        cur = next
        if (hops > MAX_REDIRECT_HOPS) break
        continue
      }
      break
    }
    const res = last
    if (!res) return { status: 0, finalUrl: cur, hops, ms: Date.now() - started, contentType: '', xRobots: '', body: '', error: 'no response' }
    const contentType = res.headers.get('content-type') ?? ''
    let body = ''
    if (opts.readBody && method === 'GET' && res.status < 400 && /html|xml|text/i.test(contentType || 'text/html')) {
      const ctl = new AbortController()
      body = await timed(res.text(), Math.max(500, timeoutMs - (Date.now() - started)), ctl)
    }
    return { status: res.status, finalUrl: cur, hops, ms: Date.now() - started, contentType, xRobots: res.headers.get('x-robots-tag') ?? '', body }
  } catch (e) {
    return { status: 0, finalUrl: cur, hops, ms: Date.now() - started, contentType: '', xRobots: '', body: '', error: e instanceof Error ? e.message : 'failed' }
  }
}

/** The sitemap's page addresses (follows a sitemap index one level, at most 5 children). Never throws: on a failure `error` says why and `urls` is empty. */
export async function fetchSitemap(siteUrl: string, f: FetchLike): Promise<{ urls: string[]; error?: string }> {
  const first = await fetchFollow(`${siteUrl.replace(/\/$/, '')}/sitemap.xml`, f, { readBody: true })
  if (first.error || first.status !== 200) return { urls: [], error: first.error ?? `the sitemap returned ${first.status}` }
  const parsed = parseSitemap(first.body)
  const urls = [...parsed.urls]
  for (const child of parsed.children.slice(0, 5)) {
    const r = await fetchFollow(child, f, { readBody: true })
    if (r.status === 200) urls.push(...parseSitemap(r.body).urls)
  }
  const clean = [...new Set(urls.map((u) => normUrl(u)).filter((u): u is string => !!u))]
  return clean.length ? { urls: clean } : { urls: [], error: 'the sitemap lists no pages' }
}

/** Runs `fn` over items with at most `concurrency` at once, stops starting new ones once `stop()` is true. Results keep the item order; items never started stay undefined. */
export async function pool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>, stop: () => boolean = () => false): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined)
  let next = 0
  const worker = async () => {
    for (;;) {
      if (stop()) return
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return out
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve())

export interface CrawlOptions {
  siteUrl: string
  /** Every address in the sitemap (to tell "in the sitemap" from not). */
  sitemapUrls: readonly string[]
  /** The pages to look at in this run. */
  window: readonly string[]
  fetch: FetchLike
  /** Absolute time (ms since 1970) after which no new request starts. */
  deadlineMs?: number
  concurrency?: number
  timeoutMs?: number
  delayMs?: number
  maxLinkChecks?: number
  maxExtraPages?: number
  /** path -> [title hash, description hash] of pages checked earlier, for the duplicate check. */
  known?: Record<string, [string, string]>
}

export interface CrawlResult {
  records: PageRecord[]
  findings: Finding[]
  /** Window addresses that were checked, in window order. */
  checked: string[]
  /** Window addresses not reached because the time ran out. */
  skipped: string[]
  linkChecks: number
  budgetUsed: boolean
  /** The last address such that it and every address before it in the window was checked (the next run starts after it). */
  cursor: string | null
}

/** Looks at the pages of one window, then at their links, then at a few linked pages the sitemap does not list. Never throws. */
export async function crawlWindow(o: CrawlOptions): Promise<CrawlResult> {
  const deadline = o.deadlineMs ?? Infinity
  const over = () => Date.now() >= deadline
  const conc = o.concurrency ?? CONCURRENCY
  const delay = o.delayMs ?? POLITE_DELAY_MS
  const timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS
  const inSitemap = new Set(o.sitemapUrls.map((u) => normUrl(u)).filter((u): u is string => !!u))

  const toRecord = (url: string, got: Fetched, sitemap: boolean): PageRecord => ({
    url,
    finalUrl: got.finalUrl,
    status: got.status,
    hops: got.hops,
    ms: got.ms,
    contentType: got.contentType,
    xRobots: got.xRobots,
    error: got.error,
    facts: got.body ? extractFacts(got.body) : null,
    inSitemap: sitemap,
  })

  const pageResults = await pool(
    o.window,
    conc,
    async (url) => {
      const got = await fetchFollow(url, o.fetch, { readBody: true, timeoutMs })
      await sleep(delay)
      return toRecord(url, got, true)
    },
    over,
  )
  const records: PageRecord[] = []
  const checked: string[] = []
  const skipped: string[] = []
  let cursor: string | null = null
  let contiguous = true
  o.window.forEach((u, i) => {
    const rec = pageResults[i]
    if (rec) {
      records.push(rec)
      checked.push(u)
      if (contiguous) cursor = u
    } else {
      skipped.push(u)
      contiguous = false
    }
  })

  const findings: Finding[] = []
  for (const r of records) findings.push(...analyzePage(r))
  findings.push(...analyzeUniqueness(records, o.known))

  // Links: every internal link of every checked page, each address asked once per run (HEAD), a fixed number in total.
  const byUrl = new Map<string, LinkResult>()
  for (const r of records) byUrl.set(normUrl(r.url) ?? r.url, { status: r.status, hops: r.hops, finalUrl: r.finalUrl, error: r.error })
  const linkPairs: { page: PageRecord; target: string }[] = []
  const toAsk: string[] = []
  for (const r of records) {
    if (!r.facts || r.status >= 400) continue
    for (const t of internalLinks(r.facts, r.finalUrl, o.siteUrl)) {
      linkPairs.push({ page: r, target: t })
      if (!byUrl.has(t) && !toAsk.includes(t)) toAsk.push(t)
    }
  }
  const maxLinks = o.maxLinkChecks ?? MAX_LINK_CHECKS_PER_RUN
  const ask = toAsk.slice(0, maxLinks)
  const linkTypes = new Map<string, { contentType: string }>()
  await pool(
    ask,
    conc,
    async (t) => {
      let got = await fetchFollow(t, o.fetch, { method: 'HEAD', timeoutMs })
      // Some servers refuse HEAD; a 5xx may be a moment's trouble. Ask once more with GET before calling it broken.
      if (got.status === 405 || got.status === 403 || got.status === 501 || got.status >= 500) got = await fetchFollow(t, o.fetch, { method: 'GET', timeoutMs })
      byUrl.set(t, { status: got.status, hops: got.hops, finalUrl: got.finalUrl, error: got.error })
      linkTypes.set(t, { contentType: got.contentType })
      await sleep(delay)
    },
    over,
  )
  const asked = ask.filter((t) => byUrl.has(t)).length
  for (const { page, target } of linkPairs) {
    const res = byUrl.get(target)
    if (res) findings.push(...analyzeLink(page.url, target, res))
  }

  // A few linked pages the sitemap does not list: fetch them to see whether a page that can be indexed is missing from the sitemap.
  const extra = ask
    .filter((t) => !inSitemap.has(t) && !over())
    .filter((t) => {
      const res = byUrl.get(t)
      return !!res && res.status === 200 && res.hops === 0 && !/pdf|image/i.test(linkTypes.get(t)?.contentType ?? '')
    })
    .slice(0, o.maxExtraPages ?? MAX_EXTRA_PAGES_PER_RUN)
  const extraResults = await pool(
    extra,
    conc,
    async (url) => {
      const got = await fetchFollow(url, o.fetch, { readBody: true, timeoutMs })
      await sleep(delay)
      return toRecord(url, got, false)
    },
    over,
  )
  for (const r of extraResults) if (r && r.facts && r.status === 200) findings.push(...analyzeIndexability(r))

  return { records, findings, checked, skipped, linkChecks: asked, budgetUsed: over() || skipped.length > 0, cursor }
}

// ---------------------------------------------------------------------------------------------------
// The stored state (app_settings key site_crawl_state). Small on purpose: a cursor, per-page counters and the top findings.
// ---------------------------------------------------------------------------------------------------

export const STATE_KEY = 'site_crawl_state'
export const MAX_STORED_FINDINGS = 30
export const MAX_STORED_PAGES = 600

export interface StoredFinding {
  url: string
  kind: string
  severity: Severity
  message: string
  hint: string
  target?: string
  status?: number
  /** When this exact problem was first seen (an ISO time). */
  firstSeen: string
}

/** One page: [last checked (days since 1970), title hash, description hash, errors, warnings, infos]. */
export type StoredPage = [number, string, string, number, number, number]

export interface CrawlState {
  v: 1
  lastRun: string | null
  /** The last address checked (the next run starts after it). */
  cursor: string | null
  /** Pages in the sitemap at the last run. */
  total: number
  /** Pages checked in the last run. */
  lastChecked: number
  budgetUsed: boolean
  note: string
  pages: Record<string, StoredPage>
  findings: StoredFinding[]
  /** Fixes made in the last run (for the card). */
  fixed: number
  /** Set when the owner dismissed the Needs attention item: only errors first seen after this show again. */
  dismissedAt: string | null
}

export const emptyState = (): CrawlState => ({ v: 1, lastRun: null, cursor: null, total: 0, lastChecked: 0, budgetUsed: false, note: '', pages: {}, findings: [], fixed: 0, dismissedAt: null })

export function parseState(raw: string | null | undefined): CrawlState {
  if (!raw) return emptyState()
  try {
    const p = JSON.parse(raw) as Partial<CrawlState>
    if (!p || p.v !== 1) return emptyState()
    return {
      ...emptyState(),
      ...p,
      pages: p.pages && typeof p.pages === 'object' ? p.pages : {},
      findings: Array.isArray(p.findings) ? p.findings : [],
    } as CrawlState
  } catch {
    return emptyState()
  }
}

export const epochDay = (d: Date) => Math.floor(d.getTime() / 86_400_000)
const SEV_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
const findingKey = (f: { url: string; kind: string; target?: string }) => `${pathOf(f.url)}|${f.kind}|${f.target ? pathOf(f.target) : ''}`

/** Folds one run into the stored state. Findings of pages checked in this run are replaced; findings of pages not checked stay until their turn.
 * Pure: `fixedKeys` are findings that were healed in this run and so are dropped. */
export function mergeState(prev: CrawlState, run: { checkedUrls: readonly string[]; records: readonly PageRecord[]; findings: readonly Finding[]; totalUrls: number; cursor: string | null; budgetUsed: boolean; fixed: number; note: string; sitemapPaths: readonly string[] }, now: Date, healedKeys: ReadonlySet<string> = new Set()): CrawlState {
  const checkedPaths = new Set(run.checkedUrls.map(pathOf))
  const live = new Set(run.sitemapPaths)
  const firstSeenBefore = new Map(prev.findings.map((f) => [findingKey(f), f.firstSeen]))

  // Counters per page.
  const pages: Record<string, StoredPage> = {}
  for (const [p, v] of Object.entries(prev.pages)) if (live.size === 0 || live.has(p)) pages[p] = v
  for (const r of run.records) {
    if (!r.inSitemap) continue
    const p = pathOf(r.url)
    const mine = run.findings.filter((f) => pathOf(f.url) === p && !healedKeys.has(findingKey(f)))
    pages[p] = [epochDay(now), r.facts?.title ? hash(r.facts.title) : '', r.facts?.description ? hash(r.facts.description) : '', mine.filter((f) => f.severity === 'error').length, mine.filter((f) => f.severity === 'warning').length, mine.filter((f) => f.severity === 'info').length]
  }
  // Keep the newest MAX_STORED_PAGES.
  const entries = Object.entries(pages)
  if (entries.length > MAX_STORED_PAGES) {
    entries.sort((a, b) => b[1][0] - a[1][0])
    for (const [p] of entries.slice(MAX_STORED_PAGES)) delete pages[p]
  }

  // A linked page the sitemap does not list is not in the window, but its finding is new information, so it is kept too.
  const isNew = (f: Finding) => checkedPaths.has(pathOf(f.url)) || f.kind === 'indexable-not-in-sitemap'
  const freshKeys = new Set(run.findings.filter(isNew).map(findingKey))
  const kept = prev.findings.filter((f) => !checkedPaths.has(pathOf(f.url)) && !freshKeys.has(findingKey(f)) && (live.size === 0 || live.has(pathOf(f.url)) || f.kind === 'indexable-not-in-sitemap'))
  const fresh: StoredFinding[] = run.findings
    .filter((f) => !healedKeys.has(findingKey(f)) && isNew(f))
    .map((f) => ({ url: f.url, kind: f.kind, severity: f.severity, message: f.message, hint: f.hint, ...(f.target ? { target: f.target } : {}), ...(f.status ? { status: f.status } : {}), firstSeen: firstSeenBefore.get(findingKey(f)) ?? now.toISOString() }))
  const all = [...kept, ...fresh].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0))
  return {
    v: 1,
    lastRun: now.toISOString(),
    cursor: run.cursor ?? prev.cursor,
    total: run.totalUrls,
    lastChecked: run.checkedUrls.length,
    budgetUsed: run.budgetUsed,
    note: run.note.slice(0, 300),
    pages,
    findings: all.slice(0, MAX_STORED_FINDINGS),
    fixed: run.fixed,
    dismissedAt: prev.dismissedAt,
  }
}

export interface CrawlSummary {
  lastRun: string | null
  total: number
  checked7d: number
  errors: number
  warnings: number
  infos: number
  fixed: number
  budgetUsed: boolean
  top: StoredFinding[]
}

/** The numbers for the System Health card, the Needs attention item and the growth digest. Pure. */
export function summarize(state: CrawlState, now: Date = new Date()): CrawlSummary {
  const today = epochDay(now)
  const rows = Object.values(state.pages)
  return {
    lastRun: state.lastRun,
    total: state.total,
    checked7d: rows.filter((p) => today - p[0] < 7).length,
    errors: rows.reduce((n, p) => n + p[3], 0),
    warnings: rows.reduce((n, p) => n + p[4], 0),
    infos: rows.reduce((n, p) => n + p[5], 0),
    fixed: state.fixed,
    budgetUsed: state.budgetUsed,
    top: state.findings,
  }
}

/** Error findings that the owner has not dismissed. */
export function undismissedErrors(state: CrawlState): StoredFinding[] {
  return state.findings.filter((f) => f.severity === 'error' && (!state.dismissedAt || f.firstSeen > state.dismissedAt))
}
