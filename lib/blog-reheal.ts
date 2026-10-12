import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import type { ComposedPost } from '@/lib/blog-composer'
import { groundAngleInPackage, type PackageGrounding } from '@/lib/blog-topics'
import { classifyBlockers, type ContentEdit, type ModelCall } from '@/lib/content-repair'
import { finalizeEdits, repairComposedPost } from '@/lib/content-repair-adapters'
import { claimDailyOnce, deleteEdits, editsLoggable, insertEdits } from '@/lib/content-edits'
import { tagVariant } from '@/lib/content-variants'
import { enrollIfDue } from '@/lib/distribution'
import { composeFullPost } from '@/lib/blog-composer'
import { healComposedPost } from '@/lib/heal-targets'
import { pingIndexNow } from '@/lib/indexnow'

// Growth loop WP19: a draft is no longer left for a person. The shared repair runs first (plain code and one cheap call),
// and a draft that is still blocked goes through the heal loop (lib/heal-loop.ts: suggester, independent QA judge, up to
// three rounds, then the escalation ladder). It is published ONLY when the gate and the judge both pass; otherwise it is
// marked rejected at once (reheal_state 'rejected', also in the heal's rejected list), which frees its slot and its trip.
// A draft the heal could not reach today (out of budget or time, AI down) is not a failed try and is looked at again.
//
// Growth loop WP18-C: blog drafts the quality gate held back used to sit forever. The daily heal-content step now
// gives each stuck autoblog draft a small number of fresh tries, with the same shared repair the writer uses:
//   - only drafts the autoblog itself wrote (they carry a cta_style tag), under REHEAL_MAX_AGE_DAYS old, that were
//     held back (held_reasons) or never scored (seo_score empty);
//   - a draft held for a HARD reason (an experience claim, a price, an outside link, ...) is left for a person, always;
//   - at most REHEAL_PER_DAY drafts a day, each with at most one repair (one model call) a day; the repair also takes
//     one of the day's 6 repair slots, so the daily AI spend line of the heal does not move;
//   - the draft is published ONLY when the full publish gate is clean afterwards, and the publish is logged in
//     content_edits (field 'status') BEFORE it happens, so Undo puts the post back to a draft;
//   - after REHEAL_MAX_TRIES failed tries the draft is marked rejected, which frees its trip for a new post.
// State lives in the post's content_variants tags: reheal_tries, reheal_last (ISO time), reheal_state.

export const REHEAL_MAX_AGE_DAYS = 14
export const REHEAL_MAX_TRIES = 2
export const REHEAL_PER_DAY = 2
const DRAFT_READ_LIMIT = 80
const PER_POST_DEADLINE_MS = 100_000
/** The heal loop gets longer per draft than the cheap repair: it makes several calls. The caller's own deadline still wins. */
const HEAL_LOOP_DEADLINE_MS = 180_000

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const faqList = (v: unknown): { q: string; a: string }[] =>
  Array.isArray(v) ? v.filter((x): x is { q: string; a: string } => !!x && typeof (x as { q?: unknown }).q === 'string' && typeof (x as { a?: unknown }).a === 'string').map((x) => ({ q: x.q, a: x.a })) : []

export interface RehealTags {
  cta_style?: string
  held_reasons?: string
  reheal_tries?: number
  reheal_last?: string
  reheal_state?: string
}

/** The held reasons that are HARD (left to a person). Reasons are joined with "; " when saved. Pure. */
export function hardHeldReasons(held: string | null | undefined): string[] {
  const parts = (held ?? '').split('; ').map((p) => p.trim()).filter((p) => p && !/^held for review/.test(p))
  return classifyBlockers(parts).hard
}

/** Is this draft due a fresh try today? Pure. `row` is a posts row, `tags` its content_variants tags. */
export function isRehealCandidate(row: Row, tags: RehealTags | null, now: Date): boolean {
  if (row.status !== 'draft') return false
  // Only the autoblog's own drafts: a draft an admin typed by hand is never published by the heal.
  if (!tags || !tags.cta_style) return false
  if (tags.reheal_state === 'rejected') return false
  const created = Date.parse(str(row.created_at))
  if (!Number.isFinite(created) || now.getTime() - created > REHEAL_MAX_AGE_DAYS * 86_400_000) return false
  const stuck = !!(tags.held_reasons && tags.held_reasons.trim()) || row.seo_score === null || row.seo_score === undefined
  if (!stuck) return false
  if ((tags.reheal_tries ?? 0) >= REHEAL_MAX_TRIES) return false
  if (tags.reheal_last && tags.reheal_last.slice(0, 10) === now.toISOString().slice(0, 10)) return false
  // WP19: a draft held for a HARD reason (an experience claim, a price, an outside link ...) is no longer left for a person.
  // The heal loop removes or softens the sentence behind it, and rejects the draft when that is not enough.
  return true
}

/** The drafts to try today, oldest first (they run out of time first), at most `limit`. Pure. */
export function selectRehealCandidates(rows: Row[], tagsBySlug: Map<string, RehealTags>, now: Date, limit: number): Row[] {
  return rows
    .filter((r) => isRehealCandidate(r, tagsBySlug.get(str(r.slug)) ?? null, now))
    .sort((a, b) => Date.parse(str(a.created_at)) - Date.parse(str(b.created_at)))
    .slice(0, Math.max(0, limit))
}

/** How many tries are left to spend today given how many were already made today. Pure. */
export function triesLeftToday(usedToday: number): number {
  return Math.max(0, REHEAL_PER_DAY - usedToday)
}

/** How many drafts were tried today (UTC day), published ones included. Null when it cannot be read: nothing is tried then. */
export async function triesMadeToday(admin: SupabaseClient, now: Date): Promise<number | null> {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const { data, error } = await admin.from('content_variants').select('slug').gte('variant_tags->>reheal_last', dayStart).limit(50)
  return error ? null : (data ?? []).length
}

/** What happens to the tries counter after a try. Pure. */
export function nextRehealState(triesBefore: number, clean: boolean): { tries: number; state: 'published' | 'retry' | 'rejected' } {
  if (clean) return { tries: triesBefore + 1, state: 'published' }
  const tries = triesBefore + 1
  return { tries, state: tries >= REHEAL_MAX_TRIES ? 'rejected' : 'retry' }
}

/** A saved draft as the composer's post shape, so the same gate and repair can run on it. Pure. */
export function composedFromRow(row: Row): ComposedPost {
  return {
    title: str(row.title),
    slug: str(row.slug),
    body: str(row.body),
    seo_title: str(row.meta_title),
    seo_description: str(row.meta_description),
    tags: strList(row.tags),
    faq: faqList(row.faq),
    key_takeaways: strList(row.key_takeaways),
    og_title: str(row.og_title),
    og_description: str(row.og_description),
    primary_keyword: str(row.primary_keyword),
    secondary_keywords: strList(row.secondary_keywords),
    content_style: str(row.content_style),
  }
}

/** The trip a draft links to, by its first /packages/<slug> link. Pure. */
export function firstPackageSlug(body: string): string | null {
  return /\(\/packages\/([a-z0-9][a-z0-9-]*)\)/i.exec(body)?.[1] ?? /\/packages\/([a-z0-9][a-z0-9-]*)/i.exec(body)?.[1] ?? null
}

/** The slugs of drafts marked rejected by this re-check. They no longer count towards "a post was written today" or
 * "this trip already has a recent post". Empty when unreadable (nothing is freed then). */
export async function rejectedPostSlugs(admin: SupabaseClient): Promise<Set<string>> {
  try {
    const { data, error } = await admin.from('content_variants').select('slug').eq('variant_tags->>reheal_state', 'rejected').limit(500)
    if (error) return new Set()
    return new Set(((data ?? []) as { slug: string }[]).map((r) => r.slug))
  } catch {
    return new Set()
  }
}

export interface RehealResult {
  tried: number
  published: number
  rejected: number
  /** Drafts the heal could not reach today (out of budget or time, the AI down): not a failure, they wait. */
  deferred: number
  repaired: number
  calls: number
  problems: string[]
  note: string
}

async function groundingFor(admin: SupabaseClient, post: ComposedPost): Promise<string> {
  const base = [post.primary_keyword, ...post.secondary_keywords].filter(Boolean).join(' ')
  const slug = firstPackageSlug(post.body)
  if (!slug) return base
  const { data } = await admin
    .from('travel_packages')
    .select('name, slug, destination, short_description, full_description, highlights, available_from, available_to')
    .eq('status', 'published')
    .eq('slug', slug)
    .maybeSingle()
  return data ? `${groundAngleInPackage(base, data as PackageGrounding)} ${base}` : base
}

/** Gives stuck autoblog drafts their daily try. `existing` is the set of paths that exist on the site (for the gate's
 * link check). Never throws. */
export async function rehealStuckDrafts(admin: SupabaseClient, opts: { existing: Set<string>; now?: Date; model?: ModelCall; deadlineMs?: number }): Promise<RehealResult> {
  const out: RehealResult = { tried: 0, published: 0, rejected: 0, deferred: 0, repaired: 0, calls: 0, problems: [], note: '' }
  const now = opts.now ?? new Date()
  try {
    if ((await getSetting(admin, 'autoblog_mode')) !== 'publish') return { ...out, note: 'blog drafts not re-checked (the blog is not in publish mode)' }
    if (await isAutomationPaused(admin)) return { ...out, note: 'blog drafts not re-checked (automation is paused)' }
    if (!(await editsLoggable(admin))) return { ...out, problems: ['blog drafts not re-checked: apply migration 0033'], note: 'blog drafts not re-checked' }

    const since = new Date(now.getTime() - REHEAL_MAX_AGE_DAYS * 86_400_000).toISOString()
    const { data: drafts, error } = await admin.from('posts').select('*').eq('status', 'draft').gte('created_at', since).order('created_at', { ascending: true }).limit(DRAFT_READ_LIMIT)
    if (error) return { ...out, problems: [`could not read the blog drafts (${error.message})`], note: 'blog drafts not re-checked' }
    const rows = (drafts ?? []) as Row[]
    if (!rows.length) return { ...out, note: 'no blog drafts waiting' }

    const { data: tagRows } = await admin.from('content_variants').select('slug, variant_tags').in('slug', rows.map((r) => str(r.slug)))
    const tagsBySlug = new Map<string, RehealTags>(((tagRows ?? []) as { slug: string; variant_tags: RehealTags | null }[]).map((t) => [t.slug, t.variant_tags ?? {}]))
    const usedToday = await triesMadeToday(admin, now)
    if (usedToday === null) return { ...out, problems: ['blog drafts not re-checked: could not count today\'s tries'], note: 'blog drafts not re-checked' }
    const left = triesLeftToday(usedToday)
    const picks = selectRehealCandidates(rows, tagsBySlug, now, left)
    if (!picks.length) return { ...out, note: `blog drafts: none due a re-check today${left === 0 ? ' (the daily limit is used)' : ''}` }

    for (const row of picks) {
      const slug = str(row.slug)
      const id = str(row.id)
      const path = `/blog/${slug}`
      const tags = tagsBySlug.get(slug) ?? {}
      // One repair per draft per day, however often the heal is run.
      if (!(await claimDailyOnce(admin, `reheal:${slug}`, now))) continue
      out.tried++

      const composed = composedFromRow(row)
      const itemDeadline = Math.min(Date.now() + PER_POST_DEADLINE_MS, opts.deadlineMs ?? Number.MAX_SAFE_INTEGER)
      const ctx = { allowedPaths: [...opts.existing], groundingText: await groundingFor(admin, composed), deadlineMs: itemDeadline }
      const repaired = await repairComposedPost(admin, composed, now, ctx, { model: opts.model })
      out.calls += repaired.calls

      // The repair could not even start (no log table, an error): that is not the draft's fault, so it does not use up one
      // of its tries. A full day of repair slots does not stop the heal loop, which has its own budget.
      if (/^not repaired:/.test(repaired.note) && !/cap of/.test(repaired.note)) {
        out.problems.push(`${path}: ${repaired.note}`)
        continue
      }

      // WP19: still blocked after the cheap repair means the heal loop, not a wait for a person.
      let value = repaired.value
      let blockersNow = repaired.blockers
      let editIds = repaired.logIds
      let healStatus: 'healed' | 'rejected_by_heal' | 'deferred' | null = null
      let healReason = ''
      if (blockersNow.length) {
        const healDeadline = Math.min(Date.now() + HEAL_LOOP_DEADLINE_MS, opts.deadlineMs ?? Number.MAX_SAFE_INTEGER)
        const healed = await healComposedPost(admin, value, now, ctx, {
          model: opts.model,
          keepSlug: true,
          deadlineMs: healDeadline,
          regenerate: async (reasons) => {
            const base = [composed.primary_keyword, ...composed.secondary_keywords].filter(Boolean)
            const angle = `${ctx.groundingText}\n\nA first draft of this post was refused by the quality checks for these reasons, so avoid them: ${reasons.join('; ')}`
            return composeFullPost(angle, base.length ? base : composed.title, { deadlineMs: healDeadline })
          },
        })
        out.calls += healed.outcome.calls
        healStatus = healed.outcome.status === 'healed' ? 'healed' : healed.outcome.status === 'rejected_by_heal' ? 'rejected_by_heal' : 'deferred'
        healReason = healed.outcome.reasons[0] ?? healed.outcome.note
        if (healed.outcome.status === 'healed') {
          value = healed.value
          blockersNow = []
          editIds = [...editIds, ...healed.logIds]
        } else if (healed.outcome.status === 'deferred') {
          // Nothing could be done today (budget, time, the AI): keep any cheap repair, spend no try, look again tomorrow.
          out.deferred++
        }
      }

      const clean = blockersNow.length === 0
      // A rejection is final at once (the loop already tried its rounds and the whole ladder); a deferral is not a try.
      const next =
        healStatus === 'rejected_by_heal'
          ? { tries: (tags.reheal_tries ?? 0) + 1, state: 'rejected' as const }
          : healStatus === 'deferred'
            ? { tries: tags.reheal_tries ?? 0, state: 'retry' as const }
            : nextRehealState(tags.reheal_tries ?? 0, clean)
      const v = value
      const textColumns: Row = {
        title: v.title,
        body: v.body,
        meta_title: v.seo_title || null,
        meta_description: v.seo_description || null,
        og_title: v.og_title || null,
        og_description: v.og_description || null,
        faq: v.faq,
        key_takeaways: v.key_takeaways,
      }
      const changedText = editIds.length > 0

      if (clean) {
        // Log the publish first; no audit row, no publish.
        const statusEdit: ContentEdit = { content_type: 'post', content_id: id, path, field: 'status', reason: 'the draft now passes the full publish gate, so the re-check published it', before: 'draft', after: 'published', method: 'fixer', published_after: true, cost_usd: 0 }
        const logged = await insertEdits(admin, [statusEdit])
        if (logged.error) {
          out.problems.push(`${path}: it passes the gate but the publish could not be logged (${logged.error})${/check constraint/i.test(logged.error) ? '; apply migration 0043' : ''}`)
          // The text repair (if any) is still real: keep it on the draft, and do not use up a try.
          if (changedText) await writeDraft(admin, id, textColumns, editIds, path, false, out, row.updated_at)
          continue
        }
        const { data: updated, error: upErr } = await admin
          .from('posts')
          .update({ ...textColumns, status: 'published', publish_date: now.toISOString().slice(0, 10), updated_at: now.toISOString() })
          .eq('id', id)
          .eq('status', 'draft')
          // nobody edited the draft while the loop was working (an edit changes updated_at); otherwise leave it alone
          .match(row.updated_at ? { updated_at: row.updated_at } : {})
          .select('id')
        if (upErr || !updated?.length) {
          // Not published (an error, or a person published or removed it meanwhile): take the audit rows back.
          await deleteEdits(admin, [...editIds, ...logged.ids]).catch(() => undefined)
          if (upErr) out.problems.push(`${path}: could not publish (${upErr.message})`)
          continue
        }
        await finalizeEdits(admin, editIds, { id, path, published: true })
        await tagVariant(admin, slug, { held_reasons: '', reheal_tries: next.tries, reheal_last: now.toISOString(), reheal_state: 'published' })
        await enrollIfDue(admin, slug, v.title).catch(() => undefined)
        await pingIndexNow([path, '/blog', '/']).catch(() => undefined)
        out.published++
        if (changedText) out.repaired++
        continue
      }

      // Still blocked: keep any real text repair on the draft, record why, and count the try (a deferral counts none).
      if (changedText) await writeDraft(admin, id, textColumns, editIds, path, false, out, row.updated_at)
      await tagVariant(admin, slug, {
        held_reasons: healStatus === 'rejected_by_heal' ? `Rejected by heal: ${healReason}` : healStatus === 'deferred' ? [...blockersNow, `heal waiting: ${healReason}`].join('; ') : blockersNow.join('; '),
        reheal_tries: next.tries,
        ...(healStatus === 'deferred' ? {} : { reheal_last: now.toISOString() }),
        ...(next.state === 'rejected' ? { reheal_state: 'rejected' } : {}),
      })
      if (next.state === 'rejected') out.rejected++
    }
    out.note = `blog drafts: ${out.tried} re-checked, ${out.published} published, ${out.rejected} retired by the heal${out.deferred ? `, ${out.deferred} waiting for tomorrow` : ''}`
    return out
  } catch (e) {
    return { ...out, problems: [...out.problems, `blog drafts re-check failed: ${e instanceof Error ? e.message : 'unknown error'}`], note: out.note || 'blog drafts re-check failed' }
  }
}

/** Saves a repaired text on a draft (the audit rows already exist; they are taken back if the save fails). */
async function writeDraft(admin: SupabaseClient, id: string, columns: Row, editIds: string[], path: string, published: boolean, out: RehealResult, expectedUpdatedAt?: unknown): Promise<void> {
  const { data, error } = await admin.from('posts').update({ ...columns, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'draft').match(expectedUpdatedAt ? { updated_at: expectedUpdatedAt as string } : {}).select('id')
  if (error || !data?.length) {
    // Nothing was written (an error, or a person edited the draft meanwhile): take the audit rows back.
    await deleteEdits(admin, editIds).catch(() => undefined)
    out.problems.push(error ? `${path}: could not save the repaired text (${error.message})` : `${path}: changed by someone else while the heal was working, so it was left alone`)
    return
  }
  await finalizeEdits(admin, editIds, { id, path, published })
  out.repaired++
}
