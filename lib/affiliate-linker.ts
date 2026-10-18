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
/** What kind of page is being rendered. */
export type PageContext = 'guides' | 'destinations' | 'blog'

export const MIN_PHRASE_LENGTH = 2
export const MAX_PHRASE_LENGTH = 80
export const MAX_RULES = 200
export const MAX_LINKS_PER_PAGE = 6
export const MAX_PER_PHRASE = 3
/** Longer input is returned untouched (a hostile or broken document cannot slow a page down). */
export const MAX_INPUT_LENGTH = 1_000_000

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

/** Does a rule with this scope apply on this kind of page? "guides" covers guide pages and destination pages. */
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
  return t
}

/** Why a phrase is not acceptable, in plain English (for the admin). Null when it is fine. */
export function phraseProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Type the word or phrase to link.'
  const t = raw.replace(/\s+/g, ' ').trim()
  if (t.length < MIN_PHRASE_LENGTH) return `The phrase is too short (at least ${MIN_PHRASE_LENGTH} characters).`
  if (t.length > MAX_PHRASE_LENGTH) return `The phrase is too long (${MAX_PHRASE_LENGTH} characters at most).`
  if (/[<>]/.test(t)) return 'The phrase cannot contain the < or > characters.'
  if (CONTROL.test(t)) return 'The phrase cannot contain line breaks or control characters.'
  return null
}

export const phraseKey = (phrase: string): string => phrase.replace(/\s+/g, ' ').trim().toLowerCase()

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export interface CompiledRule {
  rule: AffiliateRule
  key: string
  max: number
}

export interface CompiledRules {
  /** ONE combined case-insensitive regex, longest phrase first; null when there is nothing to match. */
  re: RegExp | null
  byKey: Map<string, CompiledRule>
  size: number
}

export const EMPTY_COMPILED: CompiledRules = { re: null, byKey: new Map(), size: 0 }

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
    byKey.set(key, { rule: { ...rule, phrase }, key, max })
  }
  let out: CompiledRules = EMPTY_COMPILED
  if (byKey.size > 0) {
    const alts = [...byKey.values()]
      .sort((a, b) => b.rule.phrase.length - a.rule.phrase.length || (a.key < b.key ? -1 : 1))
      .map((c) => c.rule.phrase.split(' ').map(escapeRegex).join('\\s+'))
    // Whole words only: the characters either side of the match may not be a letter, a digit or an underscore.
    out = { re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join('|')})(?![\\p{L}\\p{N}_])`, 'giu'), byKey, size: byKey.size }
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
}

export const newLinkerState = (): LinkerState => ({ total: 0, perKey: new Map(), linked: [] })

/** One piece of linked text: plain text, or a phrase to turn into a link. */
export type Part = string | { text: string; slug: string; ruleId: string }

export interface LinkOptions {
  context: PageContext
  /** 'html' (default): the input is HTML. 'text': plain text, output is escaped HTML. 'markdown': output is markdown. */
  format?: 'html' | 'text' | 'markdown'
  state?: LinkerState
  /** Page-wide limit on automatic links. Default 6; never more than 6. */
  pageCap?: number
}

export interface LinkResult {
  output: string
  /** Links added by THIS call. */
  count: number
  state: LinkerState
}

// ---------- the core: link inside one run of plain text ----------

function linkPlain(text: string, c: CompiledRules, state: LinkerState, cap: number, out: Part[]): void {
  const re = c.re
  if (!re || state.total >= cap || text.length < MIN_PHRASE_LENGTH) {
    out.push(text)
    return
  }
  re.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (state.total >= cap) break
    const hit = c.byKey.get(phraseKey(m[0]))
    if (!hit) continue
    const used = state.perKey.get(hit.key) ?? 0
    if (used >= hit.max) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push({ text: m[0], slug: hit.rule.slug, ruleId: hit.rule.id })
    state.perKey.set(hit.key, used + 1)
    state.total += 1
    state.linked.push({ ruleId: hit.rule.id, slug: hit.rule.slug, text: m[0], key: hit.key })
    last = m.index + m[0].length
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
  const state = opts.state ?? newLinkerState()
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
    } else if (SKIP.has(name) && !VOID.has(name) && !/\/\s*$/.test(html.slice(attrsStart, j))) {
      stack.push(name)
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
    return mapPlainPieces(text, (plain) => {
      const parts: Part[] = []
      linkPlain(plain, c, state, capN, parts)
      // The text of an HTML text node is already escaped markup, so it goes back out as it came in.
      return partsToHtml(parts, true)
    })
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
      mapPlainPieces(text, (plain) => {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(plain)) !== null && found.length < limit) {
          const hit = c.byKey.get(phraseKey(m[0]))
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
  const state = opts.state ?? newLinkerState()
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
