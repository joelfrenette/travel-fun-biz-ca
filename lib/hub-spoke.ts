import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { MIN_OPPORTUNITY_IMPRESSIONS, type QueryRow } from '@/lib/gsc-mining'
import { groupBySimilarity } from '@/lib/keyword-score'
import { cleanAnchor, type LinkWish } from '@/lib/seo-links'
import { internalLinkPathsOf } from '@/lib/seo-score'
import { MATCH_THRESHOLD, matchScore, TYPE_PRIORITY, type SeoPage, type SeoPageType } from '@/lib/seo-pages'

// HUB AND SPOKE (SEO engine 2, second half). Searches that mean the same thing are one topic (the same near-duplicate grouping the keyword
// engine uses). For each topic with two or more pages of ours: ONE page is the HUB (the strongest by clicks, then impressions, then guide
// over post), the others are SPOKES. Healthy: the hub links to every spoke and every spoke links back to the hub. This module builds that
// map, reports the missing links in both directions, and turns them into link wishes for lib/seo-links.ts (same caps, same Undo).
// Pure code first; one small stored result at the bottom.

export const HUBSPOKE_KEY = 'seo_hubspoke_state'
export const MAX_SPOKES = 8
export const MAX_ENTRIES = 15
/** A topic needs a hub of at least this much demand to be mapped (impressions of its searches). */
export const MIN_TOPIC_IMPRESSIONS = MIN_OPPORTUNITY_IMPRESSIONS

export interface TopicCluster {
  id: string
  primary: string
  members: string[]
  impressions: number
}

export interface PageMetric {
  clicks: number
  impressions: number
}

export interface MapPage {
  path: string
  title: string
  type: SeoPageType
  editable: boolean
}

export interface HubSpokeEntry {
  clusterId: string
  topic: string
  members: string[]
  hub: MapPage
  spokes: MapPage[]
  /** Spokes the hub does not link to (only when the hub's text is known). */
  missingHubToSpoke: string[]
  /** Spokes that do not link back to the hub (only for spokes whose text is known). */
  missingSpokeToHub: string[]
  /** When the hub is a blog post and three or more pages hang off it, a guide page would make a stronger hub. */
  proposedHub: { title: string; pageType: 'guide' } | null
}

/** Topics from Search Console searches: near-duplicate searches grouped, biggest first. Pure. */
export function clustersFromQueries(queries: readonly QueryRow[], opts: { minImpressions?: number; limit?: number } = {}): TopicCluster[] {
  const min = opts.minImpressions ?? MIN_OPPORTUNITY_IMPRESSIONS
  const rows = queries.filter((q) => q.query && q.impressions >= min).sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query))
  return groupBySimilarity(rows, (q) => q.query)
    .map((g) => ({ id: g[0].query.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''), primary: g[0].query, members: g.map((m) => m.query).slice(0, 8), impressions: g.reduce((s, m) => s + m.impressions, 0) }))
    .slice(0, opts.limit ?? 60)
}

const strength = (p: SeoPage, m: Map<string, PageMetric>) => m.get(p.path) ?? { clicks: 0, impressions: 0 }

/** The hub is the strongest page: clicks, impressions, then guide/trip/destination over post, then shorter address. Pure. */
export function pickHub(pages: readonly SeoPage[], metrics: Map<string, PageMetric>): SeoPage | null {
  return (
    [...pages].sort((a, b) => {
      const A = strength(a, metrics)
      const B = strength(b, metrics)
      return B.clicks - A.clicks || B.impressions - A.impressions || TYPE_PRIORITY[b.type] - TYPE_PRIORITY[a.type] || a.path.length - b.path.length || a.path.localeCompare(b.path)
    })[0] ?? null
  )
}

const mapPage = (p: SeoPage): MapPage => ({ path: p.path, title: p.title, type: p.type, editable: p.editable })

/** Builds the map. Each page belongs to at most one topic (the one whose searches it covers best; ties go to the bigger topic). A topic
 * with fewer than two pages is not mapped. Missing links are only reported for pages whose text is loaded. Pure. */
export function buildHubSpokeMap(clusters: readonly TopicCluster[], pages: readonly SeoPage[], metrics: Map<string, PageMetric>, opts: { threshold?: number } = {}): HubSpokeEntry[] {
  const threshold = opts.threshold ?? MATCH_THRESHOLD
  const live = pages.filter((p) => !p.thin)
  const owner = new Map<string, { cluster: TopicCluster; score: number }>()
  for (const c of clusters) {
    for (const p of live) {
      const score = Math.max(...c.members.slice(0, 4).map((m) => matchScore(m, p)))
      if (score < threshold) continue
      const cur = owner.get(p.path)
      if (!cur || score > cur.score || (score === cur.score && c.impressions > cur.cluster.impressions)) owner.set(p.path, { cluster: c, score })
    }
  }
  const entries: HubSpokeEntry[] = []
  for (const c of clusters) {
    if (c.impressions < MIN_TOPIC_IMPRESSIONS) continue
    const mine = live.filter((p) => owner.get(p.path)?.cluster.id === c.id)
    if (mine.length < 2) continue
    const hub = pickHub(mine, metrics) as SeoPage
    const spokes = mine
      .filter((p) => p.path !== hub.path)
      .sort((a, b) => strength(b, metrics).impressions - strength(a, metrics).impressions || a.path.localeCompare(b.path))
      .slice(0, MAX_SPOKES)
    const hubLinks = new Set(internalLinkPathsOf(hub.body))
    const hubKnown = hub.body.trim().length > 0
    entries.push({
      clusterId: c.id,
      topic: c.primary,
      members: c.members,
      hub: mapPage(hub),
      spokes: spokes.map(mapPage),
      missingHubToSpoke: hubKnown ? spokes.filter((s) => !hubLinks.has(s.path)).map((s) => s.path) : [],
      missingSpokeToHub: spokes.filter((s) => s.body.trim() && !internalLinkPathsOf(s.body).includes(hub.path)).map((s) => s.path),
      proposedHub: hub.type === 'blog' && spokes.length >= 3 ? { title: c.primary, pageType: 'guide' } : null,
    })
  }
  return entries.sort((a, b) => b.spokes.length - a.spokes.length || a.topic.localeCompare(b.topic)).slice(0, MAX_ENTRIES)
}

/** Link wishes for the missing links: spoke to hub first (it sends strength to the hub), then hub to spoke. Whether each is carried out is
 * decided by lib/seo-links.ts. Pure. */
export function hubSpokeWishes(map: readonly HubSpokeEntry[]): LinkWish[] {
  const up: LinkWish[] = []
  const down: LinkWish[] = []
  for (const e of map) {
    const hubAnchor = cleanAnchor(e.topic)
    if (hubAnchor) {
      for (const path of e.missingSpokeToHub) up.push({ fromPath: path, toPath: e.hub.path, anchor: hubAnchor, kind: 'spoke-to-hub', why: `This page is part of the "${e.topic}" topic; its main page is ${e.hub.path}, so it links up to it.` })
    }
    for (const path of e.missingHubToSpoke) {
      const spoke = e.spokes.find((s) => s.path === path)
      const anchor = cleanAnchor(spoke?.title ?? '')
      if (anchor) down.push({ fromPath: e.hub.path, toPath: path, anchor, kind: 'hub-to-spoke', why: `${e.hub.path} is the main page for "${e.topic}", so it links down to the related page ${path}.` })
    }
  }
  return [...up, ...down]
}

export interface HubSpokeState {
  at: string
  entries: HubSpokeEntry[]
}

export function parseHubSpokeState(raw: string | null | undefined): HubSpokeState {
  if (!raw) return { at: '', entries: [] }
  try {
    const v = JSON.parse(raw) as Partial<HubSpokeState>
    if (!v || typeof v.at !== 'string' || !Array.isArray(v.entries)) return { at: '', entries: [] }
    return { at: v.at, entries: (v.entries as HubSpokeEntry[]).slice(0, MAX_ENTRIES) }
  } catch {
    return { at: '', entries: [] }
  }
}

export async function readHubSpokeState(admin: SupabaseClient): Promise<HubSpokeState> {
  try {
    return parseHubSpokeState(await getSetting(admin, HUBSPOKE_KEY))
  } catch {
    return { at: '', entries: [] }
  }
}

export async function storeHubSpokeState(admin: SupabaseClient, entries: readonly HubSpokeEntry[], now: Date = new Date()): Promise<void> {
  try {
    await setSetting(admin, HUBSPOKE_KEY, JSON.stringify({ at: now.toISOString(), entries: entries.slice(0, MAX_ENTRIES) } satisfies HubSpokeState))
  } catch {
    // a result that cannot be saved is only a missing card
  }
}
