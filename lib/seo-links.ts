import type { SupabaseClient } from '@supabase/supabase-js'
import { addRelatedLine } from '@/lib/blog-quality-fix'
import { columnsFor, deleteEdits, editsLoggable, insertEdits, storedValue } from '@/lib/content-edits'
import type { ContentEdit } from '@/lib/content-repair'
import { appendDecisions, decision, policyGate, type AutoDecision } from '@/lib/auto-decisions'
import { internalLinkPathsOf } from '@/lib/seo-score'
import type { SeoPage } from '@/lib/seo-pages'
import { locateContent } from '@/lib/site-crawl-run'

// The one way the SEO engines add an internal link to a page (cannibalisation: lib/cannibalization.ts, hub and spoke: lib/hub-spoke.ts).
// The text change is made by plain code (no model), is exactly one link, is written to the audit log first (content_edits, so the
// Autopilot decisions page can Undo it) and is applied only to a PUBLISHED post or guide. Capped per day through the 'seo_links' policy.

export const LINKS_PER_DAY = 3
export type LinkWishKind = 'cannibalisation' | 'spoke-to-hub' | 'hub-to-spoke'

export interface LinkWish {
  fromPath: string
  toPath: string
  /** The words of the link: a real search people use for the target. */
  anchor: string
  kind: LinkWishKind
  /** Plain words: why this link helps. */
  why: string
}

export interface PlannedAdd {
  wish: LinkWish
  from: SeoPage
  to: SeoPage
}

const LINK_SPAN = /!?\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

/** A search made safe to use as link words: letters, digits, spaces and apostrophes only, 2 to 80 characters. Empty when nothing is left. Pure. */
export function cleanAnchor(q: string): string {
  return q
    .split(EM)
    .join(' ')
    .split(EN)
    .join(' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim()
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SKIP_PARA = /^(#{1,6}\s|>|\||```|---|\*\*\*|Related reading:|Quick answer:)/

/** Adds exactly one link to `path`. First choice: wrap the words of the search where an ordinary paragraph already says them (the link is
 * part of a real sentence). Otherwise one "Related reading" line is added with the search as its words. Null when the body already links
 * to the page, the anchor is unusable, or nothing could be added. Never touches an existing link. Pure. */
export function insertContextLink(body: string, anchorRaw: string, path: string): { body: string; how: 'inline' | 'related-line' } | null {
  const anchor = cleanAnchor(anchorRaw)
  if (anchor.length < 2 || !path.startsWith('/')) return null
  const norm = path.replace(/\/+$/, '') || '/'
  if (internalLinkPathsOf(body).includes(norm)) return null

  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(anchor).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu')
  const paras = body.split(/(\n{2,})/)
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]
    if (!p.trim() || /^\n+$/.test(p) || SKIP_PARA.test(p.trim()) || /^\s*([-*+]|\d+\.)\s/.test(p)) continue
    const spans: [number, number][] = []
    for (const m of p.matchAll(LINK_SPAN)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
    let from = 0
    for (;;) {
      const hit = re.exec(p.slice(from))
      if (!hit) break
      const start = from + hit.index
      const end = start + hit[0].length
      if (spans.some(([a, b]) => start < b && end > a)) {
        from = end
        continue
      }
      paras[i] = `${p.slice(0, start)}[${hit[0]}](${norm})${p.slice(end)}`
      return { body: paras.join(''), how: 'inline' }
    }
  }
  const next = addRelatedLine(body, [{ label: anchor, path: norm }], 1)
  if (next === body || !internalLinkPathsOf(next).includes(norm)) return null
  return { body: next, how: 'related-line' }
}

/** Turns wishes (best first) into at most `maxPages` planned adds. Rules: the page that gets the link must be a published post or guide with
 * its text loaded; the target must be a published, indexable page that is not the same page; the page must not already link to the target;
 * one link per page per run; a trip, a destination page or a safe (thin) page is never edited. Pure. */
export function planLinkAdds(wishes: readonly LinkWish[], pages: readonly SeoPage[], maxPages: number): { adds: PlannedAdd[]; skipped: { wish: LinkWish; reason: string }[] } {
  const byPath = new Map(pages.map((p) => [p.path, p]))
  const adds: PlannedAdd[] = []
  const skipped: { wish: LinkWish; reason: string }[] = []
  const used = new Set<string>()
  for (const wish of wishes) {
    const skip = (reason: string) => skipped.push({ wish, reason })
    const from = byPath.get(wish.fromPath)
    const to = byPath.get(wish.toPath)
    if (wish.fromPath === wish.toPath) {
      skip('a page is never linked to itself')
      continue
    }
    if (!from || !to) {
      skip('one of the two pages is not a published page')
      continue
    }
    if (to.thin || from.thin) {
      skip('a safe (noindex) page is left out of every link')
      continue
    }
    if (!from.editable || (from.type !== 'blog' && from.type !== 'guide' && from.type !== 'destination')) {
      skip('only published blog posts and guides are edited by themselves')
      continue
    }
    if (!from.body.trim()) {
      skip('the page text was not loaded')
      continue
    }
    if (used.has(from.path)) {
      skip('this page already gets a link in this run (one link per page)')
      continue
    }
    if (adds.length >= maxPages) {
      skip(`today's limit of ${maxPages} pages is reached`)
      continue
    }
    const norm = to.path.replace(/\/+$/, '') || '/'
    if (internalLinkPathsOf(from.body).includes(norm)) {
      skip('the page already links there')
      continue
    }
    if (!insertContextLink(from.body, wish.anchor, to.path)) {
      skip('no safe place for the link was found')
      continue
    }
    used.add(from.path)
    adds.push({ wish, from, to })
  }
  return { adds, skipped }
}

type Row = Record<string, unknown>

export interface LinkRunResult {
  added: number
  changedPaths: string[]
  decisions: AutoDecision[]
  notes: string[]
  /** Why nothing was done at all (paused, switched off, cap used, audit log unavailable). */
  blockedBecause?: string
}

/** Logs, then applies, the planned adds. Each page is re-read right before the write and the link is built on the FRESH text; the write only
 * happens when nobody edited the page since. Every change is one content_edits row (Undo) and one line in the Autopilot decisions log. Never throws. */
export async function applyLinkAdds(admin: SupabaseClient, wishes: readonly LinkWish[], pages: readonly SeoPage[], now: Date = new Date()): Promise<LinkRunResult> {
  const out: LinkRunResult = { added: 0, changedPaths: [], decisions: [], notes: [] }
  try {
    const gate = await policyGate(admin, 'seo_links', now)
    if (!gate.allowed) return { ...out, blockedBecause: gate.reason }
    if (!(await editsLoggable(admin))) return { ...out, blockedBecause: 'the audit log (content_edits) cannot be written, so no page was changed' }
    const { adds, skipped } = planLinkAdds(wishes, pages, Math.min(gate.room, LINKS_PER_DAY))
    for (const s of skipped.slice(0, 5)) out.notes.push(`${s.wish.fromPath} to ${s.wish.toPath}: ${s.reason}`)
    for (const add of adds) {
      const loc = await locateContent(admin, add.from.path)
      if (!loc) {
        out.notes.push(`${add.from.path}: not a published post or guide any more`)
        continue
      }
      const before = storedValue(loc.type, loc.row, 'body')
      const made = insertContextLink(before, add.wish.anchor, add.to.path)
      if (!made) {
        out.notes.push(`${add.from.path}: the text changed, no safe place for the link now`)
        continue
      }
      const columns = columnsFor(loc.type, 'body', made.body) as Row | null
      if (!columns) {
        out.notes.push(`${add.from.path}: the text could not be rewritten safely, left alone`)
        continue
      }
      const edit: ContentEdit = {
        content_type: loc.type,
        content_id: loc.row.id as string,
        path: add.from.path,
        field: 'links',
        reason: `SEO engines: added a link to ${add.to.path} (words "${cleanAnchor(add.wish.anchor)}"). ${add.wish.why}`.slice(0, 480),
        before,
        after: made.body,
        method: 'links',
        published_after: true,
        cost_usd: 0,
      }
      const logged = await insertEdits(admin, [edit])
      if (logged.error || logged.ids.length === 0) {
        out.notes.push(`${add.from.path}: the audit log could not be written (${logged.error ?? 'no id'}), nothing was changed`)
        continue
      }
      const table = loc.type === 'post' ? 'posts' : 'guides'
      let q = admin.from(table).update({ ...columns, updated_at: now.toISOString() }).eq('id', loc.row.id as string).eq('status', 'published')
      if (typeof loc.row.updated_at === 'string') q = q.eq('updated_at', loc.row.updated_at)
      const { data, error } = await q.select('id')
      if (error || !data || (data as unknown[]).length === 0) {
        await deleteEdits(admin, logged.ids)
        out.notes.push(`${add.from.path}: ${error ? `could not update the page: ${error.message}` : 'the page changed while it was being checked, left alone'}`)
        continue
      }
      out.added++
      out.changedPaths.push(add.from.path)
      out.decisions.push(
        decision('seo_links', add.from.path, `Added a link from ${add.from.path} to ${add.to.path}`, `${add.wish.why} (${made.how === 'inline' ? 'inside an existing sentence' : 'as a Related reading line'})`, { kind: 'revert-edit', ref: logged.ids[0] }, now),
      )
    }
    await appendDecisions(admin, out.decisions)
    return out
  } catch (e) {
    return { ...out, blockedBecause: `link step failed: ${e instanceof Error ? e.message : 'unknown error'}` }
  }
}
