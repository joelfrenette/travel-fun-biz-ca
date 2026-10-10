import type { SupabaseClient } from '@supabase/supabase-js'
import { isSearchConsoleConfigured, getPageMetrics } from '@/lib/search-console'
import { listSitePages } from '@/lib/site-pages'
import { getSetting, setSetting } from '@/lib/app-settings'
import { blogSlugFromPath, rankScores, MIN_POSTS_FOR_CONFIDENCE, MIN_POST_AGE_DAYS, type StyleScore } from '@/lib/style-choice'

export { SCORE_BASIS, NO_CLICKS_TEXT, chooseWeighted, rankScores, blogSlugFromPath, MIN_POSTS_FOR_CONFIDENCE, MIN_POST_AGE_DAYS, EXPLOIT_SHARE, type StyleScore } from '@/lib/style-choice'

// Growth loop WP3: a daily per-page snapshot of what each page earned (Google clicks, visits, social
// sends, leads), and the per-style scores built from it. Facts only: a number that cannot be read is
// stored as null, never guessed. Test data never counts (test leads are filtered on is_test).
export const PERFORMANCE_TABLE = 'content_performance'
const VISIT_WINDOW_DAYS = 28
const LEAD_WINDOW_DAYS = 90
const CHUNK = 500
const PAGE = 1000
const MAX_PAGES = 20
const MAX_GSC_ATTEMPTS = 4

/** Variant tag keys that get a score table. hook_style:<network> and caption_style:<network> match by prefix. */
const FIXED_KEYS = ['content_style', 'cta_style', 'video_hook', 'carousel_cta', 'carousel_hook'] as const
const PREFIX_KEYS = ['hook_style:', 'caption_style:'] as const

const cleanPath = (raw: string): string => {
  let p = raw.trim()
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname
  } catch {
    // keep as is
  }
  p = p.split(/[?#]/)[0].replace(/\/+$/, '')
  return p === '' ? '/' : p.startsWith('/') ? p : `/${p}`
}

const isMissingTable = (message: string | undefined) => !!message && /does not exist|schema cache|relation .* not found|could not find the table/i.test(message)

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<{ rows: T[]; error?: string; capped?: boolean }> {
  const rows: T[] = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await build(i * PAGE, i * PAGE + PAGE - 1)
    if (error) return { rows, error: error.message }
    rows.push(...((data ?? []) as T[]))
    if ((data ?? []).length < PAGE) break
    if (i === MAX_PAGES - 1) return { rows, capped: true }
  }
  return { rows }
}

interface Row {
  day: string
  path: string
  clicks: number | null
  impressions: number | null
  position: number | null
  visits: number | null
  social_sends: number | null
  social_failures: number | null
  leads: number | null
}

/** Takes today's snapshot, once a day (an atomic claim in app_settings, so overlapping passes cannot both
 * run it). Never throws; returns a short note, or null when today's snapshot is already taken. */
export async function snapshotContentPerformance(admin: SupabaseClient): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10)
  const claimKey = `content_performance_day:${day}`
  try {
    const { error: claimErr } = await admin.from('app_settings').insert({ key: claimKey, value: new Date().toISOString() })
    if (claimErr) return (claimErr as { code?: string }).code === '23505' ? null : `could not claim today's performance snapshot: ${claimErr.message}`
  } catch (e) {
    return `could not claim today's performance snapshot: ${e instanceof Error ? e.message : 'unknown error'}`
  }
  const release = async () => {
    try {
      await admin.from('app_settings').delete().eq('key', claimKey)
    } catch {
      // the claim simply stays for today
    }
  }

  try {
    const notes: string[] = []
    const rows = new Map<string, Row>()
    const row = (path: string): Row => {
      let r = rows.get(path)
      if (!r) {
        r = { day, path, clicks: null, impressions: null, position: null, visits: null, social_sends: null, social_failures: null, leads: null }
        rows.set(path, r)
      }
      return r
    }

    // Google Search Console first, so a retry costs one call. Configured but empty means the call failed
    // (or the site is too new): never store zeros that look like measurements. Retry on the next pass, up
    // to MAX_GSC_ATTEMPTS times in a day; after that save the snapshot with clicks left null.
    if (isSearchConsoleConfigured()) {
      const metrics = await getPageMetrics(28)
      if (!metrics.length) {
        const tryKey = `content_performance_try:${day}`
        const attempts = (Number(await getSetting(admin, tryKey)) || 0) + 1
        await setSetting(admin, tryKey, String(attempts))
        if (attempts < MAX_GSC_ATTEMPTS) {
          await release()
          return `Search Console returned no page data (try ${attempts} of ${MAX_GSC_ATTEMPTS}), will try again on the next pass`
        }
        notes.push('Search Console returned no data today')
      }
      for (const m of metrics) {
        const r = row(cleanPath(m.path))
        r.clicks = m.clicks
        r.impressions = m.impressions
        r.position = m.position
      }
    } else {
      notes.push('Search Console is not connected, so no clicks')
    }

    // Every tracked page, plus anything Google reported above.
    const pages = await listSitePages(admin)
    for (const p of pages) row(cleanPath(p.path))

    // Visits: site_visits grouped by landing path. Null everywhere when nothing is recorded at all.
    const sinceVisits = new Date(Date.now() - VISIT_WINDOW_DAYS * 864e5).toISOString()
    // site_visits has no internal or test flag today, so only /admin and /api landings are left out.
    const visits = await fetchAll<{ landing_path: string | null }>((from, to) =>
      admin.from('site_visits').select('landing_path').gte('created_at', sinceVisits).order('created_at', { ascending: false }).range(from, to),
    )
    if (visits.capped) notes.push(`visits capped at ${MAX_PAGES * PAGE} rows`)
    if (visits.error) {
      notes.push('visits could not be read')
    } else if (visits.rows.length) {
      const counts = new Map<string, number>()
      for (const v of visits.rows) {
        if (!v.landing_path) continue
        const p = cleanPath(v.landing_path)
        if (p.startsWith('/admin') || p.startsWith('/api')) continue
        counts.set(p, (counts.get(p) ?? 0) + 1)
      }
      for (const r of rows.values()) r.visits = counts.get(r.path) ?? 0
      for (const [p, n] of counts) if (!rows.has(p)) row(p).visits = n
    } else {
      notes.push('no visits recorded yet')
    }

    // Social: the post, carousel and video sends and failures, per blog slug.
    const dist = await fetchAll<{ slug: string; stage: string | null; sent_platforms: string[] | null }>((from, to) =>
      admin.from('post_distribution').select('slug, stage, sent_platforms').range(from, to),
    )
    const pipe = await fetchAll<{ slug: string; carousel_stage: string | null; video_stage: string | null; carousel_sent: string[] | null; video_sent: string[] | null }>((from, to) =>
      admin.from('content_pipeline').select('slug, carousel_stage, video_stage, carousel_sent, video_sent').range(from, to),
    )
    if (dist.error || pipe.error) notes.push('social numbers could not be fully read')
    if (dist.capped || pipe.capped) notes.push('social numbers capped at the row limit')
    const social = new Map<string, { sends: number; failures: number }>()
    const bump = (slug: string, sends: number, failures: number) => {
      const cur = social.get(slug) ?? { sends: 0, failures: 0 }
      cur.sends += sends
      cur.failures += failures
      social.set(slug, cur)
    }
    for (const d of dist.rows) bump(d.slug, d.sent_platforms?.length ?? 0, d.stage === 'failed' ? 1 : 0)
    for (const c of pipe.rows) bump(c.slug, (c.carousel_sent?.length ?? 0) + (c.video_sent?.length ?? 0), Number(c.carousel_stage === 'failed') + Number(c.video_stage === 'failed'))
    if (!dist.error && !pipe.error) {
      for (const r of rows.values()) {
        const slug = blogSlugFromPath(r.path)
        if (!slug) continue
        const s = social.get(slug)
        r.social_sends = s?.sends ?? 0
        r.social_failures = s?.failures ?? 0
      }
    }

    // Leads (test leads excluded): credited to the page the form was on, and to the blog post named in
    // utm_campaign (links we post carry the slug there). A lead counts once per distinct path.
    const sinceLeads = new Date(Date.now() - LEAD_WINDOW_DAYS * 864e5).toISOString()
    const leads = await fetchAll<{ page_path: string | null; utm_campaign: string | null }>((from, to) =>
      admin.from('leads').select('page_path, utm_campaign').eq('is_test', false).gte('created_at', sinceLeads).range(from, to),
    )
    if (leads.capped) notes.push('leads capped at the row limit')
    if (leads.error) {
      notes.push('leads could not be read')
    } else {
      const credited = new Map<string, number>()
      for (const l of leads.rows) {
        const paths = new Set<string>()
        if (l.page_path) paths.add(cleanPath(l.page_path))
        if (l.utm_campaign) {
          const asBlog = `/blog/${l.utm_campaign.trim()}`
          if (rows.has(asBlog)) paths.add(asBlog)
        }
        for (const p of paths) credited.set(p, (credited.get(p) ?? 0) + 1)
      }
      for (const r of rows.values()) r.leads = credited.get(r.path) ?? 0
    }

    const out = [...rows.values()]
    for (let i = 0; i < out.length; i += CHUNK) {
      const { error } = await admin.from(PERFORMANCE_TABLE).upsert(out.slice(i, i + CHUNK), { onConflict: 'day,path' })
      if (error) {
        // Table missing (migration 0029 not run yet): keep today's claim so this does not retry every pass.
        if (isMissingTable(error.message)) return 'content performance is not set up yet: run migration 0029'
        await release()
        return `could not save the performance snapshot: ${error.message}`
      }
    }
    return `saved performance for ${out.length} page${out.length === 1 ? '' : 's'}${notes.length ? ` (${notes.join('; ')})` : ''}`
  } catch (e) {
    await release()
    return `performance snapshot failed: ${e instanceof Error ? e.message : 'unknown error'}`
  }
}

export interface StyleScoreTable {
  key: string
  scores: StyleScore[]
  /** Posts with this kind of tag that are too new to judge (under 28 days old), not in any average. */
  youngPosts: number
  /** true when at least one judged post has measured Google clicks. False means "no Google data yet". */
  clicksMeasured: boolean
}

export interface StyleScoreResult {
  /** false when migration 0029 has not been run (or the table cannot be read). */
  ready: boolean
  /** The day of the snapshot the numbers come from, or null when none exists yet. */
  day: string | null
  tables: StyleScoreTable[]
  note?: string
}

const wantedKey = (k: string) => (FIXED_KEYS as readonly string[]).includes(k) || PREFIX_KEYS.some((p) => k.startsWith(p))

/** Per tag key, the score of each style value from the latest snapshot. Honest by construction:
 * - only posts at least 28 days old are judged (younger ones are counted in `youngPosts` only);
 * - clicks are averaged over posts whose clicks were actually measured (null is never turned into 0);
 * - only blog posts present in the snapshot count, so drafts and deleted posts do not.
 * Scores are ranked best first (see rankScores). Never throws. */
export async function styleScores(admin: SupabaseClient): Promise<StyleScoreResult> {
  try {
    const latest = await admin.from(PERFORMANCE_TABLE).select('day').order('day', { ascending: false }).limit(1)
    if (latest.error) return { ready: false, day: null, tables: [], note: isMissingTable(latest.error.message) ? 'not set up yet: run migration 0029' : latest.error.message }
    const day = (latest.data?.[0] as { day: string } | undefined)?.day ?? null
    if (!day) return { ready: true, day: null, tables: [], note: 'no snapshot taken yet' }

    const perf = await fetchAll<{ path: string; clicks: number | null; leads: number | null }>((from, to) =>
      admin.from(PERFORMANCE_TABLE).select('path, clicks, leads').eq('day', day).like('path', '/blog/%').range(from, to),
    )
    if (perf.error) return { ready: false, day, tables: [], note: perf.error }
    const bySlug = new Map<string, { clicks: number | null; leads: number }>()
    for (const p of perf.rows) {
      const slug = blogSlugFromPath(p.path)
      if (slug) bySlug.set(slug, { clicks: p.clicks, leads: p.leads ?? 0 })
    }

    const variants = await fetchAll<{ slug: string; variant_tags: Record<string, unknown> | null }>((from, to) =>
      admin.from('content_variants').select('slug, variant_tags').range(from, to),
    )
    if (variants.error) return { ready: false, day, tables: [], note: variants.error }

    // Post age: publish_date, else created_at. A post whose age cannot be read counts as too new.
    const ageDays = new Map<string, number>()
    const dates = await fetchAll<{ slug: string; created_at: string | null; publish_date: string | null }>((from, to) =>
      admin.from('posts').select('slug, created_at, publish_date').range(from, to),
    )
    if (!dates.error) {
      for (const p of dates.rows) {
        const t = Date.parse(p.publish_date || p.created_at || '')
        if (Number.isFinite(t)) ageDays.set(p.slug, (Date.now() - t) / 864e5)
      }
    }

    // posts.content_style (migration 0027) is a fallback for posts whose variant row lacks the tag.
    // The column may not exist yet, so a failed read is simply ignored.
    const postStyles = new Map<string, string>()
    const ps = await fetchAll<{ slug: string; content_style: string | null }>((from, to) => admin.from('posts').select('slug, content_style').range(from, to))
    if (!ps.error) for (const p of ps.rows) if (p.content_style) postStyles.set(p.slug, p.content_style)

    const tagged = new Map<string, Record<string, unknown>>()
    for (const v of variants.rows) tagged.set(v.slug, v.variant_tags ?? {})
    for (const [slug, style] of postStyles) {
      const tags = tagged.get(slug) ?? {}
      if (!tags.content_style) tagged.set(slug, { ...tags, content_style: style })
    }

    interface Acc { posts: number; young: number; measured: number; clicks: number; leads: number }
    const acc = new Map<string, Map<string, Acc>>()
    for (const [slug, tags] of tagged) {
      const perfRow = bySlug.get(slug)
      if (!perfRow) continue
      const old = (ageDays.get(slug) ?? 0) >= MIN_POST_AGE_DAYS
      for (const [key, value] of Object.entries(tags)) {
        if (!wantedKey(key) || typeof value !== 'string' || !value) continue
        const byValue = acc.get(key) ?? new Map<string, Acc>()
        const cur = byValue.get(value) ?? { posts: 0, young: 0, measured: 0, clicks: 0, leads: 0 }
        if (!old) {
          cur.young += 1
        } else {
          cur.posts += 1
          cur.leads += perfRow.leads
          if (perfRow.clicks !== null) {
            cur.measured += 1
            cur.clicks += perfRow.clicks
          }
        }
        byValue.set(value, cur)
        acc.set(key, byValue)
      }
    }

    const round = (n: number) => Math.round(n * 100) / 100
    const tables: StyleScoreTable[] = [...acc]
      .map(([key, byValue]) => {
        const scores = rankScores(
          [...byValue].map(([value, v]): StyleScore => ({
            value,
            posts: v.posts,
            youngPosts: v.young,
            measuredPosts: v.measured,
            clicks: v.clicks,
            clicksPerPost: v.measured ? round(v.clicks / v.measured) : 0,
            leads: v.leads,
            leadsPerPost: v.posts ? round(v.leads / v.posts) : 0,
            sample: v.posts < MIN_POSTS_FOR_CONFIDENCE ? 'thin' : 'ok',
          })),
        )
        return { key, scores, youngPosts: scores.reduce((s, x) => s + x.youngPosts, 0), clicksMeasured: scores.some((s) => s.measuredPosts > 0) }
      })
      .sort((a, b) => a.key.localeCompare(b.key))
    return { ready: true, day, tables }
  } catch (e) {
    return { ready: false, day: null, tables: [], note: e instanceof Error ? e.message : 'could not read performance' }
  }
}

/** The ranked scores for one tag key (for example 'content_style'), or [] when nothing is ready or the key
 * has no tagged posts. Feeds chooseWeighted directly:
 *   chooseWeighted(await scoresFor(admin, 'content_style'), recentStyles, STYLE_NAMES) */
export async function scoresFor(admin: SupabaseClient, key: string): Promise<StyleScore[]> {
  const r = await styleScores(admin)
  return r.ready ? (r.tables.find((t) => t.key === key)?.scores ?? []) : []
}

