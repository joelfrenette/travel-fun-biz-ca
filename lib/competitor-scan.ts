import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { stems } from '@/lib/keyword-score'
import { matchScore, MATCH_THRESHOLD, type SeoPage } from '@/lib/seo-pages'
import { site } from '@/lib/site'

// COMPETITOR SCANNER (SEO engine 3). The owner lists up to 5 competitor websites; this reads a polite sample of each one's PUBLIC pages and
// works out what they cover that we do not.
//
// How polite: it identifies itself ("TravelFunBizResearchBot"), reads robots.txt first and obeys it, asks for one page per second, never more
// than 40 pages per competitor per run, gives each request 6 seconds, stays on the competitor's own host, and only reads HTML.
//
// What it keeps: NEVER their text. For each page it keeps the address, the title and main heading (a few words), counts (words, links,
// subheadings), the structured-data types and a list of the most frequent 1 to 3 word PHRASES. No paragraph, no description text, nothing
// that could be pasted into our pages is stored. The gaps it reports are phrases, counts and page types.
//
// What it cannot do (there is no API): read a competitor's Google Business Profile categories and services, or their backlinks. For those it
// says so plainly and hands over the manual steps (MANUAL_STEPS below, also lib/competitor-tasks.ts).

export const BOT_NAME = 'TravelFunBizResearchBot'
export const USER_AGENT = `${BOT_NAME}/1.0 (competitor research for travelfunbiz.ca; obeys robots.txt; 1 request per second)`
export const MAX_COMPETITORS = 5
export const MAX_PAGES_PER_COMPETITOR = 40
export const REQUEST_TIMEOUT_MS = 6_000
export const REQUEST_GAP_MS = 1_000
export const MAX_HTML_CHARS = 1_000_000
export const RESCAN_AFTER_DAYS = 7
export const COMPETITORS_KEY = 'seo_competitors'
export const COMPETITOR_STATE_KEY = 'seo_competitor_state'

export const CANNOT_READ =
  'This tool cannot read a competitor\'s Google Business Profile categories and services, or their backlinks: Google and the backlink companies give no free way to fetch them, so nothing here guesses them. Use the manual steps below.'

export const MANUAL_STEPS = {
  businessProfile: [
    'Open Google Maps and search for the competitor by name.',
    'Click their listing, then read the main category under the business name (for example "Travel agency").',
    'Open the About tab (or scroll to "Services") and write down the other categories and the services they list.',
    'Open our own Google Business Profile, then add any of those categories and services that are really true for us. Do not add anything we do not offer.',
  ],
  backlinks: [
    'Make a free account with a backlink tool: Ahrefs Webmaster Tools (free tier, for sites you own), Semrush (free searches a day) or Ubersuggest (free searches a day).',
    'Look up the competitor\'s domain and export the list of referring domains (the sites that link to them).',
    'Pick the realistic ones: local directories, travel associations, supplier and partner pages, travel bloggers, community sites. Skip anything paid, spammy or unrelated.',
    'For each one you pick, add a task in the Link building page and contact them yourself with a short, honest message.',
  ],
} as const

// ---------------------------------------------------------------------------------------------------
// The competitor list: validation
// ---------------------------------------------------------------------------------------------------

/** Our own domains (never scanned as a competitor): this site's host, plus the .ca and .com of the brand. */
export function ownHosts(): string[] {
  const hosts = new Set(['travelfunbiz.ca', 'travelfunbiz.com'])
  try {
    hosts.add(new URL(site.url).hostname.replace(/^www\./, '').toLowerCase())
  } catch {
    // the two brand domains above are enough
  }
  return [...hosts]
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, '')

export type UrlCheck = { ok: true; origin: string; host: string } | { ok: false; reason: string }

/** A competitor must be a public https website. Refused: http, an address with a password or port, an IP address, localhost or an internal
 * name, a name with no dot, and our own domain (with or without www, including any subdomain of it). Pure. */
export function validateCompetitorUrl(raw: string, own: readonly string[] = ownHosts()): UrlCheck {
  const text = (raw ?? '').trim()
  if (!text) return { ok: false, reason: 'Type the competitor\'s website address.' }
  if (/^http:\/\//i.test(text)) return { ok: false, reason: 'Use the https:// address (a plain http address is not accepted).' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https:\/\//i.test(text)) return { ok: false, reason: 'Only https:// website addresses are accepted.' }
  let url: URL
  try {
    url = new URL(/^https:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { ok: false, reason: 'That is not a valid website address.' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Only https:// website addresses are accepted.' }
  if (url.username || url.password) return { ok: false, reason: 'The address must not contain a user name or password.' }
  if (url.port) return { ok: false, reason: 'Addresses with a port number are not accepted.' }
  const host = url.hostname.toLowerCase()
  if (!host.includes('.')) return { ok: false, reason: 'The address needs a real domain name (for example example.com).' }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[/.test(host)) return { ok: false, reason: 'Numeric (IP) addresses are not accepted.' }
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(host)) return { ok: false, reason: 'Internal or test addresses are not accepted.' }
  const b = bare(host)
  if (own.some((o) => b === bare(o) || b.endsWith(`.${bare(o)}`))) return { ok: false, reason: 'That is our own website. Add a competitor\'s site instead.' }
  return { ok: true, origin: `https://${host}`, host: b }
}

/** Parses the stored list (a JSON array of addresses). Invalid and duplicate entries are dropped; at most MAX_COMPETITORS are kept. Pure. */
export function parseCompetitorList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    const out: string[] = []
    for (const item of v) {
      if (typeof item !== 'string') continue
      const c = validateCompetitorUrl(item)
      if (c.ok && !out.includes(c.origin)) out.push(c.origin)
    }
    return out.slice(0, MAX_COMPETITORS)
  } catch {
    return []
  }
}

/** Adds one address to a list. Returns the new list or the reason it was refused. Pure. */
export function addCompetitor(list: readonly string[], raw: string): { ok: true; list: string[] } | { ok: false; reason: string } {
  const c = validateCompetitorUrl(raw)
  if (!c.ok) return c
  if (list.some((x) => bare(new URL(x).hostname) === c.host)) return { ok: false, reason: 'That competitor is already in the list.' }
  if (list.length >= MAX_COMPETITORS) return { ok: false, reason: `At most ${MAX_COMPETITORS} competitors can be tracked. Remove one first.` }
  return { ok: true, list: [...list, c.origin] }
}

export function removeCompetitor(list: readonly string[], raw: string): string[] {
  const c = validateCompetitorUrl(raw)
  const host = c.ok ? c.host : bare(raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
  return list.filter((x) => bare(new URL(x).hostname) !== host)
}

// ---------------------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------------------

export interface RobotsRules {
  /** [allow?, pattern] pairs of the group that applies to us. */
  rules: { allow: boolean; pattern: string }[]
  crawlDelaySec: number | null
  sitemaps: string[]
}

/** Reads a robots.txt for our bot: the group naming TravelFunBizResearchBot if there is one, otherwise the "*" group. Pure. */
export function parseRobots(text: string): RobotsRules {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null }[] = []
  const sitemaps: string[] = []
  let cur: (typeof groups)[number] | null = null
  let lastWasAgent = false
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'sitemap') {
      if (val) sitemaps.push(val)
      continue
    }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: null }
        groups.push(cur)
      }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur) continue
    if (key === 'allow') cur.rules.push({ allow: true, pattern: val })
    else if (key === 'disallow') cur.rules.push({ allow: false, pattern: val })
    else if (key === 'crawl-delay') {
      const n = Number(val)
      if (Number.isFinite(n) && n >= 0) cur.delay = n
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && BOT_NAME.toLowerCase().includes(a))) ?? groups.find((g) => g.agents.includes('*'))
  return { rules: mine?.rules ?? [], crawlDelaySec: mine?.delay ?? null, sitemaps }
}

function patternToRegExp(pattern: string): RegExp {
  const end = pattern.endsWith('$')
  const body = (end ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${body}${end ? '$' : ''}`)
}

/** May the bot read this path? The longest matching rule wins; on a tie Allow wins; an empty Disallow allows everything. Pure. */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null
  for (const r of rules.rules) {
    if (!r.pattern) continue
    if (!patternToRegExp(r.pattern).test(pathAndQuery)) continue
    const len = r.pattern.length
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len }
  }
  return best ? best.allow : true
}

// ---------------------------------------------------------------------------------------------------
// HTML reading
// ---------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...' }
function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (all, n: string) => ENTITIES[n.toLowerCase()] ?? all)
}
const tagText = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

const STOP = new Set(
  'a about above after again all also am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours get got make made one two three new view see click read learn find contact us home menu search skip content close open privacy policy terms cookies cookie accept sign login log register subscribe newsletter copyright reserved rights share facebook twitter instagram youtube pinterest linkedin email phone call'.split(' '),
)
const GENERIC = new Set(['travel', 'trip', 'trips', 'tour', 'tours', 'vacation', 'vacations', 'holiday', 'holidays', 'book', 'booking', 'agency', 'agent', 'agents', 'website', 'page', 'site', 'blog', 'news', 'info', 'information', 'best', 'top', 'great', 'good', 'free', 'online', 'today', 'time', 'year', 'years'])

/** Splits text into runs of meaningful words and returns every 1 to 3 word phrase in each run. A phrase never spans a stop word. Pure. */
export function phrasesOf(text: string): string[] {
  const out: string[] = []
  const runs = text.toLowerCase().replace(/[^a-z0-9'\s&-]/g, ' | ').split(/\s+/)
  let run: string[] = []
  const flush = () => {
    for (let i = 0; i < run.length; i++) {
      for (let n = 1; n <= 3 && i + n <= run.length; n++) {
        const words = run.slice(i, i + n)
        if (n === 1 && (GENERIC.has(words[0]) || words[0].length < 4)) continue
        if (GENERIC.has(words[0]) && GENERIC.has(words[n - 1])) continue
        out.push(words.join(' '))
      }
    }
    run = []
  }
  for (const raw of runs) {
    const w = raw.replace(/^[-'&]+|[-'&]+$/g, '')
    if (raw === '|' || !w || STOP.has(w) || /^\d+$/.test(w) || w.length < 2) flush()
    else run.push(w)
  }
  flush()
  return out
}

export interface PageSummary {
  path: string
  pageType: CompetitorPageType
  /** A few words: the title and the main heading. Headings only, never body text. */
  title: string
  h1: string
  h2Count: number
  wordCount: number
  /** The length of the meta description (its text is not kept). */
  metaDescriptionLength: number
  schemaTypes: string[]
  internalLinks: number
  /** The top phrases of the page, with the title and main heading weighted. Phrases only. */
  phrases: string[]
}

export type CompetitorPageType = 'home' | 'blog' | 'destination' | 'cruise' | 'tour-package' | 'from-city' | 'compare' | 'best-time' | 'faq' | 'about' | 'contact' | 'deals' | 'reviews' | 'other'

export function competitorPageType(path: string, title = ''): CompetitorPageType {
  const p = path.toLowerCase()
  const t = `${p} ${title.toLowerCase()}`
  if (p === '/' || p === '') return 'home'
  if (/\/(blog|news|articles?|stories|travel-tips|inspiration|magazine)(\/|$)/.test(p)) return 'blog'
  if (/\/(reviews?|testimonials?)(\/|$)/.test(p)) return 'reviews'
  if (/\/(faq|faqs|help|questions)(\/|$)/.test(p)) return 'faq'
  if (/\/(about|about-us|our-story|who-we-are|team)(\/|$)/.test(p)) return 'about'
  if (/\/(contact|contact-us)(\/|$)/.test(p)) return 'contact'
  if (/\/(deals?|offers?|specials?|sale|promotions?)(\/|$)/.test(p)) return 'deals'
  if (/\bvs\b|versus|compare/.test(t)) return 'compare'
  if (/best[- ]time|when[- ]to[- ](go|visit)|weather/.test(t)) return 'best-time'
  if (/\bfrom[- ](toronto|vancouver|calgary|montreal|ottawa|edmonton|winnipeg|halifax|your[- ]city)|departure[- ]cit/.test(t)) return 'from-city'
  // The address says more than the title: /tours/greek-sailing is a tour even though its title says sailing.
  if (/\/(cruises?|cruise-lines?|ships?|river-cruises|yachts?)(\/|$)/.test(p)) return 'cruise'
  if (/\/(tours?|packages?|trips?|vacations?|getaways?|escorted|groups?)(\/|$)/.test(p)) return 'tour-package'
  if (/\/(destinations?|countries|country|places?|where-to-go|resorts?|hotels?|regions?)(\/|$)/.test(p)) return 'destination'
  if (/cruis|ships?\b|sailings?|yacht/.test(t)) return 'cruise'
  return 'other'
}

const stripNoise = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, (all, tag: string) => (/^script$/i.test(tag) && /application\/ld\+json/i.test(all) ? all : ' '))

function jsonLdTypes(html: string): string[] {
  const types = new Set<string>()
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      const t = o['@type']
      if (typeof t === 'string') types.add(t)
      else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') types.add(x)
      if (o['@graph']) walk(o['@graph'])
    }
  }
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]))
    } catch {
      // a broken block is just not counted
    }
  }
  return [...types].slice(0, 12)
}

const sameSite = (a: string, b: string) => bare(a) === bare(b)

/** Reads one page. Keeps phrases and counts only. Pure. */
export function analyzePage(html: string, url: string): PageSummary & { navLabels: string[]; links: string[] } {
  const u = new URL(url)
  const schemaTypes = jsonLdTypes(html)
  const clean = stripNoise(html)
  const title = tagText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? '').slice(0, 120)
  const metaMatch = /<meta\b[^>]*name=["']description["'][^>]*>/i.exec(clean)
  const metaContent = metaMatch ? /content=["']([^"']*)["']/i.exec(metaMatch[0])?.[1] ?? '' : ''
  const h1s = [...clean.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => tagText(m[1])).filter(Boolean)
  const h2s = [...clean.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => tagText(m[1])).filter(Boolean)
  const navLabels: string[] = []
  for (const nav of clean.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)) {
    for (const a of nav[1].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = tagText(a[1]).toLowerCase()
      if (label && label.length <= 40 && !navLabels.includes(label)) navLabels.push(label)
    }
  }
  const links: string[] = []
  let internalLinks = 0
  for (const m of clean.matchAll(/<a\b[^>]*href=["']([^"'#]+)[^"']*["'][^>]*>/gi)) {
    try {
      const target = new URL(decode(m[1]), url)
      if (target.protocol === 'https:' && sameSite(target.hostname, u.hostname)) {
        internalLinks++
        if (links.length < 200) links.push(`${target.origin}${target.pathname}`)
      }
    } catch {
      // not a usable link
    }
  }
  const main = clean.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const bodyText = tagText(/<body[^>]*>([\s\S]*)<\/body>/i.exec(main)?.[1] ?? main)
  const wordCount = (bodyText.match(/[a-z0-9']+/gi) ?? []).length
  // Phrases: the body counts once, subheadings twice more, title and main heading five times.
  const weight = new Map<string, number>()
  const add = (text: string, w: number) => {
    for (const p of phrasesOf(text)) weight.set(p, (weight.get(p) ?? 0) + w)
  }
  add(bodyText, 1)
  for (const h of h2s) add(h, 2)
  for (const h of h1s) add(h, 5)
  add(title, 5)
  const phrases = [...weight.entries()]
    .filter(([p, w]) => w >= 2 || p.includes(' '))
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([p]) => p)
  const path = u.pathname.replace(/\/+$/, '') || '/'
  return {
    path,
    pageType: competitorPageType(path, `${title} ${h1s[0] ?? ''}`),
    title,
    h1: (h1s[0] ?? '').slice(0, 100),
    h2Count: h2s.length,
    wordCount,
    metaDescriptionLength: decode(metaContent).trim().length,
    schemaTypes,
    internalLinks,
    phrases,
    navLabels: navLabels.slice(0, 30),
    links,
  }
}

// ---------------------------------------------------------------------------------------------------
// The thin fetch layer (injectable)
// ---------------------------------------------------------------------------------------------------

export interface FetchResult {
  status: number
  contentType: string
  text: string
  /** The address after any redirects. */
  finalUrl: string
}

export type CompetitorFetch = (url: string, init: { timeoutMs: number; headers: Record<string, string> }) => Promise<FetchResult>

/** The real fetch: follows redirects, 6 second limit, at most 1,000,000 characters of text. The scanner itself refuses a redirect to another host. */
export const realCompetitorFetch: CompetitorFetch = async (url, init) => {
  const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: init.headers, signal: AbortSignal.timeout(init.timeoutMs), cache: 'no-store' })
  const text = (await res.text()).slice(0, MAX_HTML_CHARS)
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, finalUrl: res.url || url }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function sitemapLocs(xml: string): { urls: string[]; sitemaps: string[] } {
  const urls: string[] = []
  const sitemaps: string[] = []
  for (const block of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(block[2])?.[1]
    if (!loc) continue
    ;(block[1].toLowerCase() === 'sitemap' ? sitemaps : urls).push(decode(loc))
  }
  return { urls, sitemaps }
}

const NOT_HTML_PATH = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|xml|json|css|js|mp4|mp3|mov|docx?|xlsx?|pptx?|txt|rss|atom)$/i

/** Picks at most `max` addresses from a longer list, spread evenly so every part of the site is represented. The home page always comes first. Pure. */
export function samplePages(urls: readonly string[], origin: string, max: number): string[] {
  const home = `${origin}/`
  const rest = [...new Set(urls.map((u) => u.replace(/#.*$/, '')))].filter((u) => u.replace(/\/+$/, '') !== origin)
  const room = Math.max(0, max - 1)
  if (rest.length <= room) return [home, ...rest]
  const stride = rest.length / room
  const picked: string[] = []
  for (let i = 0; i < room; i++) picked.push(rest[Math.floor(i * stride)])
  return [home, ...picked]
}

// ---------------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------------

export interface CompetitorResult {
  host: string
  origin: string
  scannedAt: string
  /** False when the run stopped early (time budget): the next run adds more pages. */
  complete: boolean
  pagesScanned: number
  requests: number
  blockedByRobots: number
  robotsFound: boolean
  pages: PageSummary[]
  topPhrases: { phrase: string; pages: number }[]
  titlePhrases: { phrase: string; pages: number }[]
  navLabels: string[]
  schemaTypes: { type: string; pages: number }[]
  pageTypes: { type: CompetitorPageType; count: number }[]
  notes: string[]
}

export interface ScanOptions {
  fetch?: CompetitorFetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  maxPages?: number
  /** Epoch ms after which no new request is started. */
  deadlineMs?: number
  /** Pages already read in an earlier, unfinished run of the same cycle (their addresses are skipped). */
  previous?: CompetitorResult | null
}

const MAX_STORED_PAGES = 40
const hostOf = (origin: string) => bare(new URL(origin).hostname)

/** Scans one competitor. Never throws. Every network call goes through `opts.fetch`, one at a time, `REQUEST_GAP_MS` apart. */
export async function scanCompetitor(originRaw: string, opts: ScanOptions = {}): Promise<CompetitorResult> {
  const check = validateCompetitorUrl(originRaw)
  const nowMs = opts.now ?? (() => Date.now())
  const origin = check.ok ? check.origin : originRaw
  const result: CompetitorResult = {
    host: check.ok ? check.host : originRaw,
    origin,
    scannedAt: new Date(nowMs()).toISOString(),
    complete: false,
    pagesScanned: 0,
    requests: 0,
    blockedByRobots: 0,
    robotsFound: false,
    pages: [],
    topPhrases: [],
    titlePhrases: [],
    navLabels: [],
    schemaTypes: [],
    pageTypes: [],
    notes: [],
  }
  if (!check.ok) {
    result.notes.push(check.reason)
    return result
  }
  const doFetch = opts.fetch ?? realCompetitorFetch
  const sleep = opts.sleep ?? realSleep
  const maxPages = Math.min(opts.maxPages ?? MAX_PAGES_PER_COMPETITOR, MAX_PAGES_PER_COMPETITOR)
  const deadline = opts.deadlineMs ?? Infinity
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8', 'Accept-Language': 'en' }
  let gap = REQUEST_GAP_MS
  let last = 0
  const prior = opts.previous && opts.previous.host === result.host && !opts.previous.complete ? opts.previous : null
  const done = new Set((prior?.pages ?? []).map((p) => p.path))

  // One polite request: waits so that two requests are never closer than `gap`, stays on the host, never throws.
  const get = async (url: string): Promise<FetchResult | null> => {
    if (nowMs() >= deadline) return null
    const wait = result.requests > 0 ? last + gap - nowMs() : 0
    if (wait > 0) await sleep(wait)
    if (nowMs() >= deadline) return null
    last = nowMs()
    result.requests++
    try {
      const res = await doFetch(url, { timeoutMs: REQUEST_TIMEOUT_MS, headers })
      if (!sameSite(new URL(res.finalUrl || url).hostname, new URL(origin).hostname)) {
        result.notes.push('A request was sent to another website; it was ignored.')
        return null
      }
      return res
    } catch (e) {
      if (result.notes.length < 5) result.notes.push(`${url}: ${e instanceof Error ? e.message.slice(0, 80) : 'request failed'}`)
      return null
    }
  }

  // robots.txt first. A missing file means everything public is allowed; one that cannot be read at all stops the scan (be safe).
  let rules: RobotsRules = { rules: [], crawlDelaySec: null, sitemaps: [] }
  const robots = await get(`${origin}/robots.txt`)
  if (robots && robots.status >= 200 && robots.status < 300 && !/text\/html/i.test(robots.contentType)) {
    rules = parseRobots(robots.text)
    result.robotsFound = true
    if (rules.crawlDelaySec && rules.crawlDelaySec * 1000 > gap) gap = Math.min(rules.crawlDelaySec * 1000, 5_000)
  } else if (!robots) {
    result.notes.push('robots.txt could not be read, so nothing was scanned.')
    return result
  }
  if (!robotsAllows(rules, '/')) {
    result.notes.push('robots.txt asks bots to stay out of this site, so nothing was scanned.')
    result.complete = true
    return result
  }

  // The list of pages: the sitemap(s) if there is one (at most 3 files), else the links on the home page.
  let candidates: string[] = []
  const sitemapFiles = [...rules.sitemaps.filter((s) => { try { return sameSite(new URL(s).hostname, new URL(origin).hostname) } catch { return false } }), `${origin}/sitemap.xml`].slice(0, 3)
  const seenSitemap = new Set<string>()
  const queue = [...new Set(sitemapFiles)]
  while (queue.length && seenSitemap.size < 3 && candidates.length < 500) {
    const next = queue.shift() as string
    if (seenSitemap.has(next)) continue
    seenSitemap.add(next)
    const res = await get(next)
    if (!res || res.status < 200 || res.status >= 300) continue
    const locs = sitemapLocs(res.text)
    candidates.push(...locs.urls)
    for (const s of locs.sitemaps) {
      try {
        if (sameSite(new URL(s).hostname, new URL(origin).hostname) && queue.length + seenSitemap.size < 3) queue.push(s)
      } catch {
        // skip
      }
    }
  }
  const pageResults: (PageSummary & { navLabels: string[]; links: string[] })[] = []
  const takePage = async (url: string): Promise<(PageSummary & { navLabels: string[]; links: string[] }) | null> => {
    const u = new URL(url)
    if (!sameSite(u.hostname, new URL(origin).hostname) || u.protocol !== 'https:' || NOT_HTML_PATH.test(u.pathname)) return null
    if (!robotsAllows(rules, `${u.pathname}${u.search}`)) {
      result.blockedByRobots++
      return null
    }
    const res = await get(url)
    if (!res || res.status < 200 || res.status >= 300 || !/html/i.test(res.contentType)) return null
    return analyzePage(res.text, res.finalUrl || url)
  }

  let homeLinks: string[] = []
  if (candidates.length === 0) {
    const home = await takePage(`${origin}/`)
    if (home) {
      pageResults.push(home)
      homeLinks = home.links
      candidates = homeLinks
    } else {
      result.notes.push('No sitemap was found and the home page could not be read.')
    }
  }
  // Only addresses the bot may and wants to read are sampled, so the page limit is spent on real pages: same host, https, not a file, allowed by robots.txt.
  const usable = candidates.filter((c) => {
    try {
      const u = new URL(c)
      if (!sameSite(u.hostname, new URL(origin).hostname) || u.protocol !== 'https:' || NOT_HTML_PATH.test(u.pathname)) return false
      if (!robotsAllows(rules, `${u.pathname}${u.search}`)) {
        result.blockedByRobots++
        return false
      }
      return true
    } catch {
      return false
    }
  })
  const plan = samplePages(usable, origin, maxPages)
  let finished = true
  for (const url of plan) {
    if (pageResults.length + (prior?.pages.length ?? 0) >= maxPages) break
    let path = '/'
    try {
      path = new URL(url).pathname.replace(/\/+$/, '') || '/'
    } catch {
      continue
    }
    if (done.has(path) || pageResults.some((p) => p.path === path)) continue
    if (nowMs() >= deadline) {
      finished = false
      break
    }
    const p = await takePage(url)
    if (p) pageResults.push(p)
  }

  const merged: PageSummary[] = [
    ...(prior?.pages ?? []),
    ...pageResults.map(({ navLabels: _n, links: _l, ...p }) => {
      void _n
      void _l
      return p
    }),
  ].slice(0, MAX_STORED_PAGES)
  result.pages = merged
  result.pagesScanned = merged.length
  result.complete = finished && merged.length > 0
  if (merged.length === 0) result.notes.push('No page could be read.')

  // Totals: phrases (how many pages carry each), the phrases of titles and main headings, nav labels, structured-data types, page types.
  const count = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1)
  const all = new Map<string, number>()
  const titleP = new Map<string, number>()
  const schema = new Map<string, number>()
  const types = new Map<string, number>()
  for (const p of merged) {
    for (const ph of new Set(p.phrases)) count(all, ph)
    for (const ph of new Set(phrasesOf(`${p.title} ${p.h1}`))) count(titleP, ph)
    for (const t of new Set(p.schemaTypes)) count(schema, t)
    count(types, p.pageType)
  }
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
  result.topPhrases = top(all, 40).map(([phrase, pages]) => ({ phrase, pages }))
  result.titlePhrases = top(titleP, 40).map(([phrase, pages]) => ({ phrase, pages }))
  result.schemaTypes = top(schema, 12).map(([type, pages]) => ({ type, pages }))
  result.pageTypes = top(types, 14).map(([type, n]) => ({ type: type as CompetitorPageType, count: n }))
  const labels = new Set<string>(prior?.navLabels ?? [])
  for (const p of pageResults) for (const l of p.navLabels) labels.add(l)
  result.navLabels = [...labels].slice(0, 30)
  return result
}

// ---------------------------------------------------------------------------------------------------
// Gaps against our own content
// ---------------------------------------------------------------------------------------------------

export interface KeywordGapItem {
  phrase: string
  /** How many of their scanned pages carry it in the title or main heading. */
  theirPages: number
}

/** Phrases a competitor targets in titles and main headings that none of our pages cover (a page covers a phrase when 60% of its meaningful
 * words are in the page's title, heading, keywords or address). Biggest first. Pure. */
export function keywordGap(result: Pick<CompetitorResult, 'titlePhrases'>, ourPages: readonly SeoPage[], limit = 20): KeywordGapItem[] {
  const out: KeywordGapItem[] = []
  for (const tp of result.titlePhrases) {
    if (stems(tp.phrase).size === 0) continue
    // Single words are too vague unless several of their pages use them.
    if (!tp.phrase.includes(' ') && tp.pages < 2) continue
    const covered = ourPages.some((p) => !p.thin && matchScore(tp.phrase, p) >= MATCH_THRESHOLD)
    if (!covered) out.push({ phrase: tp.phrase, theirPages: tp.pages })
  }
  return out.sort((a, b) => b.theirPages - a.theirPages || b.phrase.split(' ').length - a.phrase.split(' ').length || a.phrase.localeCompare(b.phrase)).slice(0, limit)
}

export type ServiceCategory = 'cruise line' | 'destination' | 'audience' | 'style' | 'product'

/** Travel products and services worth noticing on a competitor's site: cruise lines, destinations, who the trips are for, trip styles and what is sold. */
export const SERVICE_TERMS: { term: string; category: ServiceCategory }[] = [
  ...['royal caribbean', 'norwegian', 'carnival', 'celebrity', 'princess', 'holland america', 'msc', 'disney cruise', 'viking', 'azamara', 'silversea', 'regent', 'oceania', 'seabourn', 'windstar', 'virgin voyages', 'costa', 'cunard', 'uniworld', 'avalon', 'amawaterways', 'tauck'].map((term) => ({ term, category: 'cruise line' as const })),
  ...['caribbean', 'mediterranean', 'alaska', 'europe', 'mexico', 'hawaii', 'bahamas', 'greece', 'italy', 'croatia', 'iceland', 'norway', 'tahiti', 'bali', 'japan', 'costa rica', 'jamaica', 'cuba', 'dominican republic', 'punta cana', 'cancun', 'riviera maya', 'rhine', 'danube', 'galapagos', 'antarctica', 'australia', 'new zealand', 'thailand', 'portugal', 'spain', 'france', 'ireland', 'british virgin islands'].map((term) => ({ term, category: 'destination' as const })),
  ...['singles', 'group', 'groups', 'solo', 'family', 'honeymoon', 'couples', 'seniors', 'girls trip', 'women', 'lgbtq', 'multigenerational', 'destination wedding', 'friends'].map((term) => ({ term, category: 'audience' as const })),
  ...['luxury', 'all inclusive', 'river cruise', 'ocean cruise', 'expedition', 'yacht', 'sailing', 'adventure', 'wellness', 'escorted tour', 'ski', 'budget', 'private charter'].map((term) => ({ term, category: 'style' as const })),
  ...['flights', 'hotels', 'resorts', 'travel insurance', 'excursions', 'airport transfers', 'visa', 'gift cards', 'payment plan'].map((term) => ({ term, category: 'product' as const })),
]

export interface ServiceGapItem {
  term: string
  category: ServiceCategory
  theirPages: number
}

const hasPhrase = (haystack: string, term: string) => new RegExp(`(?<![a-z0-9])${term.replace(/\s+/g, '[\\s-]+')}(?![a-z0-9])`, 'i').test(haystack)

/** Services and categories a competitor lists (in their menu, titles and main headings) that none of our titles, keywords or destinations mention. Pure. */
export function serviceGap(result: Pick<CompetitorResult, 'pages' | 'navLabels'>, ourPages: readonly SeoPage[]): ServiceGapItem[] {
  const ours = ourPages.map((p) => `${p.title} ${p.h1} ${p.keywords.join(' ')} ${p.path.replace(/-/g, ' ')}`).join(' | ')
  const nav = result.navLabels.join(' | ')
  const out: ServiceGapItem[] = []
  for (const s of SERVICE_TERMS) {
    const pages = result.pages.filter((p) => hasPhrase(`${p.title} ${p.h1}`, s.term)).length
    const inNav = hasPhrase(nav, s.term)
    if (pages === 0 && !inNav) continue
    if (hasPhrase(ours, s.term)) continue
    out.push({ term: s.term, category: s.category, theirPages: pages + (inNav ? 1 : 0) })
  }
  return out.sort((a, b) => b.theirPages - a.theirPages || a.term.localeCompare(b.term)).slice(0, 25)
}

export interface ContentTypeGapItem {
  type: CompetitorPageType
  theirPages: number
}

/** The kinds of page this site already has, as the competitor page types. Pure. */
export function ourContentTypes(ourPages: readonly SeoPage[]): Set<CompetitorPageType> {
  const have = new Set<CompetitorPageType>(['home', 'from-city', 'compare', 'best-time', 'about'])
  for (const p of ourPages) {
    if (p.type === 'blog') have.add('blog')
    if (p.type === 'destination') have.add('destination')
    if (p.type === 'package') have.add('tour-package')
    if (p.type === 'guide') {
      have.add('destination')
      if (/^\/(cruise-lines|ships|river-cruises|yachts)\//.test(p.path)) have.add('cruise')
    }
  }
  return have
}

/** Page types the competitor has that we do not. "other" is never a gap. Pure. */
export function contentTypeGap(result: Pick<CompetitorResult, 'pageTypes'>, ourPages: readonly SeoPage[]): ContentTypeGapItem[] {
  const have = ourContentTypes(ourPages)
  return result.pageTypes.filter((t) => t.type !== 'other' && !have.has(t.type)).map((t) => ({ type: t.type, theirPages: t.count })).sort((a, b) => b.theirPages - a.theirPages)
}

export interface CompetitorGaps {
  keyword: KeywordGapItem[]
  service: ServiceGapItem[]
  contentType: ContentTypeGapItem[]
}

export function gapsFor(result: CompetitorResult, ourPages: readonly SeoPage[]): CompetitorGaps {
  return { keyword: keywordGap(result, ourPages), service: serviceGap(result, ourPages), contentType: contentTypeGap(result, ourPages) }
}

// ---------------------------------------------------------------------------------------------------
// Stored state and scheduling
// ---------------------------------------------------------------------------------------------------

export interface StoredCompetitor extends CompetitorResult {
  gaps: CompetitorGaps
}

export interface CompetitorState {
  competitors: Record<string, StoredCompetitor>
}

export function parseCompetitorState(raw: string | null | undefined): CompetitorState {
  if (!raw) return { competitors: {} }
  try {
    const v = JSON.parse(raw) as Partial<CompetitorState>
    if (!v || typeof v !== 'object' || !v.competitors || typeof v.competitors !== 'object') return { competitors: {} }
    const out: Record<string, StoredCompetitor> = {}
    for (const [host, c] of Object.entries(v.competitors).slice(0, MAX_COMPETITORS)) {
      if (c && typeof c === 'object' && typeof (c as StoredCompetitor).scannedAt === 'string' && Array.isArray((c as StoredCompetitor).pages)) out[host] = c as StoredCompetitor
    }
    return { competitors: out }
  } catch {
    return { competitors: {} }
  }
}

/** The competitor to scan next: one never scanned, then one whose last run stopped early, then the one scanned longest ago (and at least
 * RESCAN_AFTER_DAYS ago). Null when none is due. Pure. */
export function pickDueCompetitor(list: readonly string[], state: CompetitorState, now: Date = new Date()): string | null {
  const age = (origin: string): number | null => {
    const s = state.competitors[hostOf(origin)]
    return s ? now.getTime() - Date.parse(s.scannedAt) : null
  }
  const never = list.find((o) => age(o) === null)
  if (never) return never
  const partial = list.find((o) => state.competitors[hostOf(o)] && !state.competitors[hostOf(o)].complete && (age(o) ?? 0) >= 20 * 3_600_000)
  if (partial) return partial
  const old = list.filter((o) => (age(o) ?? 0) >= RESCAN_AFTER_DAYS * 86_400_000).sort((a, b) => (age(b) ?? 0) - (age(a) ?? 0))
  return old[0] ?? null
}

export async function readCompetitorList(admin: SupabaseClient): Promise<string[]> {
  try {
    return parseCompetitorList(await getSetting(admin, COMPETITORS_KEY))
  } catch {
    return []
  }
}

export async function writeCompetitorList(admin: SupabaseClient, list: readonly string[]): Promise<{ error?: string }> {
  return setSetting(admin, COMPETITORS_KEY, JSON.stringify(list.slice(0, MAX_COMPETITORS)))
}

export async function readCompetitorState(admin: SupabaseClient): Promise<CompetitorState> {
  try {
    return parseCompetitorState(await getSetting(admin, COMPETITOR_STATE_KEY))
  } catch {
    return { competitors: {} }
  }
}

/** Scans one competitor, works out its gaps, stores the result (bounded) and returns a one-line note. Never throws. */
export async function runCompetitorScan(admin: SupabaseClient, origin: string, ourPages: readonly SeoPage[], opts: ScanOptions = {}): Promise<{ note: string; result: StoredCompetitor | null }> {
  try {
    const state = await readCompetitorState(admin)
    const host = hostOf(origin)
    const result = await scanCompetitor(origin, { ...opts, previous: opts.previous ?? state.competitors[host] ?? null })
    const stored: StoredCompetitor = { ...result, gaps: gapsFor(result, ourPages) }
    // Keep only competitors still in the list, and never more than the limit.
    const list = await readCompetitorList(admin)
    const keep = new Set(list.map(hostOf))
    const next: Record<string, StoredCompetitor> = {}
    for (const [h, c] of Object.entries(state.competitors)) if (keep.has(h) && h !== host) next[h] = c
    next[host] = stored
    await setSetting(admin, COMPETITOR_STATE_KEY, JSON.stringify({ competitors: next } satisfies CompetitorState))
    return { note: `${host}: ${stored.pagesScanned} pages${stored.complete ? '' : ' (partial, more tomorrow)'}, ${stored.gaps.keyword.length} keyword gaps`, result: stored }
  } catch (e) {
    return { note: `competitor scan failed: ${e instanceof Error ? e.message : 'unknown error'}`, result: null }
  }
}
