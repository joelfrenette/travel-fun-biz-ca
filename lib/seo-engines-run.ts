import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict } from '@/lib/app-settings'
import { AUTOMATION_PAUSED_KEY } from '@/lib/automation-kill-switch'
import { cannibalWishes, groupCannibalised, storeCannibalState, type AutoLinkRecord } from '@/lib/cannibalization'
import { pickDueCompetitor, readCompetitorList, readCompetitorState, runCompetitorScan, type CompetitorFetch } from '@/lib/competitor-scan'
import { runMining, readStoredQueryRows, queryRowsFromPairs, type QueryPageRow, type QueryRow } from '@/lib/gsc-mining'
import { buildHubSpokeMap, clustersFromQueries, hubSpokeWishes, storeHubSpokeState, type PageMetric } from '@/lib/hub-spoke'
import { getQueryPageRowsFull } from '@/lib/search-console'
import { applyLinkAdds, type LinkWish } from '@/lib/seo-links'
import { loadSeoPages } from '@/lib/seo-pages'

// The daily SEO engines step, run inside the existing gsc-snapshot cron (no new cron). One 20 second budget for all of it:
//   1. read Search Console (live query + page report, else the saved daily snapshot) and our own pages
//   2. query mining: new page ideas + striking-distance refresh list; safe ideas go to the blog topic queue as "suggested" (max 3 a day)
//   3. cannibalisation + hub and spoke: findings stored; at most 3 pages a day get ONE internal link (logged with Undo)
//   4. competitors: at most ONE competitor scanned per day, each one at most once a week (it carries on over days if the time runs out)
// Every part is wrapped so a failure in one never stops the next or the snapshot. Nothing is published; paused automation stops everything
// that changes a page or contacts another site.

export const SEO_BUDGET_MS = 20_000
const MIN_MS_FOR_LINKS = 3_000
const MIN_MS_FOR_SCAN = 6_000

export interface SeoRunOptions {
  /** Epoch ms after which no new part starts. Default: now + SEO_BUDGET_MS. */
  deadlineMs?: number
  now?: Date
  /** Injected for tests: the Search Console query + page rows. */
  getPairs?: () => Promise<QueryPageRow[]>
  /** Injected for tests: the competitor fetch layer and its sleep. */
  fetch?: CompetitorFetch
  sleep?: (ms: number) => Promise<void>
}

export interface SeoRunResult {
  note: string
  changedPaths: string[]
}

export async function runSeoEngines(admin: SupabaseClient, opts: SeoRunOptions = {}): Promise<SeoRunResult> {
  const now = opts.now ?? new Date()
  const deadline = opts.deadlineMs ?? Date.now() + SEO_BUDGET_MS
  const left = () => deadline - Date.now()
  const parts: string[] = []
  const changedPaths: string[] = []
  try {
    const pages = await loadSeoPages(admin, { withBodies: true })
    if (!pages) return { note: 'SEO engines: could not read the pages, nothing done', changedPaths }

    let pairs: QueryPageRow[] = []
    try {
      pairs = await (opts.getPairs ?? (() => getQueryPageRowsFull(28, Math.max(2_000, Math.min(8_000, left() - 4_000)))))()
    } catch {
      pairs = []
    }
    const stored: QueryRow[] = pairs.length ? [] : await readStoredQueryRows(admin, now)

    // 1) mining
    try {
      const m = await runMining(admin, { pairs, stored, pages }, now)
      parts.push(`ideas: ${m.note}`)
    } catch (e) {
      parts.push(`ideas failed (${e instanceof Error ? e.message : 'error'})`)
    }

    // 2) cannibalisation and hub and spoke, then the shared link step
    try {
      const queries = pairs.length ? queryRowsFromPairs(pairs) : stored
      const findings = pairs.length ? groupCannibalised(pairs, pages) : []
      const metrics = new Map<string, PageMetric>()
      for (const r of pairs) {
        const cur = metrics.get(r.path) ?? { clicks: 0, impressions: 0 }
        cur.clicks += r.clicks
        cur.impressions += r.impressions
        metrics.set(r.path, cur)
      }
      const map = queries.length ? buildHubSpokeMap(clustersFromQueries(queries), pages, metrics) : []
      const wishes: LinkWish[] = [...cannibalWishes(findings), ...hubSpokeWishes(map)]
      let linkNote = ''
      const records: AutoLinkRecord[] = []
      if (wishes.length > 0 && left() >= MIN_MS_FOR_LINKS) {
        const r = await applyLinkAdds(admin, wishes, pages, now)
        changedPaths.push(...r.changedPaths)
        for (const d of r.decisions) {
          const wish = wishes.find((w) => w.fromPath === d.subject && w.kind === 'cannibalisation')
          if (wish) records.push({ at: d.at, from: wish.fromPath, to: wish.toPath, query: findings.find((f) => f.primary.path === wish.toPath)?.query ?? '', editId: d.undo?.ref ?? null })
        }
        linkNote = r.blockedBecause ? `links paused (${r.blockedBecause})` : `${r.added} link${r.added === 1 ? '' : 's'} added`
      } else if (wishes.length > 0) {
        linkNote = 'links skipped (time budget)'
      }
      if (pairs.length) await storeCannibalState(admin, findings, records, linkNote, now)
      if (queries.length) await storeHubSpokeState(admin, map, now)
      parts.push(`competing pages: ${findings.length}${linkNote ? `, ${linkNote}` : ''}; hub and spoke topics: ${map.length}`)
    } catch (e) {
      parts.push(`links failed (${e instanceof Error ? e.message : 'error'})`)
    }

    // 3) one competitor, at most once a week each
    try {
      const list = await readCompetitorList(admin)
      if (list.length > 0 && left() >= MIN_MS_FOR_SCAN) {
        const paused = await getSettingStrict(admin, AUTOMATION_PAUSED_KEY)
        if (paused.error || paused.value === 'true') {
          parts.push('competitor scan skipped (automation is paused or the switch could not be read)')
        } else {
          const due = pickDueCompetitor(list, await readCompetitorState(admin), now)
          if (due) {
            const s = await runCompetitorScan(admin, due, pages, { deadlineMs: deadline - 1_000, fetch: opts.fetch, sleep: opts.sleep })
            parts.push(`competitor ${s.note}`)
          }
        }
      }
    } catch (e) {
      parts.push(`competitor scan failed (${e instanceof Error ? e.message : 'error'})`)
    }
    return { note: `SEO engines: ${parts.join('; ')}`, changedPaths }
  } catch (e) {
    return { note: `SEO engines failed: ${e instanceof Error ? e.message : 'unknown error'}`, changedPaths }
  }
}
