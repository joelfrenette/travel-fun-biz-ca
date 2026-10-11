import type { SupabaseClient } from '@supabase/supabase-js'
import { autoPublishBlockers, cutAtWord, findOffenders, REPAIR_MIN_MS, type ComposedPost, type PublishGateContext } from '@/lib/blog-composer'
import { slugify } from '@/lib/content-dedupe'
import { guideBlockers, parseArticle, removeDashes, type ComposedGuide, type GateContext } from '@/lib/guide-composer'
import { META_DESCRIPTION_MAX, META_TITLE_MAX, OG_DESCRIPTION_MAX, OG_TITLE_MAX, pageCopyBlockers, type ComposedPageCopy, type CopyGateContext } from '@/lib/page-copy-composer'
import type { GuideSection } from '@/lib/guides'
import { claimRepairSlot, editsLoggable, insertEdits, recordRepairSpend, attachEdits, deleteEdits } from '@/lib/content-edits'
import type { DbPackage } from '@/lib/packages'
import { copyBlockers, modelCopyWriter, rowGrounding, type CopyWriter } from '@/lib/package-enrich'
import { hasFaqs, hasFaqSource } from '@/lib/package-faqs'
import { internalLinkPathsOf, type SeoInput } from '@/lib/seo-score'
import { generateSlug } from '@/lib/utils'
import {
  classifyBlockers,
  mapFields,
  stripExternalLinks,
  MIN_MS_PER_CALL,
  repairContent,
  type ContentEdit,
  type ModelCall,
  type Offender,
  type RepairFields,
  type RepairItem,
  type RepairLimits,
  type RepairResult,
} from '@/lib/content-repair'

// Connects the shared repair core (lib/content-repair.ts) to the three places content is gated when it is written:
// a blog post (lib/autoblog-run.ts), a guide (lib/guide-run.ts) and compare / best-time page copy
// (lib/page-copy-run.ts). Each wrapper turns the composed object into RepairFields, runs the kind's own gate as the
// judge, takes a daily slot, writes the audit rows BEFORE the repaired text is used ("log, then apply"), and hands
// back the repaired object. If the audit rows cannot be written, nothing is repaired: the page is blocked as before.

export interface Repaired<T> {
  value: T
  blockers: string[]
  edits: ContentEdit[]
  /** Audit row ids to point at the saved page with finalizeEdits(). */
  logIds: string[]
  calls: number
  note: string
}

/** After the page is saved: points the audit rows at it and records whether it went live. */
export async function finalizeEdits(admin: SupabaseClient, logIds: string[], saved: { id: string; path: string; published: boolean }): Promise<void> {
  await attachEdits(admin, logIds, { content_id: saved.id, path: saved.path, published_after: saved.published })
}

interface WrapOpts {
  maxCalls: number
  deadlineMs?: number
  itemKey: string
  /** Tests inject a fake model here. */
  model?: ModelCall
}

/** The shared wrapper: skip (no spend) when a HARD blocker is present, take a slot, repair, log, report. */
async function runRepair(admin: SupabaseClient, item: RepairItem, opts: WrapOpts): Promise<{ result: RepairResult; logIds: string[]; applied: boolean; note: string }> {
  const startBlockers = item.gate(item.fields)
  const untouched = (note: string, hard: string[] = []): { result: RepairResult; logIds: string[]; applied: boolean; note: string } => ({
    result: { fields: item.fields, blockers: startBlockers, hard, edits: [], calls: 0, note },
    logIds: [],
    applied: false,
    note,
  })
  if (startBlockers.length === 0) return untouched('already clean')
  // A link to another website is mended by taking the link off (the gates also flag its address as "web address in
  // text"), so the HARD check looks at the blockers that would remain after that.
  const cls = classifyBlockers(item.gate(mapFields(item.fields, stripExternalLinks)))
  if (cls.hard.length) return untouched('held for a person (a HARD blocker)', cls.hard)
  if (!(await editsLoggable(admin))) return untouched('not repaired: the content_edits table is not set up (apply migration 0033)')
  const slot = await claimRepairSlot(admin, opts.itemKey)
  if (!slot.ok) return untouched(`not repaired: ${slot.reason ?? 'no slot'}`)

  // Anything unexpected from here on leaves the page exactly as it came in (and takes back any audit rows), so a
  // repair problem can never break the write that called it.
  let loggedIds: string[] = []
  try {
    const result = await repairContent(item, { maxCalls: opts.maxCalls, deadlineMs: opts.deadlineMs, model: opts.model })
    await recordRepairSpend(admin, result.calls)
    if (result.edits.length === 0) return { result, logIds: [], applied: false, note: result.note }

    const logged = await insertEdits(admin, result.edits)
    if (logged.error) {
      // No audit row, no edit: the page is blocked exactly as it came in.
      return { result: { fields: item.fields, blockers: startBlockers, hard: [], edits: [], calls: result.calls, note: 'not repaired' }, logIds: [], applied: false, note: `not repaired: the audit log could not be written (${logged.error})` }
    }
    loggedIds = logged.ids
    return { result, logIds: logged.ids, applied: true, note: result.note }
  } catch (e) {
    await deleteEdits(admin, loggedIds).catch(() => undefined)
    return untouched(`not repaired: ${e instanceof Error ? e.message : 'unexpected error'}`)
  }
}

// ---------------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------------

const POST_LIMITS: RepairLimits = { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }

function postFields(p: ComposedPost): RepairFields {
  return {
    title: p.title,
    body: p.body,
    meta_title: p.seo_title,
    meta_description: p.seo_description,
    og_title: p.og_title ?? '',
    og_description: p.og_description ?? '',
    faq: (p.faq ?? []).map((f) => ({ ...f })),
    key_takeaways: [...(p.key_takeaways ?? [])],
  }
}

function postFrom(base: ComposedPost, f: RepairFields): ComposedPost {
  const next: ComposedPost = {
    ...base,
    title: f.title ?? base.title,
    body: f.body,
    seo_title: f.meta_title,
    seo_description: f.meta_description,
    og_title: f.og_title,
    og_description: f.og_description,
    faq: f.faq,
    key_takeaways: f.key_takeaways,
  }
  // The FAQ and takeaways were skipped for lack of time; once they exist the post is no longer short of them.
  if (next.skipped_enrich && f.faq.length >= POST_LIMITS.faqMin && f.key_takeaways.length >= POST_LIMITS.takeMin) delete next.skipped_enrich
  // The slug follows the final title (a rewritten title must not keep a slug with its old digits).
  if (next.title !== base.title) next.slug = slugify(next.title) || base.slug
  return next
}

/** The post gate plus at most ONE model call (the same limit and deadline as before), now with the shared repair:
 * plain-code fixers first, then a generated FAQ/takeaways or a reword/delete of the sentences behind a number or
 * link blocker, then the deterministic fallback. Every change is logged before it is used. `storedBody` maps the
 * body the repair sees to the body that is saved (autoblog appends its call to action on save). */
export function buildPostItem(post: ComposedPost, now: Date, ctx: PublishGateContext, opts: { storedBody?: (body: string) => string } = {}): RepairItem {
  const allowed = new Set((ctx.allowedPaths ?? []).map((p) => p.replace(/[?#].*$/, '').replace(/\/+$/, '')))
  const map = (o: ReturnType<typeof findOffenders>[number]): Offender => ({
    field: o.field === 'seo_title' ? 'meta_title' : o.field === 'seo_description' ? 'meta_description' : o.field,
    index: o.index,
    text: o.text,
    why: o.why,
    prefix: o.prefix,
  })
  return {
    type: 'post',
    id: null,
    path: `/blog/${post.slug}`,
    fields: postFields(post),
    grounding: ctx.groundingText ?? '',
    allowedPaths: allowed,
    keyword: post.primary_keyword,
    limits: POST_LIMITS,
    gate: (f) => autoPublishBlockers(postFrom(post, f), now, ctx),
    detect: (f) => findOffenders(postFrom(post, f), ctx, now).map(map),
    storedText: opts.storedBody ? (field, text) => (field === 'body' ? opts.storedBody!(text) : text) : undefined,
  }
}

export async function repairComposedPost(
  admin: SupabaseClient,
  post: ComposedPost,
  now: Date,
  ctx: PublishGateContext,
  opts: { storedBody?: (body: string) => string; model?: ModelCall } = {},
): Promise<Repaired<ComposedPost>> {
  const item = buildPostItem(post, now, ctx, opts)
  // The post path used to skip the repair call with under REPAIR_MIN_MS left; the shared check uses MIN_MS_PER_CALL.
  const deadlineMs = ctx.deadlineMs === undefined ? undefined : ctx.deadlineMs - (REPAIR_MIN_MS - MIN_MS_PER_CALL)
  const r = await runRepair(admin, item, { maxCalls: 1, deadlineMs, itemKey: `post:${post.slug}`, model: opts.model })
  if (!r.applied) return { value: post, blockers: r.result.blockers, edits: [], logIds: [], calls: r.result.calls, note: r.note }
  return { value: postFrom(post, r.result.fields), blockers: item.gate(r.result.fields), edits: r.result.edits, logIds: r.logIds, calls: r.result.calls, note: r.note }
}

// ---------------------------------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------------------------------

export const GUIDE_LIMITS: RepairLimits = { faqMin: 4, faqMax: 6, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }

export function guideFields(g: ComposedGuide): RepairFields {
  return {
    summary: g.summary,
    body: g.body,
    meta_title: g.meta_title,
    meta_description: g.meta_description,
    og_title: g.og_title,
    og_description: g.og_description,
    faq: g.faq.map((f) => ({ ...f })),
    key_takeaways: [...g.key_takeaways],
  }
}

/** The sections of a guide from its summary and body markdown; the old ones when the text no longer parses. */
export function sectionsOf(summary: string, body: string, fallback: GuideSection[]): GuideSection[] {
  return parseArticle(`${summary}\n\n${body}`)?.sections ?? fallback
}

export function guideFrom(base: ComposedGuide, f: RepairFields): ComposedGuide {
  const summary = f.summary ?? base.summary
  return {
    ...base,
    summary,
    body: f.body,
    sections: f.body === base.body && summary === base.summary ? base.sections : sectionsOf(summary, f.body, base.sections),
    meta_title: f.meta_title,
    meta_description: f.meta_description,
    og_title: f.og_title,
    og_description: f.og_description,
    faq: f.faq,
    key_takeaways: f.key_takeaways,
  }
}

export function buildGuideItem(guide: ComposedGuide, gateCtx: GateContext, opts: { path: string; links: { path: string; label: string }[] }): RepairItem {
  return {
    type: 'guide',
    id: null,
    path: opts.path,
    fields: guideFields(guide),
    grounding: gateCtx.grounding,
    names: [...(gateCtx.names ?? []), guide.name],
    allowedPaths: gateCtx.allowedPaths,
    links: opts.links,
    keyword: guide.primary_keyword,
    limits: GUIDE_LIMITS,
    gate: (f) => guideBlockers(guideFrom(guide, f), gateCtx),
  }
}

export async function repairComposedGuide(
  admin: SupabaseClient,
  guide: ComposedGuide,
  gateCtx: GateContext,
  opts: { kind: string; slug: string; path: string; links: { path: string; label: string }[]; deadlineMs?: number; model?: ModelCall },
): Promise<Repaired<ComposedGuide>> {
  const item = buildGuideItem(guide, gateCtx, opts)
  const gate = item.gate
  const r = await runRepair(admin, item, { maxCalls: 2, deadlineMs: opts.deadlineMs, itemKey: `guide:${opts.kind}:${opts.slug}`, model: opts.model })
  if (!r.applied) return { value: guide, blockers: r.result.blockers, edits: [], logIds: [], calls: r.result.calls, note: r.note }
  // A repaired body that no longer parses into sections would leave the saved sections out of step with the text: undo it.
  if (!parseArticle(`${r.result.fields.summary ?? guide.summary}\n\n${r.result.fields.body}`)) {
    await deleteEdits(admin, r.logIds)
    return { value: guide, blockers: gate(item.fields), edits: [], logIds: [], calls: r.result.calls, note: 'not repaired: the repaired text no longer split into sections' }
  }
  return { value: guideFrom(guide, r.result.fields), blockers: gate(r.result.fields), edits: r.result.edits, logIds: r.logIds, calls: r.result.calls, note: r.note }
}

// ---------------------------------------------------------------------------------------------------
// Compare and best-time page copy
// ---------------------------------------------------------------------------------------------------

export const COPY_LIMITS: RepairLimits = { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: META_TITLE_MAX, metaDescMax: META_DESCRIPTION_MAX, ogTitleMax: OG_TITLE_MAX, ogDescMax: OG_DESCRIPTION_MAX, maxBodyLinks: 3 }

export function copyFields(c: ComposedPageCopy): RepairFields {
  return {
    body: c.intro,
    meta_title: c.meta_title,
    meta_description: c.meta_description,
    og_title: c.og_title,
    og_description: c.og_description,
    faq: c.faq.map((f) => ({ ...f })),
    key_takeaways: [...c.key_takeaways],
  }
}

export function copyFrom(base: ComposedPageCopy, f: RepairFields): ComposedPageCopy {
  return {
    ...base,
    intro: f.body,
    meta_title: f.meta_title,
    meta_description: f.meta_description,
    og_title: f.og_title,
    og_description: f.og_description,
    faq: f.faq,
    key_takeaways: f.key_takeaways,
  }
}

export function buildCopyItem(copy: ComposedPageCopy, gateCtx: CopyGateContext, opts: { path: string; links: { path: string; label: string }[] }): RepairItem {
  return {
    type: 'page_copy',
    id: null,
    path: opts.path,
    fields: copyFields(copy),
    grounding: gateCtx.grounding,
    names: [...(gateCtx.names ?? []), ...gateCtx.destinations],
    allowedPaths: gateCtx.allowedPaths,
    links: opts.links,
    keyword: copy.primary_keyword,
    limits: COPY_LIMITS,
    gate: (f) => pageCopyBlockers(copyFrom(copy, f), gateCtx),
  }
}

export async function repairComposedCopy(
  admin: SupabaseClient,
  copy: ComposedPageCopy,
  gateCtx: CopyGateContext,
  opts: { path: string; links: { path: string; label: string }[]; deadlineMs?: number; model?: ModelCall },
): Promise<Repaired<ComposedPageCopy>> {
  const item = buildCopyItem(copy, gateCtx, opts)
  const gate = item.gate
  const r = await runRepair(admin, item, { maxCalls: 2, deadlineMs: opts.deadlineMs, itemKey: `page_copy:${opts.path}`, model: opts.model })
  if (!r.applied) return { value: copy, blockers: r.result.blockers, edits: [], logIds: [], calls: r.result.calls, note: r.note }
  return { value: copyFrom(copy, r.result.fields), blockers: gate(r.result.fields), edits: r.result.edits, logIds: r.logIds, calls: r.result.calls, note: r.note }
}

// ---------------------------------------------------------------------------------------------------
// Trip pages (growth loop wave 3): score a published trip and fill in its EMPTY SEO fields
// ---------------------------------------------------------------------------------------------------
//
// Everything here is pure except `writeTripMeta` (one injectable model call). The daily heal
// (lib/content-heal-run.ts) scores every published trip with buildPackageItem, and for a trip under 70 applies ONLY the
// fixes below, each only while its field is still empty, each logged to content_edits before it is applied.
// A trip page is Joel's page: the fixers cannot reach a name, slug, price, date, inclusion, itinerary, link, status or
// the description body (the one exception is a single "Related:" line added to the END of the description when the
// description has no link to another page on this site).

/** The trip fixes the heal may make. */
export type PackageFix = 'meta' | 'keywords' | 'ai_faqs' | 'links'

/** The database column each fix may write. The allow-list: nothing else on a trip row is ever written by the heal. */
export const PACKAGE_FIX_COLUMNS: Record<PackageFix, readonly string[]> = {
  meta: ['meta_title', 'meta_description'],
  keywords: ['keywords'],
  ai_faqs: ['ai_faqs'],
  links: ['full_description'],
}

/** Every column the heal may write on a trip (plus updated_at, stamped by the apply step). */
export const PACKAGE_WRITABLE_COLUMNS: readonly string[] = Object.values(PACKAGE_FIX_COLUMNS).flat()

/** Columns the heal must never write. A check asserts the allow-list above and every change it builds avoid these. */
export const PACKAGE_FORBIDDEN_COLUMNS: readonly string[] = [
  'id', 'name', 'slug', 'destination', 'country', 'region', 'category', 'tags',
  'price_display', 'price_value', 'currency', 'price_includes', 'not_included',
  'duration', 'duration_days', 'available_from', 'available_to', 'departure_dates',
  'short_description', 'highlights', 'itinerary', 'image_url', 'gallery_urls', 'journal_entries', 'video_url',
  'booking_url', 'more_info_url', 'status', 'supplier', 'featured', 'sort_order',
]

/** A trip that already happened gets the FAQ fix only: its page text is frozen (Joel's recap rule). */
export const PAST_TRIP_FIXES: readonly PackageFix[] = ['ai_faqs']

/** The one place that says a trip is in the past (the page uses the same test: the trip's end date has gone by).
 * WP14 swaps this for lib/past-trip.ts. `today` is YYYY-MM-DD. */
export function isPastTripRow(pkg: Pick<DbPackage, 'available_to'>, today: string = new Date().toISOString().slice(0, 10)): boolean {
  return !!pkg.available_to && pkg.available_to < today
}

type TripRow = Partial<DbPackage> & { id?: string }

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const LONG_DASHES = /[–—]/g

/** One FAQ pair as the trip page stores it. */
export interface TripFaq {
  question: string
  answer: string
}

/** The pairs a trip row holds, in a fixed key order (a jsonb round trip reorders keys; the audit log must not care). */
export function normTripFaqs(v: unknown): TripFaq[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((f): f is TripFaq => !!f && typeof (f as TripFaq).question === 'string' && typeof (f as TripFaq).answer === 'string')
    .map((f) => ({ question: f.question, answer: f.answer }))
}

export interface LinkTarget {
  path: string
  title: string
  dest: string | null
  rank: number
}

export interface TripCtx {
  /** Paths that exist on the site right now. */
  existing: Set<string>
  /** The trip's primary keyword from keyword_research (a row whose target_path is this page), else null (the name is used). */
  keyword: string | null
  /** YYYY-MM-DD, for the past-trip test. */
  today: string
}

export interface PackageItem {
  id: string
  path: string
  label: string
  past: boolean
  keyword: string
  seo: SeoInput
}

const textOf = (...parts: (string | null | undefined)[]) => parts.map(trimmed).filter(Boolean).join('\n\n')

/** The SEO input for one published trip, from exactly what the page shows and emits. The body is the short and the full
 * description (plain paragraphs, no headings by design, so no H2 rule); there is no takeaways box on a trip page; the
 * page always draws its picture's alt text from the trip name (it has no alt column), so a picture counts as having
 * alt text; the schema types are the ones app/packages/[slug]/page.tsx emits (TouristTrip, or Article once the trip has
 * happened, plus FAQPage when FAQs exist). The title and meta description are the trip's own fields: an empty one is
 * the gap the heal fills, even though the page would show a fallback. */
export function buildPackageItem(pkg: TripRow, ctx: TripCtx): PackageItem {
  const past = isPastTripRow({ available_to: pkg.available_to ?? null }, ctx.today)
  const full = trimmed(pkg.full_description)
  const short = trimmed(pkg.short_description)
  const body = textOf(short, full && full !== short ? full : '')
  const faq = normTripFaqs(pkg.ai_faqs).filter((f) => f.question.trim() && f.answer.trim()).map((f) => ({ q: f.question, a: f.answer }))
  const keyword = trimmed(ctx.keyword) || trimmed(pkg.name)
  const slug = trimmed(pkg.slug)
  const metaTitle = trimmed(pkg.meta_title)
  const metaDescription = trimmed(pkg.meta_description)
  const seo: SeoInput = {
    title: metaTitle,
    metaDescription,
    // A trip has no separate share text: the page shares its meta title and description.
    ogTitle: metaTitle,
    ogDescription: metaDescription,
    body,
    faq,
    takeaways: [],
    takeawaysApply: false,
    primaryKeyword: keyword || null,
    targetWords: { min: 400, max: 1500 },
    hasImageAlt: !!trimmed(pkg.image_url),
    imageApplies: true,
    internalLinks: internalLinkPathsOf(body),
    existingPaths: ctx.existing,
    jsonLdTypes: [past ? 'Article' : 'TouristTrip', ...(faq.length ? ['FAQPage'] : [])],
    jsonLdExpected: [past ? 'Article' : 'TouristTrip', 'FAQPage'],
    expectH2: false,
  }
  return { id: trimmed(pkg.id), path: `/packages/${slug}`, label: trimmed(pkg.name) || slug, past, keyword, seo }
}

// --- keywords (no model) --------------------------------------------------------------------------

/** 5 to 8 search phrases built only from words already on the trip row (name, destination, country, category, duration,
 * tags). Fewer than 5 means the row says too little, and nothing is written. Pure. */
export function tripKeywords(pkg: TripRow): string[] {
  const clean = (v: unknown) => trimmed(v).replace(LONG_DASHES, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  const dest = clean(pkg.destination)
  const name = clean(pkg.name)
  const country = clean(pkg.country)
  const category = clean(pkg.category)
  const duration = clean(pkg.duration)
  const tags = Array.isArray(pkg.tags) ? pkg.tags.map(clean).filter(Boolean).slice(0, 2) : []
  const candidates = [
    name,
    dest && `${dest} trip`,
    dest && `${dest} group trip`,
    dest && `${dest} travel package`,
    dest && `${dest} vacation`,
    dest && category && `${category} ${dest}`,
    dest && country && country !== dest && `${dest} ${country}`,
    country && `${country} group travel`,
    dest && duration && `${dest} ${duration}`,
    ...tags.map((t) => (dest ? `${t} ${dest}` : t)),
  ]
  const out: string[] = []
  for (const c of candidates) {
    if (!c || c.length > 60 || out.includes(c)) continue
    out.push(c)
    if (out.length >= 8) break
  }
  return out.length >= 5 ? out : []
}

// --- related links line (no model) ----------------------------------------------------------------

const RELATED_PREFIX = 'Related: '

/** The destination slug of a trip, the way the site index keys it. */
export function tripDestSlug(pkg: Pick<DbPackage, 'destination'>): string {
  return trimmed(pkg.destination) ? generateSlug(trimmed(pkg.destination)) : ''
}

const labelOf = (s: string) => s.replace(LONG_DASHES, '-').replace(/[[\]()]/g, '').replace(/\s+/g, ' ').trim()

/** The "Related:" line for a trip: the destination page and up to 2 published guides about the same destination, only
 * pages that exist. Null when there is nothing real to link to. Pure. */
export function relatedLinksLine(pkg: TripRow, targets: LinkTarget[], existing: Set<string>): { line: string; paths: string[] } | null {
  const dest = tripDestSlug(pkg as Pick<DbPackage, 'destination'>)
  if (!dest) return null
  const own = `/packages/${trimmed(pkg.slug)}`
  const pool = targets.filter((t) => t.dest === dest && t.path !== own && existing.has(t.path) && !t.path.startsWith('/packages/') && !t.path.startsWith('/best-time-to-visit/') && labelOf(t.title).length >= 2)
  const destination = pool.find((t) => t.rank === 0)
  const guides = pool.filter((t) => t.rank === 1).slice(0, 2)
  const picked = [...(destination ? [destination] : []), ...guides]
  if (picked.length === 0) return null
  return { line: `${RELATED_PREFIX}${picked.map((t) => `[${labelOf(t.title)}](${t.path})`).join(', ')}.`, paths: picked.map((t) => t.path) }
}

/** Adds the related line to the end of a description as its own paragraph. Idempotent and strictly conditional: a
 * description that is empty, or that already links to a page on this site, comes back unchanged (null). */
export function appendRelatedLine(fullDescription: string | null | undefined, line: string): string | null {
  const full = typeof fullDescription === 'string' ? fullDescription : ''
  if (!full.trim()) return null
  if (internalLinkPathsOf(full).length > 0) return null
  if (full.includes(line)) return null
  return `${full.replace(/\s+$/, '')}\n\n${line}`
}

// --- meta title and description (one grounded model call) -------------------------------------------

export interface TripMetaResult {
  meta_title?: string
  meta_description?: string
  /** True when a model call was made. */
  called: boolean
  /** True when the model answered but nothing passed the gate (the heal then waits 7 days). */
  answeredEmpty: boolean
  error?: string
}

/** Writes an empty meta title and/or description from the trip row's own text. ONE model call (the same writer the
 * trip intake uses), then the same mechanical gate as the guide pages (no number or name that is not on the row, no
 * superlative, no claim about the agency, no dash, no web address) plus length rules. A field that fails is dropped,
 * never repaired by guessing. `write` is injectable so a check can run it without a network. */
export async function writeTripMeta(pkg: TripRow, want: { title: boolean; description: boolean }, write: CopyWriter = modelCopyWriter): Promise<TripMetaResult> {
  const wanted = [...(want.title ? (['meta_title'] as const) : []), ...(want.description ? (['meta_description'] as const) : [])]
  if (wanted.length === 0) return { called: false, answeredEmpty: false }
  const transcript = textOf(rowGrounding(pkg), trimmed(pkg.full_description))
  if (transcript.length < 40) return { called: false, answeredEmpty: false, error: 'the trip has too little text to write meta text from' }
  const w = await write({ pkg, transcript, wanted: [...wanted] })
  if (!w.raw) return { called: true, answeredEmpty: false, error: w.error ?? 'the meta text could not be written' }
  const grounding = `${transcript}\n${trimmed(pkg.name)}\n${trimmed(pkg.destination)}`
  const out: TripMetaResult = { called: true, answeredEmpty: false }
  for (const field of wanted) {
    const v = w.raw[field]
    if (typeof v !== 'string' || !v.trim()) continue
    const cleaned = removeDashes(v.trim()).replace(/\s+/g, ' ')
    const max = field === 'meta_title' ? 60 : 155
    const text = cleaned.length > max ? cutAtWord(cleaned, max) : cleaned
    const [min] = field === 'meta_title' ? [20] : [70]
    if (text.length < min || text.length > max) continue
    if (copyBlockers(text, { grounding, field }).length > 0) continue
    out[field] = text
  }
  out.answeredEmpty = !out.meta_title && !out.meta_description
  return out
}

// --- the plan: which changes a trip gets ------------------------------------------------------------

/** One change to one trip field, shaped like a content_edits row (before and after are what the audit log stores). */
export interface PackageChange {
  fix: PackageFix
  /** The audit log field. */
  field: 'meta_title' | 'meta_description' | 'keywords' | 'ai_faqs' | 'links'
  /** The database column this writes and its new value. */
  column: string
  value: unknown
  before: string
  after: string
  method: 'fixer' | 'links' | 'generate'
  reason: string
}

export interface GeneratedTrip {
  meta_title?: string
  meta_description?: string
  faqs?: TripFaq[]
}

/** What a trip would be asked to generate (a model call each), before any call is made. Pure. */
export function tripGenerationWanted(pkg: TripRow, past: boolean): { metaTitle: boolean; metaDescription: boolean; faq: boolean } {
  const hasText = !!(trimmed(pkg.full_description) || trimmed(pkg.short_description))
  return {
    metaTitle: !past && hasText && !trimmed(pkg.meta_title),
    metaDescription: !past && hasText && !trimmed(pkg.meta_description),
    faq: !hasFaqs(pkg.ai_faqs) && hasFaqSource(pkg as DbPackage),
  }
}

/** Every change a trip gets, from the row as it is NOW: each only while its field is still empty, and only the fixes a
 * past trip is allowed. `generated` is what the model calls returned (empty for the no-model plan). `skip` holds audit
 * fields an admin reverted (they stay reverted). Pure. */
export function assemblePackageChanges(pkg: TripRow, ctx: { past: boolean; existing: Set<string>; targets: LinkTarget[]; skip?: Set<string> }, generated: GeneratedTrip = {}): PackageChange[] {
  const allowed = (fix: PackageFix) => !ctx.past || PAST_TRIP_FIXES.includes(fix)
  const skipped = (f: string) => ctx.skip?.has(f) ?? false
  const out: PackageChange[] = []

  if (allowed('meta')) {
    if (generated.meta_title && !trimmed(pkg.meta_title) && !skipped('meta_title')) {
      out.push({ fix: 'meta', field: 'meta_title', column: 'meta_title', value: generated.meta_title, before: '', after: generated.meta_title, method: 'generate', reason: 'meta title was empty, written from the trip text only' })
    }
    if (generated.meta_description && !trimmed(pkg.meta_description) && !skipped('meta_description')) {
      out.push({ fix: 'meta', field: 'meta_description', column: 'meta_description', value: generated.meta_description, before: '', after: generated.meta_description, method: 'generate', reason: 'meta description was empty, written from the trip text only' })
    }
  }
  if (allowed('keywords') && !(Array.isArray(pkg.keywords) && pkg.keywords.some((k) => trimmed(k))) && !skipped('keywords')) {
    const kws = tripKeywords(pkg)
    if (kws.length) out.push({ fix: 'keywords', field: 'keywords', column: 'keywords', value: kws, before: JSON.stringify([]), after: JSON.stringify(kws), method: 'fixer', reason: 'keywords were empty, built from the trip name, place and type' })
  }
  if (allowed('ai_faqs') && generated.faqs && generated.faqs.length && !hasFaqs(pkg.ai_faqs) && !skipped('ai_faqs')) {
    const faqs = normTripFaqs(generated.faqs)
    out.push({ fix: 'ai_faqs', field: 'ai_faqs', column: 'ai_faqs', value: faqs, before: JSON.stringify(normTripFaqs(pkg.ai_faqs)), after: JSON.stringify(faqs), method: 'generate', reason: 'FAQ was empty, written from the trip text only' })
  }
  if (allowed('links') && !skipped('links')) {
    const related = relatedLinksLine(pkg, ctx.targets, ctx.existing)
    const next = related ? appendRelatedLine(pkg.full_description, related.line) : null
    if (next !== null) out.push({ fix: 'links', field: 'links', column: 'full_description', value: next, before: trimmed(pkg.full_description) ? (pkg.full_description as string) : '', after: next, method: 'links', reason: 'the description had no link to another page on this site; added one line linking the destination page and guides' })
  }
  return out
}
