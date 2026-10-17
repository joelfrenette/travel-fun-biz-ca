import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { anthropicText, callAnthropic, isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import { findDuplicate } from '@/lib/content-dedupe'
import { OPPORTUNITY_LABEL, removeDashes, type Opportunity } from '@/lib/keyword-cluster'
import { trackKeyword, type KeywordCountry } from '@/lib/keywords'
import { cleanPropertyName, GUIDE_PRIORITY_DAYS, GUIDE_PRIORITY_KEY, guidePath, kindFromPackageName, parseGuidePriority, type GuideKind, type PriorityGuide } from '@/lib/guides'
import { isPastTrip } from '@/lib/past-trip'
import { getDistributionMode } from '@/lib/distribution'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { packageDistributionPath, packageDistributionSlug } from '@/lib/guide-post-source'
import { bestTimePath, listPageCopyCandidates } from '@/lib/page-copy'
import { SITE_ID } from '@/lib/site'
import { generateSlug } from '@/lib/utils'

// "Promote this package" (growth loop WP15). One click on a live trip builds a PLAN of marketing actions around it
// and queues each into machinery that already exists, which then runs on its normal cadence and caps:
//   1 keywords  free     the trip's search phrases are tracked (the weekly engine clusters them)
//   2 ideas     1 AI call, bounded   4 to 6 blog ideas for THIS trip, checked in plain code, saved as approved
//   3 guides    free     the destination and any named hotel, resort or ship go to the front of the guide line (30 days)
//   4 social    free     ONE post about the trip page, in the existing post ledger (held or queued by distribution mode)
//   5 pages     free     a note on whether the compare and best-time pages exist
// Nothing here posts, renders or spends outside the existing daily and weekly caps, and nothing touches the send path.
// A trip that already happened is refused (its recap page does the promoting). At most one promotion per trip per 30 days.

export const PROMOTION_GAP_DAYS = 30
/** The most search phrases tracked for one trip. */
export const MAX_PHRASES = 14
/** The most blog ideas one promotion saves. */
export const MAX_IDEAS = 6
/** The output budget of the one AI call (callAnthropic enforces its own floor on top of this). */
export const IDEAS_MAX_TOKENS = 2500
/** At most this many trip posts are put into the social ledger per UTC day, across all trips. */
export const PACKAGE_ENROLMENTS_PER_DAY = 1
export const PROMOTION_FAILURES_KEY = 'promotion_failures'
export const MIGRATION_NOTE = 'One database update is missing: run migration 0039 (supabase/migrations/0039_promotions.sql) in the Supabase SQL editor.'

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

/** The columns of travel_packages a promotion reads. */
export interface PromotionPackage {
  id: string
  slug: string
  name: string
  destination: string | null
  category: string | null
  short_description: string | null
  highlights: string[] | null
  keywords: string[] | null
  itinerary: unknown
  available_from: string | null
  available_to: string | null
  status: string
  recap_mode?: string | null
}

export interface PlanIdea {
  /** blog_topic_queue id. */
  id: string
  keyword: string
  title: string
}

export interface PlanGuide {
  kind: GuideKind
  slug: string
  name: string
  parent_slug: string | null
}

export interface PlanSocial {
  slug: string
  path: string
  /** queued = will go out on the next posting pass; held = waiting for you on the Distribution screen;
   * waiting = today's trip post is already used, press the button again tomorrow; skipped = nothing was enrolled. */
  state: 'queued' | 'held' | 'waiting' | 'skipped'
  note: string
}

export interface PromotionPlan {
  version: 1
  /** Phrases tracked in keyword research. */
  keywords: string[]
  ideas: PlanIdea[]
  guides: PlanGuide[]
  social: PlanSocial | null
  /** Plain notes (for example about the compare and best-time pages). */
  notes: string[]
  /** When the guides stop being at the front of the line. */
  priority_until: string
  /** The idea ids that Pause itself moved from approved to suggested, so Resume re-approves only those. */
  moved_ids?: string[]
}

export interface PromotionRow {
  id: string
  package_id: string
  started_at: string
  plan: PromotionPlan
  status: 'active' | 'paused' | 'done'
}

export type PromotionGate = { ok: true } | { ok: false; code: 'missing' | 'draft' | 'past' | 'recent'; reason: string }

// ---------------------------------------------------------------------------------------------------
// Pure helpers (no database, no network): everything the offline check covers
// ---------------------------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const dayLabel = (d: Date) => d.toISOString().slice(0, 10)

/** Whether the trip can be promoted right now, and if not, the plain reason. `lastStartedAt` is when the trip was
 * last promoted (null = never). A trip that already happened is refused: its recap page does the promoting. */
export function canPromote(pkg: Pick<PromotionPackage, 'status' | 'available_to' | 'recap_mode'> | null, lastStartedAt: string | null, now: Date = new Date()): PromotionGate {
  if (!pkg) return { ok: false, code: 'missing', reason: 'That trip was not found.' }
  if (pkg.status !== 'published') return { ok: false, code: 'draft', reason: 'Publish this trip first. Only a live trip can be promoted.' }
  if (isPastTrip(pkg, dayLabel(now))) return { ok: false, code: 'past', reason: 'This trip already happened; its recap page does the promoting.' }
  if (lastStartedAt) {
    const at = Date.parse(lastStartedAt)
    if (Number.isFinite(at) && now.getTime() - at < PROMOTION_GAP_DAYS * 86_400_000) {
      const again = new Date(at + PROMOTION_GAP_DAYS * 86_400_000)
      return { ok: false, code: 'recent', reason: `This trip was promoted on ${dayLabel(new Date(at))}. It can be promoted again on ${dayLabel(again)}.` }
    }
  }
  return { ok: true }
}

/** A search phrase Google Ads would accept: lowercase letters, digits, spaces, apostrophes and hyphens, 3 to 80
 * characters, at most 10 words. Anything else is turned into spaces first. Null when nothing usable is left. */
export function usablePhrase(raw: string): string | null {
  const flat = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 '-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s'-]+|[\s'-]+$/g, '')
  if (flat.length < 3 || flat.length > 80 || flat.split(' ').length > 10) return null
  return flat
}

const NOT_A_NAME_START = new Set(['enjoy', 'stay', 'relax', 'visit', 'explore', 'discover', 'the', 'our', 'experience', 'join', 'sail', 'cruise', 'spend', 'unwind', 'at', 'in', 'a', 'an', 'on', 'to', 'from', 'with', 'and', 'for'])

export interface NamedProperty {
  name: string
  kind: GuideKind
}

/** The hotel, resort, ship or cruise line a trip names. From the trip NAME: the same rule the guide list already uses
 * (kindFromPackageName + cleanPropertyName). From the SHORT DESCRIPTION: only a run of capitalised words that ends in
 * Resort, Hotel, Lodge or Inn and does not start with an ordinary verb or article. Nothing is guessed beyond that. */
export function namedProperties(pkg: Pick<PromotionPackage, 'name' | 'category' | 'short_description'>): NamedProperty[] {
  const out: NamedProperty[] = []
  const add = (name: string | null, kind: GuideKind | null) => {
    if (!name || !kind) return
    const clean = cleanPropertyName(name)
    if (!clean || out.some((o) => norm(o.name) === norm(clean))) return
    out.push({ name: clean, kind })
  }
  add(pkg.name, kindFromPackageName(pkg.name, pkg.category))
  const re = /\b((?:[A-Z][A-Za-z'&.-]*\s+){1,4})(Resort|Hotel|Lodge|Inn)\b/g
  for (const m of (pkg.short_description ?? '').matchAll(re)) {
    // "Enjoy Grand Palace Hotel": the leading ordinary word is not part of the name.
    const words = m[1].trim().split(/\s+/)
    while (words.length && NOT_A_NAME_START.has(words[0].toLowerCase())) words.shift()
    if (!words.length) continue
    add(`${words.join(' ')} ${m[2]}`, m[2] === 'Resort' ? 'resorts' : 'hotels')
  }
  return out.slice(0, 2)
}

/** The search phrases for one trip, in this order: its name, "<destination> group trip", "<destination> <category>",
 * a named hotel or ship, "<destination> from canada", then up to 5 of its own keywords. Usable and unique, capped at
 * MAX_PHRASES. `country` only changes the "from ..." phrase for the future US site. */
export function buildPhrases(pkg: Pick<PromotionPackage, 'name' | 'destination' | 'category' | 'short_description' | 'keywords'>, country: string = SITE_ID): string[] {
  const dest = (pkg.destination ?? '').trim()
  const category = (pkg.category ?? '').replace(/[-_]+/g, ' ').trim()
  const raw: string[] = [pkg.name]
  if (dest) raw.push(`${dest} group trip`)
  if (dest && category) raw.push(`${dest} ${category}`)
  for (const p of namedProperties({ name: pkg.name, category: pkg.category, short_description: pkg.short_description })) raw.push(p.name)
  if (dest) raw.push(country === 'us' ? `${dest} from the united states` : `${dest} from canada`)
  raw.push(...(pkg.keywords ?? []).filter((k) => typeof k === 'string').slice(0, 5))
  const out: string[] = []
  for (const r of raw) {
    const p = usablePhrase(r)
    if (p && !out.includes(p)) out.push(p)
    if (out.length >= MAX_PHRASES) break
  }
  return out
}

/** The guides to put at the front of the line: the destination, then any named hotel, resort, ship or cruise line.
 * At most 3. Hotels and resorts are parented to the destination page. */
export function planGuides(pkg: Pick<PromotionPackage, 'name' | 'destination' | 'category' | 'short_description'>): PlanGuide[] {
  const out: PlanGuide[] = []
  const destSlug = generateSlug(pkg.destination ?? '')
  if (pkg.destination?.trim() && destSlug) out.push({ kind: 'destinations', slug: destSlug, name: pkg.destination.trim(), parent_slug: null })
  for (const p of namedProperties(pkg)) {
    const slug = generateSlug(p.name)
    if (!slug || out.some((o) => o.kind === p.kind && o.slug === slug)) continue
    out.push({ kind: p.kind, slug, name: p.name, parent_slug: (p.kind === 'hotels' || p.kind === 'resorts') && destSlug ? destSlug : null })
  }
  return out.slice(0, 3)
}

/** Place names from an itinerary value of unknown shape (an array of days, or an object holding one). Only text that
 * is really there is returned, so the model can be told "these are the cities" without inventing any. */
export function itineraryPlaces(itinerary: unknown, limit = 12): string[] {
  const out: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (out.length >= limit || depth > 3 || v == null) return
    if (typeof v === 'string') {
      const t = v.replace(/\s+/g, ' ').trim()
      if (t && t.length <= 80 && !out.includes(t)) out.push(t)
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k of ['title', 'name', 'location', 'city', 'heading', 'day_title']) {
        if (typeof o[k] === 'string' && (o[k] as string).trim()) {
          walk(o[k], depth + 1)
          return
        }
      }
      for (const k of ['days', 'stops', 'items', 'itinerary']) if (Array.isArray(o[k])) walk(o[k], depth + 1)
    }
  }
  walk(itinerary, 0)
  return out.slice(0, limit)
}

/** "March" from "2027-03-14", or null. The travel month for the "<destination> in <month>" idea. */
export function travelMonth(from: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(from ?? '')
  const i = m ? Number(m[2]) - 1 : -1
  return i >= 0 && i < 12 ? MONTHS[i] : null
}

/** The real text a blog idea may draw numbers and names from. */
export function packageFacts(pkg: Pick<PromotionPackage, 'name' | 'destination' | 'category' | 'short_description' | 'highlights' | 'itinerary' | 'available_from'>): string {
  return [pkg.name, pkg.destination ?? '', pkg.category ?? '', pkg.short_description ?? '', ...(pkg.highlights ?? []), ...itineraryPlaces(pkg.itinerary), travelMonth(pkg.available_from) ?? ''].join(' ')
}

/** The one prompt of a promotion. It only contains real text from the trip and the tracked phrases. */
export function buildIdeasPrompt(pkg: PromotionPackage, phrases: string[]): string {
  const places = itineraryPlaces(pkg.itinerary)
  const month = travelMonth(pkg.available_from)
  const props = namedProperties(pkg)
  const lines = [
    `Trip name: ${pkg.name}`,
    pkg.destination ? `Destination: ${pkg.destination}` : '',
    pkg.category ? `Trip style: ${pkg.category.replace(/[-_]+/g, ' ')}` : '',
    pkg.short_description ? `What it is: ${pkg.short_description}` : '',
    pkg.highlights?.length ? `Highlights: ${pkg.highlights.slice(0, 8).join('; ')}` : '',
    places.length ? `Places on the itinerary: ${places.join('; ')}` : '',
    props.length ? `Named hotel, resort or ship: ${props.map((p) => p.name).join('; ')}` : '',
    month ? `Travel month: ${month}` : '',
  ].filter(Boolean)
  return `You plan blog posts for a travel agency's site (hosted group trips, river and ocean cruises, singles getaways). Write ${MAX_IDEAS - 2} to ${MAX_IDEAS} blog post ideas for ONE real trip we sell. Cover different angles, each only where the trip text below supports it: the destination, the hotel or ship or cruise line when one is named, the cities or places on the itinerary, the style of trip (singles, girls trip, river cruise and so on), and the timing ("${pkg.destination ?? 'the destination'} in <travel month>") when a travel month is given.

THE TRIP (the only facts you may use):
${lines.join('\n')}

SEARCH PHRASES WE TRACK FOR IT (primary_keyword must be one of these, copied exactly):
${phrases.map((p) => `- ${p}`).join('\n')}

Rules:
- Never claim personal experience or a past trip. Never state a price, a date, availability, a count, a distance or a statistic. Do not put digits or number words in any field unless they are already in the trip text or the phrases above.
- primary_keyword: one phrase from the list above, copied exactly. Use a different primary_keyword for each idea. secondary_keywords: 0 to 4 other phrases from the list, copied exactly.
- title_idea: a clear working headline, 10 to 100 characters. angle: one sentence, 20 to 300 characters, that names the trip or its destination and says what the post helps the reader decide.
- Never use the long dash character; use commas or full stops.
- No superlatives or rankings anywhere (best, top, ultimate, number one, must-see, world-class, perfect, greatest): the quality gate rejects them.

Return ONLY minified JSON of this exact shape, nothing else:
{"ideas":[{"primary_keyword":"...","title_idea":"...","angle":"...","secondary_keywords":["..."]}]}`
}

export interface IdeaDraft {
  keyword: string
  keywords: string[]
  title_idea: string
  angle: string
}

const SUPERLATIVE = /\b(?:best|top|ultimate|number one|must-see|world-class|perfect|greatest|finest|unbeatable)\b/i
const FIRST_PERSON = /\b(?:we|i)\s+(?:went|visited|stayed|sailed|loved|tried|toured|explored)\b|\bour\s+(?:stay|visit|trip last|last trip)\b/i
const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dozen|dozens|hundred|hundreds|thousand|thousands|million|millions)\b/g
const MONTH_RE = /\b(January|February|March|April|June|July|August|September|October|November|December)\b|\b(?:in|during|every|each|late|early|mid|of)\s+(May)\b/g
/** Capitalised words that are fine in an angle without being in the trip text. */
const COMMON_PROPER = new Set(['canada', 'canadian', 'canadians'])

/** Month names in `text` (a bare "May" only counts after in, during, every and so on, since "may" is also a word). */
function monthsIn(text: string): string[] {
  return [...text.matchAll(MONTH_RE)].map((m) => m[1] ?? m[2])
}

/** Capitalised words in the middle of a sentence, which would be place or business names. Sentence starts and months are skipped. */
function properNounsIn(text: string): string[] {
  const out: string[] = []
  const re = /(^|[.!?]\s+)?\b([A-Z][a-z]{2,})\b/g
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined || m.index === 0) continue
    if (MONTHS.includes(m[2])) continue
    out.push(m[2])
  }
  return out
}
const numbersIn = (s: string) => s.match(/\d+/g) ?? []

export type IdeaCheck = { ok: true; idea: IdeaDraft; fixes: string[] } | { ok: false; problems: string[] }

/** Checks one idea the model wrote, with the same rules as the engine plan: the model is never trusted.
 *  - primary keyword must be one of the tracked phrases; secondary phrases must be tracked too (others are dropped)
 *  - sensible lengths, no dollar sign, no superlative, no first-person claim, dashes become commas
 *  - no digit or number word unless it is in the trip text or the phrases
 *  - the idea must name the trip or its destination, so the writer grounds the post in the right trip */
export function validatePromotionIdea(raw: unknown, ctx: { phrases: string[]; facts: string; names: string[] }): IdeaCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, problems: ['the idea is not an object'] }
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const problems: string[] = []
  const fixes: string[] = []

  const phraseOf = new Map(ctx.phrases.map((p) => [norm(p), p]))
  const primary = phraseOf.get(norm(str(r.primary_keyword)))
  if (!primary) problems.push(`primary keyword "${str(r.primary_keyword) || '(missing)'}" is not one of the tracked phrases`)

  const title = removeDashes(str(r.title_idea))
  const angle = removeDashes(str(r.angle))
  if (title.length < 10 || title.length > 100) problems.push('title idea is missing or not between 10 and 100 characters')
  if (angle.length < 20 || angle.length > 300) problems.push('angle is missing or not between 20 and 300 characters')
  const text = `${title} ${angle}`
  if (/[$]/.test(text)) problems.push('mentions a price')
  const superlative = text.replace(/\bbest (?:time|times|season|months?)\b/gi, '').match(SUPERLATIVE)
  if (superlative) problems.push(`uses a superlative ("${superlative[0]}")`)
  if (FIRST_PERSON.test(text)) problems.push('claims a personal experience')

  const allowedText = `${ctx.phrases.join(' ')} ${ctx.facts}`
  const allowedNumbers = new Set(numbersIn(allowedText))
  const stray = numbersIn(text).filter((n) => !allowedNumbers.has(n))
  const haystack = ` ${norm(allowedText).replace(/[^a-z0-9 ]/g, ' ')} `
  stray.push(...(text.toLowerCase().match(NUMBER_WORDS) ?? []).filter((w) => !haystack.includes(` ${w} `)))
  if (stray.length) problems.push(`uses a number that is not in the trip text or the phrases (${[...new Set(stray)].join(', ')})`)

  // A month must be the trip's own travel month (or written in the trip text); no other month is invented.
  const strayMonths = monthsIn(text).filter((mo) => !haystack.includes(` ${mo.toLowerCase()} `))
  if (strayMonths.length) problems.push(`names a month that is not in the trip text (${[...new Set(strayMonths)].join(', ')})`)
  // A place or business name in the angle must be in the trip text or the phrases (no invented Cities, hotels or lines).
  const strayNames = properNounsIn(angle).filter((w) => !haystack.includes(` ${w.toLowerCase()} `) && !COMMON_PROPER.has(w.toLowerCase()))
  if (strayNames.length) problems.push(`names a place or business that is not in the trip text (${[...new Set(strayNames)].join(', ')})`)

  const named = ctx.names.map((n) => norm(n)).filter(Boolean)
  const lower = norm(`${text} ${primary ?? ''}`)
  if (named.length && !named.some((n) => lower.includes(n))) problems.push('does not name the trip or its destination')

  if (problems.length || !primary) return { ok: false, problems }

  const secondary: string[] = []
  for (const w of Array.isArray(r.secondary_keywords) ? (r.secondary_keywords as unknown[]) : []) {
    const real = phraseOf.get(norm(str(w)))
    if (!real) fixes.push(`dropped "${str(w)}": not a tracked phrase`)
    else if (real !== primary && !secondary.includes(real)) secondary.push(real)
  }
  return { ok: true, fixes, idea: { keyword: primary, keywords: [primary, ...secondary.slice(0, 4)], title_idea: title, angle } }
}

export interface DedupeContext {
  /** Existing post titles. */
  posts: string[]
  /** Queue rows in ANY status. */
  queue: { keyword: string; keywords?: string[] | null; title_idea?: string | null; angle?: string | null; status?: string | null; package_slug?: string | null }[]
  /** The trip being promoted. An idea that was already WRITTEN (status used) for this same trip does not block a new idea
   * on the same phrase when the trip is promoted again; a used idea of any other trip still does. */
  packageSlug?: string
}

/** Drops ideas whose keyword is already queued or used, or whose title is too close to a post, a queued idea or an
 * earlier idea of this same batch. Keeps the order. */
export function dedupeIdeas(ideas: IdeaDraft[], ctx: DedupeContext): { kept: IdeaDraft[]; dropped: { idea: IdeaDraft; reason: string }[] } {
  const queue = ctx.queue.filter((q) => !(ctx.packageSlug && q.status === 'used' && q.package_slug === ctx.packageSlug))
  const taken = new Set(queue.flatMap((q) => [q.keyword, ...(q.keywords ?? [])]).map(norm))
  const titles: { title: string }[] = [...ctx.posts.map((title) => ({ title })), ...queue.flatMap((q) => [q.title_idea, q.angle]).filter((t): t is string => !!t).map((title) => ({ title }))]
  const kept: IdeaDraft[] = []
  const dropped: { idea: IdeaDraft; reason: string }[] = []
  for (const idea of ideas) {
    if (taken.has(norm(idea.keyword))) {
      dropped.push({ idea, reason: `"${idea.keyword}" is already in the idea queue` })
      continue
    }
    const dup = findDuplicate(idea.title_idea, titles)
    if (dup) {
      dropped.push({ idea, reason: `too close to "${dup.title}"` })
      continue
    }
    kept.push(idea)
    taken.add(norm(idea.keyword))
    titles.push({ title: idea.title_idea })
  }
  return { kept, dropped }
}

/** The ledger row for the trip's one social post, or null when social posting is off. `prepare` waits for you on the
 * Distribution screen (held); `auto` goes out on the next posting pass (queued). */
export function socialRowFor(pkg: Pick<PromotionPackage, 'slug' | 'name'>, mode: string): { content_type: 'post'; slug: string; title: string; path: string; stage: 'held' | 'queued' } | null {
  if (mode !== 'prepare' && mode !== 'auto') return null
  return { content_type: 'post', slug: packageDistributionSlug(pkg.slug), title: pkg.name, path: packageDistributionPath(pkg.slug), stage: mode === 'auto' ? 'queued' : 'held' }
}

/** A plain note on the compare and best-time pages for the trip's destination. Pure: `paths` are the candidate pages
 * the page-copy list knows about, with whether each already has written copy. */
export function pageCopyNote(destination: string | null | undefined, candidates: { path: string; type: 'compare' | 'best-time'; hasRow: boolean }[]): string {
  const slug = generateSlug(destination ?? '')
  if (!slug) return 'No destination is set, so there is no compare or best-time page to check.'
  const best = candidates.find((c) => c.path === bestTimePath(slug))
  const compare = candidates.filter((c) => c.type === 'compare' && c.path.split('/').pop()?.split('-vs-').includes(slug))
  const parts: string[] = []
  parts.push(best ? (best.hasRow ? `The best-time page for ${destination} already has written text.` : `The best-time page for ${destination} exists and is in line to get written text.`) : `There is no best-time page for ${destination} yet.`)
  parts.push(compare.length ? `${compare.length} compare page${compare.length === 1 ? '' : 's'} include${compare.length === 1 ? 's' : ''} ${destination}${compare.some((c) => !c.hasRow) ? ' (some are in line to get written text)' : ''}.` : `No compare page includes ${destination} yet.`)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------------------------------
// Failures (shown in Needs attention)
// ---------------------------------------------------------------------------------------------------

export interface PromotionFailure {
  name: string
  /** One plain line per step that did not work, for example "ideas: the AI key is not set". */
  steps: string[]
  at: string
}

export async function readPromotionFailures(admin: SupabaseClient): Promise<Record<string, PromotionFailure>> {
  const raw = await getSetting(admin, PROMOTION_FAILURES_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PromotionFailure>) : {}
  } catch {
    return {}
  }
}

async function recordPromotionFailure(admin: SupabaseClient, packageId: string, name: string, steps: string[]): Promise<void> {
  const { value, error } = await getSettingStrict(admin, PROMOTION_FAILURES_KEY)
  if (error) return
  let all: Record<string, PromotionFailure> = {}
  try {
    const parsed = JSON.parse(value || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed
  } catch {
    all = {}
  }
  if (steps.length) all[packageId] = { name, steps: steps.map((s) => s.slice(0, 300)).slice(0, 6), at: new Date().toISOString() }
  else delete all[packageId]
  await setSetting(admin, PROMOTION_FAILURES_KEY, JSON.stringify(all))
}

/** Replaces (or, with null, removes) the failure line of one step ("ideas", "keywords" ...) for one trip, keeping its other lines. */
async function setFailureStep(admin: SupabaseClient, packageId: string, name: string, step: string, line: string | null): Promise<void> {
  const all = await readPromotionFailures(admin)
  const kept = (all[packageId]?.steps ?? []).filter((s) => !s.startsWith(`${step}:`))
  await recordPromotionFailure(admin, packageId, name, line ? [...kept, line] : kept)
}

/** The Dismiss button on the Needs attention item. */
export async function clearAllPromotionFailures(admin: SupabaseClient): Promise<{ error?: string }> {
  return setSetting(admin, PROMOTION_FAILURES_KEY, '')
}

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

const PACKAGE_COLUMNS = 'id, slug, name, destination, category, short_description, highlights, keywords, itinerary, available_from, available_to, status'

async function loadPackage(admin: SupabaseClient, id: string): Promise<PromotionPackage | null> {
  let res = await admin.from('travel_packages').select(`${PACKAGE_COLUMNS}, recap_mode`).eq('id', id).maybeSingle()
  if (res.error && /recap_mode|column|schema cache/i.test(res.error.message)) res = (await admin.from('travel_packages').select(PACKAGE_COLUMNS).eq('id', id).maybeSingle()) as typeof res
  if (res.error) throw new Error(res.error.message)
  return (res.data as PromotionPackage | null) ?? null
}

/** A claim row that was inserted but never filled in (the request died half way): empty plan, older than 10 minutes.
 * It is ignored by the 30-day check and removed when the trip is promoted again. */
export function isAbandonedClaim(row: Pick<PromotionRow, 'plan' | 'started_at'> | null, now: Date = new Date()): boolean {
  if (!row) return false
  const empty = !row.plan || Object.keys(row.plan).length === 0
  const at = Date.parse(row.started_at)
  return empty && Number.isFinite(at) && now.getTime() - at > 10 * 60_000
}

/** Ids from outside are checked before they reach the database. */
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

const isMissingTable = (message: string) => /package_promotions|relation|schema cache|does not exist/i.test(message)

/** The newest promotion row of a trip, or the reason it could not be read. */
async function latestPromotion(admin: SupabaseClient, packageId: string): Promise<{ row: PromotionRow | null; error?: string; needsMigration?: boolean }> {
  const { data, error } = await admin.from('package_promotions').select('id, package_id, started_at, plan, status').eq('package_id', packageId).order('started_at', { ascending: false }).limit(1)
  if (error) return { row: null, error: error.message, needsMigration: isMissingTable(error.message) }
  return { row: ((data ?? [])[0] as PromotionRow | undefined) ?? null }
}

export interface PromotionProgress {
  keywords: { keyword: string; opportunity: string | null }[]
  ideas: { id: string; keyword: string; title: string; status: string; postSlug: string | null }[]
  guides: { kind: GuideKind; slug: string; name: string; state: 'written' | 'draft' | 'waiting'; href: string | null }[]
  social: { state: string; networks: string[]; note: string } | null
  performance: { clicks: number | null; visits: number | null; leads: number | null; day: string } | null
}

export interface PromotionState {
  migrated: boolean
  slug: string
  name: string
  gate: PromotionGate
  promotion: (Omit<PromotionRow, 'plan'> & { plan: PromotionPlan }) | null
  progress: PromotionProgress | null
}

/** Everything the panel shows. Never throws on a missing migration: it says so instead. */
export async function readPromotionState(admin: SupabaseClient, packageId: string, now: Date = new Date()): Promise<PromotionState | null> {
  if (!isUuid(packageId)) return null
  const pkg = await loadPackage(admin, packageId)
  if (!pkg) return null
  const latest = await latestPromotion(admin, packageId)
  if (latest.error && !latest.needsMigration) throw new Error(latest.error)
  // A claim that never got filled in is not a promotion (startPromotion removes it on the next click).
  const row = isAbandonedClaim(latest.row, now) ? null : latest.row
  const gate = canPromote(pkg, row?.started_at ?? null, now)
  const base = { slug: pkg.slug, name: pkg.name, gate, migrated: !latest.needsMigration }
  if (!row) return { ...base, promotion: null, progress: null }
  const plan = { ...emptyPlan(), ...(row.plan ?? {}) } as PromotionPlan
  return { ...base, promotion: { ...row, plan }, progress: await readProgress(admin, pkg, plan) }
}

function emptyPlan(): PromotionPlan {
  return { version: 1, keywords: [], ideas: [], guides: [], social: null, notes: [], priority_until: '' }
}

async function readProgress(admin: SupabaseClient, pkg: PromotionPackage, plan: PromotionPlan): Promise<PromotionProgress> {
  const progress: PromotionProgress = { keywords: [], ideas: [], guides: [], social: null, performance: null }
  try {
    if (plan.keywords.length) {
      let res = await admin.from('keyword_research').select('keyword, opportunity').in('keyword', plan.keywords).eq('country', SITE_ID)
      if (res.error) res = (await admin.from('keyword_research').select('keyword').in('keyword', plan.keywords).eq('country', SITE_ID)) as typeof res
      const label = new Map(((res.data ?? []) as { keyword: string; opportunity?: string | null }[]).map((r) => [r.keyword, r.opportunity ?? null]))
      progress.keywords = plan.keywords.map((keyword) => {
        const o = label.get(keyword)
        return { keyword, opportunity: o ? (OPPORTUNITY_LABEL[o as Opportunity] ?? o) : null }
      })
    }
    const ids = plan.ideas.map((i) => i.id)
    if (ids.length) {
      const { data } = await admin.from('blog_topic_queue').select('id, status, used_slug').in('id', ids)
      const by = new Map(((data ?? []) as { id: string; status: string; used_slug: string | null }[]).map((r) => [r.id, r]))
      progress.ideas = plan.ideas.map((i) => ({ id: i.id, keyword: i.keyword, title: i.title, status: by.get(i.id)?.status ?? 'removed', postSlug: by.get(i.id)?.used_slug ?? null }))
    }
    if (plan.guides.length) {
      const { data } = await admin.from('guides').select('kind, slug, status').in('slug', plan.guides.map((g) => g.slug))
      const by = new Map(((data ?? []) as { kind: string; slug: string; status: string }[]).map((r) => [`${r.kind}:${r.slug}`, r.status]))
      progress.guides = plan.guides.map((g) => {
        const s = by.get(`${g.kind}:${g.slug}`)
        return { kind: g.kind, slug: g.slug, name: g.name, state: s === 'published' ? 'written' : s ? 'draft' : 'waiting', href: s === 'published' ? guidePath(g.kind, g.slug) : null }
      })
    }
    if (plan.social) {
      const { data } = await admin.from('post_distribution').select('stage, sent_platforms').eq('content_type', 'post').eq('slug', plan.social.slug).maybeSingle()
      const row = data as { stage: string; sent_platforms: string[] | null } | null
      progress.social = { state: row ? row.stage : plan.social.state, networks: row?.sent_platforms ?? [], note: plan.social.note }
    }
    const { data: perf } = await admin.from('content_performance').select('day, clicks, visits, leads').eq('path', `/packages/${pkg.slug}`).order('day', { ascending: false }).limit(1)
    const p = ((perf ?? [])[0] as { day: string; clicks: number | null; visits: number | null; leads: number | null } | undefined) ?? null
    if (p) progress.performance = { day: p.day, clicks: p.clicks, visits: p.visits, leads: p.leads }
  } catch {
    // progress is a nicety: a read problem leaves a section empty, never breaks the panel
  }
  return progress
}

// ---------------------------------------------------------------------------------------------------
// Starting a promotion
// ---------------------------------------------------------------------------------------------------

export type StartResult =
  | { ok: true; promotion: PromotionRow; failures: string[] }
  | { ok: false; status: number; code: string; error: string; failures?: string[] }

async function stepKeywords(phrases: string[]): Promise<{ tracked: string[]; error?: string }> {
  const tracked: string[] = []
  let firstError: string | undefined
  for (const p of phrases) {
    try {
      await trackKeyword(p, SITE_ID as KeywordCountry)
      tracked.push(p)
    } catch (e) {
      firstError ??= e instanceof Error ? e.message : 'unknown error'
    }
  }
  return tracked.length ? { tracked, error: firstError && tracked.length < phrases.length ? `${phrases.length - tracked.length} phrase(s) could not be saved (${firstError})` : undefined } : { tracked, error: firstError ?? 'no usable search phrase could be built from this trip' }
}

async function stepIdeas(admin: SupabaseClient, pkg: PromotionPackage, phrases: string[]): Promise<{ ideas: PlanIdea[]; notes: string[]; error?: string }> {
  const notes: string[] = []
  if (!isAiConfigured()) return { ideas: [], notes, error: 'the AI key is not set (ANTHROPIC_API_KEY in Vercel), so no blog ideas were written' }
  const r = await callAnthropic({ max_tokens: IDEAS_MAX_TOKENS, messages: [{ role: 'user', content: buildIdeasPrompt(pkg, phrases) }] }, { timeoutMs: 60_000, feature: 'promotion' })
  if (!r || !r.res.ok) return { ideas: [], notes, error: `the AI call failed${r ? ` (status ${r.res.status})` : ' (no answer)'}` }
  const data = await r.res.json()
  if ((data as { stop_reason?: string })?.stop_reason === 'max_tokens') return { ideas: [], notes, error: 'the AI answer was cut off' }
  const parsed = parseModelJson<{ ideas?: unknown[] }>(anthropicText(data))
  if (!parsed || !Array.isArray(parsed.ideas)) return { ideas: [], notes, error: 'the AI answer was not usable' }

  const ctx = { phrases, facts: packageFacts(pkg), names: [pkg.name, pkg.destination ?? ''].filter(Boolean) }
  const valid: IdeaDraft[] = []
  for (const raw of parsed.ideas.slice(0, MAX_IDEAS + 2)) {
    const checked = validatePromotionIdea(raw, ctx)
    if (checked.ok) valid.push(checked.idea)
    else notes.push(`An idea was left out: ${checked.problems.join('; ')}.`)
  }

  const [{ data: posts }, queueRes] = await Promise.all([
    admin.from('posts').select('title').order('created_at', { ascending: false }).limit(200),
    admin.from('blog_topic_queue').select('keyword, keywords, title_idea, angle, status, package_slug').limit(500),
  ])
  let queue = (queueRes.data ?? []) as DedupeContext['queue']
  if (queueRes.error) queue = ((await admin.from('blog_topic_queue').select('keyword').limit(500)).data ?? []) as DedupeContext['queue']
  const { kept, dropped } = dedupeIdeas(valid, { posts: ((posts ?? []) as { title: string }[]).map((p) => p.title), queue, packageSlug: pkg.slug })
  for (const d of dropped) notes.push(`An idea was left out: ${d.reason}.`)

  const ideas: PlanIdea[] = []
  for (const idea of kept.slice(0, MAX_IDEAS)) {
    const { data: row, error } = await admin
      .from('blog_topic_queue')
      .insert({
        angle: idea.angle,
        keyword: idea.keyword,
        why: `Made for the trip "${pkg.name}" by Promote this package`,
        source: 'promote package',
        status: 'approved',
        keywords: idea.keywords,
        title_idea: idea.title_idea,
        package_slug: pkg.slug,
      })
      .select('id')
      .single()
    if (error) {
      if ((error as { code?: string }).code === '23505') notes.push(`An idea was left out: "${idea.keyword}" is already queued.`)
      else return { ideas, notes, error: `could not save an idea (${error.message})` }
      continue
    }
    ideas.push({ id: (row as { id: string }).id, keyword: idea.keyword, title: idea.title_idea })
  }
  if (!ideas.length) return { ideas, notes, error: 'none of the AI ideas passed the checks, or all were already covered' }
  return { ideas, notes }
}

async function stepGuides(admin: SupabaseClient, pkg: PromotionPackage, guides: PlanGuide[], until: string): Promise<{ error?: string }> {
  if (!guides.length) return { error: 'this trip has no destination, so there is no guide page to put first' }
  const { value, error } = await getSettingStrict(admin, GUIDE_PRIORITY_KEY)
  if (error) return { error: `could not read the guide list (${error})` }
  const mine = new Set(guides.map((g) => `${g.kind}:${g.slug}`))
  const keep = parseGuidePriority(value).filter((e) => !mine.has(`${e.kind}:${e.slug}`))
  const next: PriorityGuide[] = [...keep, ...guides.map((g) => ({ ...g, until, package_slug: pkg.slug }))]
  const saved = await setSetting(admin, GUIDE_PRIORITY_KEY, JSON.stringify(next.slice(-40)))
  return saved.error ? { error: `could not save the guide list (${saved.error})` } : {}
}

/** Puts the trip's one social post into the ledger. Never throws; says in plain words what happened. One per trip per 30
 * days, and at most PACKAGE_ENROLMENTS_PER_DAY across all trips per UTC day. The send path is not touched: the existing
 * posting pass sends the row, with its usual captions, hook rotation and UTM tags (campaign = the ledger slug). */
export async function enrolPackagePost(admin: SupabaseClient, pkg: Pick<PromotionPackage, 'slug' | 'name' | 'status' | 'available_to' | 'recap_mode'>, now: Date = new Date()): Promise<PlanSocial> {
  const slug = packageDistributionSlug(pkg.slug)
  const path = packageDistributionPath(pkg.slug)
  const result = (state: PlanSocial['state'], note: string): PlanSocial => ({ slug, path, state, note })
  try {
    if (pkg.status !== 'published' || isPastTrip(pkg, dayLabel(now))) return result('skipped', 'The trip is not live, so nothing was posted.')
    const mode = await getDistributionMode(admin)
    if (mode === 'off') return result('skipped', 'Social posting is off (Distribution mode), so no post was queued.')
    if (await isAutomationPaused(admin)) return result('skipped', 'Automation is paused, so no post was queued.')

    const { data: existing, error: readError } = await admin.from('post_distribution').select('stage, created_at').eq('content_type', 'post').eq('slug', slug).maybeSingle()
    if (readError) return result('skipped', `Could not check the post list (${readError.message}), so no post was queued.`)
    const old = existing as { stage: string; created_at: string } | null
    const aged = old && now.getTime() - Date.parse(old.created_at) >= PROMOTION_GAP_DAYS * 86_400_000
    if (old && !(aged && old.stage === 'done')) return result('skipped', 'This trip already has a social post in the list, so no second one was added.')

    const dayStart = `${dayLabel(now)}T00:00:00.000Z`
    const used = await enrolmentsSince(admin, dayStart)
    if (used === null) return result('skipped', 'Could not count today\'s trip posts, so no post was queued.')
    if (used >= PACKAGE_ENROLMENTS_PER_DAY) return result('waiting', 'Today\'s trip post is already used by another trip. Press "Queue the social post" again tomorrow.')

    const row = socialRowFor(pkg, mode)
    if (!row) return result('skipped', 'Social posting is off, so no post was queued.')
    if (old) {
      // The earlier post is over 30 days old and finished: start its ledger row again so the trip is posted afresh.
      const { error } = await admin.from('post_distribution').update({ stage: row.stage, sent_platforms: [], attempts: 0, last_error: null, provider_request_id: null, provider_job_id: null, title: row.title, path: row.path, created_at: now.toISOString(), updated_at: now.toISOString() }).eq('content_type', 'post').eq('slug', slug)
      if (error) return result('skipped', `Could not queue the post (${error.message}).`)
    } else {
      const { error } = await admin.from('post_distribution').insert(row)
      if (error) return result('skipped', `Could not queue the post (${error.message}).`)
    }
    // Two clicks in the same instant could both pass the count above. Count again and take this one back out if over.
    const after = await enrolmentsSince(admin, dayStart)
    if (after === null || after > PACKAGE_ENROLMENTS_PER_DAY) {
      if (!old) await admin.from('post_distribution').delete().eq('content_type', 'post').eq('slug', slug).neq('stage', 'done')
      return result('waiting', 'Today\'s trip post was just used by another click. Press "Queue the social post" again tomorrow.')
    }
    return row.stage === 'held' ? result('held', 'The post is waiting for you on the Distribution screen. Release it there when you are happy.') : result('queued', 'The post will go out on the next posting pass.')
  } catch (e) {
    return result('skipped', `Could not queue the post (${e instanceof Error ? e.message : 'unknown error'}).`)
  }
}

/** Trip posts put into the ledger since `sinceIso` (slug starts with package-), or null when it could not be counted. */
async function enrolmentsSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  const { count, error } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'package-%').not('path', 'is', null).gte('created_at', sinceIso)
  return error ? null : (count ?? 0)
}

async function stepPages(pkg: PromotionPackage, admin: SupabaseClient): Promise<string> {
  try {
    return pageCopyNote(pkg.destination, await listPageCopyCandidates(admin))
  } catch (e) {
    return `Could not check the compare and best-time pages (${e instanceof Error ? e.message : 'unknown error'}).`
  }
}

/** The whole click. Refuses a draft, a past trip and a trip promoted in the last 30 days. Each step runs on its own: one
 * that fails does not stop the others, and is listed in Needs attention with plain steps. When NO step did anything the
 * promotion row is removed again, so a total failure does not use up the 30 days. */
export async function startPromotion(admin: SupabaseClient, packageId: string, now: Date = new Date()): Promise<StartResult> {
  if (!isUuid(packageId)) return { ok: false, status: 404, code: 'missing', error: 'That trip was not found.' }
  const pkg = await loadPackage(admin, packageId)
  if (!pkg) return { ok: false, status: 404, code: 'missing', error: 'That trip was not found.' }

  let latest = await latestPromotion(admin, packageId)
  // A claim row from a request that died half way (empty plan, over 10 minutes old) is removed so it cannot lock the trip for 30 days.
  if (latest.row && isAbandonedClaim(latest.row, now)) {
    await admin.from('package_promotions').delete().eq('id', latest.row.id)
    latest = await latestPromotion(admin, packageId)
  }
  if (latest.needsMigration) return { ok: false, status: 503, code: 'needs-migration', error: MIGRATION_NOTE }
  // Fail closed: if the last promotion cannot be read, nothing is queued.
  if (latest.error) return { ok: false, status: 500, code: 'read-failed', error: `Could not check when this trip was last promoted, so nothing was done (${latest.error}).` }
  const gate = canPromote(pkg, latest.row?.started_at ?? null, now)
  if (!gate.ok) return { ok: false, status: gate.code === 'missing' ? 404 : 409, code: gate.code, error: gate.reason }

  const { data: claim, error: claimError } = await admin.from('package_promotions').insert({ package_id: packageId, started_at: now.toISOString(), plan: {}, status: 'active' }).select('id').single()
  if (claimError || !claim) return { ok: false, status: 500, code: 'claim-failed', error: `Could not start the promotion (${claimError?.message ?? 'no row'}).` }
  const claimId = (claim as { id: string }).id
  const since = new Date(now.getTime() - PROMOTION_GAP_DAYS * 86_400_000).toISOString()
  const { data: mine, error: mineError } = await admin.from('package_promotions').select('id').eq('package_id', packageId).gte('started_at', since).order('started_at', { ascending: true }).order('id', { ascending: true })
  if (mineError || ((mine ?? []) as { id: string }[])[0]?.id !== claimId) {
    await admin.from('package_promotions').delete().eq('id', claimId)
    return mineError ? { ok: false, status: 500, code: 'read-failed', error: `Could not double-check the promotion (${mineError.message}), so nothing was done.` } : { ok: false, status: 409, code: 'recent', error: 'Another click on this trip was handled a moment ago. Reload the page to see it.' }
  }

  const failures: string[] = []
  const plan = emptyPlan()
  const until = new Date(now.getTime() + GUIDE_PRIORITY_DAYS * 86_400_000).toISOString()
  plan.priority_until = until
  let worked = 0

  const phrases = buildPhrases(pkg)
  try {
    const k = await stepKeywords(phrases)
    plan.keywords = k.tracked
    if (k.tracked.length) worked++
    if (k.error) failures.push(`keywords: ${k.error}`)
  } catch (e) {
    failures.push(`keywords: ${e instanceof Error ? e.message : 'unknown error'}`)
  }

  try {
    const i = await stepIdeas(admin, pkg, plan.keywords.length ? plan.keywords : phrases)
    plan.ideas = i.ideas
    plan.notes.push(...i.notes)
    if (i.ideas.length) worked++
    if (i.error) failures.push(`ideas: ${i.error}`)
  } catch (e) {
    failures.push(`ideas: ${e instanceof Error ? e.message : 'unknown error'}`)
  }

  const guides = planGuides(pkg)
  try {
    const g = await stepGuides(admin, pkg, guides, until)
    if (g.error) failures.push(`guides: ${g.error}`)
    else {
      plan.guides = guides
      worked++
    }
  } catch (e) {
    failures.push(`guides: ${e instanceof Error ? e.message : 'unknown error'}`)
  }

  plan.social = await enrolPackagePost(admin, pkg, now)
  if (plan.social.state === 'queued' || plan.social.state === 'held') worked++
  else if (plan.social.state === 'waiting') plan.notes.push(plan.social.note)

  plan.notes.push(await stepPages(pkg, admin))

  if (worked === 0) {
    await admin.from('package_promotions').delete().eq('id', claimId)
    await recordPromotionFailure(admin, packageId, pkg.name, failures.length ? failures : ['nothing could be queued'])
    return { ok: false, status: 502, code: 'nothing-worked', error: 'Nothing could be queued, so this did not use up the 30 days. The reasons are in Needs attention on the Autopilot page.', failures }
  }

  const { data: saved, error: saveError } = await admin.from('package_promotions').update({ plan }).eq('id', claimId).select('id, package_id, started_at, plan, status').single()
  if (saveError || !saved) {
    failures.push(`plan: could not save the plan (${saveError?.message ?? 'no row'})`)
    await recordPromotionFailure(admin, packageId, pkg.name, failures)
    return { ok: true, promotion: { id: claimId, package_id: packageId, started_at: now.toISOString(), plan, status: 'active' }, failures }
  }
  await recordPromotionFailure(admin, packageId, pkg.name, failures)
  return { ok: true, promotion: saved as PromotionRow, failures }
}

// ---------------------------------------------------------------------------------------------------
// After the click: pause, resume, finish, queue the social post again
// ---------------------------------------------------------------------------------------------------

export type PromotionAction = 'pause' | 'resume' | 'done' | 'retry-social' | 'retry-ideas'

/** Why an action cannot run on a promotion in this state, or null when it can. Pure. */
export function actionBlockedReason(action: PromotionAction, status: PromotionRow['status']): string | null {
  if (action === 'done') return status === 'done' ? 'This promotion is already finished.' : null
  if (status === 'done') return 'This promotion is finished, so it cannot be changed. Mark-as-finished is final.'
  if (action === 'pause') return status === 'paused' ? 'This promotion is already paused.' : null
  if (action === 'resume') return status !== 'paused' ? 'This promotion is not paused.' : null
  return status !== 'active' ? 'Resume this promotion first.' : null
}

export async function updatePromotion(admin: SupabaseClient, packageId: string, action: PromotionAction, now: Date = new Date()): Promise<{ ok: true; note: string } | { ok: false; status: number; error: string }> {
  if (!isUuid(packageId)) return { ok: false, status: 404, error: 'That trip was not found.' }
  const pkg = await loadPackage(admin, packageId)
  if (!pkg) return { ok: false, status: 404, error: 'That trip was not found.' }
  const latest = await latestPromotion(admin, packageId)
  if (latest.needsMigration) return { ok: false, status: 503, error: MIGRATION_NOTE }
  if (latest.error) return { ok: false, status: 500, error: latest.error }
  const row = latest.row
  if (!row) return { ok: false, status: 409, error: 'This trip has not been promoted yet.' }
  const plan = { ...emptyPlan(), ...(row.plan ?? {}) } as PromotionPlan
  const ids = plan.ideas.map((i) => i.id)
  const setStatus = async (status: PromotionRow['status'], nextPlan: PromotionPlan = plan) => {
    const { error } = await admin.from('package_promotions').update({ status, plan: nextPlan }).eq('id', row.id)
    return error ? error.message : null
  }

  const blocked = actionBlockedReason(action, row.status)
  if (blocked) return { ok: false, status: 409, error: blocked }

  if (action === 'done') {
    const err = await setStatus('done')
    return err ? { ok: false, status: 500, error: err } : { ok: true, note: 'Marked as finished. What was queued keeps running; nothing was taken back.' }
  }

  if (action === 'pause') {
    // Ideas that were not written yet go back to "suggested" (so the writer stops picking them), and the guides leave the front of the line.
    // Remember exactly which ideas Pause moved, so Resume puts back only those (never an idea the admin put on hold).
    let moved: string[] = []
    if (ids.length) {
      const { data: approved, error: readIdeas } = await admin.from('blog_topic_queue').select('id').in('id', ids).eq('status', 'approved')
      if (readIdeas) return { ok: false, status: 500, error: readIdeas.message }
      moved = ((approved ?? []) as { id: string }[]).map((r) => r.id)
      if (moved.length) {
        const { error } = await admin.from('blog_topic_queue').update({ status: 'suggested' }).in('id', moved).eq('status', 'approved')
        if (error) return { ok: false, status: 500, error: error.message }
      }
    }
    plan.moved_ids = moved
    const { value, error: readError } = await getSettingStrict(admin, GUIDE_PRIORITY_KEY)
    if (readError) return { ok: false, status: 500, error: readError }
    const mine = new Set(plan.guides.map((g) => `${g.kind}:${g.slug}`))
    const left = parseGuidePriority(value).filter((e) => !(e.package_slug === pkg.slug && mine.has(`${e.kind}:${e.slug}`)))
    const saved = await setSetting(admin, GUIDE_PRIORITY_KEY, JSON.stringify(left))
    if (saved.error) return { ok: false, status: 500, error: saved.error }
    const err = await setStatus('paused')
    return err ? { ok: false, status: 500, error: err } : { ok: true, note: 'Paused. Unwritten blog ideas went back to suggested and the guides left the front of the line. Anything already posted or written stays.' }
  }

  if (action === 'resume') {
    const gate = canPromote(pkg, null, now)
    if (!gate.ok) return { ok: false, status: 409, error: gate.reason }
    const moved = plan.moved_ids ?? []
    if (moved.length) {
      const { error } = await admin.from('blog_topic_queue').update({ status: 'approved' }).in('id', moved).eq('status', 'suggested')
      if (error) return { ok: false, status: 500, error: error.message }
    }
    const until = new Date(now.getTime() + GUIDE_PRIORITY_DAYS * 86_400_000).toISOString()
    const g = await stepGuides(admin, pkg, plan.guides, until)
    if (g.error) return { ok: false, status: 500, error: g.error }
    const err = await setStatus('active', { ...plan, priority_until: until, moved_ids: [] })
    return err ? { ok: false, status: 500, error: err } : { ok: true, note: 'Resumed. Ideas are approved again and the guides are back at the front of the line for 30 days.' }
  }

  if (action === 'retry-ideas') {
    const g0 = canPromote(pkg, null, now)
    if (!g0.ok) return { ok: false, status: 409, error: g0.reason }
    // Only when the click saved no ideas, so a retry can never pile up more AI calls on a trip that already has them.
    if (plan.ideas.length > 0) return { ok: false, status: 409, error: 'This promotion already has blog ideas.' }
    const phrases = plan.keywords.length ? plan.keywords : buildPhrases(pkg)
    let result: Awaited<ReturnType<typeof stepIdeas>>
    try {
      result = await stepIdeas(admin, pkg, phrases)
    } catch (e) {
      result = { ideas: [], notes: [], error: e instanceof Error ? e.message : 'unknown error' }
    }
    if (result.error) {
      await setFailureStep(admin, packageId, pkg.name, 'ideas', `ideas: ${result.error}`)
      return { ok: false, status: 502, error: `No blog ideas were saved: ${result.error}.` }
    }
    const notes = [...new Set([...plan.notes, ...result.notes])]
    const err = await setStatus('active', { ...plan, ideas: result.ideas, notes })
    if (err) return { ok: false, status: 500, error: err }
    await setFailureStep(admin, packageId, pkg.name, 'ideas', null)
    return { ok: true, note: `${result.ideas.length} blog idea${result.ideas.length === 1 ? '' : 's'} saved and approved.` }
  }

  // retry-social
  const gate = canPromote(pkg, null, now)
  if (!gate.ok) return { ok: false, status: 409, error: gate.reason }
  if (plan.social && (plan.social.state === 'queued' || plan.social.state === 'held')) return { ok: false, status: 409, error: 'The social post is already queued.' }
  const social = await enrolPackagePost(admin, pkg, now)
  const err = await setStatus('active', { ...plan, social })
  if (err) return { ok: false, status: 500, error: err }
  return social.state === 'queued' || social.state === 'held' ? { ok: true, note: social.note } : { ok: false, status: 409, error: social.note }
}

// ---------------------------------------------------------------------------------------------------
// The brief line
// ---------------------------------------------------------------------------------------------------

/** One line for the daily brief: which trips are being promoted right now, or null when none (or the table is not there yet). */
export async function promotionBriefLine(admin: SupabaseClient, now: Date = new Date()): Promise<string | null> {
  try {
    const since = new Date(now.getTime() - PROMOTION_GAP_DAYS * 86_400_000).toISOString()
    const { data, error } = await admin.from('package_promotions').select('package_id').eq('status', 'active').gte('started_at', since)
    if (error || !data?.length) return null
    const ids = [...new Set((data as { package_id: string }[]).map((r) => r.package_id))]
    const { data: pkgs } = await admin.from('travel_packages').select('name').in('id', ids)
    const names = ((pkgs ?? []) as { name: string }[]).map((p) => p.name)
    if (!names.length) return null
    return `Being promoted now (${names.length}): ${names.slice(0, 4).join('; ')}${names.length > 4 ? `; and ${names.length - 4} more` : ''}. Their blog ideas, guides and social post are queued and run on the normal schedule.`
  } catch {
    return null
  }
}
