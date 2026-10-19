import { goPath, isValidSlug } from '@/lib/affiliate-go'

// WP22: the display-time word linker. A rule says "when the site writes this phrase, link it to this affiliate link".
// Nothing stored is ever rewritten: the pages call linkKeywords() on the text they are about to show, so a change to a
// link (new URL, turned OFF) or to a rule shows on the next render with no rescan. The anchor always points at our own
// short route /go/<slug> (tracked, and an edited URL changes where it lands without touching any page), never at the
// merchant, and it never contains the phrase inside an attribute.
//
// Pure: no database, no network, no React. Fully covered by scripts/check-affiliate-linker.ts.

export type LinkScope = 'all' | 'guides' | 'blog' | 'destinations'
export const LINK_SCOPES: readonly LinkScope[] = ['all', 'guides', 'blog', 'destinations']
/** What kind of page is being rendered. 'trips' is a trip (package) page; 'pages' is every other public page (best-time and
 * compare copy, home, who we are, the index pages). Only a rule whose scope is "all" applies on 'trips' and 'pages'. */
export type PageContext = 'guides' | 'destinations' | 'blog' | 'trips' | 'pages'
export const PAGE_CONTEXTS: readonly PageContext[] = ['guides', 'destinations', 'blog', 'trips', 'pages']

export const MIN_PHRASE_LENGTH = 2
export const MAX_PHRASE_LENGTH = 80
export const MAX_RULES = 200
export const MAX_LINKS_PER_PAGE = 6
export const MAX_PER_PHRASE = 3
/** Longer input is returned untouched (a hostile or broken document cannot slow a page down). */
export const MAX_INPUT_LENGTH = 300_000
/** Linking one page may take at most this long (milliseconds). After that the rest of the page is left unlinked. */
export const LINK_BUDGET_MS = 50
/** Text is matched in pieces of about this many characters, so the time budget is checked often enough to matter. */
const CHUNK = 2000

/** A rule that is ready to use: its keyword is ON and the link it points at is ON. */
export interface AffiliateRule {
  id: string
  phrase: string
  /** The short-link slug of the ON link. */
  slug: string
  scope: LinkScope
  /** 1 to 3. */
  max_per_page: number
}

export const isLinkScope = (v: unknown): v is LinkScope => typeof v === 'string' && (LINK_SCOPES as readonly string[]).includes(v)

/** Does a rule with this scope apply on this kind of page? "guides" covers guide pages and destination pages. Trip pages
 * and the other public pages ('trips', 'pages') take only rules with scope "all". */
export function scopeMatches(scope: LinkScope, ctx: PageContext): boolean {
  if (scope === 'all') return true
  if (scope === 'blog') return ctx === 'blog'
  if (scope === 'destinations') return ctx === 'destinations'
  return ctx === 'guides' || ctx === 'destinations'
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A phrase as it will be stored and matched: spaces collapsed, 2 to 80 characters, no angle brackets, no control
 * characters. Returns null when it is not acceptable. */
export function cleanPhrase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.replace(/\s+/g, ' ').trim()
  if (t.length < MIN_PHRASE_LENGTH || t.length > MAX_PHRASE_LENGTH) return null
  if (/[<>]/.test(t) || CONTROL.test(t)) return null
  if (tooManyWords(t) || mostlyRepeated(t)) return null
  if (!hasWord(t)) return null
  return t
}
/** A phrase made only of spaces, hyphens and apostrophes has no word to find. */
const hasWord = (t: string): boolean => t.split(WORD_SPLIT).some((w) => w.split(APOSTROPHES).some(Boolean))

/** A phrase of more than 8 words is not a phrase a writer repeats; it only slows matching down. */
export const MAX_PHRASE_WORDS = 8
const tooManyWords = (t: string) => t.split(' ').length > MAX_PHRASE_WORDS
/** "a a a a b": three or more words of which fewer than half are different. Such phrases make the matcher do far more work. */
function mostlyRepeated(t: string): boolean {
  const words = t.toLowerCase().split(' ')
  return words.length >= 3 && new Set(words).size * 2 < words.length
}

/** Why a phrase is not acceptable, in plain English (for the admin). Null when it is fine. */
export function phraseProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Type the word or phrase to link.'
  const t = raw.replace(/\s+/g, ' ').trim()
  if (t.length < MIN_PHRASE_LENGTH) return `The phrase is too short (at least ${MIN_PHRASE_LENGTH} characters).`
  if (t.length > MAX_PHRASE_LENGTH) return `The phrase is too long (${MAX_PHRASE_LENGTH} characters at most).`
  if (/[<>]/.test(t)) return 'The phrase cannot contain the < or > characters.'
  if (CONTROL.test(t)) return 'The phrase cannot contain line breaks or control characters.'
  if (tooManyWords(t)) return `The phrase has too many words (${MAX_PHRASE_WORDS} at most).`
  if (mostlyRepeated(t)) return 'The phrase repeats the same words too much. Use a normal phrase.'
  if (!hasWord(t)) return 'The phrase needs at least one word.'
  return null
}

// How a phrase is matched (the same on the pages and in the admin Preview, because both use this file):
//  - upper and lower case do not matter;
//  - whole words only (a letter, digit or underscore may not touch either end of the match);
//  - between two words of the phrase, any run of spaces, line breaks, non-breaking spaces, hyphens, en dashes and
//    apostrophes matches, so "croatia tours" also finds "Croatia-tours", "Croatia  tours" and "Croatia&nbsp;tours";
//  - an apostrophe INSIDE a word of the phrase is optional ("children's tours" finds "childrens tours" too);
//  - the LAST word may carry a plural ending: the phrase as typed, plus an optional "s" or "es" ("croatia tour" also finds
//    "Croatia tours"; "bus" also finds "buses"). Nothing else is guessed: no other word forms, no synonyms.
const SEPARATORS = "\\s\\u00a0\\u2010-\\u2013\\-'\\u2018\\u2019\\u02bc\\u00b4`"
const SEPARATOR_RUN = `[${SEPARATORS}]+`
// The words of a phrase are split at spaces, hyphens and dashes. An apostrophe stays INSIDE its word (and is optional there).
const WORD_SPLIT = new RegExp('[\\s\\u00a0\\u2010-\\u2013\\-]+', 'u')
const APOSTROPHES = new RegExp("['\\u2018\\u2019\\u02bc\\u00b4`]", 'u')
const INNER_APOSTROPHE = `(?:['\\u2018\\u2019\\u02bc\\u00b4\`]|[\\s\\u00a0\\u2010-\\u2013\\-])?`
const KEY_STRIP = new RegExp(`[${SEPARATORS}]+`, 'gu')

/** The comparison key of a phrase or of the text found on a page: lower case with every separator and apostrophe removed.
 * "Croatia tours", "croatia-tours" and "Croatia (no-break space) tours" all have the key "croatiatours". */
export const phraseKey = (phrase: string): string => phrase.toLowerCase().replace(KEY_STRIP, '')

const BEFORE = '(?<![\\p{L}\\p{N}_])'
const AFTER = '(?![\\p{L}\\p{N}_])'
const escapeRegex =(s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** The regex source for one phrase (see the matching rules above). */
function phraseSource(phrase: string): string {
  const words = phrase.split(WORD_SPLIT).map((w) => w.split(APOSTROPHES).filter(Boolean)).filter((pieces) => pieces.length > 0)
  return words
    .map((pieces, i) => {
      const body = pieces.map(escapeRegex).join(INNER_APOSTROPHE)
      return i === words.length - 1 ? `${body}(?:e?s)?` : body
    })
    .join(SEPARATOR_RUN)
}

/** Which rule a piece of matched text belongs to: its own key, else the key without a plural "s" or "es". */
function ruleOfMatch(byKey: Map<string, CompiledRule>, matched: string): CompiledRule | undefined {
  const k = phraseKey(matched)
  return byKey.get(k) ?? (k.endsWith('s') ? byKey.get(k.slice(0, -1)) : undefined) ?? (k.endsWith('es') ? byKey.get(k.slice(0, -2)) : undefined)
}

const ENTITY_CHARS: Record<string, string> = {
  nbsp: String.fromCharCode(0xa0), ndash: String.fromCharCode(0x2013), hyphen: String.fromCharCode(0x2010), apos: "'", rsquo: String.fromCharCode(0x2019), lsquo: String.fromCharCode(0x2018),
}
/** Turns the few entities that only mean "a space, a dash or an apostrophe" into their characters, so a phrase can match
 * across them. Every other entity (&amp;, &lt; ...) is left alone. */
export function normalizeSeparatorEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(?:(nbsp|ndash|hyphen|apos|rsquo|lsquo)|#(\d{1,5})|#[xX]([0-9a-fA-F]{1,4}));/g, (whole, name?: string, dec?: string, hex?: string) => {
    if (name) return ENTITY_CHARS[name]
    const code = dec !== undefined ? Number(dec) : parseInt(hex as string, 16)
    return code === 160 || code === 39 || code === 45 || (code >= 0x2010 && code <= 0x2013) || code === 0x2018 || code === 0x2019 || code === 0x2bc || code === 0xb4
      ? String.fromCharCode(code)
      : whole
  })
}
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export interface CompiledRule {
  rule: AffiliateRule
  key: string
  max: number
  /** The phrase as a regex source (spaces become any run of whitespace). */
  source: string
  /** Built the first time a longer rule has used up its allowance and this one is tried in its place. */
  sticky?: RegExp
}

export interface CompiledRules {
  /** ONE combined case-insensitive regex, longest phrase first; null when there is nothing to match. */
  re: RegExp | null
  byKey: Map<string, CompiledRule>
  /** The same rules, longest phrase first. */
  list: CompiledRule[]
  size: number
}

export const EMPTY_COMPILED: CompiledRules = { re: null, byKey: new Map(), list: [], size: 0 }

const compiledCache = new WeakMap<AffiliateRule[], Map<PageContext, CompiledRules>>()

/** Turns the rules that apply on this kind of page into one regex. Invalid rules (bad phrase, bad slug, wrong scope)
 * are dropped, a repeated phrase keeps its first rule, and at most 200 rules are used. */
export function compileRules(rules: AffiliateRule[] | null | undefined, ctx: PageContext): CompiledRules {
  if (!rules || rules.length === 0) return EMPTY_COMPILED
  const cached = compiledCache.get(rules)?.get(ctx)
  if (cached) return cached
  const byKey = new Map<string, CompiledRule>()
  for (const rule of rules) {
    if (byKey.size >= MAX_RULES) break
    if (!rule || !isLinkScope(rule.scope) || !scopeMatches(rule.scope, ctx) || !isValidSlug(rule.slug)) continue
    const phrase = cleanPhrase(rule.phrase)
    if (!phrase) continue
    const key = phraseKey(phrase)
    if (byKey.has(key)) continue
    const max = Math.min(MAX_PER_PHRASE, Math.max(1, Math.trunc(Number(rule.max_per_page)) || 1))
    byKey.set(key, { rule: { ...rule, phrase }, key, max, source: phraseSource(phrase) })
  }
  let out: CompiledRules = EMPTY_COMPILED
  if (byKey.size > 0) {
    const list = [...byKey.values()].sort((a, b) => b.rule.phrase.length - a.rule.phrase.length || (a.key < b.key ? -1 : 1))
    // Whole words only: the characters either side of the match may not be a letter, a digit or an underscore.
    out = { re: new RegExp(`${BEFORE}(?:${list.map((c) => c.source).join('|')})${AFTER}`, 'giu'), byKey, list, size: byKey.size }
  }
  const perCtx = compiledCache.get(rules) ?? new Map<PageContext, CompiledRules>()
  perCtx.set(ctx, out)
  compiledCache.set(rules, perCtx)
  return out
}

export interface LinkedItem {
  ruleId: string
  slug: string
  /** The text as it was written on the page (original casing). */
  text: string
  key: string
}

/** Counts for one page. Share one state across every text field of a page (body first, then FAQ) so the limits apply
 * to the page as a whole and document order wins. */
export interface LinkerState {
  total: number
  perKey: Map<string, number>
  linked: LinkedItem[]
  /** Time budget for this page: starts at the first piece of text, in milliseconds. */
  budgetMs: number
  budgetEnd: number | null
  /** True when the budget ran out and part of the page was left unlinked. */
  truncated: boolean
}

export const newLinkerState = (budgetMs: number = LINK_BUDGET_MS): LinkerState => ({ total: 0, perKey: new Map(), linked: [], budgetMs, budgetEnd: null, truncated: false })

/** One piece of linked text: plain text, or a phrase to turn into a link. */
export type Part = string | { text: string; slug: string; ruleId: string }

export interface LinkOptions {
  context: PageContext
  /** 'html' (default): the input is HTML. 'text': plain text, output is escaped HTML. 'markdown': output is markdown. */
  format?: 'html' | 'text' | 'markdown'
  state?: LinkerState
  /** Page-wide limit on automatic links. Default 6; never more than 6. */
  pageCap?: number
  /** Time budget in milliseconds for a new state (default 50). Ignored when `state` is passed in. */
  budgetMs?: number
}

export interface LinkResult {
  output: string
  /** Links added by THIS call. */
  count: number
  state: LinkerState
}

// ---------- the core: link inside one run of plain text ----------

/** Is there still time? The clock starts at the first piece of text of the page. Once it runs out, nothing more is linked. */
function timeLeft(state: LinkerState): boolean {
  const now = Date.now()
  if (state.budgetEnd === null) state.budgetEnd = now + state.budgetMs
  if (now > state.budgetEnd) {
    state.truncated = true
    return false
  }
  return true
}

/** The text of rule `alt` starting exactly at `index`, if it is there as a whole word. */
function matchRuleAt(alt: CompiledRule, text: string, index: number): string | null {
  alt.sticky ??= new RegExp(`${BEFORE}(?:${alt.source})${AFTER}`, 'iuy')
  alt.sticky.lastIndex = index
  const m = alt.sticky.exec(text)
  return m ? m[0] : null
}

/** Links inside one run of plain text, in pieces of about 2000 characters with the time budget checked between pieces. */
function linkPlain(text: string, c: CompiledRules, state: LinkerState, cap: number, out: Part[]): void {
  if (text.length <= CHUNK) {
    linkChunk(text, c, state, cap, out)
    return
  }
  let from = 0
  while (from < text.length) {
    let to = Math.min(text.length, from + CHUNK)
    if (to < text.length) {
      const space = text.lastIndexOf(' ', to)
      if (space > from + CHUNK / 2) to = space + 1
    }
    linkChunk(text.slice(from, to), c, state, cap, out)
    from = to
  }
}

function linkChunk(text: string, c: CompiledRules, state: LinkerState, cap: number, out: Part[]): void {
  const re = c.re
  if (!re || state.total >= cap || text.length < MIN_PHRASE_LENGTH || !timeLeft(state)) {
    out.push(text)
    return
  }
  re.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (state.total >= cap) break
    let hit = ruleOfMatch(c.byKey, m[0])
    let matched = m[0]
    if (!hit) continue
    if ((state.perKey.get(hit.key) ?? 0) >= hit.max) {
      // The longest rule here has used up its allowance: let a shorter rule that starts at the same place take it.
      const longer = hit
      hit = undefined
      for (const alt of c.list) {
        if (alt === longer || alt.rule.phrase.length >= longer.rule.phrase.length) continue
        if ((state.perKey.get(alt.key) ?? 0) >= alt.max) continue
        const found = matchRuleAt(alt, text, m.index)
        if (found && found.length < matched.length) {
          hit = alt
          matched = found
          break
        }
      }
      if (!hit) continue
      re.lastIndex = m.index + matched.length
    }
    const used = state.perKey.get(hit.key) ?? 0
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push({ text: matched, slug: hit.rule.slug, ruleId: hit.rule.id })
    state.perKey.set(hit.key, used + 1)
    state.total += 1
    state.linked.push({ ruleId: hit.rule.id, slug: hit.rule.slug, text: matched, key: hit.key })
    last = m.index + matched.length
  }
  re.lastIndex = 0
  if (last < text.length) out.push(text.slice(last))
}

const anchor = (slug: string, innerHtml: string) =>
  `<a href="${escapeHtml(goPath(slug))}" target="_blank" rel="sponsored nofollow noopener" data-affiliate-auto>${innerHtml}</a>`

function cap(opts: LinkOptions, state: LinkerState): number {
  void state
  const wanted = Number.isFinite(opts.pageCap) ? Math.trunc(opts.pageCap as number) : MAX_LINKS_PER_PAGE
  return Math.max(0, Math.min(MAX_LINKS_PER_PAGE, wanted))
}

/** Plain text in, parts out (React renders the strings escaped and the links as anchors). Never throws. */
export function linkTextParts(text: string, rules: AffiliateRule[] | CompiledRules | null | undefined, opts: LinkOptions): { parts: Part[]; count: number; state: LinkerState } {
  const state = opts.state ?? newLinkerState(opts.budgetMs)
  const before = state.total
  try {
    const c = Array.isArray(rules) || rules == null ? compileRules(rules as AffiliateRule[] | null, opts.context) : rules
    if (typeof text !== 'string' || !c.re || text.length > MAX_INPUT_LENGTH) return { parts: [text], count: 0, state }
    const parts: Part[] = []
    linkPlain(text, c, state, cap(opts, state), parts)
    return { parts, count: state.total - before, state }
  } catch {
    return { parts: [text], count: 0, state }
  }
}

// ---------- HTML ----------

// Elements whose text is never linked. Headings, existing links, buttons, code, form fields, FAQ question headings
// (summary), scripts (JSON-LD), styles, and anything that is not running body text.
const SKIP = new Set([
  'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'code', 'pre', 'kbd', 'samp', 'script', 'style', 'textarea', 'select', 'option', 'optgroup',
  'label', 'summary', 'svg', 'math', 'noscript', 'iframe', 'template', 'title', 'head', 'object', 'video', 'audio', 'canvas', 'figcaption',
])
SKIP.add('xmp')
SKIP.add('plaintext')
SKIP.add('noembed')
SKIP.add('noframes')
// Raw-text elements: what is inside is not markup, so it is skipped to the matching close tag without looking for tags.
// "plaintext" never ends (the rest of the document is its text).
const OPAQUE = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'plaintext', 'iframe'])
const closeTagRe = new Map<string, RegExp>()
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const HEADING = /^h[1-6]$/

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9:-]*/y
const ENTITY_SPLIT = /(&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});)/

/** Where a piece of text sits: null when it may be linked, else why it may not. */
export type Zone = 'link' | 'heading' | 'summary' | 'other'

function zoneOf(stack: string[]): Zone | null {
  if (stack.length === 0) return null
  if (stack.includes('a')) return 'link'
  if (stack.some((t) => HEADING.test(t))) return 'heading'
  if (stack.includes('summary')) return 'summary'
  return 'other'
}

/** Calls fn for every text node (text between tags) with the zone it is in, and rebuilds the HTML from what fn
 * returns (null keeps the text as it was). Tags, comments and attributes are copied byte for byte. */
export function mapHtmlText(html: string, fn: (text: string, zone: Zone | null) => string | null): string {
  const out: string[] = []
  const stack: string[] = []
  let last = 0
  const flushText = (end: number) => {
    if (end > last) {
      const text = html.slice(last, end)
      const replaced = fn(text, zoneOf(stack))
      out.push(replaced ?? text)
    }
  }
  // A single left-to-right pass: every character is looked at a bounded number of times, so a hostile document (a million
  // "<a " with no ">", a quote that never closes) cannot make this slow. A tag that never ends stops the scan and the rest
  // of the document is copied as it is, never linked (fail safe).
  let i = 0
  let lt: number
  let aborted = false
  while ((lt = html.indexOf('<', i)) !== -1) {
    const next = html.charCodeAt(lt + 1)
    const isLetter = (next >= 65 && next <= 90) || (next >= 97 && next <= 122)
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end === -1) {
        aborted = true
        break
      }
      flushText(lt)
      out.push(html.slice(lt, end + 3))
      last = i = end + 3
      continue
    }
    if (!isLetter && next !== 47 /* / */ && next !== 33 /* ! */ && next !== 63 /* ? */) {
      i = lt + 1 // a "<" in the text
      continue
    }
    let j = lt + 1
    const closing = next === 47
    if (closing) j++
    let name = ''
    if (next === 33 || next === 63) {
      j = lt + 2
    } else {
      TAG_NAME.lastIndex = j
      const nm = TAG_NAME.exec(html)
      if (!nm) {
        i = lt + 1 // "</" or "<" followed by something that is not a tag name: plain text
        continue
      }
      name = nm[0].toLowerCase()
      j += nm[0].length
    }
    const attrsStart = j
    let quote = 0
    for (; j < html.length; j++) {
      const c = html.charCodeAt(j)
      if (quote) {
        if (c === quote) quote = 0
      } else if (c === 34 || c === 39) quote = c
      else if (c === 62) break
    }
    if (j >= html.length) {
      aborted = true // never closed: stop here, the rest stays as written
      break
    }
    flushText(lt)
    out.push(html.slice(lt, j + 1))
    last = i = j + 1
    if (!name) continue // <!DOCTYPE ...> or <? ... >
    if (closing) {
      const at = stack.lastIndexOf(name)
      if (at >= 0) stack.length = at
    } else if (SKIP.has(name) && !VOID.has(name)) {
      // A "self-closing" slash on a non-void element (<a/>, <h2/>, <script/>) does nothing in HTML: the element is open.
      void attrsStart
      stack.push(name)
      if (OPAQUE.has(name)) {
        // Copy everything up to the matching close tag untouched; its content is never text.
        let re = closeTagRe.get(name)
        if (!re) closeTagRe.set(name, (re = new RegExp(`</${name}(?=[\\s/>])`, 'gi')))
        re.lastIndex = j + 1
        const close = name === 'plaintext' ? null : re.exec(html)
        if (!close) {
          out.push(html.slice(j + 1))
          last = html.length
          aborted = true
          break
        }
        out.push(html.slice(j + 1, close.index))
        last = i = close.index
      }
    }
  }
  const tail = html.slice(last)
  if (tail) out.push(aborted ? tail : (fn(tail, zoneOf(stack)) ?? tail))
  return out.join('')
}

/** Splits one text node into entity references and plain pieces; fn sees only plain pieces. */
function mapPlainPieces(text: string, fn: (plain: string) => string): string {
  return text
    .split(ENTITY_SPLIT)
    .map((piece, i) => (i % 2 === 1 || piece === '' ? piece : fn(piece)))
    .join('')
}

function partsToHtml(parts: Part[], raw: boolean): string {
  return parts.map((p) => (typeof p === 'string' ? (raw ? p : escapeHtml(p)) : anchor(p.slug, raw ? p.text : escapeHtml(p.text)))).join('')
}

function linkHtml(html: string, c: CompiledRules, state: LinkerState, capN: number): string {
  return mapHtmlText(html, (text, zone) => {
    if (zone !== null || state.total >= capN || !/[\p{L}\p{N}]/u.test(text)) return null
    const before = state.total
    const out = mapPlainPieces(normalizeSeparatorEntities(text), (plain) => {
      const parts: Part[] = []
      linkPlain(plain, c, state, capN, parts)
      // The text of an HTML text node is already escaped markup, so it goes back out as it came in.
      return partsToHtml(parts, true)
    })
    // A text node with no link in it is left exactly as written (&nbsp; stays &nbsp;).
    return state.total === before ? null : out
  })
}

// ---------- finding (for the usage report and the preview; nothing is rendered) ----------

export interface FoundMatch {
  key: string
  /** The text as written on the page. */
  text: string
  before: string
  after: string
  /** null: the linker could link this one. Otherwise why it would not (inside a link, a heading, a FAQ question, other). */
  zone: Zone | null
}

const SNIPPET_SIDE = 50

/** Every place a compiled phrase appears in this HTML, with a little text each side, in document order. Ignores the page
 * limits (so it counts what the site WRITES, not what it links). At most `limit` matches. Never throws. */
export function findMatches(html: string, rules: AffiliateRule[] | CompiledRules | null | undefined, context: PageContext, limit = 2000): FoundMatch[] {
  const found: FoundMatch[] = []
  try {
    const c = Array.isArray(rules) || rules == null ? compileRules(rules as AffiliateRule[] | null, context) : rules
    const re = c.re
    if (!re || typeof html !== 'string' || html.length > MAX_INPUT_LENGTH) return found
    mapHtmlText(html, (text, zone) => {
      if (found.length >= limit || !/[\p{L}\p{N}]/u.test(text)) return null
      mapPlainPieces(normalizeSeparatorEntities(text), (plain) => {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(plain)) !== null && found.length < limit) {
          const hit = ruleOfMatch(c.byKey, m[0])
          if (!hit) continue
          found.push({
            key: hit.key,
            text: m[0],
            before: plain.slice(Math.max(0, m.index - SNIPPET_SIDE), m.index),
            after: plain.slice(m.index + m[0].length, m.index + m[0].length + SNIPPET_SIDE),
            zone,
          })
        }
        re.lastIndex = 0
        return plain
      })
      return null
    })
  } catch {
    return found
  }
  return found
}

// ---------- markdown ----------

const MD_PROTECTED = /(`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|https?:\/\/\S+)/

function linkMarkdown(md: string, c: CompiledRules, state: LinkerState, capN: number): string {
  let fenced = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced || /^\s{0,3}#{1,6}(\s|$)/.test(line) || /^( {4}|\t)/.test(line) || /^\s*\[[^\]]+\]:\s/.test(line) || state.total >= capN) return line
      return line
        .split(MD_PROTECTED)
        .map((piece, i) => {
          if (i % 2 === 1 || piece === '') return piece
          const parts: Part[] = []
          linkPlain(piece, c, state, capN, parts)
          return parts.map((p) => (typeof p === 'string' ? p : /[[\]()`]/.test(p.text) ? p.text : `[${p.text}](${goPath(p.slug)})`)).join('')
        })
        .join('')
    })
    .join('\n')
}

/** Links the first allowed occurrences of every rule's phrase in this text. HTML is the normal case (the output of the
 * markdown renderer). The input string is never changed; a new string is returned. Never throws: any failure returns the
 * input unchanged (no links), and input over 1 MB is returned unchanged. */
export function linkKeywords(input: string, rules: AffiliateRule[] | CompiledRules | null | undefined, opts: LinkOptions): LinkResult {
  const state = opts.state ?? newLinkerState(opts.budgetMs)
  const format = opts.format ?? 'html'
  const before = state.total
  const fallback = (): LinkResult => ({ output: format === 'text' ? escapeHtml(String(input ?? '')) : String(input ?? ''), count: 0, state })
  try {
    if (typeof input !== 'string') return fallback()
    const c = Array.isArray(rules) || rules == null ? compileRules(rules as AffiliateRule[] | null, opts.context) : rules
    if (!c.re || input.length > MAX_INPUT_LENGTH) return fallback()
    const capN = cap(opts, state)
    let output: string
    if (format === 'text') {
      const parts: Part[] = []
      linkPlain(input, c, state, capN, parts)
      output = partsToHtml(parts, false)
    } else if (format === 'markdown') {
      output = linkMarkdown(input, c, state, capN)
    } else {
      output = linkHtml(input, c, state, capN)
    }
    return { output, count: state.total - before, state }
  } catch {
    // Roll back a half-finished pass so the page limits stay honest.
    state.total = before
    return fallback()
  }
}

// ---------- a whole page ----------

export interface LinkedPage {
  bodyHtml: string
  /** One entry per FAQ answer, in order. */
  faq: Part[][]
  count: number
  linked: LinkedItem[]
}

/** Body first, then the FAQ answers, sharing one state so the per-phrase and 6-per-page limits cover the whole page. */
export function linkPage(input: { bodyHtml: string; faqAnswers: string[] }, rules: AffiliateRule[] | null | undefined, context: PageContext): LinkedPage {
  const state = newLinkerState()
  const compiled = compileRules(rules, context)
  const body = linkKeywords(input.bodyHtml, compiled, { context, state })
  const faq = input.faqAnswers.map((a) => linkTextParts(a, compiled, { context, state }).parts)
  return { bodyHtml: body.output, faq, count: state.total, linked: state.linked }
}
