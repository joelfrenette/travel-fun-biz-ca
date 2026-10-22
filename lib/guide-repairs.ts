import { agencyClaims, clamp, guideBlockers, SUPERLATIVE_PATTERNS, RECENCY_PATTERNS, COUNT_CLAIM, SCHEDULE_PATTERN, WORD_NUMBER_PATTERNS, type GateContext, type ComposedGuide } from '@/lib/guide-composer'
import {
  bodySentences,
  cloneFields,
  deterministicFix,
  makeDetectCtx,
  replaceUnit,
  sentenceProblems,
  detectOffenders,
  sameFields,
  type DetectCtx,
  type Offender,
  type RepairFields,
  type RepairLimits,
  type Tracker,
} from '@/lib/content-repair'
import { deleteParagraph } from '@/lib/heal-loop'
import { guideKinds, SAFE_PAGE_NOTE, isSafePageNote, type GuideKind } from '@/lib/guides'

// Growth loop "heal-relax": plain-code repairs for guides (no model call, nothing added that is not already stored) and a last-resort
// "safe page" built only from stored facts. Both are used by the heal loop (lib/heal-loop.ts) through the optional hooks on a
// HealTarget (see healComposedGuide in lib/heal-targets.ts).
//
// What these functions may do:
//   - delete a sentence, soften a heading by dropping the flagged word, or swap an agency "what we offer / arrange" sentence for ONE
//     fixed approved line (APPROVED_CTA below);
//   - put the stored subject name into the first sentence;
//   - assemble a page from fixed, general planning text plus the stored name, kind, parent and package links.
// What they may never do: state a fact (a number, a price, a date, a feature, a name) that is not in the stored brief.
// The safe page is checked against the real gate before it is offered; a page that does not pass is never returned.

/** The one approved neutral call to action. No phone number in the text: the guide gate counts digits that are not in the facts, and
 * the page already shows the phone in its own call-to-action block. The link is the contact form that every brief offers. */
export const APPROVED_CTA_LINKED = 'We can help you plan this trip. Send us a note through [the contact form](/#contact) and we can talk through your options.'
/** The same line with no link, for FAQ answers and takeaways (the gate forbids links there). */
export const APPROVED_CTA_PLAIN = 'We can help you plan this trip, so reach out and we can talk through your options.'
export const APPROVED_CTA_SHORT = 'Our team can help you plan this trip.'

/** The note a published safe page carries in quality_notes, so a later enrichment pass can find it and improve it. */
export { SAFE_PAGE_NOTE, isSafePageNote }

export interface GuideRepairCfg {
  kind: GuideKind
  name: string
  /** The facts the writer was given (the grounding text). */
  grounding: string
  /** Names allowed besides the grounding (parent, link labels). */
  names: string[]
  links: { path: string; label: string }[]
  limits: RepairLimits
}

// ---------------------------------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------------------------------

const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const plainOf =(s: string) => s.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1').replace(/[*_`]/g, '')
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '')
const isHeadingLine = (s: string) => /^\s*#{1,6}\s/.test(s)

/** The approved CTA for body text. Always the linked form: "/#contact" is the home page to the gate ("/" is on every brief's allowed
 * list), and a guide needs at least one internal link anyway. `links` is accepted so a future brief-specific link is one change. */
export function approvedCta(links: { path: string }[]): string {
  void links
  return APPROVED_CTA_LINKED
}

function offenderOf(field: Offender['field'], s: { text: string; prefix: string }, why: string, index?: number): Offender {
  return { field, index, text: s.text, why, prefix: s.prefix }
}

// ---------------------------------------------------------------------------------------------------
// (i) the opening paragraph names the subject
// ---------------------------------------------------------------------------------------------------

const SUBJECT_NOUN = '(?:destination|place|island|city|town|village|country|region|area|spot|archipelago|resort|hotel|property|ship|vessel|cruise line|cruise|line|river cruise|yacht|yacht cruise)'

export function namesSubject(summary: string, name: string): boolean {
  return normName(summary).includes(normName(name))
}

/** Rewrites or prepends the first sentence so it names the subject exactly as stored. Uses only the existing first sentence's words
 * plus the stored name and kind; never a new fact. Returns the summary unchanged when it already names the subject. Pure. */
export function nameInOpening(summary: string, name: string, kind: GuideKind): string {
  if (namesSubject(summary, name)) return summary
  const text = summary.trim()
  if (!text) return `This ${guideKinds[kind].guideLabel.toLowerCase()} is about ${name}.`
  const m = /^(.+?[.!?])(\s+[\s\S]*)?$/.exec(text)
  const first = m ? m[1] : text
  const rest = m && m[2] ? m[2] : ''
  // "It is a ..." / "This island is a ...": the name takes the subject's place. Only when the subject is the thing itself ("It", or a
  // demonstrative plus a word for the thing). "The beaches are ..." or "The capital is ..." is about something else and is left alone.
  const subject = new RegExp(`^(?:It|(?:This|That|The)(?:\\s+[\\p{L}'’-]+){0,2}?\\s+${SUBJECT_NOUN})\\s+(is|was)\\s+([\\s\\S]+)$`, 'iu').exec(first)
  if (subject) return `${name} ${subject[1].toLowerCase()} ${subject[2]}${rest}`.trim()
  return `This ${guideKinds[kind].guideLabel.toLowerCase()} is about ${name}. ${text}`
}

// ---------------------------------------------------------------------------------------------------
// (ii) agency sentences about what the agency offers, arranges or works with
// ---------------------------------------------------------------------------------------------------

const AGENCY_SUBJ = '(?:we|our team|our advisors|our agents|our hosts|our company|our staff)'
const SELL_VERB =
  '(?:offer(?:s|ed|ing)?|arrange[sd]?|arranging|work(?:s|ed|ing)? with|put(?:s|ting)? together|organi[sz]e[sd]?|currently|specialis(?:e|es|ed)|specializ(?:e|es|ed)|provide[sd]?|curate[sd]?|sells?|handles?|runs?|hosts?|hosted|have|has|carry|carries|features?|includes?|lists?)'
/** "we offer", "our team works with", "the trips we arrange", "what we currently offer": the agency saying what it sells or does. An
 * offer of help ("we can help you plan") is not matched, because "can" sits between the subject and the verb. */
const AGENCY_SELLING = new RegExp(`\\b${AGENCY_SUBJ}\\b(?:(?!\\b(?:can|could|may|might|will help)\\b)[^.!?]){0,45}?\\b${SELL_VERB}\\b`, 'i')

/** Is this sentence an agency claim to the gate, or an "offer / arrange / work with" sentence the independent reviewer refuses? Pure. */
export function isAgencySelling(sentence: string): boolean {
  return agencyClaims(sentence).length > 0 || AGENCY_SELLING.test(plainOf(sentence))
}

/** A sentence that limits, denies or discloses ("we do not provide refunds", "we are not responsible for", "we earn a commission", "we
 * are registered with ..."). It matches the "what we offer" wording but is not a sales claim, and it may matter legally, so the plain-code
 * repair never swaps it for the help line and never deletes it on its own. Pure. */
const PROTECTED_SENTENCE =
  /\b(?:not|never|no|cannot|without|neither|nor|except)\b|n['’]t\b|\b(?:responsible|liable|liability|guarantee[sd]?|warrant(?:y|ies)?|registered|licen[cs]e[sd]?|insur(?:ance|ed)|refunds?|terms|conditions|disclaimers?|disclos\w*|commissions?|affiliates?|compensat\w*|paid|fees?|cancell?ations?|regulat\w*|TICO|FSA|CIRA)\b/i
export function isProtectedSentence(sentence: string): boolean {
  return PROTECTED_SENTENCE.test(plainOf(sentence))
}

/** A flagged agency sentence the plain-code repair may change: selling wording and not a protected (limiting or legal) sentence. */
const repairableAgency = (sentence: string) => isAgencySelling(sentence) && !isProtectedSentence(sentence)

function sentenceCountOfBlock(text: string, needle: string): number {
  for (const block of text.split(/\n\s*\n/)) if (block.includes(needle)) return bodySentences(block).filter((s) => !s.heading).length
  return 0
}

/** Removes a whole section (its heading and everything under it) that holds `needle`, when the page keeps at least `minSections`. */
function deleteSectionHolding(f: RepairFields, needle: string, minSections: number): RepairFields | null {
  const chunks = f.body.split(/^(?=##\s)/m).filter((c) => c.length)
  const sections = chunks.filter((c) => /^##\s/.test(c))
  if (sections.length - 1 < minSections) return null
  const at = chunks.findIndex((c) => /^##\s/.test(c) && c.includes(needle))
  if (at === -1) return null
  const next = cloneFields(f)
  next.body = chunks.filter((_c, i) => i !== at).join('')
  return next
}

/** Deletes the flagged sentence where the existing rules allow it, then more loosely: the sentence may be the only one in its
 * paragraph when the section keeps other text, or the whole section goes when the page keeps six or more. A FAQ pair or a
 * takeaway is dropped (the caller tops the list up). Null when nothing is allowed. Never rewords. */
export function looseDelete(f: RepairFields, o: Offender, limits: RepairLimits, cfg?: Pick<GuideRepairCfg, 'kind' | 'name' | 'limits'>): RepairFields | null {
  if (o.field === 'body') {
    if (isHeadingLine(o.text)) return null
    const strict = deterministicFixNoCtx(f, o, limits)
    if (strict) return strict
    const viaParagraph = deleteParagraph(f, o)
    if (viaParagraph) return viaParagraph
    if (sentenceCountOfBlock(f.body, o.text) >= 2) {
      const n = replaceUnit(f, o, null)
      return n === f ? null : n
    }
    return deleteSectionHolding(f, o.text, 6)
  }
  if (o.field === 'summary') {
    if (bodySentences(f.summary ?? '').filter((s) => !s.heading).length < 2) return null
    const n = replaceUnit(f, o, null)
    return n === f ? null : n
  }
  if (o.field === 'faq_q' || o.field === 'faq_a' || o.field === 'takeaway') {
    const n = replaceUnit(f, o, null)
    return n === f ? null : cfg ? topUpLists(n, cfg) : n
  }
  return null
}

// deterministicFix wants a DetectCtx; looseDelete only needs its deletion half, so a throw-away context is enough (trimClause needs one).
function deterministicFixNoCtx(f: RepairFields, o: Offender, limits: RepairLimits): RepairFields | null {
  return deterministicFix(f, o, makeDetectCtx('guide', '', []), limits)
}

/** Replaces each agency-selling sentence with the approved CTA the first time, and removes later ones (or replaces them when they
 * cannot be removed). The opening paragraph never gets a CTA: a flagged sentence there is removed. Pure. */
export function fixAgencySentences(f: RepairFields, cfg: GuideRepairCfg, t: Tracker): RepairFields {
  let cur = f
  const cta = approvedCta(cfg.links)
  const ctaUsed = () => cur.body.includes(APPROVED_CTA_LINKED) || cur.body.includes(APPROVED_CTA_PLAIN)
  const touched = new Set<string>()
  // body and summary
  for (let guard = 0; guard < 30; guard++) {
    let progressed = false
    for (const field of ['summary', 'body'] as const) {
      const text = cur[field]
      if (!text) continue
      for (const s of bodySentences(text)) {
        if (s.heading || !repairableAgency(s.text)) continue
        const o = offenderOf(field, s, 'says what the agency offers, arranges or does')
        let next: RepairFields | null = null
        if (field === 'summary') next = looseDelete(cur, o, cfg.limits, cfg)
        else if (ctaUsed()) next = looseDelete(cur, o, cfg.limits, cfg)
        if (!next && field === 'body') next = replaceUnit(cur, o, cta)
        if (next && next !== cur && !sameFields(next, cur)) {
          touched.add(field)
          cur = next
          progressed = true
        }
        break
      }
      if (progressed) break
    }
    if (!progressed) break
  }
  if (touched.size) t.touch('body', 'fixer', 'replaced a sentence about what the agency offers or arranges with the approved help line (or removed it)')
  // FAQ answers, FAQ questions, takeaways
  const faq = cur.faq.map((p) => ({ ...p }))
  let faqChanged = false
  for (let i = faq.length - 1; i >= 0; i--) {
    if (repairableAgency(faq[i].q)) {
      faq.splice(i, 1)
      faqChanged = true
    } else if (repairableAgency(faq[i].a)) {
      faq[i].a = APPROVED_CTA_PLAIN
      faqChanged = true
    }
  }
  if (faqChanged) {
    cur = { ...cur, faq }
    t.touch('faq', 'fixer', 'replaced an answer about what the agency offers with the approved help line (or dropped it)')
  }
  const take = cur.key_takeaways.filter((x) => !repairableAgency(x))
  if (take.length !== cur.key_takeaways.length) {
    cur = { ...cur, key_takeaways: take }
    t.touch('key_takeaways', 'delete', 'removed a takeaway about what the agency offers')
  }
  return cur
}

// ---------------------------------------------------------------------------------------------------
// Headings, meta text and short lists
// ---------------------------------------------------------------------------------------------------

function flaggedPatterns(): RegExp[] {
  const out: RegExp[] = [...SUPERLATIVE_PATTERNS.map(([p]) => p), ...RECENCY_PATTERNS, COUNT_CLAIM, SCHEDULE_PATTERN, ...WORD_NUMBER_PATTERNS]
  return out.map((p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`))
}

/** A heading with the flagged word taken out ("The best beaches" becomes "The beaches"), or null when that leaves too little. Pure. */
export function softenHeadingText(heading: string, ctx: DetectCtx): string | null {
  let text = heading
  for (let i = 0; i < 4 && sentenceProblems(text, ctx).length; i++) {
    let changed = false
    for (const re of flaggedPatterns()) {
      re.lastIndex = 0
      if (re.test(text)) {
        re.lastIndex = 0
        text = text.replace(re, ' ')
        changed = true
        break
      }
    }
    text = text.replace(/\b\d[\d,.]*\b/g, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([:,;.)])/g, '$1').trim()
    if (!changed) break
  }
  text = text.replace(/\s{2,}/g, ' ').replace(/^[\s:,;-]+|[\s:,;-]+$/g, '').trim()
  if (text.split(/\s+/).filter(Boolean).length < 2 || sentenceProblems(text, ctx).length) return null
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function softenHeadings(f: RepairFields, cfg: GuideRepairCfg, ctx: DetectCtx, t: Tracker): RepairFields {
  let body = f.body
  let changed = false
  const used = new Set(body.split('\n').filter((l) => /^##\s/.test(l)).map((l) => l.toLowerCase()))
  body = body
    .split('\n')
    .map((line) => {
      const m = /^(#{2,6})\s+(.*)$/.exec(line)
      if (!m || !sentenceProblems(m[2], ctx).length) return line
      changed = true
      const softened = softenHeadingText(m[2], ctx)
      if (softened) return `${m[1]} ${softened}`
      const generic = !used.has('## good to know') ? 'Good to know' : `More about ${cfg.name}`
      used.add(`## ${generic.toLowerCase()}`)
      return `${m[1]} ${generic}`
    })
    .join('\n')
  if (!changed) return f
  t.touch('body', 'fixer', 'took a superlative, count or similar word out of a heading')
  return { ...f, body }
}

function plainMeta(cfg: GuideRepairCfg) {
  const info = guideKinds[cfg.kind]
  return { title: clamp(`${cfg.name}: ${info.guideLabel}`, 60), desc: clamp(`A plain-English introduction to ${cfg.name} with practical points for planning a trip.`, 155), ogDesc: clamp(`An introduction to ${cfg.name} and how to plan a trip.`, 110) }
}

/** A meta or share field that is empty or still has a problem is rebuilt from the stored name and kind only. */
function rebuildMeta(f: RepairFields, cfg: GuideRepairCfg, ctx: DetectCtx, t: Tracker): RepairFields {
  const m = plainMeta(cfg)
  const bad = (s: string) => !s.trim() || sentenceProblems(s, ctx, true).length > 0 || LONG_DASH.test(s)
  const next = { ...f }
  const done: string[] = []
  if (bad(f.meta_title)) { next.meta_title = m.title; done.push('meta title') }
  if (bad(f.meta_description)) { next.meta_description = m.desc; done.push('meta description') }
  if (bad(f.og_title)) { next.og_title = clamp(m.title, cfg.limits.ogTitleMax); done.push('share title') }
  if (bad(f.og_description)) { next.og_description = m.ogDesc; done.push('share description') }
  if (!done.length) return f
  t.touch('meta_title', 'fixer', `rebuilt the ${done.join(', ')} from the stored name`)
  for (const k of ['meta_title', 'meta_description', 'og_title', 'og_description'] as const) if (next[k] !== f[k]) t.touch(k, 'fixer', 'rebuilt from the stored name')
  return next
}

/** Fills a FAQ or takeaway list that dropped below its minimum from the general pool (fixed text, only the stored name added). Pure. */
export function topUpLists(f: RepairFields, cfg: Pick<GuideRepairCfg, 'kind' | 'name' | 'limits'>): RepairFields {
  const pool = safePool(cfg.kind, cfg.name)
  let next = f
  if (f.faq.length < cfg.limits.faqMin) {
    const have = new Set(f.faq.map((p) => p.q.toLowerCase()))
    const add = pool.faq.filter((p) => !have.has(p.q.toLowerCase()))
    next = { ...next, faq: [...f.faq, ...add].slice(0, cfg.limits.faqMax).map((p) => ({ ...p })) }
    if (next.faq.length < cfg.limits.faqMin) next = f
  }
  if (next.key_takeaways.length < cfg.limits.takeMin) {
    const have = new Set(next.key_takeaways.map((x) => x.toLowerCase()))
    const add = pool.takeaways.filter((x) => !have.has(x.toLowerCase()))
    next = { ...next, key_takeaways: [...next.key_takeaways, ...add].slice(0, cfg.limits.takeMax) }
  }
  return next
}

// ---------------------------------------------------------------------------------------------------
// The hook the heal loop calls before any model call
// ---------------------------------------------------------------------------------------------------

/** Plain-code repairs for a guide, in order: agency sentences, headings, the opening names the subject, meta text, short lists.
 * No model call. Returns the same object when nothing applied. The gate decides afterwards whether the page is clean. */
export function repairGuideFields(f: RepairFields, cfg: GuideRepairCfg, blockers: string[], t: Tracker): RepairFields {
  const ctx = makeDetectCtx('guide', cfg.grounding, [...cfg.names, cfg.name])
  let cur = f
  cur = fixAgencySentences(cur, cfg, t)
  cur = softenHeadings(cur, cfg, ctx, t)
  if (cur.summary !== undefined && !namesSubject(cur.summary, cfg.name)) {
    const summary = nameInOpening(cur.summary, cfg.name, cfg.kind)
    if (summary !== cur.summary) {
      t.touch('body', 'fixer', 'put the subject name into the first sentence of the opening paragraph')
      cur = { ...cur, summary }
    }
  }
  if (blockers.some((b) => /missing meta|^meta|^OG|^social/.test(b)) || [cur.meta_title, cur.meta_description, cur.og_title, cur.og_description].some((s) => !s.trim())) cur = rebuildMeta(cur, cfg, ctx, t)
  if (blockers.some((b) => /^(missing FAQ|missing key takeaways|\d+ FAQ|\d+ key takeaways)/.test(b))) {
    const topped = topUpLists(cur, cfg)
    if (!sameFields(topped, cur)) {
      if (topped.faq.length !== cur.faq.length) t.touch('faq', 'generate', 'topped up the FAQ with general planning questions')
      if (topped.key_takeaways.length !== cur.key_takeaways.length) t.touch('key_takeaways', 'generate', 'topped up the takeaways with general planning points')
      cur = topped
    }
  }
  return sameFields(cur, f) ? f : cur
}

/** A guide's offenders for the loose delete in the strip rung; also catches sentences the generic detector misses (agency "arrange"). */
export function guideOffenders(f: RepairFields, cfg: GuideRepairCfg, blockers: string[]): Offender[] {
  const ctx = makeDetectCtx('guide', cfg.grounding, [...cfg.names, cfg.name])
  const out = detectOffenders(f, ctx, blockers)
  for (const field of ['summary', 'body'] as const) {
    const text = f[field]
    if (!text) continue
    for (const s of bodySentences(text)) if (!s.heading && repairableAgency(s.text) && !out.some((o) => o.field === field && o.text === s.text)) out.push(offenderOf(field, s, 'says what the agency offers, arranges or does'))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// The safe page
// ---------------------------------------------------------------------------------------------------

const TYPE_PHRASE: Record<GuideKind, { type: string; article: string; going: string; note: string }> = {
  destinations: {
    type: 'destination',
    article: 'a destination',
    going: 'a trip',
    note: 'A destination is more than its main sights. Where you base yourself, how you move around and which season you choose can change the trip as much as the places you visit, so think about those choices early.',
  },
  hotels: {
    type: 'hotel',
    article: 'a hotel',
    going: 'a stay',
    note: 'A hotel stay is shaped by the location, the room type and the facilities that matter to you. Think about whether you want to be close to restaurants and transport or somewhere quieter, and ask about the room options for your group.',
  },
  resorts: {
    type: 'resort',
    article: 'a resort',
    going: 'a stay',
    note: 'A resort often bundles accommodation, meals and activities, so it helps to ask exactly what is included and what is charged separately. Think about whether you want everything in one place or the freedom to explore beyond the grounds.',
  },
  'cruise-lines': {
    type: 'cruise line',
    article: 'a cruise line',
    going: 'a cruise',
    note: 'A cruise line shapes the atmosphere on board, from the style of the dining to the kind of entertainment and the mix of passengers. Ask which ships and itineraries suit your group, and what the cabin choices look like.',
  },
  ships: {
    type: 'ship',
    article: 'a ship',
    going: 'a cruise',
    note: 'On a ship, the cabin type, the dining arrangements and the ports of call all shape the experience. Ask about each of them, and about how much time you will have ashore at each stop.',
  },
  'river-cruises': {
    type: 'river cruise',
    article: 'a river cruise',
    going: 'a river cruise',
    note: 'A river cruise is usually a calmer way to travel than an ocean voyage, with the scenery changing along the banks. Ask about the cabin choices, the excursions and how the days are usually organised.',
  },
  yachts: {
    type: 'yacht cruise',
    article: 'a yacht cruise',
    going: 'a yacht cruise',
    note: 'A yacht cruise tends to feel more intimate than a large ship, so the details matter: the cabin layout, the dining arrangements and how flexible the route is. Ask about each of them, and about what is included.',
  },
}

/** The general FAQ and takeaway text, with only the stored name and kind filled in. Exposed so a list that dropped below its
 * minimum can be topped up. */
export function safePool(kind: GuideKind, name: string): { faq: { q: string; a: string }[]; takeaways: string[] } {
  const p = TYPE_PHRASE[kind]
  return {
    faq: [
      { q: `What is ${name}?`, a: `${name} is ${p.article}. This page is a short introduction built from the details on file, so check specifics with the provider before you book.` },
      { q: `How do I plan ${p.going} with ${name}?`, a: 'Start with your dates, your budget range and the people travelling. Then compare what is included, ask about cancellation rules and write down the answers before you pay.' },
      { q: `What should I ask before booking ${name}?`, a: 'Ask what is included in the price, what costs extra, how changes and cancellations work and what support is available if plans change.' },
      { q: `Can a travel advisor help with ${name}?`, a: 'An advisor can talk through your options and help you compare choices. You can reach out through the contact form to start the conversation.' },
      { q: `Is this page the final word on ${name}?`, a: 'No. It is a general starting point. Details change, so confirm current information with the provider and official sources.' },
    ],
    takeaways: [
      `${name} is ${p.article}; this page is a general planning guide.`,
      'Agree dates, budget and style before anyone pays a deposit.',
      'Ask what is included, what costs extra and how changes work.',
      'Confirm current details with the provider before you book.',
      'A travel advisor can help you talk through your options.',
    ],
  }
}

export interface SafePageInput {
  kind: GuideKind
  name: string
  /** The stored parent (a resort's destination, a ship's cruise line), when known. */
  parentName: string | null
  links: { path: string; label: string }[]
  limits: RepairLimits
}

/** The parent name in a grounding text from groundingText(): the "Related place or company" line. */
export function parentFromGrounding(grounding: string): string | null {
  const m = /^Related place or company: (.+)$/m.exec(grounding)
  return m ? m[1].trim() : null
}

/** Assembles a minimal page ONLY from stored facts and fixed general planning text. Passes the guide gate by construction and is
 * verified against the gate before it is returned (null when it does not pass, so the caller falls back to rejecting). */
export function buildSafePage(input: SafePageInput, gateCtx: GateContext): RepairFields | null {
  const fields = assembleSafePage(input, gateCtx)
  // Verified, not assumed: the page is offered only if the real gate is clean on it.
  const info = guideKinds[input.kind]
  const asGuide = fieldsToGuide(fields, input.name, info.guideLabel, `${input.name} ${info.guideLabel.toLowerCase()}`)
  return guideBlockers(asGuide, gateCtx).length === 0 ? fields : null
}

/** The safe page's fields before the gate has looked at them. Exposed for the offline check, which asserts the gate result itself. */
export function assembleSafePage(input: SafePageInput, gateCtx: GateContext): RepairFields {
  const { kind, name } = input
  const p = TYPE_PHRASE[kind]
  const N = name
  const cta = approvedCta(input.links)

  const about: string[] = [
    `${N} is ${p.article}, and this guide treats it that way: as one option to weigh up when you plan ${p.going}. Before you decide, it helps to know what you want from the trip, who is travelling and how much time you can set aside. Those three answers shape almost every other choice, from the time of year to the kind of room or cabin you ask for.`,
    'This page stays general on purpose. Details such as opening dates, facilities and fees change, so check them directly with the provider before you book. If something here does not match what you are told later, trust the provider\'s current information and use this page only as a planning checklist.',
    p.note,
  ]
  if (input.parentName) about.splice(1, 0, `${N} is linked on this site with ${input.parentName}.`)
  // Real trips on this site that involve it: the link text is the stored trip name.
  const trips = input.links.filter((l) => l.path.startsWith('/packages/')).slice(0, 2)
  const ctx = makeDetectCtx('guide', gateCtx.grounding, [...(gateCtx.names ?? []), name])
  for (const l of trips) {
    const label = l.label.replace(/[[\]]/g, '').trim()
    if (label && !sentenceProblems(`Related: ${label}.`, ctx).length) about.push(`Related: [${label}](${l.path}).`)
  }

  const sections: { heading: string; paras: string[] }[] = [
    { heading: `About ${N}`, paras: about },
    {
      heading: `Who ${N} may suit`,
      paras: [
        `Different travellers want different things from ${p.article}. Some want a relaxed pace with plenty of free time. Others want a full schedule of things to do, or a base that makes it easy to explore nearby. Think about the people in your group: their ages, their energy levels, any mobility needs and what each person hopes to enjoy.`,
        'If you are travelling with friends or family, talk through the mix before you look at options. A group that agrees on the pace in advance usually has a smoother trip. If you are travelling on your own, consider whether you would like organised time with others or mostly your own company, and look for a setup that supports that choice.',
      ],
    },
    {
      heading: 'Questions to ask before you book',
      paras: [
        `Good questions save trouble later. Ask what is included in the price and what costs extra. Ask about cancellation and change rules, and what happens if plans shift. Ask how payments work and when they are due. Ask about any health, safety or documentation requirements that apply to ${p.going}.`,
        `Write the answers down and keep them with your booking. When two options look similar, the clearer answers often point to the better-organised provider. If an answer is vague, ask again in writing. A reliable provider will be happy to explain the details of ${N} in plain language.`,
      ],
    },
    {
      heading: 'Planning a group trip',
      paras: [
        'A group trip goes more smoothly when one person coordinates and everyone agrees on a few basics early. Settle the dates, the budget range and the style of trip before anyone pays a deposit. Share the plan in writing so nobody is surprised. Decide how you will handle shared costs and who will keep the booking details.',
        `Allow time for people to arrange leave from work, passports and any medical needs. Ask whether the group can sit together, dine together or share transfers, because these small points affect how the trip feels. Build in some free time as well, so people can rest or follow their own interests during ${p.going}.`,
      ],
    },
    {
      heading: 'Making the most of your time',
      paras: [
        'Decide which experiences matter most to your group and build the days around them, leaving gaps so the pace stays comfortable. A packed schedule can feel exciting on paper and exhausting in practice. Ask the provider what can be booked ahead and what is easy to arrange on the day.',
        'Read independent reviews for a balanced picture, and remember that individual opinions vary. Look for details that repeat across several reviews, such as comments about service, cleanliness or organisation, rather than relying on a single story.',
      ],
    },
    {
      heading: 'Getting ready to travel',
      paras: [
        'Check that every passport is valid for the whole trip, and look up entry rules well ahead of time. Rules can change, so confirm them close to departure with an official government source. Ask your doctor about health advice, and read your insurance policy so you know what it covers.',
        'Pack for the kind of trip you have chosen. Comfortable shoes, sun protection and a small first-aid kit are useful on most journeys. Keep copies of key documents separate from the originals, and carry medication in your carry-on bag. Leave a copy of your plans with someone at home.',
      ],
    },
    {
      heading: 'Choosing the time of year',
      paras: [
        `The season you travel in changes the experience of ${p.article}. Busy periods often mean higher prices and more crowds, while quieter periods may offer more space and lower costs. Weather, school holidays and local events all play a part, so check what applies to ${N} before you fix your dates.`,
        'If you are flexible, compare a few possible windows and ask the provider what each one is like. If you are not, plan around the dates you have and adjust your expectations to match. Either way, it is wise to keep some flexibility in your plans for weather or small changes.',
      ],
    },
    {
      heading: 'Budget and what to compare',
      paras: [
        'Set a total budget before you compare options, and include everything: travel to and from the departure point, transfers, meals, activities, tips, insurance and spending money. A low headline price can hide extras, and a higher price can include more than it first appears. Compare like with like.',
        `When you compare ${N} with other choices, line up the same points side by side: what is included, how flexible the booking is, and what support you can reach if something goes wrong. Value is the match between what you pay and what you actually use, not simply the lowest figure.`,
      ],
    },
    {
      heading: 'Staying safe and well',
      paras: [
        'Travel is safer and more enjoyable with a few simple habits. Keep valuables out of sight, use the safe if one is provided, and be careful with passports and cards. Drink plenty of water, protect yourself from the sun and take breaks when you are tired. Know how to reach local emergency services and your insurer.',
        'Share your plans with someone at home, and keep your phone charged. If you have a medical condition, carry a note describing it and your medication, and ask the provider in advance about any support you may need. Small preparations like these help a trip go smoothly for everyone in the group.',
      ],
    },
    {
      heading: 'How to get help planning',
      paras: [
        `Planning ${p.going} can feel like a lot, and you do not have to do it alone. A travel advisor can listen to what you want, explain the choices and talk through the next steps with you. Bring your questions, your rough dates and your budget range, and you will get more from the conversation.`,
        cta,
      ],
    },
  ]

  const summary = `${N} is ${p.article}. This page is a short, plain-English introduction built only from the details on file, with practical points for planning ${p.going}. It may be expanded as more checked information becomes available.`
  const body = sections.map((s) => `## ${s.heading}\n\n${s.paras.join('\n\n')}`).join('\n\n')
  const pool = safePool(kind, name)
  const meta = plainMeta({ kind, name, grounding: gateCtx.grounding, names: gateCtx.names ?? [], links: input.links, limits: input.limits })
  return {
    summary,
    body,
    meta_title: meta.title,
    meta_description: meta.desc,
    og_title: clamp(meta.title, input.limits.ogTitleMax),
    og_description: meta.ogDesc,
    faq: pool.faq.slice(0, input.limits.faqMax),
    key_takeaways: pool.takeaways.slice(0, input.limits.takeMax),
  }
}

/** Fields as a ComposedGuide, for running the gate over them. */
export function fieldsToGuide(f: RepairFields, name: string, guideLabel: string, primaryKeyword: string): ComposedGuide {
  const parts = f.body.split(/^(?=##\s)/m).filter((c) => /^##\s/.test(c))
  return {
    name,
    summary: f.summary ?? '',
    body: f.body,
    sections: parts.map((c) => {
      const m = /^##\s+(.+)\n?([\s\S]*)$/.exec(c.trim())
      return { heading: m ? m[1].trim() : '', body: m ? m[2].trim() : '' }
    }),
    faq: f.faq,
    key_takeaways: f.key_takeaways,
    meta_title: f.meta_title,
    meta_description: f.meta_description,
    og_title: f.og_title,
    og_description: f.og_description,
    primary_keyword: primaryKeyword || `${name} ${guideLabel.toLowerCase()}`,
    secondary_keywords: [],
    hero_query: '',
  }
}
