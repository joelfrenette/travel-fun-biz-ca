// Pure aggregation for the admin Dashboard "Top pages" and "Top posts by clicks" tables.
// No network, no database: scripts/check-dashboard-top.ts proves all of it offline. Nothing here invents a number:
// a source that could not be read is a status, never a zero.
import { visitChannelToDash } from '@/lib/dashboard-range'

export const TOP_PAGES_LIMIT = 10
export const TOP_POSTS_LIMIT = 15
/** A hook style or network needs at least this many sends in the range before it is named "best". */
export const MIN_SENDS_TO_RANK = 5

export type SourceStatus = 'ok' | 'off' | 'not_connected' | 'error'

// ---------- paths ----------

/** Clean path for grouping: origin, query string, hash and trailing slashes dropped, lower-cased, always starts with "/".
 * Returns null for empty / "(not set)" / admin and API paths (never a public page). */
export function cleanPath(raw: string | null | undefined): string | null {
  let p = String(raw ?? '').trim()
  if (!p || p === '(not set)') return null
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname
    } catch {
      return null
    }
  }
  p = p.split(/[?#]/)[0].replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase()
  if (p === '') p = '/'
  if (!p.startsWith('/')) p = `/${p}`
  if (p === '/admin' || p.startsWith('/admin/') || p === '/api' || p.startsWith('/api/')) return null
  return p
}

export type TopPageType = 'blog' | 'guide' | 'trip' | 'destination' | 'from-city' | 'home' | 'other'

export const TOP_PAGE_TYPE_LABELS: Record<TopPageType, string> = {
  blog: 'Blog',
  guide: 'Guide',
  trip: 'Trip',
  destination: 'Destination',
  'from-city': 'From city',
  home: 'Home',
  other: 'Other',
}

const GUIDE_PREFIXES = ['hotels', 'resorts', 'cruise-lines', 'ships', 'river-cruises', 'yachts']

export function topPageTypeOf(cleaned: string): TopPageType {
  if (cleaned === '/') return 'home'
  const first = cleaned.replace(/^\/+/, '').split('/')[0]
  if (first === 'blog') return 'blog'
  if (first === 'packages') return 'trip'
  if (first === 'destinations') return 'destination'
  if (first === 'from') return 'from-city'
  if (GUIDE_PREFIXES.includes(first)) return 'guide'
  return 'other'
}

// ---------- Top pages ----------

export interface VisitPageRow {
  landing_path: string | null
  channel: string | null
  source: string | null
}

export interface Ga4PageRow {
  pagePath: string
  views: number
  sessions: number
}

export interface TopPageRow {
  path: string
  pageType: TopPageType
  /** First-party recorded visits that started on this page; null when that source could not be read. */
  recordedVisits: number | null
  /** Share of all recorded visits (or of GA4 views when recorded visits are unavailable), 0 to 1. */
  share: number | null
  /** utm_source, else the channel. Null when no recorded visit names a source. */
  topSource: string | null
  /** GA4 screenPageViews; null when GA4 could not be read or is not connected. */
  ga4Views: number | null
  ga4Sessions: number | null
  /** Non-test leads whose page_path is this page; null when leads could not be read. */
  leads: number | null
}

export interface TopPagesResult {
  rows: TopPageRow[]
  /** What `share` is a share of. */
  shareBasis: 'recorded' | 'ga4' | 'none'
  totalRecorded: number | null
  totalGa4Views: number | null
  pagesCounted: number
}

export interface TopPagesInput {
  recorded: { status: SourceStatus; rows: VisitPageRow[] }
  ga4: { status: SourceStatus; rows: Ga4PageRow[] }
  leads: { status: SourceStatus; paths: (string | null)[] }
  limit?: number
}

function topLabel(counts: Map<string, number>): string | null {
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && k < best)) {
      best = k
      bestN = n
    }
  }
  return best
}

export function aggregateTopPages(input: TopPagesInput): TopPagesResult {
  const limit = input.limit ?? TOP_PAGES_LIMIT
  const recOk = input.recorded.status === 'ok'
  const gaOk = input.ga4.status === 'ok'
  const leadsOk = input.leads.status === 'ok'

  interface Acc { visits: number; sources: Map<string, number>; views: number; sessions: number; leads: number }
  const map = new Map<string, Acc>()
  const get = (p: string) => {
    let a = map.get(p)
    if (!a) {
      a = { visits: 0, sources: new Map(), views: 0, sessions: 0, leads: 0 }
      map.set(p, a)
    }
    return a
  }

  let totalRecorded = 0
  if (recOk) {
    for (const r of input.recorded.rows) {
      const p = cleanPath(r.landing_path)
      if (!p) continue
      const a = get(p)
      a.visits++
      totalRecorded++
      const src = (r.source ?? '').trim().toLowerCase() || (r.channel ? visitChannelToDash(r.channel) : '')
      if (src) a.sources.set(src, (a.sources.get(src) ?? 0) + 1)
    }
  }
  let totalGa4 = 0
  if (gaOk) {
    for (const r of input.ga4.rows) {
      const p = cleanPath(r.pagePath)
      if (!p) continue
      const views = Number.isFinite(r.views) && r.views > 0 ? Math.round(r.views) : 0
      const sessions = Number.isFinite(r.sessions) && r.sessions > 0 ? Math.round(r.sessions) : 0
      const a = get(p)
      a.views += views
      a.sessions += sessions
      totalGa4 += views
    }
  }
  if (leadsOk) {
    for (const raw of input.leads.paths) {
      const p = cleanPath(raw)
      if (p) get(p).leads++
    }
  }

  const shareBasis: TopPagesResult['shareBasis'] = recOk ? 'recorded' : gaOk ? 'ga4' : 'none'
  const primary = (a: Acc) => (shareBasis === 'recorded' ? a.visits : shareBasis === 'ga4' ? a.views : 0)
  const secondary = (a: Acc) => (shareBasis === 'recorded' ? a.views : 0)
  const basisTotal = shareBasis === 'recorded' ? totalRecorded : shareBasis === 'ga4' ? totalGa4 : 0

  // Pages that only exist because of a lead (no visits, no views) would fill the table with zeros: keep them out of the ranking.
  const entries = [...map].filter(([, a]) => a.visits > 0 || a.views > 0)
  entries.sort((x, y) => primary(y[1]) - primary(x[1]) || secondary(y[1]) - secondary(x[1]) || y[1].leads - x[1].leads || x[0].localeCompare(y[0]))

  const rows: TopPageRow[] = entries.slice(0, limit).map(([path, a]) => ({
    path,
    pageType: topPageTypeOf(path),
    recordedVisits: recOk ? a.visits : null,
    share: basisTotal > 0 ? primary(a) / basisTotal : null,
    topSource: recOk ? topLabel(a.sources) : null,
    ga4Views: gaOk ? a.views : null,
    ga4Sessions: gaOk ? a.sessions : null,
    leads: leadsOk ? a.leads : null,
  }))
  return { rows, shareBasis, totalRecorded: recOk ? totalRecorded : null, totalGa4Views: gaOk ? totalGa4 : null, pagesCounted: entries.length }
}

// ---------- Top posts by clicks ----------

export const SOCIAL_FORMATS = ['post', 'guide', 'trip', 'news', 'carousel', 'video', 'recap'] as const
/** Formats whose sends are logged in post_distribution (photo posts). Carousel and video sends live elsewhere, so they are not used in the per-send summaries. */
export const LOGGED_SEND_FORMATS: readonly string[] = ['post', 'guide', 'trip', 'news', 'recap']

/** utm_content is "<hook_style>-<format>" (for example "question-video", "how-to-post") or just "<format>". "fallback" means no style was chosen. */
export function parseSocialContent(raw: string | null | undefined): { hookStyle: string | null; format: string | null; bio: boolean } {
  const c = String(raw ?? '').trim().toLowerCase()
  if (!c) return { hookStyle: null, format: null, bio: false }
  if (c.startsWith('bio-') || c === 'bio') return { hookStyle: null, format: 'bio', bio: true }
  for (const f of SOCIAL_FORMATS) {
    if (c === f) return { hookStyle: null, format: f, bio: false }
    if (c.endsWith(`-${f}`)) {
      const h = c.slice(0, -(f.length + 1))
      return { hookStyle: h === 'fallback' || !h ? null : h, format: f, bio: false }
    }
  }
  return { hookStyle: null, format: c, bio: false }
}

/** twitter is x, as in lib/utm.ts canonicalNetwork. */
function net(raw: string | null | undefined): string {
  const n = String(raw ?? '').trim().toLowerCase()
  return n === 'twitter' ? 'x' : n
}

export interface SocialVisitRow {
  campaign: string | null
  source: string | null
  medium: string | null
  content: string | null
}
export interface SocialLeadRow {
  utm_campaign: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_content: string | null
}
export interface SendRow {
  slug: string
  network: string
  hookStyle: string | null
}

export interface TopPostRow {
  slug: string
  title: string
  /** True when the title came from the posts table; false means the slug is shown instead. */
  titleFound: boolean
  network: string
  hookStyle: string | null
  format: string | null
  /** Recorded visits; null when visit tracking is off or could not be read. */
  visits: number | null
  /** Non-test leads credited to this post, network and style; null when leads could not be read. */
  leads: number | null
}

export type BestPick =
  | { enough: true; name: string; visitsPerSend: number; sends: number; visits: number }
  | { enough: false; sends: number; needed: number }

export interface TopPostsResult {
  rows: TopPostRow[]
  rowsCounted: number
  totalVisits: number | null
  bestHookStyle: BestPick
  bestNetwork: BestPick
}

export interface TopPostsInput {
  visits: { status: SourceStatus; rows: SocialVisitRow[] }
  leads: { status: SourceStatus; rows: SocialLeadRow[] }
  sends: { status: SourceStatus; rows: SendRow[] }
  titles: Map<string, string> | Record<string, string>
  limit?: number
}

const isSocial = (medium: string | null | undefined) => (medium ?? '').trim().toLowerCase() === 'social'

/** Highest visits per send among names with at least MIN_SENDS_TO_RANK sends. Ties go to more sends, then the name. */
export function bestBySends(visitsByName: Map<string, number>, sendsByName: Map<string, number>, min = MIN_SENDS_TO_RANK): BestPick {
  const totalSends = [...sendsByName.values()].reduce((a, b) => a + b, 0)
  let best: { name: string; vps: number; sends: number; visits: number } | null = null
  for (const [name, sends] of sendsByName) {
    if (sends < min) continue
    const visits = visitsByName.get(name) ?? 0
    const vps = visits / sends
    if (!best || vps > best.vps || (vps === best.vps && (sends > best.sends || (sends === best.sends && name < best.name)))) best = { name, vps, sends, visits }
  }
  if (!best) return { enough: false, sends: totalSends, needed: min }
  return { enough: true, name: best.name, visitsPerSend: Math.round(best.vps * 100) / 100, sends: best.sends, visits: best.visits }
}

export function aggregateTopPosts(input: TopPostsInput): TopPostsResult {
  const limit = input.limit ?? TOP_POSTS_LIMIT
  const titleOf = (slug: string): string | undefined => (input.titles instanceof Map ? input.titles.get(slug) : input.titles[slug])
  const visOk = input.visits.status === 'ok'
  const leadsOk = input.leads.status === 'ok'

  interface Acc { slug: string; network: string; hookStyle: string | null; format: string | null; visits: number; leads: number }
  const map = new Map<string, Acc>()
  const get = (slug: string, network: string, content: string | null | undefined) => {
    const c = parseSocialContent(content)
    const key = `${slug}|${network}|${c.hookStyle ?? ''}|${c.format ?? ''}`
    let a = map.get(key)
    if (!a) {
      a = { slug, network, hookStyle: c.hookStyle, format: c.format, visits: 0, leads: 0 }
      map.set(key, a)
    }
    return a
  }

  const visitsByStyle = new Map<string, number>()
  const visitsByNetwork = new Map<string, number>()
  let totalVisits = 0
  if (visOk) {
    for (const r of input.visits.rows) {
      const slug = (r.campaign ?? '').trim().toLowerCase()
      if (!slug || !isSocial(r.medium)) continue
      const c = parseSocialContent(r.content)
      if (c.bio) continue
      const network = net(r.source)
      if (!network) continue
      get(slug, network, r.content).visits++
      totalVisits++
      if (c.format && LOGGED_SEND_FORMATS.includes(c.format)) {
        visitsByNetwork.set(network, (visitsByNetwork.get(network) ?? 0) + 1)
        if (c.hookStyle) visitsByStyle.set(c.hookStyle, (visitsByStyle.get(c.hookStyle) ?? 0) + 1)
      }
    }
  }
  if (leadsOk) {
    for (const r of input.leads.rows) {
      const slug = (r.utm_campaign ?? '').trim().toLowerCase()
      if (!slug || !isSocial(r.utm_medium)) continue
      if (parseSocialContent(r.utm_content).bio) continue
      const network = net(r.utm_source)
      if (!network) continue
      get(slug, network, r.utm_content).leads++
    }
  }

  const entries = [...map.values()].filter((a) => a.visits > 0 || a.leads > 0)
  entries.sort((x, y) => y.visits - x.visits || y.leads - x.leads || x.slug.localeCompare(y.slug) || x.network.localeCompare(y.network) || (x.hookStyle ?? '').localeCompare(y.hookStyle ?? '') || (x.format ?? '').localeCompare(y.format ?? ''))

  const rows: TopPostRow[] = entries.slice(0, limit).map((a) => {
    const t = titleOf(a.slug)
    return {
      slug: a.slug,
      title: t || a.slug,
      titleFound: !!t,
      network: a.network,
      hookStyle: a.hookStyle,
      format: a.format,
      visits: visOk ? a.visits : null,
      leads: leadsOk ? a.leads : null,
    }
  })

  // Visits per send, only from logged sends (photo posts), only from visits of those formats.
  const sendsOk = input.sends.status === 'ok'
  const sendsByStyle = new Map<string, number>()
  const sendsByNetwork = new Map<string, number>()
  if (sendsOk) {
    for (const s of input.sends.rows) {
      const n = net(s.network)
      if (n) sendsByNetwork.set(n, (sendsByNetwork.get(n) ?? 0) + 1)
      const h = (s.hookStyle ?? '').trim().toLowerCase()
      if (h && h !== 'fallback') sendsByStyle.set(h, (sendsByStyle.get(h) ?? 0) + 1)
    }
  }
  const unavailable: BestPick = { enough: false, sends: 0, needed: MIN_SENDS_TO_RANK }
  const summariesOk = visOk && sendsOk
  return {
    rows,
    rowsCounted: entries.length,
    totalVisits: visOk ? totalVisits : null,
    bestHookStyle: summariesOk ? bestBySends(visitsByStyle, sendsByStyle) : unavailable,
    bestNetwork: summariesOk ? bestBySends(visitsByNetwork, sendsByNetwork) : unavailable,
  }
}
