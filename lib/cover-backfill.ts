// Cover backfill (images loop): finds PUBLISHED posts and guides whose cover is missing, broken or bad (lib/image-quality.ts)
// or whose alt text is missing, and fills them in. It never overwrites a good cover. The plan is a pure function (so the
// offline check can test every rule); runCoverBackfill() reads the rows, probes the addresses, and writes only when apply is true.
// Run it through scripts/backfill-covers.ts (dry run by default, --yes to write).
import type { SupabaseClient } from '@supabase/supabase-js'
import { assessCover, coverAlt, coverKey, describeProblems, heroAlt, isOgCardUrl, type CoverProblem } from '@/lib/image-quality'
import { newsCoverAlt, newsCoverUrl, hasNewsTag } from '@/lib/news-cover'
import { ogImageUrl } from '@/lib/og-path'
import { SITE_URL } from '@/lib/site'

export interface BackfillRow {
  table: 'posts' | 'guides'
  id: string
  slug: string
  /** Guides only: the URL kind (destinations, hotels ...). */
  guideKind?: string
  title: string
  tags?: string[]
  date?: string | null
  cover: string | null
  alt: string | null
}

export interface Probe {
  ok: boolean
  width?: number
  height?: number
}

export type BackfillSource = 'news-card' | 'branded-card' | 'pexels' | 'alt-only' | 'needs-photo'

export interface BackfillAction {
  table: 'posts' | 'guides'
  id: string
  slug: string
  title: string
  source: BackfillSource
  reasons: string[]
  before: { cover: string | null; alt: string | null }
  /** What would be written; a missing key is left alone. */
  set: { cover?: string; alt?: string }
}

/** A stored address as a fetchable one (a site path becomes absolute). */
export function resolveCoverUrl(cover: string): string {
  const s = cover.trim()
  return s.startsWith('/') && !s.startsWith('//') ? `${SITE_URL}${s}` : s
}

/** True when an address is worth probing over the network: not a rendered card (those are drawn on demand). */
export const shouldProbe = (cover: string | null): cover is string => !!cover && !isOgCardUrl(cover) && /^(https?:\/\/|\/)/i.test(cover.trim())

/** Pure: the changes to make. Rows are walked oldest first so the earliest post keeps a repeated picture. `probes` is keyed by
 * the stored address. A good cover is never replaced; only its alt text is fixed when that is missing. */
export function planBackfill(rows: readonly BackfillRow[], probes: Readonly<Record<string, Probe>> = {}): BackfillAction[] {
  const actions: BackfillAction[] = []
  const ordered = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date ?? '').localeCompare(b.r.date ?? '') || a.i - b.i)
  const seen = new Set<string>()
  for (const { r } of ordered) {
    const probe = r.cover ? probes[r.cover] : undefined
    const assessment = assessCover(
      { url: r.cover, alt: r.alt, width: probe?.width ?? null, height: probe?.height ?? null },
      { otherCovers: seen, broken: probe ? !probe.ok : false },
    )
    const before = { cover: r.cover, alt: r.alt }
    const base = { table: r.table, id: r.id, slug: r.slug, title: r.title, before }

    if (assessment.good) {
      if (r.cover && !isOgCardUrl(r.cover)) seen.add(coverKey(r.cover))
      if (assessment.needsAlt) {
        const alt = r.table === 'guides' ? heroAlt(r.alt, r.title) : hasNewsTag(r.tags) ? newsCoverAlt(r.title) : coverAlt({ title: r.title, keyword: r.title })
        actions.push({ ...base, source: 'alt-only', reasons: ['alt text missing or generic'], set: { alt } })
      }
      continue
    }

    const reasons = [describeProblems(assessment.problems as CoverProblem[])]
    if (r.table === 'posts') {
      const isNews = hasNewsTag(r.tags)
      // A card for the post itself: unique to it, always 1200x630, no stock photo, no cost.
      const cover = isNews ? newsCoverUrl(r.slug) : ogImageUrl('blog', r.slug)
      const alt = isNews ? newsCoverAlt(r.title) : coverAlt({ title: r.title, keyword: r.title })
      actions.push({ ...base, source: isNews ? 'news-card' : 'branded-card', reasons, set: { cover, alt } })
    } else {
      // A guide's hero is captioned "Illustrative stock photo", so a drawn card must not stand in for it. Left for the selector
      // (--pexels) or a person; its alt text is still fixed when a (bad) hero exists.
      actions.push({ ...base, source: 'needs-photo', reasons, set: assessment.needsAlt && r.cover ? { alt: heroAlt(r.alt, r.title) } : {} })
    }
  }
  return actions
}

export interface BackfillReport {
  scanned: { posts: number; guides: number }
  actions: BackfillAction[]
  applied: number
  failed: { slug: string; error: string }[]
  skipped: string[]
}

const PROBE_TIMEOUT_MS = 8000

/** Fetches an address and reads its size when sharp is available. Never throws. */
export async function probeCover(cover: string, fetchImpl: typeof fetch = fetch): Promise<Probe> {
  try {
    const res = await fetchImpl(resolveCoverUrl(cover), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' })
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!res.ok || !type.startsWith('image/')) {
      await res.body?.cancel().catch(() => {})
      return { ok: false }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0) return { ok: false }
    try {
      const sharp = (await import('sharp')).default
      const meta = await sharp(buf).metadata()
      return { ok: true, width: meta.width, height: meta.height }
    } catch {
      return { ok: true }
    }
  } catch {
    return { ok: false }
  }
}

async function probeAll(covers: string[], probe: (c: string) => Promise<Probe>): Promise<Record<string, Probe>> {
  const out: Record<string, Probe> = {}
  const unique = Array.from(new Set(covers))
  let next = 0
  const worker = async () => {
    for (let i = next++; i < unique.length; i = next++) out[unique[i]] = await probe(unique[i])
  }
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, worker))
  return out
}

export interface BackfillOptions {
  /** False (the default in the script): read and plan only. */
  apply: boolean
  /** Fetch each stored cover to find broken or tiny ones. */
  probe?: boolean
  /** Ask the ranked Pexels selector for a photo before falling back to the branded card (needs PEXELS_API_KEY; the search is free, the
   * upload goes to the post-images bucket). Off by default. */
  pexels?: boolean
  limit?: number
  /** Test seams. */
  probeImpl?: (cover: string) => Promise<Probe>
  selector?: (row: BackfillRow) => Promise<{ cover: string; alt: string } | null>
}

type PostRow = { id: string; slug: string; title: string; tags: string[] | null; publish_date: string | null; created_at: string | null; cover_image_url: string | null; alt_text: string | null }
type GuideRow = { id: string; kind: string; slug: string; name: string; created_at: string | null; hero_image_url: string | null; hero_alt: string | null }

/** Reads the published posts and guides, plans, and (when apply) writes. A before/after list is returned so a run can be undone by hand. */
export async function runCoverBackfill(admin: SupabaseClient, opts: BackfillOptions): Promise<BackfillReport> {
  const posts = await admin.from('posts').select('id, slug, title, tags, publish_date, created_at, cover_image_url, alt_text').eq('status', 'published').limit(2000)
  if (posts.error) throw new Error(`could not read posts: ${posts.error.message}`)
  const guides = await admin.from('guides').select('id, kind, slug, name, created_at, hero_image_url, hero_alt').eq('status', 'published').limit(2000)
  if (guides.error) throw new Error(`could not read guides: ${guides.error.message}`)

  const rows: BackfillRow[] = [
    ...((posts.data ?? []) as PostRow[]).map((p): BackfillRow => ({ table: 'posts', id: p.id, slug: p.slug, title: p.title, tags: p.tags ?? [], date: p.publish_date ?? p.created_at, cover: p.cover_image_url?.trim() || null, alt: p.alt_text })),
    ...((guides.data ?? []) as GuideRow[]).map((g): BackfillRow => ({ table: 'guides', id: g.id, slug: g.slug, guideKind: g.kind, title: g.name, date: g.created_at, cover: g.hero_image_url?.trim() || null, alt: g.hero_alt })),
  ]

  const probes = opts.probe === false ? {} : await probeAll(rows.map((r) => r.cover).filter(shouldProbe), opts.probeImpl ?? ((c) => probeCover(c)))
  let actions = planBackfill(rows, probes)
  if (opts.limit && opts.limit > 0) actions = actions.slice(0, opts.limit)

  const report: BackfillReport = { scanned: { posts: (posts.data ?? []).length, guides: (guides.data ?? []).length }, actions, applied: 0, failed: [], skipped: [] }

  if (opts.pexels && opts.selector) {
    const byId = new Map(rows.map((r) => [`${r.table}:${r.id}`, r]))
    for (const a of actions) {
      if (a.source === 'alt-only') continue
      const row = byId.get(`${a.table}:${a.id}`)
      if (!row || (a.source === 'news-card')) continue
      const pick = await opts.selector(row).catch(() => null)
      if (pick) {
        a.set = { cover: pick.cover, alt: pick.alt }
        a.source = 'pexels'
      }
    }
  }

  if (!opts.apply) return report

  for (const a of actions) {
    const patch: Record<string, string> =
      a.table === 'posts'
        ? { ...(a.set.cover ? { cover_image_url: a.set.cover } : {}), ...(a.set.alt ? { alt_text: a.set.alt } : {}) }
        : { ...(a.set.cover ? { hero_image_url: a.set.cover } : {}), ...(a.set.alt ? { hero_alt: a.set.alt } : {}) }
    if (Object.keys(patch).length === 0) {
      report.skipped.push(`${a.table}/${a.slug}: ${a.source}`)
      continue
    }
    const { error } = await admin.from(a.table).update(patch).eq('id', a.id)
    if (error) report.failed.push({ slug: a.slug, error: error.message })
    else report.applied++
  }
  return report
}
