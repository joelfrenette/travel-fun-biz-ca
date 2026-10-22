import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import {
  FETCH_TIMEOUT_MS,
  MAX_FEED_BYTES,
  MAX_ITEMS_PER_FEED,
  MAX_REDIRECTS,
  MAX_ROBOTS_BYTES,
  MIN_FETCH_INTERVAL_MS,
  NEWS_ROBOTS_TOKEN,
  NEWS_USER_AGENT,
  SUMMARY_MAX_CHARS,
  TITLE_MAX_CHARS,
  isAllowedFeedUrl,
  linkAllowedFor,
  redirectAllowedFor,
  type NewsSource,
} from '@/lib/news-sources'
import { FEED_FAIL_LIMIT } from '@/lib/news-sources'

// Growth loop WP20: reading a feed. Two halves.
//   1. PARSING (pure): RSS 2.0, RSS 1.0 (RDF) and Atom, tolerant of broken XML, never expands entities, never keeps
//      anything but the feed item's own title, link, date and short description. The full text some feeds carry
//      (content:encoded, atom content) is deliberately ignored: we use the short summary only.
//   2. FETCHING: https only, the exact allowlisted URL, a 10 second timeout, a 1 MB cap read as a stream, a descriptive
//      User-Agent, conditional GET (ETag / Last-Modified), at most one fetch per source per 30 minutes, robots.txt
//      respected. Redirects are followed by hand and only inside the source's own hosts.
// Everything in a feed is untrusted text. It is data to be quoted, never an instruction.

export interface RawFeedItem {
  guid: string
  url: string
  title: string
  summary: string
  publishedAt: string | null
  /** JSON advisory snapshots only: the country id and a short hash of its advisory text and date (used to find what changed). */
  stateKey?: string
  stateHash?: string
  /** JSON advisory snapshots only: the country name and its advisory LEVEL text (eng.advisory-text, e.g. "Avoid all travel"). */
  stateName?: string
  stateLevel?: string
}

/** UK FCDO Atom entries are titled with the bare country name ("Belgium"); the item title says what the item is. */
export const UK_FCDO_TITLE_PREFIX = 'UK travel advice update for '

/** Pure. Shapes a parsed feed item for storage and writing. Only the UK FCDO feed is changed: "Belgium" becomes "UK travel advice
 * update for Belgium". A title that is not a bare country name (long, or with punctuation that a country name never has) is left
 * alone so nothing odd is ever wrapped. Other sources are returned unchanged. */
export function shapeFeedItem(sourceKey: string, item: RawFeedItem): RawFeedItem {
  if (sourceKey !== 'uk-fcdo' || item.title.startsWith(UK_FCDO_TITLE_PREFIX)) return item
  if (!/^[A-Za-z][A-Za-z .,'()&-]{1,70}$/.test(item.title)) return item
  return { ...item, title: `${UK_FCDO_TITLE_PREFIX}${item.title.trim()}` }
}

export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf' | 'json' | 'unknown'
  items: RawFeedItem[]
  /** Items that had no usable title or link and were skipped. */
  skipped: number
  error?: string
}

// ---------------------------------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...' }

/** Decodes the five XML entities, a few common HTML ones and numeric references. Never fetches or expands anything. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' '
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m
  })
}

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]', 'g')

/** Plain one-line text from a feed field: CDATA unwrapped, entities decoded, HTML removed (including script and style
 * with their content), control and invisible characters removed, spaces collapsed, cut to `max`. */
export function cleanFeedText(raw: string, max: number): string {
  // Bounded work: a hostile field is cut BEFORE any scan, and every scan below is linear (indexOf) or runs on the cut text, so a
  // 1 MB feed full of unterminated tags cannot make the reader quadratic.
  let s = (raw.length > max * 12 + 1000 ? raw.slice(0, max * 12 + 1000) : raw).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
  s = decodeEntities(s)
  s = dropBlocks(dropBlocks(dropBlocks(s, 'script', '</script'), 'style', '</style'), '!--', '-->')
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ')
  s = decodeEntities(s)
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/[<>]/g, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}.` : s
}

/** Removes every `<open ... close ...>` block, case-insensitively, in one linear pass. An unterminated block drops the rest. */
function dropBlocks(s: string, open: string, close: string): string {
  const lower = s.toLowerCase()
  let out = ''
  let pos = 0
  for (;;) {
    const i = lower.indexOf(`<${open}`, pos)
    if (i < 0) break
    out += `${s.slice(pos, i)} `
    const j = lower.indexOf(close, i + 1)
    if (j < 0) return out
    const k = close.endsWith('>') ? j + close.length : lower.indexOf('>', j)
    pos = k < 0 ? s.length : close.endsWith('>') ? k : k + 1
  }
  return out + s.slice(pos)
}

/** Text that talks to a model instead of describing news. Such an item is not used at all. */
const INJECTION_PATTERNS = [
  /\bignore (all |any |the )?(previous|prior|above|earlier|preceding)\b/i,
  /\bdisregard (all |any |the )?(previous|prior|above|earlier|your)\b/i,
  /\b(system|developer) (prompt|message|instruction)s?\b/i,
  /\b(new|updated|override) instructions?\b/i,
  /\byou are (now |an? |the )?(ai|assistant|language model|chatbot|helpful)\b/i,
  /\bact as (an? |the )?/i,
  /\b(reveal|print|repeat|show) (your|the) (prompt|instructions|rules)\b/i,
  /<\|?(im_start|im_end|system|assistant)\|?>/i,
  /\b(assistant|system|human):\s/i,
  /\bdo not (follow|obey) (the |your )?(rules|instructions|guidelines)\b/i,
  /\b(jailbreak|prompt injection)\b/i,
]

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text))
}

// ---------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------

/** Removes the XML declaration, any DOCTYPE (and so every entity definition) and processing instructions. */
function stripPrologueBom(xml: string): string {
  return xml.replace(/^﻿/, '')
}

/** Linear (indexOf) removal of leading processing instructions and the DOCTYPE with every entity definition. */
function stripPrologue(input: string): string {
  let xml = stripPrologueBom(input)
  for (let n = 0; n < 5; n++) {
    const t = xml.trimStart()
    if (!t.startsWith('<?')) {
      xml = t
      break
    }
    const e = t.indexOf('?>')
    if (e < 0) return ''
    xml = t.slice(e + 2)
  }
  const d = xml.toLowerCase().indexOf('<!doctype')
  if (d >= 0) {
    const gt = xml.indexOf('>', d)
    const br = xml.indexOf('[', d)
    let end = gt
    if (br >= 0 && (gt < 0 || br < gt)) {
      const cb = xml.indexOf(']', br)
      end = cb < 0 ? -1 : xml.indexOf('>', cb)
    }
    if (end < 0) return ''
    xml = xml.slice(0, d) + xml.slice(end + 1)
  }
  return xml
}

/** The inner text of the first <name> element in a block (namespace prefix allowed), or ''. Case-insensitive. Linear: it walks
 * the block with indexOf and never uses a lazy regex over the whole block. */
function firstTag(block: string, name: string, lower: string = block.toLowerCase()): string {
  const openRe = new RegExp(`^(?:[a-z0-9]+:)?${name.toLowerCase()}(?=[\\s>/])`)
  const closeRe = new RegExp(`^(?:[a-z0-9]+:)?${name.toLowerCase()}\\s*>`)
  let from = 0
  for (;;) {
    const i = lower.indexOf('<', from)
    if (i < 0) return ''
    from = i + 1
    if (!openRe.test(lower.slice(i + 1, i + 1 + name.length + 24))) continue
    const e = lower.indexOf('>', i)
    if (e < 0) return ''
    if (lower[e - 1] === '/') continue
    let c = lower.indexOf('</', e)
    while (c >= 0) {
      if (closeRe.test(lower.slice(c + 2, c + 2 + name.length + 24))) return block.slice(e + 1, c)
      c = lower.indexOf('</', c + 2)
    }
    return ''
  }
}

/** Splits a feed into its <item> or <entry> blocks in one linear pass. A block with no closing tag ends the scan. */
function splitBlocks(xml: string, tag: string, limit: number): string[] {
  const lower = xml.toLowerCase()
  const out: string[] = []
  let pos = 0
  while (out.length < limit) {
    const i = lower.indexOf(`<${tag}`, pos)
    if (i < 0) break
    const next = lower[i + tag.length + 1]
    if (next !== '>' && next !== ' ' && next !== '\n' && next !== '\t' && next !== '\r') {
      pos = i + 1
      continue
    }
    const j = lower.indexOf(`</${tag}`, i)
    if (j < 0) break
    const end = lower.indexOf('>', j)
    if (end < 0) break
    if (end - i <= 60_000) out.push(xml.slice(i, end + 1))
    pos = end + 1
  }
  return out
}

/** The href of an Atom <link>, preferring rel="alternate" (or no rel), else the first one. */
function atomLink(block: string): string {
  const links: string[] = []
  const lower = block.toLowerCase()
  let pos = 0
  while (links.length < 20) {
    const i = lower.indexOf('<link', pos)
    if (i < 0) break
    const e = lower.indexOf('>', i)
    if (e < 0) break
    links.push(block.slice(i + 5, e).replace(/\/$/, ''))
    pos = e + 1
  }
  const attr = (s: string, a: string) => new RegExp(`\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(s)
  const pick = (s: string) => {
    const m = attr(s, 'href')
    return m ? (m[2] ?? m[3] ?? '') : ''
  }
  const alt = links.find((l) => {
    const rel = attr(l, 'rel')
    return !rel || (rel[2] ?? rel[3]) === 'alternate'
  })
  return pick(alt ?? links[0] ?? '')
}

function toIso(raw: string, now: number): string | null {
  const t = Date.parse(cleanFeedText(raw, 80))
  if (!Number.isFinite(t)) return null
  // A date in the future (more than a day ahead) is a wrong clock or a trick: treat as unknown.
  if (t > now + 86_400_000) return null
  if (t < Date.UTC(2000, 0, 1)) return null
  return new Date(t).toISOString()
}

/** Parses one feed document. Never throws. Items without a usable title and https link are skipped. */
export function parseFeed(xmlRaw: string, opts: { maxItems?: number; now?: number } = {}): ParsedFeed {
  const maxItems = opts.maxItems ?? MAX_ITEMS_PER_FEED
  const now = opts.now ?? Date.now()
  if (typeof xmlRaw !== 'string' || xmlRaw.length === 0) return { format: 'unknown', items: [], skipped: 0, error: 'the feed was empty' }
  if (xmlRaw.length > MAX_FEED_BYTES) return { format: 'unknown', items: [], skipped: 0, error: 'the feed was larger than the size limit' }
  try {
    const xml = stripPrologue(xmlRaw)
    const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml)
    const isRdf = /<(?:[a-z0-9]+:)?RDF[\s>]/i.test(xml)
    const isRss = /<rss[\s>]/i.test(xml) || /<channel[\s>]/i.test(xml)
    const format: ParsedFeed['format'] = isAtom ? 'atom' : isRdf ? 'rdf' : isRss ? 'rss' : 'unknown'
    if (format === 'unknown') return { format, items: [], skipped: 0, error: 'this is not an RSS or Atom feed' }
    // At most 3 x maxItems blocks are looked at, each at most 60 KB, so even a hostile 1 MB feed costs a bounded amount of work.
    const blocks = splitBlocks(xml, isAtom ? 'entry' : 'item', maxItems * 3)
    const items: RawFeedItem[] = []
    let skipped = 0
    for (const block of blocks) {
      if (items.length >= maxItems) break
      const lower = block.toLowerCase()
      const title = cleanFeedText(firstTag(block, 'title', lower), TITLE_MAX_CHARS)
      const link = (isAtom ? atomLink(block) : cleanFeedText(firstTag(block, 'link', lower), 600)).trim()
      // Only the short summary. content:encoded and atom <content> are the article body and are never read.
      const summary = cleanFeedText(firstTag(block, isAtom ? 'summary' : 'description', lower), SUMMARY_MAX_CHARS)
      const dateRaw = isAtom ? firstTag(block, 'published', lower) || firstTag(block, 'updated', lower) : firstTag(block, 'pubDate', lower) || firstTag(block, 'date', lower)
      const guidRaw = cleanFeedText(isAtom ? firstTag(block, 'id', lower) : firstTag(block, 'guid', lower), 400)
      if (!title || !/^https:\/\//i.test(link)) {
        skipped++
        continue
      }
      items.push({ guid: guidRaw || link, url: link.slice(0, 600), title, summary, publishedAt: toIso(dateRaw, now) })
    }
    return { format, items, skipped }
  } catch {
    return { format: 'unknown', items: [], skipped: 0, error: 'the feed could not be read' }
  }
}

// ---------------------------------------------------------------------------------------------------
// JSON advisory snapshot (Government of Canada open data)
// ---------------------------------------------------------------------------------------------------
// The file lists EVERY country. The exact shape was not available offline, so this reader looks for each field under a few
// likely names and never trusts the structure: an unknown shape is an error result (a Needs attention note after repeated
// failures), never an exception. Only the feed's own fields are used, every text goes through cleanFeedText, and a link is kept
// only when the feed itself gives an https address on travel.gc.ca (a path starting with "/" is read as a travel.gc.ca path).

/** More entries than this means the file is not the advisory list we know: it is not read. */
export const MAX_ADVISORY_ENTRIES = 600
export const ADVISORY_LINK_HOSTS = ['travel.gc.ca']

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The value at the first path that exists, where a path is dotted keys ("eng.advisory-text"). Only plain objects are walked. */
function pickPath(o: Json, ...paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = o
    for (const k of p.split('.')) {
      if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) {
        cur = undefined
        break
      }
      cur = cur[k]
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur
  }
  return undefined
}

/** Strings and finite numbers only; everything else (objects, arrays, booleans) is "no value". */
const scalarText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')

function advisoryDate(o: Json, now: number): { iso: string | null; raw: string } {
  const ts = pickPath(o, 'date-published.timestamp', 'date_published.timestamp', 'timestamp')
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts < 1e11 ? ts * 1000 : ts
    if (ms <= now + 86_400_000 && ms >= Date.UTC(2000, 0, 1)) return { iso: new Date(ms).toISOString(), raw: String(ts) }
  }
  const raw = scalarText(pickPath(o, 'date-published.date', 'date-published', 'date_published', 'updated', 'date', 'eng.friendly-date', 'friendly-date'))
  return { iso: raw ? toIso(raw, now) : null, raw: cleanFeedText(raw, 60) }
}

function advisoryLink(o: Json, hosts: string[]): string {
  const raw = cleanFeedText(scalarText(pickPath(o, 'url', 'eng.url', 'link', 'eng.link')), 600)
  if (!raw) {
    // The real feed gives no url, only eng.url-slug. A strictly shaped slug becomes the country page on travel.gc.ca; nothing else does.
    const slug = scalarText(pickPath(o, 'eng.url-slug', 'url-slug'))
    return /^[a-z0-9-]{2,60}$/.test(slug) ? `https://${hosts[0]}/destinations/${slug}` : ''
  }
  try {
    const u = new URL(raw.startsWith('/') && !raw.startsWith('//') ? `https://${hosts[0]}${raw}` : raw)
    if (u.protocol !== 'https:' || u.username || u.password) return ''
    const h = u.hostname.toLowerCase()
    return hosts.some((x) => h === x || h.endsWith(`.${x}`)) ? u.toString().slice(0, 600) : ''
  } catch {
    return ''
  }
}

/** Parses the Canadian advisory snapshot into one RawFeedItem per country (ALL of them: the caller keeps only what changed).
 * Never throws. A country with no name or no advisory text is skipped. Items without a travel.gc.ca link keep url '' and are
 * dropped later by the link check; if NO country has a link the whole file is reported as an unknown shape. */
export function parseAdvisoryJson(textRaw: string, opts: { now?: number; linkHosts?: string[] } = {}): ParsedFeed {
  const now = opts.now ?? Date.now()
  const hosts = opts.linkHosts ?? ADVISORY_LINK_HOSTS
  const fail = (error: string): ParsedFeed => ({ format: 'unknown', items: [], skipped: 0, error })
  if (typeof textRaw !== 'string' || textRaw.trim().length === 0) return fail('the advisory data was empty')
  if (textRaw.length > MAX_FEED_BYTES) return fail('the advisory data was larger than the size limit')
  const text = textRaw.replace(/^﻿/, '').trimStart()
  if (text[0] !== '{' && text[0] !== '[') return fail('this is not JSON (a web page or an error page was returned)')
  try {
    const root: unknown = JSON.parse(text)
    const data = isObj(root) && 'data' in root ? root.data : root
    const entries: unknown[] = Array.isArray(data) ? data : isObj(data) ? Object.values(data) : []
    if (entries.length === 0 || entries.length > MAX_ADVISORY_ENTRIES) return fail('the advisory data is not in the expected shape (a list of countries)')
    const items: RawFeedItem[] = []
    const seen = new Set<string>()
    let skipped = 0
    let linked = 0
    for (const e of entries) {
      if (!isObj(e)) {
        skipped++
        continue
      }
      const name = cleanFeedText(scalarText(pickPath(e, 'country-eng', 'eng.name', 'name', 'country')), 80)
      const advisory = cleanFeedText(scalarText(pickPath(e, 'advisory-text', 'eng.advisory-text', 'advisory_text', 'advisory.text', 'eng.advisory-state-text')), 160)
      const id = cleanFeedText(scalarText(pickPath(e, 'country-iso', 'country-id', 'iso', 'id')) || name, 40).toLowerCase()
      if (!name || !advisory || !id || seen.has(id)) {
        skipped++
        continue
      }
      seen.add(id)
      const date = advisoryDate(e, now)
      const url = advisoryLink(e, hosts)
      if (url) linked++
      const stateHash = createHash('sha1').update(`${advisory}\n${date.raw}`).digest('hex').slice(0, 12)
      items.push({
        guid: `gac:${id}:${stateHash}`,
        url,
        title: cleanFeedText(`Canada advisory for ${name}: ${advisory}`, TITLE_MAX_CHARS),
        summary: cleanFeedText(scalarText(pickPath(e, 'description', 'eng.description', 'summary', 'eng.summary', 'recent-updates', 'eng.recent-updates')), SUMMARY_MAX_CHARS),
        publishedAt: date.iso,
        stateKey: id,
        stateHash,
        stateName: name,
        stateLevel: advisory,
      })
    }
    if (items.length === 0) return fail('no country in the advisory data had a name and advisory text')
    if (linked === 0) return fail('no country in the advisory data gave a travel.gc.ca page address')
    return { format: 'json', items, skipped }
  } catch {
    return fail('the advisory data could not be read as JSON')
  }
}

// ---------------------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------------------

/** True when robots.txt allows `path` for us. The group naming us wins over "*"; the longest matching rule wins and
 * Allow wins a tie. Supports * and $ in rules. Pure. */
export function robotsAllows(robotsTxt: string, path: string, token: string = NEWS_ROBOTS_TOKEN): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = []
  let cur: (typeof groups)[number] | null = null
  let lastWasAgent = false
  for (const lineRaw of robotsTxt.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] }
        groups.push(cur)
      }
      cur.agents.push(value.toLowerCase())
      lastWasAgent = true
    } else if ((field === 'allow' || field === 'disallow') && cur) {
      lastWasAgent = false
      if (value) cur.rules.push({ allow: field === 'allow', pattern: value })
    } else lastWasAgent = false
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a.replace(/\/.*$/, ''))))
  const group = ours.length ? ours : groups.filter((g) => g.agents.includes('*'))
  const rules = group.flatMap((g) => g.rules)
  const toRe = (p: string) => {
    const anchored = p.endsWith('$')
    const src = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${src}${anchored ? '$' : ''}`)
  }
  let best: { len: number; allow: boolean } | null = null
  for (const r of rules) {
    let re: RegExp
    try {
      re = toRe(r.pattern)
    } catch {
      continue
    }
    if (!re.test(path)) continue
    const len = r.pattern.length
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow }
  }
  return best ? best.allow : true
}

// ---------------------------------------------------------------------------------------------------
// Per-source state (app_settings)
// ---------------------------------------------------------------------------------------------------

export interface FeedState {
  etag?: string
  lastModified?: string
  /** When a fetch was last started (set BEFORE the request, so a crash cannot cause a retry storm). */
  lastFetchAt?: string
  lastOkAt?: string
  /** Consecutive failed fetches. 3 raises a Needs attention item. */
  fails: number
  lastError?: string
  robotsAt?: string
  robotsAllowed?: boolean
}

export const FEED_STATE_PREFIX = 'news_feed_state:'
export { FEED_FAIL_LIMIT }
const ROBOTS_TTL_MS = 24 * 3_600_000

export async function readFeedState(admin: SupabaseClient, key: string): Promise<FeedState> {
  try {
    const parsed = JSON.parse((await getSetting(admin, `${FEED_STATE_PREFIX}${key}`)) ?? 'null') as Partial<FeedState> | null
    return { ...parsed, fails: Number(parsed?.fails) || 0 }
  } catch {
    return { fails: 0 }
  }
}

export async function writeFeedState(admin: SupabaseClient, key: string, state: FeedState): Promise<boolean> {
  const { error } = await setSetting(admin, `${FEED_STATE_PREFIX}${key}`, JSON.stringify(state))
  return !error
}

// ---------------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------------

export interface FetchDeps {
  fetch: typeof fetch
  now: () => number
}

export const realFetchDeps = (): FetchDeps => ({ fetch: (...a) => fetch(...a), now: () => Date.now() })

export type FetchOutcome =
  | { kind: 'ok'; text: string; etag?: string; lastModified?: string }
  | { kind: 'not-modified' }
  | { kind: 'error'; error: string }

async function readCapped(res: Response, cap: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) return null
  const reader = res.body?.getReader()
  if (!reader) {
    const t = await res.text()
    return t.length > cap ? null : t
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    merged.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

/** One guarded GET. Follows at most MAX_REDIRECTS redirects by hand, each staying inside the source's hosts over https. */
async function guardedGet(source: NewsSource, startUrl: string, headers: Record<string, string>, deps: FetchDeps, cap: number): Promise<{ res: Response; text: string | null } | { error: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    let url = startUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await deps.fetch(url, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': NEWS_USER_AGENT, ...headers } })
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get('location')
        if (!loc) return { error: `HTTP ${res.status} with no location` }
        let target: string
        try {
          target = new URL(loc, url).toString()
        } catch {
          return { error: 'a redirect pointed at an address that could not be read' }
        }
        if (!redirectAllowedFor(source, target)) return { error: 'the feed redirected somewhere that is not allowed' }
        if (hop === MAX_REDIRECTS) return { error: 'too many redirects' }
        url = target
        continue
      }
      if (res.status === 304) return { res, text: null }
      if (!res.ok) return { error: `HTTP ${res.status}` }
      const text = await readCapped(res, cap)
      if (text === null) return { error: 'the response was larger than the size limit' }
      return { res, text }
    }
    return { error: 'too many redirects' }
  } catch (e) {
    return { error: ctl.signal.aborted ? 'the request timed out' : `the request failed (${e instanceof Error ? e.message.slice(0, 80) : 'unknown'})` }
  } finally {
    clearTimeout(timer)
  }
}

/** Fetches one source's feed text. Checks, in order: the allowlist, https, robots.txt (cached a day), then a conditional
 * GET. Never fetches anything but the feed (and robots.txt on the same host). */
export async function fetchFeed(source: NewsSource, state: FeedState, deps: FetchDeps): Promise<FetchOutcome & { robots?: { at: string; allowed: boolean } }> {
  if (!source.enabled || !isAllowedFeedUrl(source.feedUrl)) return { kind: 'error', error: 'this feed is not on the allowlist' }

  // robots.txt: respected for the feed path. Cached for a day; an unreadable robots.txt means "try next time", not "go".
  let robots: { at: string; allowed: boolean } | undefined
  const robotsFresh = state.robotsAt && deps.now() - Date.parse(state.robotsAt) < ROBOTS_TTL_MS && typeof state.robotsAllowed === 'boolean'
  if (robotsFresh) {
    if (!state.robotsAllowed) return { kind: 'error', error: 'the publisher robots.txt does not allow this feed to be read' }
  } else {
    const feed = new URL(source.feedUrl)
    const r = await guardedGet(source, `${feed.origin}/robots.txt`, { Accept: 'text/plain' }, deps, MAX_ROBOTS_BYTES)
    let allowed: boolean
    if ('error' in r) {
      // 404 / 410: no robots.txt, nothing is disallowed. Any other problem: do not guess, try again next time.
      if (/^HTTP (404|410)$/.test(r.error)) allowed = true
      else return { kind: 'error', error: `could not read robots.txt (${r.error}), so the feed was not fetched` }
    } else allowed = robotsAllows(r.text ?? '', `${feed.pathname}${feed.search}`)
    robots = { at: new Date(deps.now()).toISOString(), allowed }
    if (!allowed) return { kind: 'error', error: 'the publisher robots.txt does not allow this feed to be read', robots }
  }

  const headers: Record<string, string> = { Accept: source.kind === 'json' ? 'application/json, text/json;q=0.9' : 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' }
  if (state.etag) headers['If-None-Match'] = state.etag
  if (state.lastModified) headers['If-Modified-Since'] = state.lastModified
  const r = await guardedGet(source, source.feedUrl, headers, deps, MAX_FEED_BYTES)
  if ('error' in r) return { kind: 'error', error: r.error, robots }
  if (r.res.status === 304) return { kind: 'not-modified', robots }
  const type = (r.res.headers.get('content-type') ?? '').toLowerCase()
  if (type.includes('html')) return { kind: 'error', error: 'the address returned a web page, not a feed', robots }
  return { kind: 'ok', text: r.text ?? '', etag: r.res.headers.get('etag') ?? undefined, lastModified: r.res.headers.get('last-modified') ?? undefined, robots }
}

/** True when this source may be fetched now (not within MIN_FETCH_INTERVAL_MS of the last attempt). */
export function fetchDue(state: FeedState, nowMs: number): boolean {
  if (!state.lastFetchAt) return true
  const last = Date.parse(state.lastFetchAt)
  return !Number.isFinite(last) || nowMs - last >= MIN_FETCH_INTERVAL_MS
}

/** Keeps an item only when its link is an https address on the source's own hosts. */
export function itemLinkOk(source: NewsSource, item: RawFeedItem): boolean {
  return linkAllowedFor(source, item.url)
}
