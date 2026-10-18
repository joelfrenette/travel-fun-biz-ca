import type { SupabaseClient } from '@supabase/supabase-js'
import { renderMarkdown } from '@/lib/markdown'
import { guidePath, isGuideKind } from '@/lib/guides'
import { getSetting, setSetting } from '@/lib/app-settings'
import { compileRules, findMatches, scopeMatches, cleanPhrase, phraseKey, type AffiliateRule, type FoundMatch, type LinkScope, type PageContext } from '@/lib/affiliate-linker'
import { KEYWORD_COLUMNS, isMissingKeywordsTable, type KeywordRow } from '@/lib/affiliate-rules'

// WP22 part 4: "where is each phrase used on the site?" The scan reads published posts, guides and destination guides,
// renders their markdown to HTML in memory, and runs the SAME finder the pages use (lib/affiliate-linker.ts) without
// writing anything back. The result is a compact report kept in app_settings (at most 100 KB).

export const USAGE_SETTING_KEY = 'affiliate_usage_report'
export const MAX_USAGE_DOCS = 500
export const MAX_REPORT_BYTES = 100_000
export const MAX_EXAMPLES = 10
/** More than this many pages: the preview warns that it may look spammy. */
export const COMMON_PAGE_LIMIT = 40
/** Under this many characters a phrase is flagged as too short to be safe. */
export const SHORT_PHRASE = 4

export interface UsageDoc {
  context: PageContext
  /** Site path, for example /blog/my-post or /destinations/croatia. */
  path: string
  title: string
  markdown: string
  faqAnswers: string[]
}

export interface Snippet { before: string; match: string; after: string }

export interface UsagePage { path: string; title: string; count: number; snippet: Snippet }

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
}

export interface UsageReport {
  generatedAt: string
  /** Documents actually scanned. */
  scanned: number
  /** True when the site has more than MAX_USAGE_DOCS documents and the rest were not scanned. */
  truncated: boolean
  totalDocs: number
  phrases: PhraseUsage[]
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The HTML the pages would show for this document (before linking): the article, then the FAQ answers. */
export function docHtml(doc: UsageDoc): string {
  return renderMarkdown(doc.markdown) + doc.faqAnswers.map((a) => `<p>${escapeText(String(a ?? ''))}</p>`).join('')
}

const snippetOf = (m: FoundMatch): Snippet => ({ before: m.before, match: m.text, after: m.after })

interface KeywordLike { id: string; phrase: string; scope: LinkScope; status: 'on' | 'off' }

/** Pure: counts, per keyword, the pages and occurrences across the documents. */
export function buildUsageReport(docs: UsageDoc[], keywords: KeywordLike[], opts: { now?: Date; totalDocs?: number } = {}): UsageReport {
  const asRules = (list: KeywordLike[]): AffiliateRule[] => list.map((k) => ({ id: k.id, phrase: k.phrase, slug: 'xx', scope: k.scope, max_per_page: 1 }))
  const contexts: PageContext[] = ['blog', 'guides', 'destinations']
  const compiled = new Map<PageContext, ReturnType<typeof compileRules>>()
  // Counting does not depend on ON or OFF, so every keyword is compiled for every context it applies to.
  for (const ctx of contexts) compiled.set(ctx, compileRules(asRules(keywords.filter((k) => scopeMatches(k.scope, ctx))), ctx))

  const byKey = new Map<string, { pages: number; occurrences: number; examples: UsagePage[] }>()
  for (const doc of docs) {
    const c = compiled.get(doc.context)
    if (!c || !c.re) continue
    const perKey = new Map<string, { count: number; first: FoundMatch }>()
    for (const m of findMatches(docHtml(doc), c, doc.context)) {
      if (m.zone !== null) continue
      const cur = perKey.get(m.key)
      if (cur) cur.count += 1
      else perKey.set(m.key, { count: 1, first: m })
    }
    for (const [key, v] of perKey) {
      const agg = byKey.get(key) ?? { pages: 0, occurrences: 0, examples: [] }
      agg.pages += 1
      agg.occurrences += v.count
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
    }
  })
  const totalDocs = opts.totalDocs ?? docs.length
  return { generatedAt: (opts.now ?? new Date()).toISOString(), scanned: docs.length, truncated: totalDocs > docs.length, totalDocs, phrases }
}

/** Shrinks a report until its JSON fits: fewer examples, then no snippets. Counts are never dropped. */
export function fitReport(report: UsageReport, maxBytes = MAX_REPORT_BYTES): UsageReport {
  let r = report
  for (const keep of [MAX_EXAMPLES, 3, 1, 0]) {
    r = { ...report, phrases: report.phrases.map((p) => ({ ...p, examples: p.examples.slice(0, keep) })) }
    if (JSON.stringify(r).length <= maxBytes) return r
  }
  return r
}

// ---------- preview (before saving a rule) ----------

export interface PreviewPage extends UsagePage {
  kind: PageContext
  /** How many of the occurrences the rule would link on this page (limited by Max per page). */
  willLink: number
  warnings: string[]
}

export interface PreviewResult {
  pages: PreviewPage[]
  pageCount: number
  occurrences: number
  /** Pages in the list above are cut to this many; pageCount is the true number. */
  shown: number
  warnings: string[]
  scanned: number
  truncated: boolean
}

export const PREVIEW_SHOWN = 50

/** Pure: what would this rule do across the documents? Does not write anything. */
export function previewRule(docs: UsageDoc[], input: { phrase: string; scope: LinkScope; max_per_page: number }, opts: { totalDocs?: number } = {}): PreviewResult {
  const phrase = cleanPhrase(input.phrase)
  const empty: PreviewResult = { pages: [], pageCount: 0, occurrences: 0, shown: 0, warnings: [], scanned: docs.length, truncated: (opts.totalDocs ?? docs.length) > docs.length }
  if (!phrase) return { ...empty, warnings: ['That phrase cannot be used.'] }
  const rule: AffiliateRule = { id: 'preview', phrase, slug: 'xx', scope: input.scope, max_per_page: Math.min(3, Math.max(1, Math.trunc(input.max_per_page) || 1)) }
  const pages: PreviewPage[] = []
  let occurrences = 0
  let pageCount = 0
  let anyInLink = 0
  let anyInHeading = 0
  for (const doc of docs) {
    if (!scopeMatches(input.scope, doc.context)) continue
    const matches = findMatches(docHtml(doc), [rule], doc.context)
    const linkable = matches.filter((m) => m.zone === null)
    const inLink = matches.filter((m) => m.zone === 'link').length
    const inHeading = matches.filter((m) => m.zone === 'heading' || m.zone === 'summary').length
    if (inLink) anyInLink += 1
    if (inHeading) anyInHeading += 1
    if (linkable.length === 0) continue
    pageCount += 1
    occurrences += linkable.length
    if (pages.length < PREVIEW_SHOWN) {
      const warnings: string[] = []
      if (inLink) warnings.push('The phrase is already part of another link on this page.')
      if (inHeading) warnings.push('The phrase also appears in a heading (headings are never linked).')
      pages.push({ path: doc.path, title: doc.title, kind: doc.context, count: linkable.length, willLink: Math.min(rule.max_per_page, linkable.length), snippet: snippetOf(linkable[0]), warnings })
    }
  }
  const warnings: string[] = []
  if (phrase.length < SHORT_PHRASE) warnings.push(`This phrase is very short (${phrase.length} characters). It may link where you did not expect.`)
  if (pageCount > COMMON_PAGE_LIMIT) warnings.push(`This phrase is on ${pageCount} pages: this may look spammy. Think about a longer phrase or the "Max per page" setting.`)
  if (anyInLink) warnings.push(`On ${anyInLink} page${anyInLink === 1 ? '' : 's'} the phrase is already inside another link; those spots are left alone.`)
  if (anyInHeading) warnings.push(`On ${anyInHeading} page${anyInHeading === 1 ? '' : 's'} the phrase is in a heading; headings are never linked.`)
  if (pageCount === 0) warnings.push('Not found anywhere on the site yet, so nothing would be linked today.')
  return { pages, pageCount, occurrences, shown: pages.length, warnings, scanned: docs.length, truncated: empty.truncated }
}

// ---------- reading the site ----------

interface PostRow { title: string; slug: string; body: string | null; faq: { a?: unknown }[] | null; publish_date: string | null }
interface GuideRow { kind: string; slug: string; name: string; body: string | null; faq: { a?: unknown }[] | null }

const answers = (faq: { a?: unknown }[] | null): string[] => (Array.isArray(faq) ? faq.map((f) => (typeof f?.a === 'string' ? f.a : '')).filter(Boolean) : [])

/** Published guides, destination guides and posts as documents. At most MAX_USAGE_DOCS are returned; totalDocs says how many exist (capped at the number read). */
export async function loadUsageDocs(admin: SupabaseClient, now: Date = new Date()): Promise<{ docs: UsageDoc[]; totalDocs: number; error?: string }> {
  const [guidesRes, postsRes] = await Promise.all([
    admin.from('guides').select('kind, slug, name, body, faq').eq('status', 'published').limit(MAX_USAGE_DOCS + 1),
    admin.from('posts').select('title, slug, body, faq, publish_date').eq('status', 'published').limit(MAX_USAGE_DOCS + 1),
  ])
  if (guidesRes.error && postsRes.error) return { docs: [], totalDocs: 0, error: guidesRes.error.message }
  const docs: UsageDoc[] = []
  for (const g of ((guidesRes.error ? [] : guidesRes.data) ?? []) as unknown as GuideRow[]) {
    if (!isGuideKind(g.kind)) continue
    docs.push({ context: g.kind === 'destinations' ? 'destinations' : 'guides', path: guidePath(g.kind, g.slug), title: g.name, markdown: g.body ?? '', faqAnswers: answers(g.faq) })
  }
  for (const p of ((postsRes.error ? [] : postsRes.data) ?? []) as unknown as PostRow[]) {
    if (p.publish_date && new Date(p.publish_date).getTime() > now.getTime()) continue // not live yet
    docs.push({ context: 'blog', path: `/blog/${p.slug}`, title: p.title, markdown: p.body ?? '', faqAnswers: answers(p.faq) })
  }
  return { docs: docs.slice(0, MAX_USAGE_DOCS), totalDocs: docs.length }
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
