import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/integrations/supabase/client'
import { getComparePairSlugs } from '@/lib/compare-destinations'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'

// Real copy for the compare and best-time pages (growth loop wave 2, WP8): the types, the public read (anon
// client, RLS only lets published rows through), the admin reads and writes (service role) and the candidate
// list (which pages could get copy next). Writing it is lib/page-copy-composer.ts (the AI and the quality
// gate) and lib/page-copy-run.ts (caps, lock and the pipeline step).

export const PAGE_COPY_TYPES = ['compare', 'best-time'] as const
export type PageCopyType = (typeof PAGE_COPY_TYPES)[number]

export interface PageCopyFaq {
  q: string
  a: string
}

export interface PageCopy {
  id: string
  path: string
  page_type: PageCopyType
  intro: string
  faq: PageCopyFaq[]
  key_takeaways: string[]
  /** Slugs of the trips the intro links to (/packages/<slug>). */
  linked_slugs: string[]
  meta_title: string | null
  meta_description: string | null
  og_title: string | null
  og_description: string | null
  primary_keyword: string | null
  status: 'draft' | 'published'
  source: 'ai' | 'manual'
  quality_notes: string | null
  created_at: string
  updated_at: string
}

/** What a visitor gets: no admin notes, no source. */
export type PublicPageCopy = Omit<PageCopy, 'quality_notes' | 'source'>

const PUBLIC_COLUMNS = 'id, path, page_type, intro, faq, key_takeaways, linked_slugs, meta_title, meta_description, og_title, og_description, primary_keyword, status, created_at, updated_at'
const ADMIN_COLUMNS = `${PUBLIC_COLUMNS}, source, quality_notes`
/** The admin list does not need the long intro or the FAQ. */
const SUMMARY_COLUMNS = 'id, path, page_type, status, source, quality_notes, created_at, updated_at'

export type PageCopySummary = Pick<PageCopy, 'id' | 'path' | 'page_type' | 'status' | 'source' | 'quality_notes' | 'created_at' | 'updated_at'>

export function comparePath(pairSlug: string): string {
  return `/compare/${pairSlug}`
}

export function bestTimePath(destinationSlug: string): string {
  return `/best-time-to-visit/${destinationSlug}`
}

export function pageTypeOfPath(path: string): PageCopyType | null {
  if (/^\/compare\/[^/]+$/.test(path)) return 'compare'
  if (/^\/best-time-to-visit\/[^/]+$/.test(path)) return 'best-time'
  return null
}

// ---------------------------------------------------------------------------------------------------
// Public read (anon client: RLS returns published rows only, a draft can never leak through here)
// ---------------------------------------------------------------------------------------------------

/** The published copy for a page, or null (no row, a draft, or a read error: the page then renders as before). */
export async function getPublishedPageCopy(path: string): Promise<PublicPageCopy | null> {
  const { data, error } = await supabase.from('page_copy').select(PUBLIC_COLUMNS).eq('path', path).eq('status', 'published').maybeSingle()
  if (error) {
    console.error('[page-copy] fetch failed:', error.message)
    return null
  }
  return (data as unknown as PublicPageCopy | null) ?? null
}

/** The slugs the copy links to that are NOT among the page's current trips. Empty means the copy is safe to show.
 * Pure, so it can be tested. */
export function staleLinkedSlugs(linkedSlugs: string[] | null | undefined, currentSlugs: string[]): string[] {
  const current = new Set(currentSlugs)
  return (linkedSlugs ?? []).filter((s) => !current.has(s))
}

// ---------------------------------------------------------------------------------------------------
// Admin reads and writes (service role)
// ---------------------------------------------------------------------------------------------------

export async function listPageCopyAdmin(admin: SupabaseClient): Promise<PageCopySummary[]> {
  const { data, error } = await admin.from('page_copy').select(SUMMARY_COLUMNS).order('created_at', { ascending: false })
  if (error) throw new Error(`Could not read page copy: ${error.message}`)
  return (data ?? []) as PageCopySummary[]
}

export async function getPageCopyAdmin(admin: SupabaseClient, path: string): Promise<PageCopy | null> {
  const { data } = await admin.from('page_copy').select(ADMIN_COLUMNS).eq('path', path).maybeSingle()
  return (data as unknown as PageCopy | null) ?? null
}

export async function getPageCopyById(admin: SupabaseClient, id: string): Promise<PageCopy | null> {
  const { data } = await admin.from('page_copy').select(ADMIN_COLUMNS).eq('id', id).maybeSingle()
  return (data as unknown as PageCopy | null) ?? null
}

export type PageCopyWrite = Omit<PageCopy, 'id' | 'created_at' | 'updated_at'>

/** Insert or replace the copy for one path (path is unique). Returns the saved row. */
export async function savePageCopy(admin: SupabaseClient, row: PageCopyWrite): Promise<PageCopy> {
  const { data, error } = await admin
    .from('page_copy')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'path' })
    .select(ADMIN_COLUMNS)
    .single()
  if (error || !data) throw new Error(`Could not save the page copy: ${error?.message ?? 'no row returned'}`)
  return data as unknown as PageCopy
}

export async function setPageCopyStatus(admin: SupabaseClient, id: string, status: 'draft' | 'published'): Promise<{ copy?: PageCopySummary; error?: string }> {
  // Publishing is the admin's decision, so the "held back" reasons stop being true: clear them.
  const patch = status === 'published' ? { status, quality_notes: null, updated_at: new Date().toISOString() } : { status, updated_at: new Date().toISOString() }
  const { data, error } = await admin.from('page_copy').update(patch).eq('id', id).select(SUMMARY_COLUMNS).maybeSingle()
  if (error) return { error: error.message }
  if (!data) return { error: 'That page copy no longer exists.' }
  return { copy: data as PageCopySummary }
}

export async function deletePageCopy(admin: SupabaseClient, id: string): Promise<{ error?: string }> {
  const { error } = await admin.from('page_copy').delete().eq('id', id)
  return error ? { error: error.message } : {}
}

/** How many rows were created since `sinceIso`, or null when the count could not be read. Callers that guard
 * spending MUST treat null as "do not write" (fail closed). */
export async function pageCopyCreatedSince(admin: SupabaseClient, sinceIso: string): Promise<number | null> {
  const { count, error } = await admin.from('page_copy').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso)
  return error ? null : (count ?? 0)
}

// ---------------------------------------------------------------------------------------------------
// Candidates: which pages could get copy next
// ---------------------------------------------------------------------------------------------------

export interface PageCopyCandidate {
  path: string
  type: PageCopyType
  /** Plain label for the admin, for example "Italy vs Tahiti" or "Best time to visit Santorini". */
  label: string
  /** True when a row (draft or published) already exists for the path. */
  hasRow: boolean
  /** The existing row's status, or null when there is none. */
  rowStatus: 'draft' | 'published' | null
}

/** Every compare pair and every best-time destination that currently has at least one published package, with
 * whether a copy row already exists. Never invents a page: the lists come from getComparePairSlugs and
 * getBestTimeToVisitSlugs, the same ones the sitemap uses. */
export async function listPageCopyCandidates(admin: SupabaseClient): Promise<PageCopyCandidate[]> {
  const [pairs, destinations, existing] = await Promise.all([
    getComparePairSlugs(),
    getBestTimeToVisitSlugs(),
    admin.from('page_copy').select('path, status'),
  ])
  if (existing.error) throw new Error(`Could not read page copy: ${existing.error.message}`)
  const rowStatus = new Map(((existing.data ?? []) as { path: string; status: 'draft' | 'published' }[]).map((r) => [r.path, r.status]))
  const out: PageCopyCandidate[] = []
  for (const p of pairs) {
    const path = comparePath(p.pairSlug)
    out.push({ path, type: 'compare', label: `${p.destinationA} vs ${p.destinationB}`, hasRow: rowStatus.has(path), rowStatus: rowStatus.get(path) ?? null })
  }
  for (const d of destinations) {
    const path = bestTimePath(d.slug)
    out.push({ path, type: 'best-time', label: `Best time to visit ${d.destination}`, hasRow: rowStatus.has(path), rowStatus: rowStatus.get(path) ?? null })
  }
  return out
}

/** The next page to write, or null. Pure, so the order can be tested.
 * - Only candidates with no row at all (a draft waits for the admin; it is never rewritten by the pipeline) and
 *   fewer than `maxAttempts` recorded failures are eligible.
 * - The two page types alternate: the type whose newest copy row is OLDEST goes first (a type with no row yet
 *   goes before one with rows; a tie goes to the order of PAGE_COPY_TYPES), so compare and best-time pages
 *   interleave instead of one type being finished first.
 * - Inside the type, the order is alphabetical by path, which is stable from run to run. */
export function pickNextCopyCandidate(
  candidates: PageCopyCandidate[],
  newestByType: Partial<Record<PageCopyType, string>>,
  failureCounts: Record<string, number>,
  maxAttempts: number,
): PageCopyCandidate | null {
  const eligible = candidates.filter((c) => !c.hasRow && (failureCounts[c.path] ?? 0) < maxAttempts)
  const types = PAGE_COPY_TYPES.filter((t) => eligible.some((c) => c.type === t))
  if (types.length === 0) return null
  types.sort((a, b) => {
    const ta = newestByType[a] ?? ''
    const tb = newestByType[b] ?? ''
    return ta === tb ? PAGE_COPY_TYPES.indexOf(a) - PAGE_COPY_TYPES.indexOf(b) : ta < tb ? -1 : 1
  })
  return eligible.filter((c) => c.type === types[0]).sort((a, b) => a.path.localeCompare(b.path))[0] ?? null
}
