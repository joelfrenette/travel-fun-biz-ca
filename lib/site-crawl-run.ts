import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { AUTOMATION_PAUSED_KEY } from '@/lib/automation-kill-switch'
import { internalLinksOfText, internalPath, stripLinks, type ContentEdit } from '@/lib/content-repair'
import { columnsFor, deleteEdits, insertEdits, storedValue } from '@/lib/content-edits'
import { GUIDE_KINDS, guideKinds } from '@/lib/guides'
import { coverAlt, heroAlt, isGenericAlt } from '@/lib/image-quality'
import { SITE_NAME, SITE_URL } from '@/lib/site'
import { fitTitle, planPostTitle } from '@/lib/title-fit'
import { STATE_KEY, crawlWindow, emptyState, fetchFollow, fetchSitemap, mergeState, parseState, pathOf, pickWindow, realFetch, windowSize, type CrawlState, type FetchLike, type Finding } from '@/lib/site-crawl'

// The database side of the site health crawl: read the stored state, run one rotating window of the live site, repair the few things
// that are safe to repair by themselves (always logged to content_edits with Undo), and store a small result.
//
// Self-heal rules (anything else is only reported):
//   a) a dead internal link inside a post or guide body: the link goes, the words stay;
//   b) a post cover or guide hero with an empty or generic description: a descriptive one is set from the title / name;
//   c) a title over 60 characters, or a title two pages share (title-long, title-duplicate): the title fields are shortened by
//      lib/title-fit.ts (deterministic, no AI), at most MAX_TITLE_FIXES_PER_RUN a run, never publishing or unpublishing.
// Hard caps: MAX_FIXES_PER_RUN a run, nothing is changed while "Pause all automation" is on (or when that switch cannot be read),
// every change is written to the audit log BEFORE it is applied and taken back out of the log if it cannot be applied.

export const MAX_FIXES_PER_RUN = 5
/** Title rewrites (titles over 60 characters, shared titles) a run may make, on top of MAX_FIXES_PER_RUN. */
export const MAX_TITLE_FIXES_PER_RUN = 25
/** The whole step (sitemap, pages, links, repairs) stops starting new work after this long. */
export const CRAWL_BUDGET_MS = 40_000
/** A repair is only started with at least this long left. */
const MIN_MS_FOR_REPAIR = 4_000

export interface HealResult {
  fixed: number
  healedKeys: Set<string>
  changedPaths: string[]
  notes: string[]
  /** Why nothing was repaired, when that is the case ("automation is paused"). */
  skippedBecause?: string
}

type Row = Record<string, unknown>
export interface Located {
  type: 'post' | 'guide'
  row: Row
  path: string
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
export const findingKeyOf = (f: { url: string; kind: string; target?: string }) => `${pathOf(f.url)}|${f.kind}|${f.target ? pathOf(f.target) : ''}`

/** The published post or guide a public path belongs to. Null for every other kind of page, and for a draft. */
export async function locateContent(admin: SupabaseClient, path: string): Promise<Located | null> {
  const blog = /^\/blog\/([^/?]+)$/.exec(path)
  if (blog) {
    const { data } = await admin.from('posts').select('*').eq('slug', blog[1]).eq('status', 'published').maybeSingle()
    return data ? { type: 'post', row: data as Row, path } : null
  }
  const m = /^\/([^/?]+)\/([^/?]+)$/.exec(path)
  if (!m) return null
  const kind = GUIDE_KINDS.find((k) => guideKinds[k].urlPrefix === `/${m[1]}`)
  if (!kind) return null
  const { data } = await admin.from('guides').select('*').eq('kind', kind).eq('slug', m[2]).eq('status', 'published').maybeSingle()
  return data ? { type: 'guide', row: data as Row, path } : null
}

/** Logs, then applies, one edit. Re-checks that the page did not change since it was read; takes the log row back if the page cannot be written. */
export async function applyEdit(admin: SupabaseClient, loc: Located, edit: ContentEdit | ContentEdit[], columns: Row): Promise<{ ok: boolean; note?: string }> {
  const logged = await insertEdits(admin, Array.isArray(edit) ? edit : [edit])
  if (logged.error) return { ok: false, note: `the audit log could not be written (${logged.error}), so nothing was changed` }
  const table = loc.type === 'post' ? 'posts' : 'guides'
  let q = admin.from(table).update({ ...columns, updated_at: new Date().toISOString() }).eq('id', loc.row.id as string).eq('status', 'published')
  // Only write if nobody edited the page since we read it.
  if (typeof loc.row.updated_at === 'string') q = q.eq('updated_at', loc.row.updated_at)
  const { data, error } = await q.select('id')
  if (error || !data || (data as unknown[]).length === 0) {
    await deleteEdits(admin, logged.ids)
    return { ok: false, note: error ? `could not update the page: ${error.message}` : 'the page changed while it was being checked, left alone' }
  }
  return { ok: true }
}

/** Repairs what is safe to repair. Never throws. `findings` are those of this run (every kind); only dead links and missing cover alt are acted on. */
export async function healCrawlFindings(
  admin: SupabaseClient,
  findings: readonly Finding[],
  opts: { fetch: FetchLike; sitemapPaths: ReadonlySet<string>; cap?: number; titleCap?: number; deadlineMs?: number },
): Promise<HealResult> {
  const out: HealResult = { fixed: 0, healedKeys: new Set(), changedPaths: [], notes: [] }
  const cap = opts.cap ?? MAX_FIXES_PER_RUN
  try {
    // The kill switch: while automation is paused (or the switch cannot be read) nothing is changed.
    const paused = await getSettingStrict(admin, AUTOMATION_PAUSED_KEY)
    if (paused.error) return { ...out, skippedBecause: 'the pause switch could not be read' }
    if (paused.value === 'true') return { ...out, skippedBecause: 'automation is paused' }

    const timeLeft = () => (opts.deadlineMs === undefined ? Infinity : opts.deadlineMs - Date.now())

    // a) Dead internal links, grouped by the page they are on. One page is one repair.
    const deadByPage = new Map<string, Finding[]>()
    for (const f of findings) if (f.kind === 'dead-link' && f.target && (f.status === 404 || f.status === 410)) deadByPage.set(pathOf(f.url), [...(deadByPage.get(pathOf(f.url)) ?? []), f])
    for (const [page, list] of deadByPage) {
      if (out.fixed >= cap || timeLeft() < MIN_MS_FOR_REPAIR) break
      const loc = await locateContent(admin, page)
      if (!loc) continue // the link is in the page template or a trip page, not in a post or guide body: report only
      // Ask once more, right now: only a link that is still gone is removed. A link to a page that is in the sitemap is never removed.
      const gone: string[] = []
      for (const f of list) {
        const tp = internalPath(f.target as string)
        if (!tp || tp === '/' || opts.sitemapPaths.has(pathOf(f.target as string))) continue
        const again = await fetchFollow(f.target as string, opts.fetch, { method: 'GET' })
        if (again.error || (again.status !== 404 && again.status !== 410)) continue
        gone.push(tp)
      }
      if (gone.length === 0) continue
      const before = storedValue(loc.type, loc.row, 'body')
      const present = new Set(internalLinksOfText(before))
      const toStrip = new Set(gone.filter((g) => present.has(g)))
      if (toStrip.size === 0) continue // the link is not in the stored text (it comes from a template)
      const after = stripLinks(before, (href) => {
        const p = internalPath(href)
        return p !== null && toStrip.has(p)
      })
      if (after === before) continue
      const columns = columnsFor(loc.type, 'body', after)
      if (!columns) {
        out.notes.push(`${page}: the text could not be rewritten safely, left alone`)
        continue
      }
      const edit: ContentEdit = {
        content_type: loc.type,
        content_id: loc.row.id as string,
        path: page,
        field: 'links',
        reason: `Site crawl: removed ${toStrip.size === 1 ? 'a link' : `${toStrip.size} links`} to ${[...toStrip].join(', ')} (the page returns 404; the words stay)`.slice(0, 480),
        before,
        after,
        method: 'links',
        published_after: true,
        cost_usd: 0,
      }
      const res = await applyEdit(admin, loc, edit, columns)
      if (!res.ok) {
        out.notes.push(`${page}: ${res.note}`)
        continue
      }
      out.fixed++
      out.changedPaths.push(page)
      for (const f of list) if (toStrip.has(internalPath(f.target as string) ?? '')) out.healedKeys.add(findingKeyOf(f))
    }

    // b) A cover or hero whose description is empty or generic, on a page where the crawl saw a picture with no alt.
    for (const f of findings) {
      if (out.fixed >= cap || timeLeft() < MIN_MS_FOR_REPAIR) break
      if (f.kind !== 'img-alt-missing') continue
      const page = pathOf(f.url)
      if (out.changedPaths.includes(page) && deadByPage.has(page)) continue
      const loc = await locateContent(admin, page)
      if (!loc) continue
      let edit: ContentEdit | null = null
      let columns: Row | null = null
      if (loc.type === 'post') {
        if (!str(loc.row.cover_image_url).trim() || !isGenericAlt(str(loc.row.alt_text))) continue
        const alt = coverAlt({ title: str(loc.row.title), keyword: str(loc.row.primary_keyword) })
        if (!alt.trim() || alt === str(loc.row.alt_text)) continue
        edit = { content_type: 'post', content_id: loc.row.id as string, path: page, field: 'alt_text', reason: 'Site crawl: the cover picture had no useful description, so one was set from the post title', before: str(loc.row.alt_text), after: alt, method: 'fixer', published_after: true, cost_usd: 0 }
        columns = { alt_text: alt }
      } else {
        if (!str(loc.row.hero_image_url).trim() || !isGenericAlt(str(loc.row.hero_alt))) continue
        const alt = heroAlt(str(loc.row.hero_alt), str(loc.row.name))
        if (!alt.trim() || alt === str(loc.row.hero_alt)) continue
        edit = { content_type: 'guide', content_id: loc.row.id as string, path: page, field: 'hero_alt', reason: 'Site crawl: the hero picture had no useful description, so one was set from the guide name', before: str(loc.row.hero_alt), after: alt, method: 'fixer', published_after: true, cost_usd: 0 }
        columns = { hero_alt: alt }
      }
      const res = await applyEdit(admin, loc, edit, columns)
      if (!res.ok) {
        out.notes.push(`${page}: ${res.note}`)
        continue
      }
      out.fixed++
      out.changedPaths.push(page)
    }

    // c) Titles over 60 characters, and titles two pages share. A post gets a shorter title and search title; a guide a shorter search
    // title. Only the title fields change: never the text, never published or unpublished (published_after is false, so Undo cannot
    // unpublish). Own cap (MAX_TITLE_FIXES_PER_RUN), logged first and undoable like the repairs above.
    const titleFindings = findings.filter((f) => f.kind === 'title-long' || f.kind === 'title-duplicate')
    if (titleFindings.length > 0 && timeLeft() >= MIN_MS_FOR_REPAIR) {
      const titleCap = opts.titleCap ?? MAX_TITLE_FIXES_PER_RUN
      let titleFixed = 0
      const taken = new Map<string, string>() // lower-cased search title -> slug of the post that has it
      const { data: others } = await admin.from('posts').select('slug, title, meta_title').eq('status', 'published').limit(2000)
      for (const r of (others ?? []) as { slug: string; title: string | null; meta_title: string | null }[]) {
        const shown = (r.meta_title ?? '').trim() || `${r.title ?? ''} | ${SITE_NAME}`
        taken.set(shown.toLowerCase().replace(/\s+/g, ' ').trim(), r.slug)
      }
      const seen = new Set<string>()
      for (const f of titleFindings) {
        if (titleFixed >= titleCap || timeLeft() < MIN_MS_FOR_REPAIR) break
        const page = pathOf(f.url)
        if (seen.has(page)) continue
        seen.add(page)
        const loc = await locateContent(admin, page)
        if (!loc) continue
        const edits: ContentEdit[] = []
        let columns: Row | null = null
        const reason = `Site crawl: ${f.kind === 'title-long' ? 'the title was longer than 60 characters' : 'another page had the same title'}, so it was shortened`
        if (loc.type === 'post') {
          const slug = str(loc.row.slug)
          const others = new Set([...taken].filter(([, s]) => s !== slug).map(([k]) => k))
          const plan = planPostTitle({ slug, title: str(loc.row.title), meta_title: str(loc.row.meta_title), publish_date: str(loc.row.publish_date) }, others, SITE_NAME)
          const base = { content_type: 'post' as const, content_id: loc.row.id as string, path: page, reason: reason.slice(0, 480), method: 'fixer' as const, published_after: false, cost_usd: 0 }
          columns = {}
          if (plan.titleChanged) {
            edits.push({ ...base, field: 'title', before: str(loc.row.title), after: plan.title })
            columns.title = plan.title
          }
          if (plan.metaChanged) {
            edits.push({ ...base, field: 'meta_title', before: str(loc.row.meta_title), after: plan.meta_title ?? '' })
            columns.meta_title = plan.meta_title
          }
        } else {
          const meta = str(loc.row.meta_title).trim()
          const next = meta ? fitTitle(meta) : ''
          if (next && next !== meta) {
            edits.push({ content_type: 'guide', content_id: loc.row.id as string, path: page, field: 'meta_title', reason: reason.slice(0, 480), before: meta, after: next, method: 'fixer', published_after: false, cost_usd: 0 })
            columns = { meta_title: next }
          }
        }
        if (edits.length === 0 || !columns) continue
        const res = await applyEdit(admin, loc, edits, columns)
        if (!res.ok) {
          out.notes.push(`${page}: ${res.note}`)
          continue
        }
        titleFixed++
        out.fixed++
        out.changedPaths.push(page)
        out.healedKeys.add(findingKeyOf(f))
        if (loc.type === 'post') {
          const slug = str(loc.row.slug)
          for (const [k, s] of [...taken]) if (s === slug) taken.delete(k)
          const nextMeta = (columns.meta_title as string | null | undefined) ?? (str(loc.row.meta_title).trim() || null)
          const nextTitle = (columns.title as string | undefined) ?? str(loc.row.title)
          taken.set(((nextMeta ?? '').trim() || `${nextTitle} | ${SITE_NAME}`).toLowerCase().replace(/\s+/g, ' ').trim(), slug)
        }
      }
    }
  } catch (e) {
    out.notes.push(`self-heal stopped: ${e instanceof Error ? e.message : 'failed'}`)
  }
  return out
}

export interface SiteCrawlResult {
  ok: boolean
  note: string
  fixed: number
  changedPaths: string[]
}

/** The daily step. Never throws, and a failure here never fails the cron that calls it. */
export async function runSiteCrawl(admin: SupabaseClient, opts: { deadlineMs?: number; fetch?: FetchLike; now?: Date; siteUrl?: string; delayMs?: number } = {}): Promise<SiteCrawlResult> {
  const now = opts.now ?? new Date()
  const deadline = opts.deadlineMs ?? Date.now() + CRAWL_BUDGET_MS
  const f = opts.fetch ?? realFetch
  const siteUrl = (opts.siteUrl ?? SITE_URL).replace(/\/$/, '')
  try {
    const stored = await getSettingStrict(admin, STATE_KEY)
    if (stored.error) return { ok: false, note: `site crawl skipped: could not read its state (${stored.error})`, fixed: 0, changedPaths: [] }
    const prev = parseState(stored.value)

    const sm = await fetchSitemap(siteUrl, f)
    if (sm.error || sm.urls.length === 0) {
      const note = `site crawl: ${sm.error ?? 'the sitemap is empty'}`
      await setSetting(admin, STATE_KEY, JSON.stringify({ ...prev, note, lastRun: now.toISOString() } satisfies CrawlState)).catch(() => undefined)
      return { ok: false, note, fixed: 0, changedPaths: [] }
    }
    const win = pickWindow(sm.urls, prev.cursor, windowSize(sm.urls.length))
    const known: Record<string, [string, string]> = {}
    for (const [p, v] of Object.entries(prev.pages)) known[p] = [v[1], v[2]]

    const crawl = await crawlWindow({ siteUrl, sitemapUrls: sm.urls, window: win, fetch: f, deadlineMs: deadline, known, delayMs: opts.delayMs })
    const sitemapPaths = new Set(sm.urls.map(pathOf))
    const heal = crawl.budgetUsed && deadline - Date.now() < MIN_MS_FOR_REPAIR ? ({ fixed: 0, healedKeys: new Set<string>(), changedPaths: [], notes: [], skippedBecause: 'the time budget was used' } as HealResult) : await healCrawlFindings(admin, crawl.findings, { fetch: f, sitemapPaths, deadlineMs: deadline })

    const errors = crawl.findings.filter((x) => x.severity === 'error' && !heal.healedKeys.has(findingKeyOf(x))).length
    const warnings = crawl.findings.filter((x) => x.severity === 'warning').length
    const note = `site crawl: checked ${crawl.checked.length} of ${sm.urls.length} pages (${crawl.linkChecks} links), ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}, fixed ${heal.fixed}${heal.skippedBecause ? ` (no repairs: ${heal.skippedBecause})` : ''}${crawl.budgetUsed ? '; the time budget ran out before every page in the window was checked' : ''}${heal.notes.length ? `; ${heal.notes.slice(0, 2).join('; ')}` : ''}`
    const next = mergeState(prev, { checkedUrls: crawl.checked, records: crawl.records, findings: crawl.findings, totalUrls: sm.urls.length, cursor: crawl.cursor, budgetUsed: crawl.budgetUsed, fixed: heal.fixed, note, sitemapPaths: [...sitemapPaths] }, now, heal.healedKeys)
    const saved = await setSetting(admin, STATE_KEY, JSON.stringify(next))
    if (saved.error) return { ok: false, note: `${note}; but the result could not be saved (${saved.error})`, fixed: heal.fixed, changedPaths: heal.changedPaths }
    return { ok: true, note, fixed: heal.fixed, changedPaths: heal.changedPaths }
  } catch (e) {
    return { ok: false, note: `site crawl failed: ${e instanceof Error ? e.message : 'unknown error'}`, fixed: 0, changedPaths: [] }
  }
}

/** The stored result, for the System Health card, Needs attention and the growth digest. Null when it cannot be read. */
export async function readCrawlState(admin: SupabaseClient): Promise<CrawlState | null> {
  try {
    const r = await getSettingStrict(admin, STATE_KEY)
    return r.error ? null : parseState(r.value)
  } catch {
    return null
  }
}

/** Hides the Needs attention item until a NEW error appears. */
export async function dismissCrawlErrors(admin: SupabaseClient, now: Date = new Date()): Promise<string | null> {
  const state = (await readCrawlState(admin)) ?? emptyState()
  const { error } = await setSetting(admin, STATE_KEY, JSON.stringify({ ...state, dismissedAt: now.toISOString() }))
  return error ?? null
}

