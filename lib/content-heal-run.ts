import type { SupabaseClient } from '@supabase/supabase-js'
import { isAiConfigured } from '@/lib/ai-verify'
import { getSetting, setSetting } from '@/lib/app-settings'
import { cutAtWord } from '@/lib/blog-composer'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'
import { getComparePairSlugs } from '@/lib/compare-destinations'
import {
  buildEdits,
  classifyBlockers,
  cloneFields,
  clampLengths,
  fixAllDashes,
  generateExtras,
  internalLinksOfText,
  makeDetectCtx,
  mapFields,
  plainForPrompt,
  sameFields,
  serializeField,
  stripDeadLinks,
  callModelText,
  Tracker,
  EST_COST_USD_PER_CALL,
  type ContentEdit,
  type ContentType,
  type GenKey,
  type RepairFields,
  type RepairLimits,
} from '@/lib/content-repair'
import { TRIP_SLOT_PREFIX, claimDailyOnce, claimRepairSlot, countEditsSince, editsLoggable, insertEdits, readRepairSpend, recordRepairSpend, deleteEdits, repairDay, startOfSiteDayIso, REPAIR_ITEMS_PER_DAY } from '@/lib/content-edits'
import {
  assemblePackageChanges,
  buildPackageItem,
  COPY_LIMITS,
  GUIDE_LIMITS,
  isPastTripRow,
  normTripFaqs,
  PACKAGE_WRITABLE_COLUMNS,
  sectionsOf,
  tripGenerationWanted,
  writeTripMeta,
  type GeneratedTrip,
  type PackageChange,
  type PackageItem,
} from '@/lib/content-repair-adapters'
import { pingIndexNow } from '@/lib/indexnow'
import { rehealStuckDrafts, rejectedPostSlugs } from '@/lib/blog-reheal'
import { healHeldCopy, healHeldGuides } from '@/lib/heal-drafts'
import { healLoopCard, type HealLoopCard } from '@/lib/heal-loop'
import type { DbPackage } from '@/lib/packages'
import { completenessScore } from '@/lib/package-completeness'
import { generatePackageFaqsDetailed, hasFaqs, hasFaqSource } from '@/lib/package-faqs'
import { tripFaqDailyKey, tripFaqsOff } from '@/lib/package-enrich'
import { SITE_ID } from '@/lib/site'
import { guideKinds, GUIDE_KINDS, guidePath, type GuideKind } from '@/lib/guides'
import { linkedPackageSlugs } from '@/lib/page-copy-composer'
import { SEO_PASS_SCORE, SEO_FIX, seoScore, type SeoCheckId, type SeoInput, type SeoResult } from '@/lib/seo-score'
import { styleById } from '@/lib/content-styles'
import { generateSlug } from '@/lib/utils'

// The daily heal-content step (growth loop WP10): score every published post, guide and page copy for SEO (no AI),
// store the number and the reasons on the row, and for pages under 70 run the cheapest fixes first:
//   1. plain code, no model: long dashes, over-long meta and share text, share text copied from the meta text,
//      links to pages that do not exist (the words stay), and a "Related" link to real pages that share the
//      page's destination;
//   2. one grounded model call that writes MISSING meta text, FAQ or takeaways from the page's own body.
// Trip pages (wave 3) are scored here too, with their own narrow fix list (see healTripPages and
// lib/content-repair-adapters.ts): only EMPTY SEO fields, never a fact.
// It never rewrites the body of a published page for score alone, never adds a fact, never touches a page it was
// told to leave alone (an edit that was reverted stays reverted), and logs every change BEFORE applying it.

export const HEAL_LAST_KEY = 'content_heal_last'
const HEAL_DAY_PREFIX = 'content_heal_day'
/** Pages scoring under this get the cheap fixes. */
export const HEAL_BELOW = SEO_PASS_SCORE
/** No new page is started after this long into a run (each can wait on a model call). */
const HEAL_BUDGET_MS = 60_000
const REVERT_MEMORY_DAYS = 60
const NOGEN_PREFIX = 'content_heal_nogen'
const NOGEN_DAYS = 7

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const faqList = (v: unknown): { q: string; a: string }[] => (Array.isArray(v) ? v.filter((x): x is { q: string; a: string } => !!x && typeof (x as { q?: unknown }).q === 'string' && typeof (x as { a?: unknown }).a === 'string').map((x) => ({ q: x.q, a: x.a })) : [])

export interface HealSummary {
  at: string
  scored: number
  avg: number | null
  below: number
  lowest: { type: ContentType; path: string; score: number; reasons: string[] }[]
  healedPages: number
  edits: number
  hardWaiting: number
  calls: number
  /** How many of `scored` are trip pages, and how many trip pages the last run fixed (absent in an older summary). */
  trips?: number
  tripsFixed?: number
  note: string
}

export async function readHealSummary(admin: SupabaseClient): Promise<HealSummary | null> {
  try {
    return JSON.parse((await getSetting(admin, HEAL_LAST_KEY)) ?? 'null') as HealSummary | null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------
// HARD items waiting on a person
// ---------------------------------------------------------------------------------------------------

/** Drafts the quality gate held back for a HARD reason (an experience claim, a price, an outside link ...). A draft
 * held only because the publish mode is "draft" is not counted: nothing is wrong with it. */
export async function countHardWaiting(admin: SupabaseClient): Promise<number> {
  const hardIn = (notes: string | null | undefined): boolean => {
    if (!notes) return false
    const parts = notes.split('; ').map((p) => p.trim()).filter((p) => p && !/^held for review/.test(p))
    return parts.length > 0 && classifyBlockers(parts).hard.length > 0
  }
  let n = 0
  try {
    for (const table of ['guides', 'page_copy'] as const) {
      const { data } = await admin.from(table).select('quality_notes').eq('status', 'draft').not('quality_notes', 'is', null).limit(500)
      n += ((data ?? []) as { quality_notes: string | null }[]).filter((r) => hardIn(r.quality_notes)).length
    }
    const { data: drafts } = await admin.from('posts').select('slug').eq('status', 'draft').limit(300)
    // A draft the re-check retired (rejected) is no longer waiting on anyone.
    const retired = await rejectedPostSlugs(admin)
    const slugs = ((drafts ?? []) as { slug: string }[]).map((r) => r.slug).filter((s) => !retired.has(s))
    if (slugs.length) {
      const { data: tags } = await admin.from('content_variants').select('variant_tags').in('slug', slugs)
      n += ((tags ?? []) as { variant_tags: { held_reasons?: string } | null }[]).filter((r) => hardIn(r.variant_tags?.held_reasons)).length
    }
  } catch {
    // an unreadable table is just not counted
  }
  return n
}

// ---------------------------------------------------------------------------------------------------
// The pages that exist, and which share a destination (for links)
// ---------------------------------------------------------------------------------------------------

interface Target {
  path: string
  title: string
  dest: string | null
  rank: number
}

interface SiteIndex {
  /** False when any read failed or the trips list came back empty. An incomplete index must never be used to strip links. */
  ok: boolean
  existing: Set<string>
  targets: Target[]
  /** package id -> destination slug, and package slug -> destination slug */
  destByPackageId: Map<string, string>
  destByPackageSlug: Map<string, string>
}

const STATIC_PATHS = ['/', '/packages', '/blog', '/who-we-are', '/thank-you', '/compare', '/destinations', '/best-time-to-visit', ...GUIDE_KINDS.map((k) => guideKinds[k].urlPrefix)]

export async function buildSiteIndex(admin: SupabaseClient): Promise<SiteIndex> {
  const existing = new Set<string>(STATIC_PATHS)
  const targets: Target[] = []
  const destByPackageId = new Map<string, string>()
  const destByPackageSlug = new Map<string, string>()
  const seenDest = new Set<string>()

  let complete = true
  const { data: pkgs, error: pkgError } = await admin.from('travel_packages').select('id, slug, name, destination').eq('status', 'published')
  if (pkgError) complete = false
  for (const p of (pkgs ?? []) as { id: string; slug: string | null; name: string | null; destination: string | null }[]) {
    const dest = p.destination ? generateSlug(p.destination) : ''
    if (p.slug) {
      existing.add(`/packages/${p.slug}`)
      if (dest) destByPackageSlug.set(p.slug, dest)
      if (dest) targets.push({ path: `/packages/${p.slug}`, title: p.name || p.slug, dest, rank: 3 })
    }
    if (dest) {
      destByPackageId.set(p.id, dest)
      if (!seenDest.has(dest)) {
        seenDest.add(dest)
        existing.add(`/destinations/${dest}`)
        targets.push({ path: `/destinations/${dest}`, title: p.destination as string, dest, rank: 0 })
      }
    }
  }
  try {
    for (const b of await getBestTimeToVisitSlugs()) {
      existing.add(`/best-time-to-visit/${b.slug}`)
      targets.push({ path: `/best-time-to-visit/${b.slug}`, title: `the best time to visit ${b.destination}`, dest: b.slug, rank: 2 })
    }
  } catch {
    complete = false
  }
  try {
    for (const c of await getComparePairSlugs()) existing.add(`/compare/${c.pairSlug}`)
  } catch {
    complete = false
  }
  const { data: guides, error: guideError } = await admin.from('guides').select('kind, slug, name, parent_slug').eq('status', 'published')
  if (guideError) complete = false
  for (const g of (guides ?? []) as { kind: GuideKind; slug: string; name: string; parent_slug: string | null }[]) {
    if (!GUIDE_KINDS.includes(g.kind) || !g.slug) continue
    const path = guidePath(g.kind, g.slug)
    existing.add(path)
    const dest = g.kind === 'destinations' ? g.slug : g.parent_slug
    if (g.kind !== 'destinations' && dest) targets.push({ path, title: g.name, dest, rank: 1 })
  }
  const { data: posts, error: postError } = await admin.from('posts').select('slug').eq('status', 'published')
  if (postError) complete = false
  for (const p of (posts ?? []) as { slug: string }[]) if (p.slug) existing.add(`/blog/${p.slug}`)
  // A site with published trips always has /packages/<slug> pages: none at all means the read came back empty.
  if (![...existing].some((p) => p.startsWith('/packages/'))) complete = false
  return { ok: complete, existing, targets, destByPackageId, destByPackageSlug }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Turns the first plain mention of `title` (not in a heading, not already inside a link) into a link. Null when there is none. */
export function linkFirstMention(body: string, title: string, path: string): string | null {
  if (title.trim().length < 4) return null
  const re = new RegExp(`(?<![\\w/\\[(])${escapeRe(title)}(?![\\w\\]])`)
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#{1,6}\s/.test(lines[i])) continue
    // Search only the parts of the line that are not already link syntax.
    const parts = lines[i].split(/(!?\[[^\]]*\]\([^)]*\))/)
    for (let p = 0; p < parts.length; p += 2) {
      if (re.test(parts[p])) {
        parts[p] = parts[p].replace(re, `[${title}](${path})`)
        lines[i] = parts.join('')
        return lines.join('\n')
      }
    }
  }
  return null
}

/** Adds up to `max` links to real pages: a mention becomes a link where the page already names it, otherwise one
 * "Related" line is appended. Returns the new body and the paths added. Pure. */
export function addRelatedLinks(body: string, candidates: Target[], max: number): { body: string; added: string[] } {
  let text = body
  const added: string[] = []
  const appended: Target[] = []
  for (const t of candidates) {
    if (added.length >= max) break
    const linked = linkFirstMention(text, t.title, t.path)
    if (linked) {
      text = linked
      added.push(t.path)
    } else if (appended.length < 2) {
      appended.push(t)
      added.push(t.path)
    }
  }
  if (appended.length) {
    const label = (t: Target) => t.title.replace(/[[\]]/g, '').trim()
    text = `${text.replace(/\s+$/, '')}\n\nRelated: ${appended.map((t) => `[${label(t)}](${t.path})`).join(', ')}.`
  }
  return { body: text, added }
}

// ---------------------------------------------------------------------------------------------------
// One published page, ready to score and fix
// ---------------------------------------------------------------------------------------------------

interface HealItem {
  type: ContentType
  id: string
  path: string
  label: string
  fields: RepairFields
  keyword: string | null
  limits: RepairLimits
  row: Row
  destSlugs: string[]
  /** Names that may appear in generated text besides the body (the subject's own name). */
  names: string[]
  /** The SEO input for these fields (the page's own text) over the paths that exist. */
  seo: (fields: RepairFields, existing: Set<string>) => SeoInput
}

const POST_LIMITS: RepairLimits = { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }

function postItem(row: Row, idx: SiteIndex): HealItem {
  const slug = str(row.slug)
  const style = styleById(str(row.content_style) || null)
  const fields: RepairFields = {
    title: str(row.title),
    body: str(row.body),
    meta_title: str(row.meta_title),
    meta_description: str(row.meta_description),
    og_title: str(row.og_title),
    og_description: str(row.og_description),
    faq: faqList(row.faq),
    key_takeaways: strList(row.key_takeaways),
  }
  const dests = new Set<string>()
  const byId = row.related_package_id ? idx.destByPackageId.get(str(row.related_package_id)) : null
  if (byId) dests.add(byId)
  for (const l of internalLinksOfText(fields.body)) {
    const m = /^\/packages\/([^/]+)$/.exec(l)
    const d = m ? idx.destByPackageSlug.get(m[1]) : null
    if (d) dests.add(d)
  }
  return {
    type: 'post',
    id: str(row.id),
    path: `/blog/${slug}`,
    label: fields.title ?? slug,
    fields,
    keyword: str(row.primary_keyword) || null,
    limits: POST_LIMITS,
    row,
    destSlugs: [...dests],
    names: [str(row.title)],
    seo: (f, existing) => ({
      title: f.meta_title || f.title || '',
      metaDescription: f.meta_description,
      ogTitle: f.og_title,
      ogDescription: f.og_description,
      body: f.body,
      faq: f.faq,
      takeaways: f.key_takeaways,
      primaryKeyword: str(row.primary_keyword) || null,
      targetWords: { min: style?.minWords ?? 700, max: style?.maxWords ?? 1000 },
      hasImageAlt: !!str(row.cover_image_url) && !!str(row.alt_text).trim(),
      existingPaths: existing,
      jsonLdTypes: ['Article', 'BreadcrumbList', ...(f.faq.length ? ['FAQPage'] : [])],
    }),
  }
}

function guideItem(row: Row, idx: SiteIndex): HealItem {
  const kind = str(row.kind) as GuideKind
  const slug = str(row.slug)
  const fields: RepairFields = {
    summary: str(row.summary),
    body: str(row.body),
    meta_title: str(row.meta_title),
    meta_description: str(row.meta_description),
    og_title: str(row.og_title),
    og_description: str(row.og_description),
    faq: faqList(row.faq),
    key_takeaways: strList(row.key_takeaways),
  }
  const dests = new Set<string>()
  if (kind === 'destinations') dests.add(slug)
  else if (str(row.parent_slug)) dests.add(str(row.parent_slug))
  for (const id of strList(row.related_package_ids)) {
    const d = idx.destByPackageId.get(id)
    if (d) dests.add(d)
  }
  return {
    type: 'guide',
    id: str(row.id),
    path: guidePath(kind, slug),
    label: str(row.name) || slug,
    fields,
    keyword: str(row.primary_keyword) || null,
    limits: GUIDE_LIMITS,
    row,
    destSlugs: [...dests],
    names: [str(row.name)],
    seo: (f, existing) => ({
      title: f.meta_title || str(row.name),
      metaDescription: f.meta_description,
      ogTitle: f.og_title,
      ogDescription: f.og_description,
      body: `${f.summary ?? ''}\n\n${f.body}`,
      faq: f.faq,
      takeaways: f.key_takeaways,
      primaryKeyword: str(row.primary_keyword) || null,
      targetWords: { min: 1200, max: 1800 },
      hasImageAlt: !!str(row.hero_image_url) && !!str(row.hero_alt).trim(),
      existingPaths: existing,
      jsonLdTypes: ['Article', 'BreadcrumbList', ...(f.faq.length ? ['FAQPage'] : [])],
    }),
  }
}

function copyItem(row: Row, idx: SiteIndex): HealItem {
  const path = str(row.path)
  const fields: RepairFields = {
    body: str(row.intro),
    meta_title: str(row.meta_title),
    meta_description: str(row.meta_description),
    og_title: str(row.og_title),
    og_description: str(row.og_description),
    faq: faqList(row.faq),
    key_takeaways: strList(row.key_takeaways),
  }
  const dests = new Set<string>()
  const best = /^\/best-time-to-visit\/([^/]+)$/.exec(path)?.[1]
  if (best) dests.add(best)
  for (const slug of strList(row.linked_slugs)) {
    const d = idx.destByPackageSlug.get(slug)
    if (d) dests.add(d)
  }
  return {
    type: 'page_copy',
    id: str(row.id),
    path,
    label: path,
    fields,
    keyword: str(row.primary_keyword) || null,
    limits: COPY_LIMITS,
    row,
    destSlugs: [...dests],
    names: [path.replace(/^\/[^/]+\//, '').replace(/-/g, ' ')],
    seo: (f, existing) => ({
      title: f.meta_title,
      titleRange: [20, 60],
      metaDescription: f.meta_description,
      ogTitle: f.og_title,
      ogDescription: f.og_description,
      body: f.body,
      faq: f.faq,
      takeaways: f.key_takeaways,
      primaryKeyword: str(row.primary_keyword) || null,
      targetWords: { min: 150, max: 300 },
      hasImageAlt: false,
      imageApplies: false,
      expectH2: false,
      existingPaths: existing,
      jsonLdTypes: ['CollectionPage', 'BreadcrumbList', ...(f.faq.length ? ['FAQPage'] : [])],
      jsonLdExpected: ['CollectionPage', 'FAQPage', 'BreadcrumbList'],
    }),
  }
}

// ---------------------------------------------------------------------------------------------------
// The fixes
// ---------------------------------------------------------------------------------------------------

export interface HealPlan {
  fields: RepairFields
  tracker: Tracker
  addedLinks: string[]
  /** The missing fields that a model call should write (empty when none or when no model is allowed). */
  generate: GenKey[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Step 1: every fix that needs no model. Pure. `allowed` is what exists on the site; `targets` are real pages that share
 * the page's destination. Returns the new fields, what was touched, and which fields a model should still write. */
export function planCheapFixes(
  item: Pick<HealItem, 'type' | 'path' | 'fields' | 'limits' | 'destSlugs'>,
  failed: SeoCheckId[],
  existing: Set<string>,
  targets: Target[],
  opts: { stripDead?: boolean } = {},
): HealPlan {
  const tracker = new Tracker()
  let f = cloneFields(item.fields)
  const touchChanged = (candidate: RepairFields, method: ContentEdit['method'], reason: string) => {
    // The heal never changes a title or a guide's opening summary (a title carries the slug; both are the page's
    // headline wording), so a fixer that maps every field leaves those two exactly as they were.
    const next: RepairFields = { ...candidate }
    if (f.title === undefined) delete next.title
    else next.title = f.title
    if (f.summary === undefined) delete next.summary
    else next.summary = f.summary
    for (const fld of ['title', 'body', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways'] as const) {
      if (serializeField(item.type, next, fld) !== serializeField(item.type, f, fld)) tracker.touch(fld, method, reason)
    }
    f = next
  }
  const failedSet = new Set(failed)

  if (failedSet.has('dashes')) touchChanged(fixAllDashes(f), 'fixer', 'removed a long dash')

  // Over-long meta description and share text is cut at a word (never made longer, never rewritten). A title is
  // left alone: cutting one can leave half a phrase, and a long title only costs a few points.
  const clamped = { ...clampLengths(f, item.limits), meta_title: f.meta_title }
  if (!sameFields(clamped, f)) touchChanged(clamped, 'fixer', 'cut meta or share text to its length limit')

  // Links to pages that do not exist lose the link (the words stay).
  if (failedSet.has('dead-links') && opts.stripDead !== false) touchChanged(mapFields(f, (s) => stripDeadLinks(s, existing)), 'fixer', 'removed a link to a page that does not exist (the words stay)')

  // A page with no internal link gets up to two links to real pages that share its destination.
  let addedLinks: string[] = []
  if (failedSet.has('internal-link') || (failedSet.has('dead-links') && internalLinksOfText(f.body).length === 0)) {
    const have = new Set([...internalLinksOfText(`${f.summary ?? ''}\n${f.body}`), item.path])
    const maxBodyLinks = item.limits.maxBodyLinks ?? 3
    const room = Math.max(0, maxBodyLinks - internalLinksOfText(f.body).length)
    const candidates = targets
      .filter((t) => t.dest !== null && item.destSlugs.includes(t.dest) && !have.has(t.path) && existing.has(t.path))
      // Page copy lists its trips itself: only link a destination, best-time or guide page from its intro, never a package.
      .filter((t) => item.type !== 'page_copy' || !t.path.startsWith('/packages/'))
      .sort((a, b) => a.rank - b.rank)
    const { body, added } = addRelatedLinks(f.body, candidates, Math.min(2, room || 0))
    if (added.length) {
      addedLinks = added
      touchChanged({ ...f, body }, 'links', 'added a link to a real page about the same destination')
    }
  }

  // A missing share title or description borrows the page's own meta text.
  if (!f.og_title.trim() && (f.meta_title.trim() || f.title)) touchChanged({ ...f, og_title: cutAtWord((f.meta_title || f.title || '').trim(), item.limits.ogTitleMax) }, 'fixer', 'share title copied from the page title')
  if (!f.og_description.trim() && f.meta_description.trim()) touchChanged({ ...f, og_description: cutAtWord(f.meta_description.trim(), item.limits.ogDescMax) }, 'fixer', 'share description copied from the meta description')

  const generate: GenKey[] = []
  if (f.faq.length < 3) generate.push('faq')
  if (f.key_takeaways.length < 3) generate.push('key_takeaways')
  if (!f.meta_description.trim()) generate.push('meta_description')
  if (!f.meta_title.trim() && failedSet.has('title')) generate.push('meta_title')
  return { fields: f, tracker, addedLinks, generate }
}

/** Keeps the pairs a page already has and adds generated ones that do not repeat a question, up to the limit. */
export function mergeFaq(existing: { q: string; a: string }[], generated: { q: string; a: string }[], max: number): { q: string; a: string }[] {
  const out = [...existing]
  for (const g of generated) {
    if (out.length >= max) break
    if (!out.some((e) => norm(e.q) === norm(g.q))) out.push(g)
  }
  return out
}

function mergeList(existing: string[], generated: string[], max: number): string[] {
  const out = [...existing]
  for (const g of generated) {
    if (out.length >= max) break
    if (!out.some((e) => norm(e) === norm(g))) out.push(g)
  }
  return out
}

/** Writes the fixed fields back to the row. */
function columnsFrom(item: HealItem, f: RepairFields): Row {
  const cols: Row = {
    meta_title: f.meta_title || null,
    meta_description: f.meta_description || null,
    og_title: f.og_title || null,
    og_description: f.og_description || null,
    faq: f.faq,
    key_takeaways: f.key_takeaways,
  }
  if (item.type === 'post') cols.body = f.body
  else if (item.type === 'guide') {
    cols.body = f.body
    cols.sections = sectionsOf(f.summary ?? '', f.body, (Array.isArray(item.row.sections) ? item.row.sections : []) as { heading: string; body: string }[])
  } else {
    cols.intro = f.body
    cols.linked_slugs = linkedPackageSlugs(f.body)
  }
  return cols
}

const TABLE: Record<ContentType, string> = { post: 'posts', guide: 'guides', page_copy: 'page_copy', package: 'travel_packages' }

// ---------------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------------

export interface HealRunResult {
  ok: boolean
  note: string
}

interface Scored {
  item: HealItem
  result: SeoResult
}

/** Runs the daily heal. Without `force`, the day is claimed first (only the first pass after midnight does the work).
 * `force` (the Heal now button) skips that claim and nothing else: the repair slots and every cap still apply.
 * Returns null on a pass where nothing was due. Never throws. */
export async function runHealContentIfDue(admin: SupabaseClient, opts: { force?: boolean; deadlineMs?: number } = {}): Promise<HealRunResult | null> {
  const now = new Date()
  try {
    if (!opts.force) {
      const { error } = await admin.from('app_settings').insert({ key: `${HEAL_DAY_PREFIX}:${repairDay(now)}`, value: now.toISOString() })
      if (error) return (error as { code?: string }).code === '23505' ? null : { ok: false, note: `could not claim today's heal: ${error.message}` }
    }
    const result = await runHealContent(admin, { deadlineMs: opts.deadlineMs })
    // Without migration 0033 nothing was done, so today's claim is given back: the next pass tries again and the
    // step keeps showing in Needs attention until the migration is applied.
    if (!opts.force && !result.ok && /migration 0033/.test(result.note)) await admin.from('app_settings').delete().eq('key', `${HEAL_DAY_PREFIX}:${repairDay(now)}`)
    return result
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'the content heal failed' }
  }
}

export async function runHealContent(admin: SupabaseClient, opts: { deadlineMs?: number } = {}): Promise<HealRunResult> {
  const started = Date.now()
  if (!(await editsLoggable(admin))) return { ok: false, note: 'self-healing needs one database update: apply migration 0033 (supabase/migrations/0033_content_edits.sql)' }

  const idx = await buildSiteIndex(admin)
  const [{ data: posts, error: pErr }, { data: guides, error: gErr }, { data: copies, error: cErr }] = await Promise.all([
    admin.from('posts').select('*').eq('status', 'published'),
    admin.from('guides').select('*').eq('status', 'published'),
    admin.from('page_copy').select('*').eq('status', 'published'),
  ])
  if (pErr || gErr || cErr) return { ok: false, note: `could not read the pages: ${(pErr ?? gErr ?? cErr)?.message}` }

  const items: HealItem[] = [
    ...((posts ?? []) as Row[]).map((r) => postItem(r, idx)),
    ...((guides ?? []) as Row[]).map((r) => guideItem(r, idx)),
    ...((copies ?? []) as Row[]).map((r) => copyItem(r, idx)),
  ]

  // 1. Score everything (no AI) and store the numbers.
  const scored: Scored[] = items.map((item) => ({ item, result: seoScore(item.seo(item.fields, idx.existing)) }))
  const nowIso = new Date().toISOString()
  let storeFailed: string | null = null
  for (const s of scored) {
    const reasons = s.result.reasons
    const prev = s.item.row
    if (prev.seo_score === s.result.score && JSON.stringify(prev.seo_reasons ?? []) === JSON.stringify(reasons)) continue
    const { error } = await admin.from(TABLE[s.item.type]).update({ seo_score: s.result.score, seo_reasons: reasons, seo_scored_at: nowIso }).eq('id', s.item.id)
    if (error) {
      storeFailed = error.message
      break
    }
  }
  if (storeFailed) return { ok: false, note: `could not store the SEO scores (${storeFailed})${/column|schema cache/i.test(storeFailed) ? '; apply migration 0033' : ''}` }

  // 2. Fix the cheap reasons on pages under 70, lowest first, within the daily cap and the time budget.
  const revertedFields = await recentlyRevertedFields(admin)
  const aiOn = isAiConfigured()
  let healedPages = 0
  let editCount = 0
  let calls = 0
  const changedPaths: string[] = []
  const problems: string[] = []
  const queue = scored.filter((s) => s.result.score < HEAL_BELOW).sort((a, b) => a.result.score - b.result.score)

  for (const s of queue) {
    if (Date.now() - started > HEAL_BUDGET_MS) break
    const item = s.item
    const reverted = revertedFields.get(`${item.type}:${item.id}`) ?? new Set<string>()
    const fixable = s.result.failed.some((id) => SEO_FIX[id] !== null)
    if (!fixable) continue

    // With an incomplete site index no link is stripped (a page that looks missing may only be unread).
    const plan = planCheapFixes(item, s.result.failed, idx.existing, idx.targets, { stripDead: idx.ok })
    // An edit that was reverted stays reverted: those fields go back to what they were.
    let fields = plan.fields
    for (const field of reverted) fields = restoreField(fields, item.fields, field)
    const itemKey = `${item.type}:${item.type === 'page_copy' ? item.path : item.id}`
    let wantsModel = aiOn && plan.generate.filter((k) => !reverted.has(k)).length > 0
    // A page whose generation call produced nothing usable is not retried for 7 days, so one stubborn page cannot
    // take a slot every day and starve the others.
    if (wantsModel) {
      const stamp = Date.parse((await getSetting(admin, `${NOGEN_PREFIX}:${itemKey}`)) ?? '')
      if (Number.isFinite(stamp) && Date.now() - stamp < NOGEN_DAYS * 86_400_000) wantsModel = false
    }
    const cheapChanged = !sameFields(fields, item.fields)
    if (!cheapChanged && !wantsModel) continue

    const slot = await claimRepairSlot(admin, itemKey)
    if (!slot.ok) {
      if (/cap of/.test(slot.reason ?? '')) break
      problems.push(slot.reason ?? 'no repair slot')
      break
    }
    // One model call per page per day, however often Heal now is pressed.
    if (wantsModel && !(await claimDailyOnce(admin, itemKey))) wantsModel = false
    if (!cheapChanged && !wantsModel) continue

    let usedCall = false
    if (wantsModel) {
      const keys = plan.generate.filter((k) => !reverted.has(k))
      const bodyCtx = makeDetectCtx(item.type, plainForPrompt(fields), [...item.names, item.keyword ?? ''])
      usedCall = true
      calls++
      // Three FAQ questions are enough for the score, even where the write-time gate wants four.
      const { got, answered } = await generateExtras(callModelText, fields, keys, { ...item.limits, faqMin: Math.min(3, item.limits.faqMin) }, item.keyword, bodyCtx)
      const next = cloneFields(fields)
      // Only when the model answered and nothing was accepted; a failed or empty call is retried tomorrow.
      if (answered && Object.keys(got).length === 0) await setSetting(admin, `${NOGEN_PREFIX}:${itemKey}`, new Date().toISOString())
      if (got.faq) {
        const merged = mergeFaq(fields.faq, got.faq, item.limits.faqMax)
        if (merged.length >= 3) next.faq = merged
      }
      if (got.key_takeaways) {
        const merged = mergeList(fields.key_takeaways, got.key_takeaways, item.limits.takeMax)
        if (merged.length >= 3) next.key_takeaways = merged
      }
      if (got.meta_description) next.meta_description = got.meta_description
      if (got.meta_title) next.meta_title = got.meta_title
      // Share text that was still missing can now borrow the new meta text.
      if (!next.og_description.trim() && next.meta_description.trim()) next.og_description = cutAtWord(next.meta_description, item.limits.ogDescMax)
      if (!next.og_title.trim() && (next.meta_title.trim() || next.title)) next.og_title = cutAtWord((next.meta_title || next.title || '').trim(), item.limits.ogTitleMax)
      for (const k of ['faq', 'key_takeaways', 'meta_title', 'meta_description', 'og_title', 'og_description'] as const) {
        if (serializeField(item.type, next, k) !== serializeField(item.type, fields, k)) plan.tracker.touch(k, 'generate', `${k === 'faq' ? 'FAQ' : k === 'key_takeaways' ? 'key takeaways' : k.replace('_', ' ')} was missing, written from the page text only`)
      }
      fields = next
      for (const field of reverted) fields = restoreField(fields, item.fields, field)
    }
    if (usedCall) await recordRepairSpend(admin, 1)
    if (sameFields(fields, item.fields)) continue

    // Log first, then apply: no audit row, no edit.
    const edits = buildEdits({ type: item.type, id: item.id, path: item.path, published: true }, item.fields, fields, plan.tracker, usedCall ? 1 : 0)
    if (edits.length === 0) continue
    const logged = await insertEdits(admin, edits)
    if (logged.error) {
      problems.push(`the audit log could not be written (${logged.error})`)
      break
    }
    const { error: updateError } = await admin
      .from(TABLE[item.type])
      .update({ ...columnsFrom(item, fields), ...rescoreColumns(item, fields, idx.existing), updated_at: new Date().toISOString() })
      .eq('status', 'published')
      .eq('id', item.id)
    if (updateError) {
      await deleteEdits(admin, logged.ids)
      problems.push(`could not update ${item.path}: ${updateError.message}`)
      continue
    }
    healedPages++
    editCount += edits.length
    changedPaths.push(item.path)
  }
  // 2b. Trip pages (wave 3): the ONE trip heal. Every published trip is scored with the same seoScore, and a trip under 70
  // gets only the fixes in lib/content-repair-adapters.ts (empty meta text, share picture, keywords, FAQ, one related
  // line). Same 6-slot daily cap and once-per-page-per-day markers as the pages above. This also replaces the separate
  // WP12 trip FAQ pass: the FAQ is one of the trip fixes now, and is logged to content_edits like the rest.
  const trips = await healTripPages(admin, idx, { started, aiOn, revertedFields, onChanged: (path) => changedPaths.push(path) })
  healedPages += trips.fixed
  editCount += trips.edits
  calls += trips.calls
  problems.push(...trips.problems)
  // 2c. Stuck blog drafts (WP18): up to 2 a day get one fresh repair; published only if the full gate is clean.
  const reheal = await rehealStuckDrafts(admin, { existing: idx.existing, deadlineMs: opts.deadlineMs })
  calls += reheal.calls
  problems.push(...reheal.problems)
  if (reheal.published) healedPages += reheal.published
  // 2d. Held guides and page copy (WP19): the heal loop (suggester, independent QA judge, escalation ladder) instead of waiting
  // for a person. Published only when the gate and the judge both pass; otherwise rejected_by_heal with the reasons.
  const heldGuides = await healHeldGuides(admin, { deadlineMs: opts.deadlineMs })
  const heldCopy = await healHeldCopy(admin, { deadlineMs: opts.deadlineMs })
  for (const r of [heldGuides, heldCopy]) {
    calls += r.calls
    problems.push(...r.problems)
    healedPages += r.published + r.healedDraft
  }
  if (changedPaths.length) await pingIndexNow(changedPaths).catch(() => undefined)

  // 3. The numbers for the card, the brief and Needs attention (pages and trips together).
  const everyone: { type: ContentType; path: string; score: number; reasons: string[] }[] = [
    ...scored.map((s) => ({ type: s.item.type, path: s.item.path, score: s.result.score, reasons: s.result.reasons })),
    ...trips.scored.map((t) => ({ type: 'package' as ContentType, path: t.item.path, score: t.result.score, reasons: t.result.reasons })),
  ]
  const after = everyone.map((s) => s.score)
  const avg = after.length ? Math.round(after.reduce((n, x) => n + x, 0) / after.length) : null
  const lowest = [...everyone].sort((a, b) => a.score - b.score).slice(0, 5).map((s) => ({ type: s.type, path: s.path, score: s.score, reasons: s.reasons.slice(0, 3) }))
  const belowAll = queue.length + trips.scored.filter((t) => t.result.score < HEAL_BELOW).length
  const hardWaiting = await countHardWaiting(admin)
  const note = `scored ${everyone.length} page${everyone.length === 1 ? '' : 's'} (${trips.scored.length} trip page${trips.scored.length === 1 ? '' : 's'})${avg !== null ? ` (average ${avg})` : ''}, ${belowAll} under ${HEAL_BELOW}; fixed ${healedPages} (${editCount} edit${editCount === 1 ? '' : 's'}, ${trips.fixed} trip page${trips.fixed === 1 ? '' : 's'}); ${hardWaiting} waiting on a person${idx.ok ? '' : '; the page list was incomplete this run, so no broken link was removed'}${reheal.tried || reheal.published ? `; ${reheal.note}` : ''}${heldGuides.tried ? `; ${heldGuides.note}` : ''}${heldCopy.tried ? `; ${heldCopy.note}` : ''}${problems.length ? `; ${problems.join('; ')}` : ''}`
  const summary: HealSummary = { at: new Date().toISOString(), scored: everyone.length, avg, below: belowAll, lowest, healedPages, edits: editCount, hardWaiting, calls, trips: trips.scored.length, tripsFixed: trips.fixed, note }
  await setSetting(admin, HEAL_LAST_KEY, JSON.stringify(summary)).catch(() => undefined)
  return { ok: problems.length === 0, note }
}

/** True while a "the last call gave nothing usable" marker (an ISO time) is younger than NOGEN_DAYS. Pure. */
export function nogenActive(stamp: string | null, now: number = Date.now()): boolean {
  const t = Date.parse(stamp ?? '')
  return Number.isFinite(t) && now - t < NOGEN_DAYS * 86_400_000
}

/** Published trips the heal may write FAQs for: a description of 150+ words, no FAQs, and a trip completeness score
 * under 70. Lowest score first. Pure. */
export function tripsNeedingFaqs<T extends Row>(rows: T[]): { row: T; score: number }[] {
  return rows
    .filter((r) => hasFaqSource(r as unknown as DbPackage) && !hasFaqs(r.ai_faqs))
    .map((row) => ({ row, score: completenessScore(row as unknown as DbPackage).score }))
    .filter((x) => x.score < HEAL_BELOW)
    .sort((a, b) => a.score - b.score)
}

/** The primary keyword of each trip page: the highest-volume keyword_research row whose target_path is the page.
 * Empty when the table cannot be read (the trip name is used instead). */
async function tripKeywordMap(admin: SupabaseClient): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const { data } = await admin.from('keyword_research').select('keyword, volume, target_path').eq('country', SITE_ID).like('target_path', '/packages/%')
    const best = new Map<string, number>()
    for (const r of (data ?? []) as { keyword: string | null; volume: number | null; target_path: string | null }[]) {
      const path = (r.target_path ?? '').split(/[?#]/)[0].replace(/\/+$/, '')
      if (!path || !r.keyword?.trim()) continue
      const vol = typeof r.volume === 'number' ? r.volume : -1
      if (!out.has(path) || vol > (best.get(path) ?? -1)) {
        out.set(path, r.keyword.trim())
        best.set(path, vol)
      }
    }
  } catch {
    // no keyword data: the trip name stands in
  }
  return out
}

export interface ScoredTrip {
  item: PackageItem
  result: SeoResult
  row: Row
}

/** Model calls ONE trip can cost in a day: meta text (1) and FAQ (1). The two have their own once-a-day markers. */
export const TRIP_CALLS_PER_DAY_MAX = 2

/** The trip-page part of the heal. Scores every published trip (no AI, nothing stored on the row), and for a trip under
 * 70 makes the fixes in lib/content-repair-adapters.ts, each only while its field is empty. Never throws. Each trip
 * uses one of the day's repair slots, and at most TRIP_CALLS_PER_DAY_MAX model calls a day. Every change is logged to
 * content_edits (content_type 'package') BEFORE it is applied, and is undone by the same Undo as the other pages. */
async function healTripPages(
  admin: SupabaseClient,
  idx: SiteIndex,
  ctx: { started: number; aiOn: boolean; revertedFields: Map<string, Set<string>>; onChanged: (path: string) => void },
): Promise<{ scored: ScoredTrip[]; fixed: number; edits: number; calls: number; problems: string[] }> {
  const out = { scored: [] as ScoredTrip[], fixed: 0, edits: 0, calls: 0, problems: [] as string[] }
  try {
    const { data, error } = await admin.from('travel_packages').select('*').eq('status', 'published')
    if (error) return { ...out, problems: [`could not read the trips (${error.message})`] }
    const keywords = await tripKeywordMap(admin)
    const today = new Date().toISOString().slice(0, 10)
    out.scored = ((data ?? []) as Row[])
      .filter((row) => str(row.slug))
      .map((row) => {
        const item = buildPackageItem(row as Partial<DbPackage>, { existing: idx.existing, keyword: keywords.get(`/packages/${str(row.slug)}`) ?? null, today })
        return { item, result: seoScore(item.seo), row }
      })
    const queue = out.scored.filter((t) => t.result.score < HEAL_BELOW).sort((a, b) => a.result.score - b.result.score)

    for (const t of queue) {
      if (Date.now() - ctx.started > HEAL_BUDGET_MS) break
      const id = t.item.id
      const row = t.row as Partial<DbPackage>
      const skip = ctx.revertedFields.get(`package:${id}`) ?? new Set<string>()
      const planCtx = { past: t.item.past, existing: idx.existing, targets: idx.targets, skip }

      // What this trip would be asked to write. All the cheap "not today" checks come BEFORE a slot is claimed, so a
      // trip that will be skipped never uses one of the day's 6.
      const want = ctx.aiOn ? tripGenerationWanted(row, t.item.past) : { metaTitle: false, metaDescription: false, faq: false }
      let wantMeta = (want.metaTitle && !skip.has('meta_title')) || (want.metaDescription && !skip.has('meta_description'))
      let wantFaq = want.faq && !skip.has('ai_faqs')
      if (wantMeta && nogenActive(await getSetting(admin, `${NOGEN_PREFIX}:package-meta:${id}`))) wantMeta = false
      // FAQs an admin took out stay out; a trip whose last FAQ call answered but gave nothing usable waits 7 days.
      if (wantFaq && ((await tripFaqsOff(admin, id)) || nogenActive(await getSetting(admin, `${NOGEN_PREFIX}:trip:${id}`)))) wantFaq = false
      const cheap = assemblePackageChanges(row, planCtx)
      if (cheap.length === 0 && !wantMeta && !wantFaq) continue

      // One meta call and one FAQ call per trip per day, however often Heal now is pressed. The markers are taken
      // BEFORE the slot, so a trip whose calls were already used today (and has nothing else to do) never takes a slot.
      if (wantMeta && !(await claimDailyOnce(admin, `package:${id}`))) wantMeta = false
      if (wantFaq && !(await claimDailyOnce(admin, tripFaqDailyKey(id)))) wantFaq = false
      if (cheap.length === 0 && !wantMeta && !wantFaq) continue

      const slot = await claimRepairSlot(admin, `${TRIP_SLOT_PREFIX}${id}`)
      if (!slot.ok) {
        if (!/cap of/.test(slot.reason ?? '')) out.problems.push(slot.reason ?? 'no repair slot')
        break
      }

      const generated: GeneratedTrip = {}
      if (wantMeta) {
        const m = await writeTripMeta(row, { title: want.metaTitle && !skip.has('meta_title'), description: want.metaDescription && !skip.has('meta_description') })
        if (m.called) {
          out.calls++
          await recordRepairSpend(admin, 1)
        }
        if (m.answeredEmpty) await setSetting(admin, `${NOGEN_PREFIX}:package-meta:${id}`, new Date().toISOString()).catch(() => undefined)
        generated.meta_title = m.meta_title
        generated.meta_description = m.meta_description
      }
      if (wantFaq) {
        const made = await generatePackageFaqsDetailed(row as DbPackage)
        if (made.called) {
          out.calls++
          await recordRepairSpend(admin, 1)
        }
        if (made.answered) await setSetting(admin, `${NOGEN_PREFIX}:trip:${id}`, new Date().toISOString()).catch(() => undefined)
        if (made.faqs.length) generated.faqs = normTripFaqs(made.faqs)
      }

      // The model calls take a while: plan again from the row as it is NOW, so a field an admin filled in meanwhile is
      // never overwritten, and a trip that was unpublished is left alone.
      const { data: freshRow } = await admin.from('travel_packages').select('*').eq('id', id).eq('status', 'published').maybeSingle()
      if (!freshRow) continue
      const fresh = freshRow as Partial<DbPackage>
      const changes = assemblePackageChanges(fresh, { ...planCtx, past: isPastTripRow({ available_to: fresh.available_to ?? null }, today) }, generated)
      if (changes.length === 0) continue

      const applied = await applyTripChanges(admin, { id, path: t.item.path }, changes)
      if (applied.error) {
        out.problems.push(`${str(row.slug)}: ${applied.error}`)
        continue
      }
      out.fixed++
      out.edits += changes.length
      ctx.onChanged(t.item.path)
    }
  } catch (e) {
    out.problems.push(`trip pages: ${e instanceof Error ? e.message : 'failed'}`)
  }
  return out
}

/** Logs, then applies, the changes for one trip. "Log, then apply": no audit row, no edit; a failed update takes the
 * audit rows back out. Writes only the allow-listed columns (PACKAGE_FIX_COLUMNS), only on a published row. */
export async function applyTripChanges(admin: SupabaseClient, trip: { id: string; path: string }, changes: PackageChange[]): Promise<{ error?: string }> {
  // The meta title and description come from ONE call, so they share its estimate; the FAQ is its own call.
  const writable = new Set<string>(PACKAGE_WRITABLE_COLUMNS)
  const forbidden = changes.find((c) => !writable.has(c.column))
  if (forbidden) return { error: `refused: ${forbidden.column} is not a field the trip heal may write` }
  const metaRows = changes.filter((c) => c.fix === 'meta').length
  const edits: ContentEdit[] = changes.map((c) => ({
    content_type: 'package',
    content_id: trip.id,
    path: trip.path,
    field: c.field,
    reason: c.reason,
    before: c.before,
    after: c.after,
    method: c.method,
    published_after: true,
    cost_usd: c.method !== 'generate' ? 0 : c.fix === 'meta' ? Math.round((EST_COST_USD_PER_CALL / Math.max(1, metaRows)) * 10000) / 10000 : EST_COST_USD_PER_CALL,
  }))
  const logged = await insertEdits(admin, edits)
  if (logged.error) return { error: `the audit log could not be written (${logged.error})${/check constraint/i.test(logged.error) ? '; apply migration 0038' : ''}` }
  // The payload is built from the allow-list: a column is written only if it is on it AND a change names it.
  const columns: Row = {}
  for (const col of PACKAGE_WRITABLE_COLUMNS) {
    const c = changes.find((x) => x.column === col)
    if (c) columns[col] = c.value
  }
  const { error } = await admin.from('travel_packages').update({ ...columns, updated_at: new Date().toISOString() }).eq('status', 'published').eq('id', trip.id)
  if (error) {
    await deleteEdits(admin, logged.ids)
    return { error: `could not update ${trip.path}: ${error.message}` }
  }
  return {}
}

/** The new score columns for a fixed page, so the card is right straight away. */
function rescoreColumns(item: HealItem, fields: RepairFields, existing: Set<string>): Row {
  const next = seoScore(item.seo(fields, existing))
  return { seo_score: next.score, seo_reasons: next.reasons, seo_scored_at: new Date().toISOString() }
}

function restoreField(f: RepairFields, original: RepairFields, field: string): RepairFields {
  const key = field === 'links' ? 'body' : field
  const next = cloneFields(f)
  switch (key) {
    case 'body':
      next.body = original.body
      if (original.summary !== undefined) next.summary = original.summary
      return next
    case 'faq':
      next.faq = original.faq.map((p) => ({ ...p }))
      return next
    case 'key_takeaways':
      next.key_takeaways = [...original.key_takeaways]
      return next
    case 'title':
    case 'meta_title':
    case 'meta_description':
    case 'og_title':
    case 'og_description':
      ;(next as unknown as Record<string, unknown>)[key] = (original as unknown as Record<string, unknown>)[key]
      return next
    default:
      return next
  }
}

/** Fields whose automatic edit a person reverted in the last 60 days, keyed `<type>:<id>`. The heal leaves them alone. */
async function recentlyRevertedFields(admin: SupabaseClient): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  try {
    const since = new Date(Date.now() - REVERT_MEMORY_DAYS * 86_400_000).toISOString()
    const { data } = await admin.from('content_edits').select('content_type, content_id, field').not('reverted_at', 'is', null).gte('created_at', since)
    for (const r of (data ?? []) as { content_type: string; content_id: string | null; field: string }[]) {
      if (!r.content_id) continue
      const key = `${r.content_type}:${r.content_id}`
      if (!out.has(key)) out.set(key, new Set())
      out.get(key)!.add(r.field)
    }
  } catch {
    // unreadable: nothing is protected, but nothing is rewritten beyond the cheap fixes either
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------------

export interface HealCard {
  summary: HealSummary | null
  editsToday: number | null
  slotsUsed: number | null
  slotCap: number
  spend: { calls: number; usd: number }
  needsMigration: boolean
  /** WP19: the heal loop's budget, what it did today and the last few things it did. */
  loop: HealLoopCard
}

/** Everything the Self-healing card shows. Never throws. */
export async function healCard(admin: SupabaseClient): Promise<HealCard> {
  const loggable = await editsLoggable(admin)
  const [summary, editsToday, spend] = await Promise.all([readHealSummary(admin), loggable ? countEditsSince(admin, startOfSiteDayIso()) : Promise.resolve(null), readRepairSpend(admin)])
  let slotsUsed: number | null = null
  try {
    const { data } = await admin.from('app_settings').select('key').like('key', `content_repair_slot:${repairDay()}:%`)
    slotsUsed = (data ?? []).length
  } catch {
    slotsUsed = null
  }
  const loop = await healLoopCard(admin)
  return { summary, editsToday, slotsUsed, slotCap: REPAIR_ITEMS_PER_DAY, spend, needsMigration: !loggable, loop }
}
