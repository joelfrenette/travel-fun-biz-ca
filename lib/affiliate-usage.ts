import type { SupabaseClient } from '@supabase/supabase-js'
import { guidePath, guideKinds, GUIDE_KINDS, isGuideKind } from '@/lib/guides'
import { getSetting, setSetting } from '@/lib/app-settings'
import { generateSlug } from '@/lib/utils'
import { isNewsPost } from '@/lib/news-post'
import { pickRelatedPosts, type Post } from '@/lib/posts'
import { readAllPages } from '@/lib/paged-read'
import { compileRules, findMatches, scopeMatches, cleanPhrase, phraseKey, PAGE_CONTEXTS, type AffiliateRule, type CompiledRules, type FoundMatch, type LinkScope, type PageContext } from '@/lib/affiliate-linker'
import { KEYWORD_COLUMNS, isMissingKeywordsTable, type KeywordRow } from '@/lib/affiliate-rules'
import { articleHtml } from '@/lib/markdown'
import {
  PAGE_TYPE_LABEL, blogFieldSet, blogIndexFieldSet, destinationBlurbFieldSet, fieldAsHtml, fieldLabelOfKey, guideFieldSet, guideIndexFieldSet, homeFieldSet,
  linkPageFields, pageCopyFieldSet, tripFieldSet, whoWeAreFieldSet, type PageType, type TextField,
} from '@/lib/affiliate-text-sources'

// WP22 part 4 and WP23: "where is each phrase used on the site?" The scan reads every place listed in
// lib/affiliate-text-sources.ts (published guides, destination guides and blurbs, blog posts, trip pages, best-time and
// compare copy, and the home, who we are and index pages), builds the SAME text fields the public pages build, and runs the
// SAME finder and linker the pages use without writing anything back. The result is a compact report kept in app_settings
// (at most 100 KB).

export const USAGE_SETTING_KEY = 'affiliate_usage_report'
/** Most documents (pages) one scan reads. A site with more says so ("Only the first 2000 pages were checked"). */
export const MAX_USAGE_DOCS = 2000
export const MAX_REPORT_BYTES = 100_000
/** Example pages kept per phrase and shown in the preview. */
export const MAX_EXAMPLES = 10
/** More than this many pages: the preview warns that it may look spammy. */
export const COMMON_PAGE_LIMIT = 40
/** Under this many characters a phrase is flagged as too short to be safe. */
export const SHORT_PHRASE = 4
/** Most breakdown rows kept per phrase in the stored report. */
export const MAX_BREAKDOWN_ROWS = 40

export const NO_PAGE_NOTICE = 'No page uses this phrase yet; it will link wherever it appears in future.'

export interface UsageDoc {
  context: PageContext
  /** Site path, for example /blog/my-post or /destinations/croatia. */
  path: string
  title: string
  pageType?: PageType
  /** The text fields of the page in reading order (the same ones the page builds). */
  fields?: TextField[]
  /** Older shape: a markdown article and FAQ answers. Used only when `fields` is absent. */
  markdown?: string
  faqAnswers?: string[]
}

export interface Snippet { before: string; match: string; after: string }

export interface UsagePage { path: string; title: string; count: number; snippet: Snippet }

/** Matches of one phrase in one place, for example Trip pages (description): 4 matches. */
export interface BreakdownRow {
  pageType: PageType
  fieldKey: string
  /** Page type in plain English ("Trip pages"). */
  page: string
  /** Field in plain English ("description"). */
  field: string
  matches: number
  pages: number
}

export interface PhraseUsage {
  keywordId: string
  phrase: string
  status: 'on' | 'off'
  /** Pages where the phrase is written in plain text (so it can be linked). */
  pages: number
  /** Times it is written in plain text across those pages. */
  occurrences: number
  /** No page writes it anywhere: flagged for the admin. */
  notFound: boolean
  examples: UsagePage[]
  /** Where the matches are, by page type and field. Absent in reports stored before WP23. */
  breakdown?: BreakdownRow[]
}

export interface UsageReport {
  generatedAt: string
  /** Documents actually scanned. */
  scanned: number
  /** True when the site has more than MAX_USAGE_DOCS documents and the rest were not scanned. */
  truncated: boolean
  totalDocs: number
  /** Distinct places (page type and field) that had text in the scanned pages. Absent in older reports. */
  places?: number
  phrases: PhraseUsage[]
}

const LEGACY_PAGE_TYPE: Record<PageContext, PageType> = { blog: 'blog', guides: 'guide', destinations: 'destination', trips: 'trip', pages: 'home' }
export const pageTypeOfDoc = (doc: UsageDoc): PageType => doc.pageType ?? LEGACY_PAGE_TYPE[doc.context]

/** The text fields of a document. A document built the old way (markdown plus FAQ answers) gets the article and FAQ fields. */
export function docFields(doc: UsageDoc): TextField[] {
  if (doc.fields) return doc.fields
  const prefix = pageTypeOfDoc(doc) === 'blog' ? 'blog' : pageTypeOfDoc(doc) === 'destination' ? 'destination' : 'guide'
  const body: TextField = { id: `${prefix}.body`, key: `${prefix}.body`, format: 'html', value: articleHtml(doc.markdown ?? '') }
  const faq = (doc.faqAnswers ?? []).map((a, i): TextField => ({ id: `${prefix}.faq#${i}`, key: `${prefix}.faq`, format: 'text', value: String(a ?? '') }))
  return [body, ...faq]
}

/** The HTML the pages would show for this document (before linking). */
export function docHtml(doc: UsageDoc): string {
  return docFields(doc).map(fieldAsHtml).join('')
}

const snippetOf = (m: FoundMatch): Snippet => ({ before: m.before, match: m.text, after: m.after })

interface KeywordLike { id: string; phrase: string; scope: LinkScope; status: 'on' | 'off' }

interface FieldHit extends FoundMatch { fieldKey: string }

/** Every place the compiled phrases appear in this document, field by field, in reading order. */
function scanDoc(doc: UsageDoc, c: CompiledRules): FieldHit[] {
  const out: FieldHit[] = []
  for (const f of docFields(doc)) {
    if (!f.value) continue
    for (const m of findMatches(fieldAsHtml(f), c, doc.context)) out.push({ ...m, fieldKey: f.key })
  }
  return out
}

/** Distinct places (field keys) that have any text in these documents. */
function placesIn(docs: UsageDoc[]): Set<string> {
  const places = new Set<string>()
  for (const d of docs) for (const f of docFields(d)) if (f.value.trim()) places.add(f.key)
  return places
}

const labelOf = (key: string): { page: string; field: string } => {
  const f = key.split('.')[0]
  return { page: PAGE_TYPE_LABEL[f as PageType] ?? f, field: fieldLabelOfKey(key) }
}
function pageTypeOfKey(key: string): PageType {
  return key.split('.')[0] as PageType
}

/** "Trip pages (description): 4 matches". */
export const breakdownLabel = (r: Pick<BreakdownRow, 'page' | 'field' | 'matches'>): string => `${r.page} (${r.field}): ${r.matches} match${r.matches === 1 ? '' : 'es'}`

type Agg = Map<string, { matches: number; pages: number }>
function addBreakdown(agg: Agg, fieldKey: string, matches: number) {
  const cur = agg.get(fieldKey) ?? { matches: 0, pages: 0 }
  cur.matches += matches
  cur.pages += 1
  agg.set(fieldKey, cur)
}
function breakdownRows(agg: Agg): BreakdownRow[] {
  return [...agg.entries()]
    .map(([fieldKey, v]): BreakdownRow => ({ pageType: pageTypeOfKey(fieldKey), fieldKey, ...labelOf(fieldKey), matches: v.matches, pages: v.pages }))
    .sort((a, b) => b.matches - a.matches || (a.fieldKey < b.fieldKey ? -1 : 1))
}

/** Pure: counts, per keyword, the pages and occurrences across the documents. */
export function buildUsageReport(docs: UsageDoc[], keywords: KeywordLike[], opts: { now?: Date; totalDocs?: number } = {}): UsageReport {
  const asRules = (list: KeywordLike[]): AffiliateRule[] => list.map((k) => ({ id: k.id, phrase: k.phrase, slug: 'xx', scope: k.scope, max_per_page: 1 }))
  const compiled = new Map<PageContext, CompiledRules>()
  // Counting does not depend on ON or OFF, so every keyword is compiled for every context it applies to.
  for (const ctx of PAGE_CONTEXTS) compiled.set(ctx, compileRules(asRules(keywords.filter((k) => scopeMatches(k.scope, ctx))), ctx))

  interface Entry { pages: number; occurrences: number; examples: UsagePage[]; breakdown: Agg }
  const byKey = new Map<string, Entry>()
  for (const doc of docs) {
    const c = compiled.get(doc.context)
    if (!c || !c.re) continue
    const perKey = new Map<string, { count: number; first: FoundMatch; fields: Map<string, number> }>()
    for (const m of scanDoc(doc, c)) {
      if (m.zone !== null) continue
      const cur = perKey.get(m.key)
      if (cur) {
        cur.count += 1
        cur.fields.set(m.fieldKey, (cur.fields.get(m.fieldKey) ?? 0) + 1)
      } else perKey.set(m.key, { count: 1, first: m, fields: new Map([[m.fieldKey, 1]]) })
    }
    for (const [key, v] of perKey) {
      const agg: Entry = byKey.get(key) ?? { pages: 0, occurrences: 0, examples: [], breakdown: new Map() }
      agg.pages += 1
      agg.occurrences += v.count
      for (const [fieldKey, n] of v.fields) addBreakdown(agg.breakdown, fieldKey, n)
      if (agg.examples.length < MAX_EXAMPLES) agg.examples.push({ path: doc.path, title: doc.title, count: v.count, snippet: snippetOf(v.first) })
      byKey.set(key, agg)
    }
  }

  const phrases: PhraseUsage[] = keywords.map((k) => {
    const phrase = cleanPhrase(k.phrase) ?? k.phrase
    const agg = byKey.get(phraseKey(phrase))
    return {
      keywordId: k.id,
      phrase,
      status: k.status,
      pages: agg?.pages ?? 0,
      occurrences: agg?.occurrences ?? 0,
      notFound: !agg,
      examples: agg?.examples ?? [],
      breakdown: agg ? breakdownRows(agg.breakdown).slice(0, MAX_BREAKDOWN_ROWS) : [],
    }
  })
  const totalDocs = opts.totalDocs ?? docs.length
  return { generatedAt: (opts.now ?? new Date()).toISOString(), scanned: docs.length, truncated: totalDocs > docs.length, totalDocs, places: placesIn(docs).size, phrases }
}

/** Shrinks a report until its JSON fits: fewer examples, then no snippets. Counts are never dropped. */
export function fitReport(report: UsageReport, maxBytes = MAX_REPORT_BYTES): UsageReport {
  let r = report
  for (const [keep, rows] of [[MAX_EXAMPLES, MAX_BREAKDOWN_ROWS], [3, 20], [1, 8], [0, 3]] as const) {
    r = { ...report, phrases: report.phrases.map((p) => ({ ...p, examples: p.examples.slice(0, keep), breakdown: (p.breakdown ?? []).slice(0, rows) })) }
    if (JSON.stringify(r).length <= maxBytes) return r
  }
  return r
}

// ---------- preview (before saving a rule) ----------

export interface PreviewPage extends UsagePage {
  kind: PageContext
  pageType: PageType
  /** Page type in plain English ("Trip pages"). */
  pageLabel: string
  /** How many of the occurrences the rule would link on this page: the real linker is run, so the limits are the page's own. */
  willLink: number
  /** Where on the page the matches are: [{ label: "description", count: 2 }]. */
  fields: { label: string; count: number }[]
  warnings: string[]
}

export interface PreviewResult {
  /** Example pages (at most PREVIEW_SHOWN), the first ones in the order they are checked. */
  pages: PreviewPage[]
  pageCount: number
  occurrences: number
  /** Pages in the list above are cut to this many; pageCount is the true number. */
  shown: number
  warnings: string[]
  /** Documents read. */
  scanned: number
  truncated: boolean
  totalDocs: number
  /** Pages checked for this phrase (the ones inside the chosen "Where"), and the places (page type and field) that had text. */
  checkedPages: number
  checkedPlaces: number
  /** Where the matches are, by page type and field, biggest first. */
  breakdown: BreakdownRow[]
  /** "Checked 120 pages in 14 places." (plus a notice when the site has more pages than were read). */
  coverage: string
  /** Said in plain words when the phrase was found nowhere. Null otherwise. */
  explanation: string | null
  /** Set when no page uses the phrase yet. Saving is still allowed. */
  emptyNotice: string | null
}

export const PREVIEW_SHOWN = 10

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Checked 120 pages in 14 places." plus, when the site has more pages than were read, how many were. */
export function coverageSentence(r: { checkedPages: number; checkedPlaces: number; truncated: boolean; scanned: number; totalDocs: number }): string {
  const base = `Checked ${plural(r.checkedPages, 'page')} in ${plural(r.checkedPlaces, 'place')}.`
  return r.truncated ? `${base} Only the first ${r.scanned} of ${r.totalDocs} pages were checked.` : base
}

/** Pure: what would this rule do across the documents? Does not write anything. */
export function previewRule(docs: UsageDoc[], input: { phrase: string; scope: LinkScope; max_per_page: number }, opts: { totalDocs?: number } = {}): PreviewResult {
  const totalDocs = opts.totalDocs ?? docs.length
  const truncated = totalDocs > docs.length
  const empty: PreviewResult = {
    pages: [], pageCount: 0, occurrences: 0, shown: 0, warnings: [], scanned: docs.length, truncated, totalDocs,
    checkedPages: 0, checkedPlaces: 0, breakdown: [], coverage: '', explanation: null, emptyNotice: null,
  }
  const phrase = cleanPhrase(input.phrase)
  if (!phrase) return { ...empty, warnings: ['That phrase cannot be used.'] }
  const rule: AffiliateRule = { id: 'preview', phrase, slug: 'xx', scope: input.scope, max_per_page: Math.min(3, Math.max(1, Math.trunc(input.max_per_page) || 1)) }
  // The same matching the pages use. A copy of the rule with scope "all" finds the pages the chosen "Where" leaves out.
  const anywhere: AffiliateRule = { ...rule, scope: 'all' }
  const compiledAnywhere = new Map<PageContext, CompiledRules>()
  const anywhereFor = (ctx: PageContext) => compiledAnywhere.get(ctx) ?? (compiledAnywhere.set(ctx, compileRules([anywhere], ctx)), compiledAnywhere.get(ctx)!)

  const pages: PreviewPage[] = []
  const agg: Agg = new Map()
  const checked: UsageDoc[] = []
  const leftOut = new Map<string, number>()
  let occurrences = 0
  let pageCount = 0
  let anyInLink = 0
  let anyInHeading = 0
  for (const doc of docs) {
    const hits = scanDoc(doc, anywhereFor(doc.context))
    const linkable = hits.filter((m) => m.zone === null)
    if (!scopeMatches(input.scope, doc.context)) {
      if (linkable.length > 0) leftOut.set(PAGE_TYPE_LABEL[pageTypeOfDoc(doc)], (leftOut.get(PAGE_TYPE_LABEL[pageTypeOfDoc(doc)]) ?? 0) + 1)
      continue
    }
    checked.push(doc)
    const inLink = hits.filter((m) => m.zone === 'link').length
    const inHeading = hits.filter((m) => m.zone === 'heading' || m.zone === 'summary').length
    if (inLink) anyInLink += 1
    if (inHeading) anyInHeading += 1
    if (linkable.length === 0) continue
    pageCount += 1
    occurrences += linkable.length
    const perField = new Map<string, number>()
    for (const m of linkable) perField.set(m.fieldKey, (perField.get(m.fieldKey) ?? 0) + 1)
    for (const [fieldKey, n] of perField) addBreakdown(agg, fieldKey, n)
    if (pages.length < PREVIEW_SHOWN) {
      const warnings: string[] = []
      if (inLink) warnings.push('The phrase is already part of another link on this page.')
      if (inHeading) warnings.push('The phrase also appears in a heading (headings are never linked).')
      const type = pageTypeOfDoc(doc)
      pages.push({
        path: doc.path,
        title: doc.title,
        kind: doc.context,
        pageType: type,
        pageLabel: PAGE_TYPE_LABEL[type],
        count: linkable.length,
        // The page's own linker, over the page's own fields, with the page's own limits.
        willLink: linkPageFields(docFields(doc), [rule], doc.context).count,
        fields: [...perField].map(([k, n]) => ({ label: fieldLabelOfKey(k), count: n })),
        snippet: snippetOf(linkable[0]),
        warnings,
      })
    }
  }
  const warnings: string[] = []
  if (phrase.length < SHORT_PHRASE) warnings.push(`This phrase is very short (${phrase.length} characters). It may link where you did not expect.`)
  if (pageCount > COMMON_PAGE_LIMIT) warnings.push(`This phrase is on ${pageCount} pages: this may look spammy. Think about a longer phrase or the "Max per page" setting.`)
  if (anyInLink) warnings.push(`On ${anyInLink} page${anyInLink === 1 ? '' : 's'} the phrase is already inside another link; those spots are left alone.`)
  if (anyInHeading) warnings.push(`On ${anyInHeading} page${anyInHeading === 1 ? '' : 's'} the phrase is in a heading; headings are never linked.`)
  const leftOutTotal = [...leftOut.values()].reduce((a, b) => a + b, 0)
  if (leftOutTotal > 0) {
    warnings.push(`The phrase is also written on ${plural(leftOutTotal, 'page')} that your "Where" choice leaves out (${[...leftOut].map(([l, n]) => `${l}: ${n}`).join(', ')}). Choose "All pages" to link it there too.`)
  }
  const checkedPlaces = placesIn(checked).size
  const result: PreviewResult = {
    pages, pageCount, occurrences, shown: pages.length, warnings, scanned: docs.length, truncated, totalDocs,
    checkedPages: checked.length, checkedPlaces, breakdown: breakdownRows(agg), coverage: '', explanation: null, emptyNotice: null,
  }
  const coverage = coverageSentence(result)
  result.coverage = coverage
  if (pageCount === 0) {
    result.explanation =
      checked.length === 0
        ? `${coverage} There is nothing to check in the part of the site you picked. Choose "All pages" in "Where".`
        : `${coverage} "${phrase}" was not found in any of them. Try the singular or the plural, or check the spelling. A hyphen, a different spacing and a plural "s" at the end are matched for you; other word forms are not.`
    result.emptyNotice = NO_PAGE_NOTICE
  }
  return result
}

// ---------- reading the site ----------

interface GuideRow { kind: string; slug: string; name: string; summary: string | null; key_takeaways: string[] | null; body: string | null; faq: { q?: unknown; a?: unknown }[] | null }
interface TripRow { slug: string | null; name: string; destination: string | null; [k: string]: unknown }
interface BlurbRow { slug: string; destination: string; blurb: string }
interface CopyRow { path: string; intro: string | null; key_takeaways: string[] | null; faq: { q?: unknown; a?: unknown }[] | null }

/** Reads a whole table (page by page, PostgREST returns at most 1000 rows at a time). A failing table gives no rows and its message. */
async function readRows<T>(admin: SupabaseClient, table: string, columns: string, orderBy: string, narrow: (q: any) => any): Promise<{ rows: T[]; error?: string }> {
  const res = await readAllPages<T>((from, to) => narrow(admin.from(table).select(columns)).order(orderBy).range(from, to), 3)
  return { rows: res.rows, error: res.ok || res.capped ? undefined : res.error }
}

/** The pages that are not rows in a table: home, who we are, the blog index and the index of each guide kind. */
export function staticUsageDocs(): UsageDoc[] {
  const docs: UsageDoc[] = [
    { context: 'pages', pageType: 'home', path: '/', title: 'Home page', fields: homeFieldSet('en').fields },
    { context: 'pages', pageType: 'who-we-are', path: '/who-we-are', title: 'Who we are', fields: whoWeAreFieldSet().fields },
    { context: 'pages', pageType: 'blog-index', path: '/blog', title: 'Blog', fields: blogIndexFieldSet().fields },
  ]
  for (const kind of GUIDE_KINDS) {
    const info = guideKinds[kind]
    docs.push({ context: 'pages', pageType: 'guide-index', path: info.urlPrefix, title: `${info.plural} index`, fields: guideIndexFieldSet(kind, info.plural).fields })
  }
  return docs
}

/** Every public page we can list from the database, as documents. At most MAX_USAGE_DOCS are returned; totalDocs says how many exist (capped at the number read). */
export async function loadUsageDocs(admin: SupabaseClient, now: Date = new Date()): Promise<{ docs: UsageDoc[]; totalDocs: number; error?: string; notes?: string[] }> {
  const [guidesRes, postsRes, tripsRes, blurbsRes, copyRes] = await Promise.all([
    readRows<GuideRow>(admin, 'guides', 'kind, slug, name, summary, key_takeaways, body, faq', 'slug', (q) => q.eq('status', 'published')),
    readRows<Post>(admin, 'posts', '*', 'slug', (q) => q.eq('status', 'published')),
    readRows<TripRow>(admin, 'travel_packages', '*', 'slug', (q) => q.eq('status', 'published')),
    readRows<BlurbRow>(admin, 'destination_blurbs', 'slug, destination, blurb', 'slug', (q) => q),
    readRows<CopyRow>(admin, 'page_copy', 'path, intro, key_takeaways, faq', 'path', (q) => q.eq('status', 'published')),
  ])
  if (guidesRes.error && postsRes.error) return { docs: [], totalDocs: 0, error: guidesRes.error }
  const notes = [guidesRes, postsRes, tripsRes, blurbsRes, copyRes].flatMap((r, i) => (r.error ? [`${['guides', 'posts', 'trips', 'destination blurbs', 'page copy'][i]}: ${r.error}`] : []))

  const docs: UsageDoc[] = staticUsageDocs()

  const destinationGuideSlugs = new Set<string>()
  for (const g of guidesRes.rows) {
    if (!isGuideKind(g.kind)) continue
    const isDestination = g.kind === 'destinations'
    if (isDestination) destinationGuideSlugs.add(g.slug)
    docs.push({
      context: isDestination ? 'destinations' : 'guides',
      pageType: isDestination ? 'destination' : 'guide',
      path: guidePath(g.kind, g.slug),
      title: g.name,
      // The quick facts are counted under the title ("left"): that is where a page with no trip card shows them.
      fields: guideFieldSet(g, isDestination ? 'destination' : 'guide', 'left').fields,
    })
  }

  const live = postsRes.rows.filter((p) => !(p.publish_date && new Date(p.publish_date).getTime() > now.getTime())) // not live yet
  for (const p of live) {
    const more = pickRelatedPosts(p, live, 3).map((x) => x.meta_description ?? '')
    docs.push({ context: 'blog', pageType: 'blog', path: `/blog/${p.slug}`, title: p.title, fields: blogFieldSet(p, { isNews: isNewsPost(p), moreExcerpts: more }).fields })
  }

  const trips = tripsRes.rows.filter((t) => !!t.slug)
  for (const t of trips) {
    docs.push({ context: 'trips', pageType: 'trip', path: `/packages/${t.slug}`, title: t.name, fields: tripFieldSet(t as Parameters<typeof tripFieldSet>[0], now.toISOString().slice(0, 10)).fields })
  }

  // A destination page with no guide shows the destination's intro blurb (only when the destination has a published trip).
  const tripSlugs = new Set(trips.map((t) => generateSlug(String(t.destination ?? ''))).filter(Boolean))
  for (const b of blurbsRes.rows) {
    if (!b.slug || destinationGuideSlugs.has(b.slug) || !tripSlugs.has(b.slug)) continue
    const set = destinationBlurbFieldSet(b.blurb)
    if (set.fields.length > 0) docs.push({ context: 'destinations', pageType: 'destination-trips', path: `/destinations/${b.slug}`, title: b.destination || b.slug, fields: set.fields })
  }

  for (const c of copyRes.rows) {
    const kind = /^\/compare\/[^/]+$/.test(c.path) ? 'compare' : /^\/best-time-to-visit\/[^/]+$/.test(c.path) ? 'best-time' : null
    if (!kind) continue
    docs.push({ context: 'pages', pageType: kind, path: c.path, title: c.path, fields: pageCopyFieldSet(c, kind).fields })
  }

  return { docs: docs.slice(0, MAX_USAGE_DOCS), totalDocs: docs.length, notes }
}

export async function loadKeywordRows(admin: SupabaseClient): Promise<{ rows: KeywordRow[]; missing: boolean; error?: string }> {
  const res = await admin.from('affiliate_keywords').select(KEYWORD_COLUMNS).order('created_at').limit(1000)
  if (res.error) return isMissingKeywordsTable(res.error.message) ? { rows: [], missing: true } : { rows: [], missing: false, error: res.error.message }
  return { rows: (res.data ?? []) as unknown as KeywordRow[], missing: false }
}

export async function loadStoredReport(admin: SupabaseClient): Promise<UsageReport | null> {
  try {
    const raw = await getSetting(admin, USAGE_SETTING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as UsageReport
    return parsed && Array.isArray(parsed.phrases) ? parsed : null
  } catch {
    return null
  }
}

/** Scans the site and stores the report. Never throws: returns the report, or why it could not be made. */
export async function rescanSite(admin: SupabaseClient, now: Date = new Date()): Promise<{ ok: true; report: UsageReport } | { ok: false; error: string; migrationMissing?: boolean }> {
  try {
    const kw = await loadKeywordRows(admin)
    if (kw.missing) return { ok: false, error: 'Run migration 0050 first.', migrationMissing: true }
    if (kw.error) return { ok: false, error: kw.error }
    const site = await loadUsageDocs(admin, now)
    if (site.error) return { ok: false, error: site.error }
    const report = fitReport(buildUsageReport(site.docs, kw.rows, { now, totalDocs: site.totalDocs }))
    const saved = await setSetting(admin, USAGE_SETTING_KEY, JSON.stringify(report))
    if (saved.error) return { ok: false, error: saved.error }
    return { ok: true, report }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not scan the site' }
  }
}
