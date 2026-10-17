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
}

export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf' | 'unknown'
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
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  s = decodeEntities(s)
  s = s.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ')
  s = decodeEntities(s)
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}.` : s
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
function stripPrologue(xml: string): string {
  return xml.replace(/^﻿/, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/gi, '')
}

/** The inner text of the first <name> element in a block (namespace prefix allowed), or ''. Case-insensitive. */
function firstTag(block: string, name: string): string {
  const re = new RegExp(`<(?:[a-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}\\s*>`, 'i')
  const m = re.exec(block)
  return m ? m[1] : ''
}

/** The href of an Atom <link>, preferring rel="alternate" (or no rel), else the first one. */
function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1])
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
    const blocks = [...xml.matchAll(isAtom ? /<entry[\s>][\s\S]*?<\/entry\s*>/gi : /<item[\s>][\s\S]*?<\/item\s*>/gi)].map((m) => m[0])
    const items: RawFeedItem[] = []
    let skipped = 0
    for (const block of blocks) {
      if (items.length >= maxItems) break
      const title = cleanFeedText(firstTag(block, 'title'), TITLE_MAX_CHARS)
      const link = (isAtom ? atomLink(block) : cleanFeedText(firstTag(block, 'link'), 600)).trim()
      // Only the short summary. content:encoded and atom <content> are the article body and are never read.
      const summary = cleanFeedText(firstTag(block, isAtom ? 'summary' : 'description'), SUMMARY_MAX_CHARS)
      const dateRaw = isAtom ? firstTag(block, 'published') || firstTag(block, 'updated') : firstTag(block, 'pubDate') || firstTag(block, 'date')
      const guidRaw = cleanFeedText(isAtom ? firstTag(block, 'id') : firstTag(block, 'guid'), 400)
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
export const FEED_FAIL_LIMIT = 3
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

  const headers: Record<string, string> = { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' }
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
