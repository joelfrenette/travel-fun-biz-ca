import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import type { QueryPageRow } from '@/lib/gsc-mining'
import { cleanAnchor, type LinkWish } from '@/lib/seo-links'
import { TYPE_PRIORITY, type SeoPage, type SeoPageType } from '@/lib/seo-pages'

// CANNIBALISATION (SEO engine 2). Two of our own pages competing for the same search split their strength, so neither ranks as well as one
// strong page would. This finds the searches where that happens, picks ONE primary page per search, and acts in order of safety:
//   (i)  AUTOMATIC and reversible: one link from each secondary blog post or guide to the primary page (lib/seo-links.ts: logged with Undo,
//        at most 3 pages a day, never to itself, only published pages). That shows Google which page is the main one.
//   (ii) SUGGESTED for the owner, never automatic: differentiate the titles, merge the pages, or point a canonical at the primary.
// The pure functions take plain rows and pages. The stored result is read by the SEO playbook audit.

/** Each page needs at least this many impressions for the search (in the 28 days) to count as competing. */
export const MIN_IMPRESSIONS_EACH = 10
export const MAX_FINDINGS = 30
export const MAX_SECONDARIES = 4
export const CANNIBAL_KEY = 'seo_cannibalization_state'

export interface PageShare {
  path: string
  type: SeoPageType
  clicks: number
  impressions: number
  position: number
}

export interface CannibalFinding {
  query: string
  primary: PageShare
  secondaries: PageShare[]
  /** Impressions of the search across the competing pages. */
  impressions: number
  /** What a person should decide (never done automatically). */
  suggestions: string[]
}

/** The primary page: most clicks, then most impressions, then a guide, trip or destination over a post, then the shorter address. Pure. */
export function comparePrimary(a: PageShare, b: PageShare): number {
  return b.clicks - a.clicks || b.impressions - a.impressions || TYPE_PRIORITY[b.type] - TYPE_PRIORITY[a.type] || a.path.length - b.path.length || a.path.localeCompare(b.path)
}

export function pickPrimary(candidates: readonly PageShare[]): PageShare | null {
  return candidates.length ? [...candidates].sort(comparePrimary)[0] : null
}

const label = (t: SeoPageType) => (t === 'blog' ? 'post' : t === 'package' ? 'trip page' : t === 'destination' ? 'destination page' : 'guide')

/** The searches where two or more of OUR pages each have at least MIN_IMPRESSIONS_EACH impressions, with a primary and the secondaries.
 * Only pages that exist (published, indexable) count; the home page never does. Pure. */
export function groupCannibalised(rows: readonly QueryPageRow[], pages: readonly SeoPage[], opts: { minImpressions?: number } = {}): CannibalFinding[] {
  const min = opts.minImpressions ?? MIN_IMPRESSIONS_EACH
  const known = new Map(pages.filter((p) => !p.thin).map((p) => [p.path, p]))
  const byQuery = new Map<string, Map<string, { clicks: number; imp: number; weighted: number }>>()
  for (const r of rows) {
    const page = known.get(r.path)
    if (!page || !r.query) continue
    const perPage = byQuery.get(r.query) ?? new Map()
    const cur = perPage.get(r.path) ?? { clicks: 0, imp: 0, weighted: 0 }
    cur.clicks += r.clicks
    cur.imp += r.impressions
    cur.weighted += r.position * Math.max(r.impressions, 1)
    perPage.set(r.path, cur)
    byQuery.set(r.query, perPage)
  }
  const findings: CannibalFinding[] = []
  for (const [query, perPage] of byQuery) {
    const shares: PageShare[] = []
    for (const [path, v] of perPage) {
      if (v.imp < min) continue
      const page = known.get(path) as SeoPage
      shares.push({ path, type: page.type, clicks: v.clicks, impressions: v.imp, position: Math.round((v.weighted / Math.max(v.imp, 1)) * 10) / 10 })
    }
    if (shares.length < 2) continue
    shares.sort(comparePrimary)
    const [primary, ...secondaries] = shares
    findings.push({
      query,
      primary,
      secondaries: secondaries.slice(0, MAX_SECONDARIES),
      impressions: shares.reduce((s, x) => s + x.impressions, 0),
      suggestions: suggestionsFor(query, primary, secondaries.slice(0, MAX_SECONDARIES)),
    })
  }
  return findings.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query)).slice(0, MAX_FINDINGS)
}

/** What the owner could do, in plain words. None of this is done by itself. Pure. */
export function suggestionsFor(query: string, primary: PageShare, secondaries: readonly PageShare[]): string[] {
  const out: string[] = []
  for (const s of secondaries) {
    out.push(`Differentiate: give ${s.path} (a ${label(s.type)}) a title and first heading about a different angle than "${query}", so it stops competing with ${primary.path}.`)
    out.push(`Merge: if ${s.path} says the same thing as ${primary.path}, fold the useful parts into ${primary.path} and redirect ${s.path} to it. Only a person should do this.`)
    out.push(`Canonical: if ${s.path} is a near copy of ${primary.path}, set its canonical address to ${primary.path}. Only a person should do this.`)
  }
  return out
}

/** The link wishes for a set of findings, biggest first: every secondary post or guide links once to its primary, using the search as the
 * words of the link. Whether a wish is carried out is decided by lib/seo-links.ts (caps, published only, never to itself). Pure. */
export function cannibalWishes(findings: readonly CannibalFinding[]): LinkWish[] {
  const out: LinkWish[] = []
  for (const f of findings) {
    const anchor = cleanAnchor(f.query)
    if (!anchor) continue
    for (const s of f.secondaries) {
      out.push({
        fromPath: s.path,
        toPath: f.primary.path,
        anchor,
        kind: 'cannibalisation',
        why: `Both pages show in Google for "${f.query}" (${s.impressions} and ${f.primary.impressions} impressions in 28 days). The main page is ${f.primary.path}; this link tells Google so.`,
      })
    }
  }
  return out
}

export interface AutoLinkRecord {
  at: string
  from: string
  to: string
  query: string
  editId: string | null
}

export interface CannibalState {
  at: string
  findings: CannibalFinding[]
  autoLinked: AutoLinkRecord[]
  note: string
}

export const emptyCannibalState = (): CannibalState => ({ at: '', findings: [], autoLinked: [], note: '' })

export function parseCannibalState(raw: string | null | undefined): CannibalState {
  if (!raw) return emptyCannibalState()
  try {
    const v = JSON.parse(raw) as Partial<CannibalState>
    if (!v || typeof v !== 'object' || typeof v.at !== 'string') return emptyCannibalState()
    return {
      at: v.at,
      findings: Array.isArray(v.findings) ? (v.findings as CannibalFinding[]).slice(0, MAX_FINDINGS) : [],
      autoLinked: Array.isArray(v.autoLinked) ? (v.autoLinked as AutoLinkRecord[]).slice(-30) : [],
      note: typeof v.note === 'string' ? v.note : '',
    }
  } catch {
    return emptyCannibalState()
  }
}

export async function readCannibalState(admin: SupabaseClient): Promise<CannibalState> {
  try {
    return parseCannibalState(await getSetting(admin, CANNIBAL_KEY))
  } catch {
    return emptyCannibalState()
  }
}

/** Saves the findings (bounded) and the automatic links added so far (the newest 30). Never throws. */
export async function storeCannibalState(admin: SupabaseClient, findings: readonly CannibalFinding[], newLinks: readonly AutoLinkRecord[], note: string, now: Date = new Date()): Promise<CannibalState> {
  const prev = await readCannibalState(admin)
  const state: CannibalState = { at: now.toISOString(), findings: findings.slice(0, MAX_FINDINGS), autoLinked: [...prev.autoLinked, ...newLinks].slice(-30), note }
  try {
    await setSetting(admin, CANNIBAL_KEY, JSON.stringify(state))
  } catch {
    // a result that cannot be saved is only a missing card
  }
  return state
}
