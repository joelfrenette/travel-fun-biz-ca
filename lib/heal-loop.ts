import type { SupabaseClient } from '@supabase/supabase-js'
import { isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { POST_EXPERIENCE_CLAIM_PATTERNS } from '@/lib/blog-composer'
import { EXPERIENCE_CLAIM_PATTERNS, removeDashes } from '@/lib/guide-composer'
import { editsLoggable, insertEdits, repairDay } from '@/lib/content-edits'
import {
  applyFixers,
  blockerKinds,
  bodySentences,
  buildEdits,
  callModelText,
  cloneFields,
  detectOffenders,
  deterministicFix,
  generateExtras,
  internalLinksOfText,
  isNamedPersonLike,
  isPriceOrDate,
  logicalOf,
  makeDetectCtx,
  MAX_REPAIR_SENTENCES,
  MIN_MS_PER_CALL,
  missingExtras,
  plainForPrompt,
  replaceUnit,
  sameFields,
  sentenceProblems,
  Tracker,
  validateRewrite,
  type ContentEdit,
  type ContentType,
  type DetectCtx,
  type EditMethod,
  type ModelCall,
  type Offender,
  type OffenderField,
  type RepairFields,
  type RepairItem,
} from '@/lib/content-repair'

// Growth loop WP19: self-healing loops, never hold for a person.
//
// One loop for every kind of page (blog drafts, guides, compare / best-time page copy). A held item goes through:
//
//   SUGGESTER  (a model call: gets the reasons, the text and the allowed facts; may only SHORTEN, SOFTEN or DELETE the
//               offending sentences, and every answer is checked in code: nothing it adds survives)
//   QA JUDGE   (first the kind's own deterministic gate, which is the law; then a SECOND, independent model call with a
//               different prompt that must say pass or fail against the same rules and the facts; BOTH must pass)
//   ... and if either fails, the QA reasons go back to the suggester. At most HEAL_MAX_ROUNDS rounds per item per run.
//
// Then, instead of holding the item for a person, an ESCALATION LADDER:
//   (a) deterministic removal of the offending sentences / paragraphs (plain code), then judge again;
//   (b) regenerate just the offending section(s) from the brief, then judge again;
//   (c) blog posts only: regenerate the whole post once with the failure reasons as constraints, then judge again.
// If the item is still not clean after the ladder it is NOT published: it is marked rejected_by_heal with the reasons,
// its slot is freed, and the pipeline moves on to the next topic or guide by itself.
//
// HARD SAFETY (all enforced in code, not only in the prompts):
//   1. Text that fails the deterministic gate is never accepted. The judge runs only after the gate is clean, and its
//      verdict can only ADD failures: a "pass" never overrides a gate failure (see acceptState).
//   2. A rewrite is thrown away if it is longer, or adds a number, name, link, price or date (validateRewrite).
//      A regenerated section must satisfy the same sentence rules, may link only to the pages the brief allows, and
//      contains no price, date, named person, experience claim or web address.
//   3. Budget: HEAL_MAX_ROUNDS per item, a daily cap on model calls (setting heal_loop_calls_per_day, default 20, hard
//      max 60), each call bounded by max_tokens. A counter that cannot be read means NO call (fail closed). When the
//      cap is reached the item waits for the next day; that is a plain note on the Autopilot page, not an error.
//   4. Every change is returned as content_edits rows that the caller writes BEFORE applying them, so Undo works.
//   5. Guides about a business named from a package title (isGuessedProperty, WP15/WP16) may have their text healed,
//      but the caller never publishes them: that rule lives in lib/guide-run.ts and lib/heal-drafts.ts, and
//      scripts/check-heal-loop.ts checks it.

export const HEAL_CALLS_KEY = 'heal_loop_calls_per_day'
export const HEAL_CALLS_DEFAULT = 20
export const HEAL_CALLS_HARD_MAX = 60
export const HEAL_MAX_ROUNDS = 3
/** max_tokens per kind of call. */
export const SUGGEST_MAX_TOKENS = 3000
export const JUDGE_MAX_TOKENS = 1500
export const SECTION_MAX_TOKENS = 2500
/** composeFullPost makes five calls (keywords, idea, body, title, enrich); a whole-post regeneration is charged as that many. */
export const WHOLE_REGEN_CALLS = 5
/** At most this many items are rejected_by_heal in a day across all kinds; after that new writing waits for tomorrow. */
export const MAX_REJECTS_PER_DAY = 3

export const HEAL_LOG_KEY = 'heal_loop_log'
export const HEAL_LOG_MAX = 100
export const HEAL_REJECTED_KEY = 'heal_loop_rejected'
const REJECTED_MAX = 300
const COUNTER_PREFIX = 'heal_loop_calls_used'
const CALL_TIMEOUT_MS = 45_000

// ---------------------------------------------------------------------------------------------------
// The daily budget
// ---------------------------------------------------------------------------------------------------

/** The daily call cap for a stored value. Unset or text that is not a whole number means the default (20); a number
 * above the hard max (60) is cut to it; 0 switches the loop off. Pure. */
export function parseHealCap(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return HEAL_CALLS_DEFAULT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return HEAL_CALLS_DEFAULT
  return Math.min(HEAL_CALLS_HARD_MAX, n)
}

export async function setHealCap(admin: SupabaseClient, n: number): Promise<{ error?: string }> {
  if (!Number.isInteger(n) || n < 0 || n > HEAL_CALLS_HARD_MAX) return { error: `the heal limit must be a whole number from 0 to ${HEAL_CALLS_HARD_MAX}` }
  return setSetting(admin, HEAL_CALLS_KEY, String(n))
}

export interface HealBudget {
  /** The day's cap (0 when the loop is off or the counters could not be read). */
  cap: number
  /** Calls already used today. */
  used: number
  /** False when the cap or the counter could not be read: no call is ever made then (fail closed). */
  readable: boolean
  reason?: string
  remaining(): number
  /** Reserves `n` calls and saves the new total BEFORE the call is made. False when there is not enough left or the total could not be saved. */
  take(n?: number): Promise<boolean>
}

/** Opens today's budget. Fails closed: an unreadable cap or counter means a cap of 0. */
export async function openBudget(admin: SupabaseClient, now: Date = new Date()): Promise<HealBudget> {
  const counterKey = `${COUNTER_PREFIX}:${repairDay(now)}`
  const closed = (reason: string): HealBudget => ({ cap: 0, used: 0, readable: false, reason, remaining: () => 0, take: async () => false })
  let cap: number
  let used = 0
  try {
    const capRead = await getSettingStrict(admin, HEAL_CALLS_KEY)
    if (capRead.error) return closed(`could not read the heal limit (${capRead.error})`)
    cap = parseHealCap(capRead.value)
    const usedRead = await getSettingStrict(admin, counterKey)
    if (usedRead.error) return closed(`could not read today's heal counter (${usedRead.error})`)
    if (usedRead.value !== null && usedRead.value.trim() !== '') {
      const n = Number(usedRead.value)
      if (!Number.isInteger(n) || n < 0) return closed("today's heal counter holds something that is not a number")
      used = n
    }
  } catch (e) {
    return closed(`could not read the heal counters (${e instanceof Error ? e.message : 'unknown error'})`)
  }
  let broken = false
  const budget: HealBudget = {
    cap,
    used,
    readable: true,
    remaining: () => (broken ? 0 : Math.max(0, cap - budget.used)),
    take: async (n = 1) => {
      if (broken || budget.used + n > cap) return false
      const next = budget.used + n
      const saved = await setSetting(admin, counterKey, String(next))
      if (saved.error) {
        broken = true
        return false
      }
      budget.used = next
      return true
    },
  }
  return budget
}

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export type HealStatus = 'already_clean' | 'healed' | 'rejected_by_heal' | 'deferred'
export type LadderStep = 'suggest' | 'strip' | 'section' | 'whole'

export interface HealTarget {
  type: ContentType
  /** Unique per item: post:<slug>, guide:<kind>:<slug>, page_copy:<path>. */
  key: string
  path: string
  /** The kind's own repair item: its fields, its deterministic gate, its limits. The gate is the law. */
  item: RepairItem
  /** The facts the writer was given: the only place a fact may come from. Shown to the suggester and the judge. */
  brief: string
  /** Ladder (c), blog posts only: write the whole post again with these reasons as constraints. Null when it could not. */
  regenerateWhole?: (reasons: string[]) => Promise<RepairFields | null>
}

export interface HealDeps {
  model: ModelCall
  budget: HealBudget
  /** Absolute time (Date.now() scale) the caller must be done by. */
  deadlineMs?: number
}

export interface HealRoundLog {
  n: number
  offenders: number
  applied: number
  gate: number
  judge: 'pass' | 'fail' | 'skipped' | 'unreadable'
}

export interface HealOutcome {
  status: HealStatus
  /** The healed fields when status is 'healed'; otherwise exactly the fields that came in. */
  fields: RepairFields
  /** What the deterministic gate said about `fields`. */
  blockers: string[]
  /** Plain reasons (why it was rejected or deferred). */
  reasons: string[]
  rounds: number
  ladder: LadderStep[]
  calls: number
  judgeRuns: number
  edits: ContentEdit[]
  log: HealRoundLog[]
  note: string
}

interface JudgeFail {
  quote: string
  reason: string
}

// ---------------------------------------------------------------------------------------------------
// Finding the sentences
// ---------------------------------------------------------------------------------------------------

const MD_LINK_ANY = /!?\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/g
const EXPERIENCE = [...EXPERIENCE_CLAIM_PATTERNS, ...POST_EXPERIENCE_CLAIM_PATTERNS]
const PLACEHOLDER_TEXT = [/lorem ipsum/i, /\btodo\b/i, /\btbd\b/i, /insert .* here/i, /\{\{|\}\}/, /\[[^\]]*\](?!\()/]
const REFUSAL_TEXT = [/i (cannot|can't|won'?t) (write|generate|help|comply)/i, /as an ai( language model)?/i, /i don'?t have (enough )?information/i]
const WEB_ADDRESS = /https?:\/\/|\bwww\./i

/** A sentence with link syntax reduced to its anchor words and the markdown marks taken off (what a reader sees). */
export function plainSentence(s: string): string {
  return s.replace(MD_LINK_ANY, (_a, label: string) => label).replace(/^\s*(?:[-*]\s+|\d+[.)]\s+|#{1,6}\s+)/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
}

interface ScanUnit {
  field: OffenderField
  index?: number
  text: string
  prefix: string
  heading: boolean
}

function scanUnits(f: RepairFields): ScanUnit[] {
  const out: ScanUnit[] = []
  if (f.title?.trim()) out.push({ field: 'title', text: f.title, prefix: '', heading: false })
  for (const field of ['summary', 'body'] as const) {
    const text = f[field]
    if (!text) continue
    for (const s of bodySentences(text)) out.push({ field, text: s.text, prefix: s.heading ? (s.text.match(/^#{1,6}\s+/)?.[0] ?? '') : s.prefix, heading: s.heading })
  }
  for (const field of ['meta_title', 'meta_description', 'og_title', 'og_description'] as const) if (f[field].trim()) out.push({ field, text: f[field], prefix: '', heading: false })
  f.faq.forEach((p, i) => {
    out.push({ field: 'faq_q', index: i, text: p.q, prefix: '', heading: false })
    out.push({ field: 'faq_a', index: i, text: p.a, prefix: '', heading: false })
  })
  f.key_takeaways.forEach((t, i) => out.push({ field: 'takeaway', index: i, text: t, prefix: '', heading: false }))
  return out
}

/** Sentences behind the blockers that the sentence rules of content-repair do not describe: an experience claim,
 * placeholder text, a model refusal, a web address typed into the text. Only the categories the gate raised are looked for. Pure. */
export function hardOffenders(f: RepairFields, blockers: string[]): Offender[] {
  const kinds = blockerKinds(blockers)
  const tests: { test: (plain: string, raw: string) => boolean; why: string }[] = []
  if (kinds.has('experience')) tests.push({ test: (p) => EXPERIENCE.some((re) => re.test(p)), why: 'claims a first-person or agency experience; remove it' })
  if (kinds.has('placeholder')) tests.push({ test: (_p, raw) => PLACEHOLDER_TEXT.some((re) => re.test(raw.replace(MD_LINK_ANY, (_a, label: string) => label))), why: 'placeholder text; remove it' })
  if (kinds.has('refusal')) tests.push({ test: (p) => REFUSAL_TEXT.some((re) => re.test(p)), why: 'the writer refused or apologised; remove it' })
  if (kinds.has('web-address')) tests.push({ test: (_p, raw) => WEB_ADDRESS.test(raw), why: 'a web address typed into the text; remove it' })
  if (tests.length === 0) return []
  const out: Offender[] = []
  for (const u of scanUnits(f)) {
    const hit = tests.filter((t) => t.test(plainSentence(u.text), u.text))
    if (hit.length) out.push({ field: u.field, index: u.index, text: u.text, why: hit.map((h) => h.why).join('; '), prefix: u.prefix })
  }
  return out
}

/** The offender a reviewer quote points at, or null when the quote matches nothing on the page. Pure. */
export function locateQuote(f: RepairFields, fail: JudgeFail): Offender | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const quote = norm(fail.quote.replace(/[*_`]/g, ''))
  if (quote.length < 12) return null
  for (const u of scanUnits(f)) {
    const plain = norm(plainSentence(u.text))
    if (plain.length < 12) continue
    if (plain.includes(quote) || quote.includes(plain)) return { field: u.field, index: u.index, text: u.text, why: `QA reviewer: ${fail.reason}`, prefix: u.prefix }
  }
  return null
}

const sameOffender = (a: Offender, b: Offender) => a.field === b.field && a.index === b.index && a.text === b.text

function mergeOffenders(...lists: Offender[][]): Offender[] {
  const out: Offender[] = []
  for (const o of lists.flat()) {
    const at = out.findIndex((x) => sameOffender(x, o))
    if (at === -1) out.push(o)
    else if (!out[at].why.includes(o.why)) out[at] = { ...out[at], why: `${out[at].why}; ${o.why}` }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Units (sections) of a body, for the regeneration step
// ---------------------------------------------------------------------------------------------------

interface Unit {
  field: 'summary' | 'body'
  start: number
  end: number
  text: string
  /** The heading line when the unit starts with "## ", else null (an opening paragraph, or a whole page-copy intro). */
  heading: string | null
}

function unitsOf(f: RepairFields): Unit[] {
  const out: Unit[] = []
  if (f.summary?.trim()) out.push({ field: 'summary', start: 0, end: f.summary.length, text: f.summary, heading: null })
  let at = 0
  for (const chunk of f.body.split(/^(?=##\s)/m)) {
    if (chunk) out.push({ field: 'body', start: at, end: at + chunk.length, text: chunk, heading: /^##\s/.test(chunk) ? (chunk.split('\n')[0] ?? '') : null })
    at += chunk.length
  }
  return out
}

function unitHolding(f: RepairFields, o: Offender): Unit | null {
  if (o.field !== 'body' && o.field !== 'summary') return null
  return unitsOf(f).find((u) => u.field === o.field && u.text.includes(o.text)) ?? null
}

function putUnit(f: RepairFields, u: Unit, text: string): RepairFields {
  const next = cloneFields(f)
  const trailing = /\s*$/.exec(u.text)?.[0] ?? ''
  const replacement = `${text.trim()}${trailing}`
  if (u.field === 'summary') next.summary = replacement.trim()
  else next.body = `${f.body.slice(0, u.start)}${replacement}${f.body.slice(u.end)}`
  return next
}

/** Removes the whole paragraph (block) that holds an offending sentence, when the page keeps at least one other block.
 * Headings are never removed here. Null when not allowed. Pure. */
export function deleteParagraph(f: RepairFields, o: Offender): RepairFields | null {
  if ((o.field !== 'body' && o.field !== 'summary') || /^\s*#{1,6}\s/.test(o.text)) return null
  if (o.field === 'summary') return null
  const blocks = f.body.split(/\n\s*\n/)
  const at = blocks.findIndex((b) => b.includes(o.text))
  if (at === -1) return null
  const kept = blocks.filter((_b, i) => i !== at)
  if (!kept.some((b) => b.trim() && !/^\s*#{1,6}\s/.test(b))) return null
  // A block that is a heading followed by its paragraph on the next line: only the paragraph line goes.
  const lines = blocks[at].split('\n')
  if (lines.length > 1 && /^\s*#{1,6}\s/.test(lines[0])) {
    const rest = lines.filter((l) => !l.includes(o.text))
    if (rest.length === lines.length) return null
    const next = cloneFields(f)
    next.body = blocks.map((b, i) => (i === at ? rest.join('\n') : b)).join('\n\n')
    return next
  }
  const next = cloneFields(f)
  next.body = kept.join('\n\n')
  return next
}

/** Takes a stale year out of the title (a removal, never an addition). Pure. */
export function fixStaleYear(f: RepairFields, blockers: string[], currentYear: string): RepairFields {
  if (!f.title || !blockers.some((b) => /^stale year/.test(b))) return f
  const title = f.title
    .replace(/\b(20\d{2})\b/g, (y) => (y === currentYear ? y : ''))
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([:,;.)])/g, '$1')
    .replace(/[\s:,;(-]+$/g, '')
    .replace(/^[\s:,;)-]+/g, '')
    .trim()
  return title && title !== f.title ? { ...f, title } : f
}

// ---------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------

const BRIEF_MAX = 6000
const clipBrief = (s: string) => (s.length > BRIEF_MAX ? s.slice(0, BRIEF_MAX) : s)

function suggesterPrompt(brief: string, offenders: Offender[], otherBlockers: string[], qaNotes: string[]): string {
  const list = offenders.map((o, i) => `${i}. [${o.why}] ${o.text.slice(o.prefix.length)}`).join('\n')
  const other = otherBlockers.length ? `\n\nTHE AUTOMATIC CHECKS ALSO SAID (information only; fix what you can by rewording the numbered items):\n${otherBlockers.map((b) => `- ${b}`).join('\n')}` : ''
  const notes = qaNotes.length ? `\n\nNOTES FROM THE LAST TRY (a reviewer or a check refused it for these reasons; do not repeat them):\n${qaNotes.map((n) => `- ${n}`).join('\n')}` : ''
  return `You are repairing sentences on a Canadian travel agency web page so that it passes a strict publishing check. You may only SHORTEN, SOFTEN or DELETE. You must never add a fact, name, number, date, price, count, claim or link.\n\nFACTS (the only source for any fact; nothing outside them may be stated as fact):\n${clipBrief(brief)}\n\nNUMBERED TEXTS TO FIX (each has its problem in square brackets):\n${list}${other}${notes}\n\nRules: fix each numbered item in one of two ways: (a) rewrite it so it no longer has the problem, or (b) delete it, when rewording cannot fix it. A rewrite must not be longer than the original. Use only words that already appear in the original sentence, plus plain joining words (a, the, and, with, well known, many, often). Where a flagged word, number or name goes, drop it or leave the idea out. Keep markdown formatting. Never use the long dash character. Never write in the first person ("I", "we visited", "our guests loved").\n\nReturn ONLY minified JSON: {"rewrites":[{"id":0,"text":"..."},{"id":1,"delete":true}]}`
}

const QA_RULES = [
  'No first-person experience: nothing like "I visited", "we stayed", "our guests loved", "when we sailed".',
  'No statement about what the agency has done, hosted or sailed. The agency may only offer help ("we can help you plan").',
  'No superlatives, rankings, ratings, awards or reputation words (best, top-rated, award-winning, famous, luxury, world-class, largest, most popular).',
  'No specific number, price, date, count, distance, size or year unless it appears in the FACTS.',
  'No named venue, hotel, restaurant, ship, person or place unless it appears in the FACTS or is the subject of the page.',
  'No claim that something is new, recently changed, or happens on a schedule ("every week").',
  'No link to another website, no web address, no email address. Links to this site (starting with /) are fine.',
  'A specific fact (a feature, an amenity, an inclusion, a name) must be supported by the FACTS. General, well-known travel advice needs no source.',
]

function judgePrompt(brief: string, text: string): string {
  return `You are an independent quality reviewer for a Canadian travel agency website. Decide whether the page text below is safe to publish. Judge it ONLY against the RULES and the FACTS. You did not write it and you must not be kind to it.\n\nRULES (a text that breaks any rule FAILS):\n${QA_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nFACTS:\n${clipBrief(brief)}\n\nPAGE TEXT:\n${text}\n\nList every sentence that breaks a rule, copying the sentence EXACTLY as written in the page text. If nothing breaks a rule, pass.\nReturn ONLY minified JSON: {"pass":true,"failures":[]} or {"pass":false,"failures":[{"quote":"<exact sentence>","rule":<rule number>,"reason":"<short reason>"}]}`
}

function judgeText(f: RepairFields): string {
  const parts = [plainForPrompt(f)]
  if (f.faq.length) parts.push(`FAQ:\n${f.faq.map((p) => `Q: ${p.q}\nA: ${p.a}`).join('\n')}`)
  if (f.key_takeaways.length) parts.push(`KEY TAKEAWAYS:\n${f.key_takeaways.map((t) => `- ${t}`).join('\n')}`)
  const meta = [f.meta_title, f.meta_description, f.og_title, f.og_description].filter((s) => s.trim())
  if (meta.length) parts.push(`SEARCH AND SHARE TEXT:\n${meta.map((m) => `- ${m}`).join('\n')}`)
  const all = parts.join('\n\n')
  return all.length > 18_000 ? all.slice(0, 18_000) : all
}

function sectionPrompt(brief: string, unit: Unit, reasons: string[]): string {
  const hasHeading = unit.heading !== null
  const words = unit.text.trim().split(/\s+/).length
  return `Rewrite one section of a Canadian travel agency web page. The previous version of the section was refused for these reasons:\n${reasons.map((r) => `- ${r}`).join('\n') || '- it did not pass the quality check'}\n\nFACTS (the only source for any fact; if the facts do not support something, leave it out):\n${clipBrief(brief)}\n\nPREVIOUS VERSION OF THE SECTION:\n${unit.text.trim()}\n\nWrite the section again in plain, warm English, about ${Math.max(30, Math.round(words * 0.9))} words. ${hasHeading ? `Start with a heading line that begins "## " (you may reword the heading, but keep it about the same topic).` : 'Do not start with a heading line.'} Use only general travel-planning knowledge and the FACTS. Never write in the first person, never say what the agency has done, no superlatives or ratings (best, famous, luxury, top-rated), no numbers, prices, dates or counts that are not in the FACTS, no names of hotels, restaurants, ships or people that are not in the FACTS, no web addresses, no links, never the long dash character. The agency may only offer help ("our team can help you plan this").\n\nReturn ONLY the section as markdown, nothing before or after it.`
}

// ---------------------------------------------------------------------------------------------------
// Checking what a model sends back
// ---------------------------------------------------------------------------------------------------

/** Why a regenerated section must be thrown away, or null when it is acceptable. Pure. */
export function validateRegeneratedUnit(unit: Pick<Unit, 'text' | 'heading'>, text: string, ctx: DetectCtx, allowedPaths: Set<string>, maxLinks?: number): string | null {
  const t = text.trim().replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim()
  if (!t) return 'empty'
  if (/[–—]/.test(t)) return 'contains a long dash'
  const startsHeading = /^##\s/.test(t)
  if (unit.heading !== null && !startsHeading) return 'lost its heading'
  if (unit.heading === null && /^#{1,6}\s/.test(t)) return 'added a heading to a section that has none'
  if (WEB_ADDRESS.test(t)) return 'contains a web address'
  const origWords = unit.text.trim().split(/\s+/).length
  const words = t.split(/\s+/).length
  if (words > origWords * 1.5 + 10) return 'much longer than the original'
  if (origWords >= 40 && words < origWords * 0.4) return 'much shorter than the original'
  const links = internalLinksOfText(t)
  if (links.some((l) => !allowedPaths.has(l) && l !== '/')) return 'links to a page that is not allowed'
  if (/\]\((?!\/)[^)]*\)/.test(t)) return 'contains a link that is not to this site'
  if (typeof maxLinks === 'number' && links.length > maxLinks) return 'has too many links'
  for (const s of bodySentences(t)) {
    const plain = plainSentence(s.text)
    if (!plain) continue
    const probs = sentenceProblems(s.heading ? plain : s.text, ctx)
    if (probs.length) return `a sentence still has a problem (${probs[0].slice(0, 80)})`
    if (isPriceOrDate(plain)) return 'contains a price or a date'
    if (isNamedPersonLike(plain)) return 'names a person'
    if (EXPERIENCE.some((re) => re.test(plain))) return 'contains an experience claim'
    if (PLACEHOLDER_TEXT.some((re) => re.test(s.text.replace(MD_LINK_ANY, (_a, label: string) => label)))) return 'contains placeholder text'
    if (REFUSAL_TEXT.some((re) => re.test(plain))) return 'contains a refusal'
  }
  return null
}

// ---------------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------------

/** Heals one item. Never throws and never writes: it works on the fields it is given and returns the result (and the
 * content_edits rows for it). The caller logs the edits, then applies the fields. Whatever happens, `fields` is either
 * a version that passed the kind's gate AND the independent judge, or exactly the fields that came in. */
export async function healLoop(target: HealTarget, deps: HealDeps): Promise<HealOutcome> {
  const item = target.item
  const original = cloneFields(item.fields)
  const tracker = new Tracker()
  const ctx = makeDetectCtx(item.type, item.grounding, item.names)
  const detect = (f: RepairFields, blockers: string[]) => (item.detect ? item.detect(f, blockers) : detectOffenders(f, ctx, blockers))
  const log: HealRoundLog[] = []
  const ladder: LadderStep[] = []
  let calls = 0
  let judgeRuns = 0
  let judgeAnswered = 0
  // An object, not a plain variable: the model closure below sets it, and TypeScript would otherwise narrow it to null.
  const st = { stop: null as 'budget' | 'time' | null, answers: 0 }

  const timeOk = () => deps.deadlineMs === undefined || deps.deadlineMs - Date.now() >= MIN_MS_PER_CALL
  /** The only way a model is ever reached: reserves the call first, and refuses with no spend when out of budget or time. */
  const bound: ModelCall = async (prompt, maxTokens) => {
    if (!timeOk()) {
      st.stop = 'time'
      return null
    }
    if (!(await deps.budget.take(1))) {
      st.stop = 'budget'
      return null
    }
    calls++
    const timeout = deps.deadlineMs === undefined ? CALL_TIMEOUT_MS : Math.max(5_000, Math.min(CALL_TIMEOUT_MS, deps.deadlineMs - Date.now() - 3_000))
    try {
      const text = await deps.model(prompt, Math.min(maxTokens, SUGGEST_MAX_TOKENS), timeout)
      if (text) st.answers++
      return text
    } catch {
      return null
    }
  }

  const finish = (status: HealStatus, fields: RepairFields, reasons: string[], note: string, rounds: number): HealOutcome => {
    const blockers = item.gate(fields)
    // The last wall: nothing is reported healed unless the deterministic gate is clean on exactly these fields.
    if (status === 'healed' && blockers.length) return finish('rejected_by_heal', original, [`the final text still failed the checks: ${blockers.slice(0, 3).join('; ')}`], 'the final text did not pass the checks', rounds)
    const healed = status === 'healed'
    return {
      status,
      fields: healed ? fields : original,
      blockers: healed ? [] : item.gate(original),
      reasons,
      rounds,
      ladder,
      calls,
      judgeRuns,
      edits: healed ? buildEdits(item, original, fields, tracker, calls) : [],
      log,
      note,
    }
  }

  const startBlockers = item.gate(original)
  if (startBlockers.length === 0) return finish('already_clean', original, [], 'already clean', 0)
  if (!deps.budget.readable) return finish('deferred', original, [deps.budget.reason ?? 'the heal counters could not be read'], deps.budget.reason ?? 'the heal counters could not be read', 0)
  if (deps.budget.remaining() < 2) return finish('deferred', original, ["today's heal limit is used up"], "today's heal limit is used up, so this waits for tomorrow", 0)

  let cur = original
  let qaNotes: string[] = []
  let judgeFails: JudgeFail[] = []

  const collect = (f: RepairFields, blockers: string[]): Offender[] => {
    const judged = judgeFails.map((j) => locateQuote(f, j)).filter((o): o is Offender => !!o)
    return mergeOffenders(blockers.length ? detect(f, blockers) : [], blockers.length ? hardOffenders(f, blockers) : [], judged)
  }

  /** The independent judge. Runs only when the gate is clean. Returns pass, or the failures it found. */
  const judge = async (f: RepairFields): Promise<{ pass: boolean; answered: boolean; fails: JudgeFail[]; reasons: string[] }> => {
    judgeRuns++
    const answer = await bound(judgePrompt(target.brief, judgeText(f)), JUDGE_MAX_TOKENS, CALL_TIMEOUT_MS)
    if (!answer) return { pass: false, answered: false, fails: [], reasons: ['the QA review did not answer'] }
    const parsed = parseModelJson<{ pass?: unknown; failures?: unknown }>(answer)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.pass !== 'boolean') return { pass: false, answered: false, fails: [], reasons: ['the QA review was unreadable'] }
    judgeAnswered++
    const fails: JudgeFail[] = (Array.isArray(parsed.failures) ? parsed.failures : [])
      .map((x) => ({ quote: typeof (x as JudgeFail)?.quote === 'string' ? (x as JudgeFail).quote : '', reason: typeof (x as JudgeFail)?.reason === 'string' ? (x as JudgeFail).reason.slice(0, 160) : 'breaks a rule' }))
      .filter((x) => x.quote.trim())
    // A "pass" with failures listed is a fail: the judge can only ADD failures, never wave one through.
    const pass = parsed.pass === true && fails.length === 0
    return { pass, answered: true, fails, reasons: pass ? [] : fails.length ? fails.map((x) => `QA reviewer: ${x.reason} ("${x.quote.slice(0, 80)}")`) : ['QA reviewer said fail without naming a sentence'] }
  }

  /** gate first, then the judge: both must pass. A judge pass can never override a gate failure. */
  const acceptState = async (f: RepairFields): Promise<{ ok: boolean; reasons: string[]; judged: 'pass' | 'fail' | 'skipped' | 'unreadable' }> => {
    const blockers = item.gate(f)
    if (blockers.length) return { ok: false, reasons: blockers, judged: 'skipped' }
    const j = await judge(f)
    judgeFails = j.fails
    if (!j.answered) return { ok: false, reasons: j.reasons, judged: 'unreadable' }
    return { ok: j.pass, reasons: j.reasons, judged: j.pass ? 'pass' : 'fail' }
  }

  const touch = (o: Offender, method: EditMethod, reason: string) => tracker.touch(logicalOf(o.field), method, reason)

  // ---- rounds: SUGGESTER then QA ----
  let lastReasons: string[] = startBlockers
  let rounds = 0
  for (let round = 1; round <= HEAL_MAX_ROUNDS; round++) {
    if (st.stop) break
    rounds = round
    let blockers = item.gate(cur)
    // Plain code first: it needs no model and cannot add a fact.
    if (blockers.length) {
      cur = applyFixers(cur, blockers, item, tracker)
      cur = fixStaleYear(cur, blockers, String(new Date().getFullYear()))
      blockers = item.gate(cur)
    }
    const offenders = collect(cur, blockers).slice(0, MAX_REPAIR_SENTENCES)
    const entry: HealRoundLog = { n: round, offenders: offenders.length, applied: 0, gate: blockers.length, judge: 'skipped' }
    log.push(entry)

    if (offenders.length) {
      if (!ladder.includes('suggest')) ladder.push('suggest')
      const answer = await bound(suggesterPrompt(target.brief, offenders, blockers.slice(0, 6), qaNotes), SUGGEST_MAX_TOKENS, CALL_TIMEOUT_MS)
      const parsed = answer ? parseModelJson<{ rewrites?: { id?: number; text?: unknown; delete?: unknown }[] }>(answer) : null
      const rewrites = parsed && Array.isArray(parsed.rewrites) ? parsed.rewrites : []
      const refused: string[] = []
      const deletions: Offender[] = []
      for (const r of rewrites) {
        const o = typeof r.id === 'number' ? offenders[r.id] : undefined
        if (!o) continue
        if (r.delete === true) {
          deletions.push(o)
          continue
        }
        if (typeof r.text !== 'string') continue
        const text = removeDashes(o.prefix ? r.text.trim().replace(/^\s*(?:[-*]\s+|\d+[.)]\s+|#{1,6}\s+)/, '') : r.text.trim()).trim()
        const bad = validateRewrite(o.text, text, ctx)
        if (bad) {
          refused.push(`your rewrite of "${o.text.slice(0, 60)}" was refused: ${bad}`)
          continue
        }
        const next = replaceUnit(cur, o, text)
        if (next !== cur) {
          tracker.touch(logicalOf(o.field), 'ai', o.why.split(';')[0].slice(0, 120))
          cur = next
          entry.applied++
        }
      }
      for (const o of deletions.sort((a, b) => (b.index ?? 0) - (a.index ?? 0))) {
        const next = deterministicFix(cur, o, ctx, item.limits)
        if (next) {
          touch(o, 'ai', `the model removed it: ${o.why.split(';')[0].slice(0, 100)}`)
          cur = next
          entry.applied++
        } else refused.push(`"${o.text.slice(0, 60)}" cannot be deleted by itself (its paragraph would be too short); reword it instead`)
      }
      qaNotes = refused
    } else if (blockers.length && missingExtras(cur, item.limits).length && blockerKinds(blockers).has('missing-extras')) {
      // Nothing to reword: the page only lacks FAQ, takeaways or meta text. Write them from the page's own text.
      if (!ladder.includes('suggest')) ladder.push('suggest')
      const keys = missingExtras(cur, item.limits)
      const bodyCtx = makeDetectCtx(item.type, plainForPrompt(cur), [...(item.names ?? []), item.fields.title ?? '', item.keyword ?? ''])
      const { got } = await generateExtras(bound, cur, keys, item.limits, item.keyword ?? null, bodyCtx)
      const gotKeys = Object.keys(got) as (keyof typeof got)[]
      if (gotKeys.length) {
        const next: RepairFields = { ...cur, ...got }
        for (const k of gotKeys) tracker.touch(k, 'generate', `${k === 'faq' ? 'FAQ' : k === 'key_takeaways' ? 'key takeaways' : String(k).replace('_', ' ')} was missing, written from the page text only`)
        cur = next
        entry.applied += gotKeys.length
      }
    }

    cur = applyFixers(cur, item.gate(cur), item, tracker)
    blockers = item.gate(cur)
    entry.gate = blockers.length
    if (blockers.length) {
      lastReasons = blockers
      qaNotes = [...qaNotes, ...blockers.map((b) => `the automatic checks still say: ${b}`)].slice(-8)
      if (entry.applied === 0 && !offenders.length) break // nothing a rewrite can reach: go to the ladder
      // The AI answered nothing at all in this round: it is down or unreachable. Do not burn the rest of the budget on it.
      if (calls > 0 && st.answers === 0) break
      continue
    }
    const verdict = await acceptState(cur)
    entry.judge = verdict.judged
    if (verdict.ok) return finish('healed', cur, [], `healed in ${round} round${round === 1 ? '' : 's'}`, round)
    lastReasons = verdict.reasons
    qaNotes = verdict.reasons.slice(0, 8)
    if (verdict.judged === 'unreadable' && st.stop) break
  }

  // ---- the ladder, instead of holding ----
  const ladderPossible = !st.stop && deps.budget.remaining() >= 1 && timeOk()
  if (!ladderPossible) {
    const why = st.stop === 'time' ? 'ran out of time' : "today's heal limit is used up"
    return finish('deferred', original, [why, ...lastReasons].slice(0, 6), `${why}, so this waits for the next run`, rounds)
  }

  // The sections that had a problem when the ladder started (found before anything is removed).
  const startOffenders = collect(cur, item.gate(cur))
  const problemUnits = startOffenders.map((o) => unitHolding(cur, o)).filter((u): u is Unit => !!u)
  const problemHeadings = [...new Set(problemUnits.map((u) => `${u.field}:${u.heading ?? ''}:${u.heading === null ? u.text.slice(0, 40) : ''}`))]

  const strip = (from: RepairFields): RepairFields => {
    let f = from
    for (let guard = 0; guard < MAX_REPAIR_SENTENCES * 2; guard++) {
      const blockers = item.gate(f)
      const fixedYear = fixStaleYear(f, blockers, String(new Date().getFullYear()))
      if (fixedYear !== f) {
        tracker.touch('title', 'delete', 'removed a stale year from the title')
        f = fixedYear
        continue
      }
      const offs = collect(f, blockers).filter((o) => !/^\s*#{1,6}\s/.test(o.text))
      let progressed = false
      for (const o of offs) {
        const next = deterministicFix(f, o, ctx, item.limits) ?? deleteParagraph(f, o)
        if (!next) continue
        touch(o, 'delete', `removed: ${o.why.split(';')[0].slice(0, 110)}`)
        f = applyFixers(next, item.gate(next), item, tracker)
        progressed = true
        break
      }
      if (!progressed) break
    }
    return f
  }

  // (a) strip
  ladder.push('strip')
  const stripped = strip(cur)
  let verdict = await acceptState(stripped)
  log.push({ n: rounds + 1, offenders: startOffenders.length, applied: sameFields(stripped, cur) ? 0 : 1, gate: item.gate(stripped).length, judge: verdict.judged })
  if (verdict.ok) return finish('healed', stripped, [], 'healed by removing the offending sentences', rounds)
  cur = stripped
  lastReasons = verdict.reasons

  // (b) regenerate the offending section(s) from the brief
  if (!st.stop && deps.budget.remaining() >= 1 && timeOk()) {
    const stillHere = collect(cur, item.gate(cur))
    const targets: Unit[] = []
    for (const o of stillHere) {
      const u = unitHolding(cur, o)
      if (u && !targets.some((t) => t.field === u.field && t.start === u.start)) targets.push(u)
    }
    // A section that had a problem at the start and still exists, but is no longer flagged, is regenerated too when the page is now too thin.
    for (const u of unitsOf(cur)) {
      if (targets.length >= 2) break
      const key = `${u.field}:${u.heading ?? ''}:${u.heading === null ? u.text.slice(0, 40) : ''}`
      if (problemHeadings.includes(key) && !targets.some((t) => t.field === u.field && t.start === u.start) && item.gate(cur).some((b) => /^(intro )?too short/.test(b))) targets.push(u)
    }
    let regenerated = cur
    let didAny = false
    // Last section first so earlier offsets stay valid.
    for (const unit of targets.slice(0, 2).sort((a, b) => b.start - a.start)) {
      if (st.stop || deps.budget.remaining() < 1 || !timeOk()) break
      const fresh = unitsOf(regenerated).find((u) => u.field === unit.field && u.start === unit.start && u.text === unit.text) ?? unitsOf(regenerated).find((u) => u.field === unit.field && u.heading === unit.heading && u.heading !== null)
      if (!fresh) continue
      if (!ladder.includes('section')) ladder.push('section')
      const reasons = [...new Set([...collect(regenerated, item.gate(regenerated)).filter((o) => fresh.text.includes(o.text)).map((o) => o.why), ...lastReasons])].slice(0, 6)
      const answer = await bound(sectionPrompt(target.brief, fresh, reasons), SECTION_MAX_TOKENS, CALL_TIMEOUT_MS)
      if (!answer) continue
      const text = removeDashes(answer).trim()
      const bad = validateRegeneratedUnit(fresh, text, ctx, item.allowedPaths, item.limits.maxBodyLinks)
      if (bad) {
        qaNotes = [...qaNotes, `a regenerated section was refused: ${bad}`].slice(-8)
        continue
      }
      regenerated = putUnit(regenerated, fresh, text)
      tracker.touch('body', 'generate', `rewrote the section "${(fresh.heading ?? 'opening').replace(/^##\s*/, '').slice(0, 60)}" from the brief`)
      didAny = true
    }
    if (didAny) {
      regenerated = applyFixers(regenerated, item.gate(regenerated), item, tracker)
      regenerated = strip(regenerated)
      verdict = await acceptState(regenerated)
      log.push({ n: rounds + 2, offenders: targets.length, applied: 1, gate: item.gate(regenerated).length, judge: verdict.judged })
      if (verdict.ok) return finish('healed', regenerated, [], 'healed by rewriting the offending section from the brief', rounds)
      cur = regenerated
      lastReasons = verdict.reasons
    }
  }

  // (c) blog posts: the whole post once, with the failure reasons as constraints
  if (target.regenerateWhole && !st.stop && deps.budget.remaining() >= WHOLE_REGEN_CALLS + 1 && timeOk() && (deps.deadlineMs === undefined || deps.deadlineMs - Date.now() >= 150_000)) {
    if (await deps.budget.take(WHOLE_REGEN_CALLS)) {
      calls += WHOLE_REGEN_CALLS
      ladder.push('whole')
      let whole: RepairFields | null = null
      try {
        whole = await target.regenerateWhole(lastReasons.slice(0, 8))
      } catch {
        whole = null
      }
      if (whole) {
        for (const field of ['title', 'body', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways'] as const) {
          tracker.touch(field, 'generate', 'wrote the whole post again from the brief, with the earlier failures as constraints')
        }
        let next = applyFixers(whole, item.gate(whole), item, tracker)
        next = strip(next)
        verdict = await acceptState(next)
        log.push({ n: rounds + 3, offenders: 0, applied: 1, gate: item.gate(next).length, judge: verdict.judged })
        if (verdict.ok) return finish('healed', next, [], 'healed by writing the whole post again', rounds)
        lastReasons = verdict.reasons
      } else lastReasons = ['the whole post could not be written again', ...lastReasons]
    }
  }

  // Ran out of road. If a model never got to answer (down, out of time or budget) wait; otherwise reject.
  const modelDown = calls > 0 && st.answers === 0
  const judgeDown = judgeRuns > 0 && judgeAnswered === 0 && !lastReasons.some((r) => !/QA review/.test(r))
  if (st.stop || modelDown || judgeDown) {
    const why = st.stop === 'time' ? 'ran out of time' : st.stop === 'budget' ? "today's heal limit is used up" : modelDown ? 'the AI did not answer' : 'the QA review could not be reached'
    return finish('deferred', original, [why, ...lastReasons].slice(0, 6), `${why}, so this waits for the next run`, rounds)
  }
  return finish('rejected_by_heal', original, lastReasons.slice(0, 6), `could not be made to pass: ${lastReasons[0] ?? 'unknown'}`, rounds)
}

// ---------------------------------------------------------------------------------------------------
// The compact log and the rejected list (app_settings), for the Autopilot page
// ---------------------------------------------------------------------------------------------------

export interface HealLogEntry {
  at: string
  type: ContentType
  path: string
  status: HealStatus
  rounds: number
  calls: number
  ladder: LadderStep[]
  /** One plain line: why it was rejected or deferred, or what healed it. */
  reason: string
}

function parseJson<T>(raw: string | null, fallback: T): T {
  try {
    const v = JSON.parse(raw ?? 'null') as T | null
    return v ?? fallback
  } catch {
    return fallback
  }
}

export async function readHealLog(admin: SupabaseClient): Promise<HealLogEntry[]> {
  const v = parseJson<HealLogEntry[]>(await getSetting(admin, HEAL_LOG_KEY).catch(() => null), [])
  return Array.isArray(v) ? v : []
}

/** Adds one entry; keeps the last HEAL_LOG_MAX. Best effort: a log must never break the heal. */
export async function appendHealLog(admin: SupabaseClient, entry: HealLogEntry): Promise<void> {
  try {
    const list = await readHealLog(admin)
    list.push({ ...entry, reason: entry.reason.slice(0, 240) })
    await setSetting(admin, HEAL_LOG_KEY, JSON.stringify(list.slice(-HEAL_LOG_MAX)))
  } catch {
    // a display log
  }
}

export interface RejectedEntry {
  at: string
  type: ContentType
  path: string
  reasons: string[]
  rounds: number
}

/** Items marked rejected_by_heal. Null when the list could not be read (callers then free nothing: fail closed). */
export async function readRejected(admin: SupabaseClient): Promise<Record<string, RejectedEntry> | null> {
  const { value, error } = await getSettingStrict(admin, HEAL_REJECTED_KEY)
  if (error) return null
  const v = parseJson<Record<string, RejectedEntry>>(value, {})
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

export async function markRejected(admin: SupabaseClient, key: string, entry: RejectedEntry): Promise<void> {
  try {
    const map = (await readRejected(admin)) ?? {}
    map[key] = { ...entry, reasons: entry.reasons.slice(0, 6).map((r) => r.slice(0, 200)) }
    const keys = Object.keys(map)
    if (keys.length > REJECTED_MAX) for (const k of keys.sort((a, b) => (map[a].at < map[b].at ? -1 : 1)).slice(0, keys.length - REJECTED_MAX)) delete map[k]
    await setSetting(admin, HEAL_REJECTED_KEY, JSON.stringify(map))
  } catch {
    // the item's own status carries the truth too
  }
}

/** How many items were rejected_by_heal today (site day). Null when unreadable: callers then stop writing (fail closed). */
export async function rejectedToday(admin: SupabaseClient, now: Date = new Date()): Promise<number | null> {
  const map = await readRejected(admin)
  if (map === null) return null
  const day = repairDay(now)
  return Object.values(map).filter((e) => repairDay(new Date(e.at)) === day).length
}

/** True when writing new items should wait because MAX_REJECTS_PER_DAY items were already rejected today. */
export async function rejectLimitReached(admin: SupabaseClient, now: Date = new Date()): Promise<{ reached: boolean; note: string }> {
  const n = await rejectedToday(admin, now)
  if (n === null) return { reached: true, note: 'could not check how many drafts the heal rejected today, so nothing was written' }
  if (n >= MAX_REJECTS_PER_DAY) return { reached: true, note: `${n} drafts were rejected by the heal today, so new writing waits until tomorrow (nothing is wrong; it keeps the AI spend bounded)` }
  return { reached: false, note: '' }
}

// ---------------------------------------------------------------------------------------------------
// healItem: the database side
// ---------------------------------------------------------------------------------------------------

export interface HealRun {
  outcome: HealOutcome
  /** Audit rows written for the healed text. The caller points them at the saved page with finalizeEdits(). */
  logIds: string[]
}

/** Runs the loop for one item with the daily budget, writes the audit rows (log, then apply: no audit row, no edit),
 * records the compact log and the rejected list. `model` is injectable so checks run offline. Never throws. */
export async function healItem(
  admin: SupabaseClient,
  target: HealTarget,
  opts: { model?: ModelCall; deadlineMs?: number; now?: Date; budget?: HealBudget; recordRejected?: boolean } = {},
): Promise<HealRun> {
  const now = opts.now ?? new Date()
  const empty = (status: HealStatus, reasons: string[], note: string): HealRun => ({
    outcome: { status, fields: target.item.fields, blockers: target.item.gate(target.item.fields), reasons, rounds: 0, ladder: [], calls: 0, judgeRuns: 0, edits: [], log: [], note },
    logIds: [],
  })
  try {
    if (!opts.model && !isAiConfigured()) return empty('deferred', ['AI writing is not configured'], 'AI writing is not configured, so nothing was healed')
    if (!(await editsLoggable(admin))) return empty('deferred', ['the content_edits table is not set up'], 'self-healing needs migration 0033 (the edit log), so nothing was healed')
    const budget = opts.budget ?? (await openBudget(admin, now))
    const outcome = await healLoop(target, { model: opts.model ?? callModelText, budget, deadlineMs: opts.deadlineMs })
    let logIds: string[] = []
    let final = outcome
    if (outcome.status === 'healed' && outcome.edits.length) {
      const logged = await insertEdits(admin, outcome.edits)
      if (logged.error) {
        final = { ...outcome, status: 'deferred', fields: target.item.fields, blockers: target.item.gate(target.item.fields), edits: [], reasons: [`the audit log could not be written (${logged.error})`], note: 'the audit log could not be written, so the healed text was not used' }
      } else logIds = logged.ids
    }
    if (final.status !== 'already_clean') {
      await appendHealLog(admin, {
        at: now.toISOString(),
        type: target.type,
        path: target.path,
        status: final.status,
        rounds: final.rounds,
        calls: final.calls,
        ladder: final.ladder,
        reason: final.status === 'healed' ? final.note : final.reasons[0] ?? final.note,
      })
    }
    if (final.status === 'rejected_by_heal' && opts.recordRejected !== false) {
      await markRejected(admin, target.key, { at: now.toISOString(), type: target.type, path: target.path, reasons: final.reasons, rounds: final.rounds })
    }
    return { outcome: final, logIds }
  } catch (e) {
    return empty('deferred', [e instanceof Error ? e.message : 'unexpected error'], `the heal failed: ${e instanceof Error ? e.message : 'unexpected error'}`)
  }
}

// ---------------------------------------------------------------------------------------------------
// What the Autopilot page shows
// ---------------------------------------------------------------------------------------------------

export interface HealLoopCard {
  cap: number
  used: number
  readable: boolean
  /** A plain sentence when the day's limit is used up or unreadable; empty otherwise. */
  waiting: string
  healedToday: number
  rejectedToday: number | null
  roundsToday: number
  recent: HealLogEntry[]
}

export async function healLoopCard(admin: SupabaseClient, now: Date = new Date()): Promise<HealLoopCard> {
  const budget = await openBudget(admin, now)
  const log = await readHealLog(admin)
  const day = repairDay(now)
  const today = log.filter((e) => repairDay(new Date(e.at)) === day)
  const waiting = !budget.readable
    ? `The heal limit could not be read (${budget.reason ?? 'unknown'}), so no automatic rewriting ran. This is safe; it will retry on the next pass.`
    : budget.cap === 0
      ? 'Automatic rewriting of held drafts is switched off (the daily limit is 0).'
      : budget.remaining() === 0
        ? `Today's rewriting limit (${budget.cap} AI calls) is used up. Held drafts wait and are tried again tomorrow. Nothing is wrong.`
        : ''
  return {
    cap: budget.cap,
    used: budget.used,
    readable: budget.readable,
    waiting,
    healedToday: today.filter((e) => e.status === 'healed').length,
    rejectedToday: await rejectedToday(admin, now),
    roundsToday: today.reduce((n, e) => n + e.rounds, 0),
    recent: log.slice(-8).reverse(),
  }
}
