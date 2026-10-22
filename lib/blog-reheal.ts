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
import { checkCadence, postCadenceKey, postLimits, recordPublish } from '@/lib/publish-cadence'
import { isNewsSlug } from '@/lib/news-post'
import { autoPublishBlockers, normalizePost } from '@/lib/blog-composer'
import { qualityBlockers, internalHrefs, withSiteLinks, type TripDates } from '@/lib/blog-quality'
import { addRelatedLine, applyQualityRewrites, improves, mechanicalFix, qualityOffenders, qualityRewritePrompt, type FixLink } from '@/lib/blog-quality-fix'
import { Tracker, buildEdits, modelCallFor, type EditMethod, type LogicalField } from '@/lib/content-repair'
import { postFields } from '@/lib/content-repair-adapters'
import { openBudget, type HealBudget } from '@/lib/heal-loop'
import { styleById } from '@/lib/content-styles'
import { isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import { generateSlug } from '@/lib/utils'

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

/** The grounding text of a post and, when it links a real trip, that trip's travel dates (for the title-year check). */
async function groundingAndTrip(admin: SupabaseClient, post: ComposedPost): Promise<{ text: string; tripDates: TripDates | null }> {
  const base = [post.primary_keyword, ...post.secondary_keywords].filter(Boolean).join(' ')
  const slug = firstPackageSlug(post.body)
  if (!slug) return { text: base, tripDates: null }
  const { data } = await admin
    .from('travel_packages')
    .select('name, slug, destination, short_description, full_description, highlights, available_from, available_to')
    .eq('status', 'published')
    .eq('slug', slug)
    .maybeSingle()
  if (!data) return { text: base, tripDates: null }
  const pkg = data as PackageGrounding
  return { text: `${groundAngleInPackage(base, pkg)} ${base}`, tripDates: { from: pkg.available_from, to: pkg.available_to } }
}

/** Gives stuck autoblog drafts their daily try. `existing` is the set of paths that exist on the site (for the gate's
 * link check). Never throws. */
export async function rehealStuckDrafts(admin: SupabaseClient, opts: { existing: Set<string>; now?: Date; model?: ModelCall; deadlineMs?: number; refresh?: boolean }): Promise<RehealResult> {
  const drafts = await rehealDraftsOnly(admin, opts)
  // loop-blog-quality: the same daily step also gives the weakest PUBLISHED posts their weekly refresh (no new cron). It never throws and
  // only touches the result when it did something or had a problem to report.
  if (opts.refresh === false) return drafts
  const refresh = await refreshPublishedPosts(admin, { existing: opts.existing, now: opts.now, model: opts.model, deadlineMs: opts.deadlineMs })
  if (!refresh.ran) return refresh.problems.length ? { ...drafts, problems: [...drafts.problems, ...refresh.problems] } : drafts
  return {
    ...drafts,
    repaired: drafts.repaired + refresh.refreshed + refresh.linked,
    calls: drafts.calls + refresh.calls,
    problems: [...drafts.problems, ...refresh.problems],
    note: `${drafts.note}; ${refresh.note}`,
  }
}

async function rehealDraftsOnly(admin: SupabaseClient, opts: { existing: Set<string>; now?: Date; model?: ModelCall; deadlineMs?: number }): Promise<RehealResult> {
  const out: RehealResult = { tried: 0, published: 0, rejected: 0, deferred: 0, repaired: 0, calls: 0, problems: [], note: '' }
  const now = opts.now ?? new Date()
  try {
    if ((await getSetting(admin, 'autoblog_mode')) !== 'publish') return { ...out, note: 'blog drafts not re-checked (the blog is not in publish mode)' }
    if (await isAutomationPaused(admin)) return { ...out, note: 'blog drafts not re-checked (automation is paused)' }
    if (!(await editsLoggable(admin))) return { ...out, problems: ['blog drafts not re-checked: apply migration 0033'], note: 'blog drafts not re-checked' }

    const since = new Date(now.getTime() - REHEAL_MAX_AGE_DAYS * 86_400_000).toISOString()
    const { data: drafts, error } = await admin.from('posts').select('*').eq('status', 'draft').gte('created_at', since).order('created_at', { ascending: true }).limit(DRAFT_READ_LIMIT)
    if (error) return { ...out, problems: [`could not read the blog drafts (${error.message})`], note: 'blog drafts not re-checked' }
    // Travel news drafts (slug "news-...", WP20) are queued by the news step and go live only through it, in travel_news_mode
    // publish, with their own gate and judge. The blog re-check never touches them.
    const rows = ((drafts ?? []) as Row[]).filter((r) => !isNewsSlug(str(r.slug)))
    if (!rows.length) return { ...out, note: 'no blog drafts waiting' }

    const { data: tagRows } = await admin.from('content_variants').select('slug, variant_tags').in('slug', rows.map((r) => str(r.slug)))
    const tagsBySlug = new Map<string, RehealTags>(((tagRows ?? []) as { slug: string; variant_tags: RehealTags | null }[]).map((t) => [t.slug, t.variant_tags ?? {}]))
    const usedToday = await triesMadeToday(admin, now)
    if (usedToday === null) return { ...out, problems: ['blog drafts not re-checked: could not count today\'s tries'], note: 'blog drafts not re-checked' }
    const left = triesLeftToday(usedToday)
    const picks = selectRehealCandidates(rows, tagsBySlug, now, left)
    if (!picks.length) return { ...out, note: `blog drafts: none due a re-check today${left === 0 ? ' (the daily limit is used)' : ''}` }

    let waitNote = ''
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
      const grounded = await groundingAndTrip(admin, composed)
      const ctx = { allowedPaths: [...opts.existing], groundingText: grounded.text, tripDates: grounded.tripDates, deadlineMs: itemDeadline }
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
            // The style and the link list matter now: the quality gate refuses a post with no content style or fewer than 3 links.
            return composeFullPost(angle, base.length ? base : composed.title, { deadlineMs: healDeadline, style: styleById(composed.content_style) ?? undefined, allowedLinks: withSiteLinks(pkgLinksFor(composed.body)) })
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
        // The shared publishing limiter (lib/publish-cadence.ts): asked only now, when the draft really is about to go live, so a wait never
        // blocks a draft that is being rejected. No free slot (90 minutes after the last automatic post) means the repaired text is kept on
        // the draft, no try is used up, and the next run publishes it: deferred, never dropped.
        const slot = await checkCadence(admin, 'post', postLimits(), now)
        if (!slot.allowed) {
          if (changedText) await writeDraft(admin, id, textColumns, editIds, path, false, out, row.updated_at)
          out.deferred++
          waitNote = slot.note
          continue
        }
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
        await recordPublish(admin, 'post', postCadenceKey(slug), now)
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
    out.note = `blog drafts: ${out.tried} re-checked, ${out.published} published, ${out.rejected} retired by the heal${out.deferred ? `, ${out.deferred} waiting for ${waitNote ? 'a free publishing slot' : 'tomorrow'}` : ''}`
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

// ---------------------------------------------------------------------------------------------------
// Weekly refresh of PUBLISHED posts (loop-blog-quality)
// ---------------------------------------------------------------------------------------------------
//
// The editor audit scored the ten live posts about 5 out of 10. This pass runs inside the same daily heal step as the draft re-check
// (no new cron). Every published post is scored with the same gates the writer uses (lib/blog-quality.ts); the worst REFRESH_PER_DAY
// that were not looked at in the last REFRESH_COOLDOWN_DAYS get ONE bounded pass: plain-code fixes first (filler phrases, FAQ
// meta-language, unverifiable place claims, a stale year, a missing contact link, too few internal links), then at most ONE model call
// for the exact sentences code cannot mend, drawn from the heal loop's daily call budget (heal_loop_calls_per_day). The change is kept
// ONLY if the full publish gate shows fewer blockers and no new kind of blocker; it never changes a fact (a rewrite that adds a number
// or a link is thrown away), and every change is logged in content_edits BEFORE it is applied, so Undo works exactly like the other heals.
// A post that did not improve is left untouched and not retried for a week. The slug never changes.
//
// Hub and spoke: when two published posts are about the same trip, each gets a link to the other (a "Related reading" line, logged and
// undoable, at most HUB_LINKS_PER_DAY posts a day). The posts table has no canonical column (the page template sets each post's own
// canonical URL), so no post is marked canonical here: the reciprocal links are the whole mechanism.

export const REFRESH_PER_DAY = 2
export const REFRESH_COOLDOWN_DAYS = 7
export const HUB_LINKS_PER_DAY = 2
const REFRESH_READ_LIMIT = 200
const REFRESH_CALL_TIMEOUT_MS = 60_000
const MIN_MS_FOR_REFRESH_CALL = 50_000

export interface RefreshResult {
  /** False when the pass did nothing at all (nothing weak, or not allowed to run), so the heal note stays quiet. */
  ran: boolean
  checked: number
  weak: number
  refreshed: number
  unchanged: number
  linked: number
  calls: number
  problems: string[]
  note: string
}

interface PkgRow {
  id: string
  slug: string
  name: string
  destination: string | null
  short_description?: string | null
  full_description?: string | null
  highlights?: string[] | null
  available_from?: string | null
  available_to?: string | null
}

/** Like groundingAndTrip, from trips already read (the refresh reads them once instead of once per post). Pure. */
function groundingFromTrips(post: ComposedPost, pkgs: PkgRow[]): { text: string; tripDates: TripDates | null } {
  const base = [post.primary_keyword, ...post.secondary_keywords].filter(Boolean).join(' ')
  const slug = firstPackageSlug(post.body)
  const pkg = slug ? pkgs.find((p) => p.slug === slug) : undefined
  if (!pkg) return { text: base, tripDates: null }
  const grounding: PackageGrounding = {
    name: pkg.name,
    slug: pkg.slug,
    destination: pkg.destination ?? '',
    short_description: pkg.short_description ?? null,
    full_description: pkg.full_description ?? null,
    highlights: pkg.highlights ?? null,
    available_from: pkg.available_from ?? null,
    available_to: pkg.available_to ?? null,
  }
  return { text: `${groundAngleInPackage(base, grounding)} ${base}`, tripDates: { from: grounding.available_from, to: grounding.available_to } }
}

/** The trip page a post body links to, as writer link material. */
export function pkgLinksFor(body: string): FixLink[] {
  const slug = firstPackageSlug(body)
  return slug ? [{ path: `/packages/${slug}`, label: 'the trip page' }] : []
}

/** The trip a post is about (its linked package, else its first /packages/ link), or null. Pure. */
export function tripKeyOf(row: Row, pkgSlugById: Map<string, string>): string | null {
  const id = str(row.related_package_id)
  return (id && pkgSlugById.get(id)) || firstPackageSlug(str(row.body)) || null
}

export interface ScoredPost {
  row: Row
  blockers: string[]
  /** ISO time of the last refresh try, or null. */
  lastRefresh: string | null
}

/** The posts to refresh today: weak ones only, not looked at in the last 7 days, worst first (then the longest unchecked, then oldest), at most `limit`. Pure. */
export function selectRefreshPicks<T extends ScoredPost>(scored: T[], now: Date, limit: number): T[] {
  const cool = REFRESH_COOLDOWN_DAYS * 86_400_000
  const ms = (s: string | null | undefined) => Date.parse(s ?? '') || 0
  return scored
    .filter((s) => s.blockers.length > 0 && !(s.lastRefresh && now.getTime() - ms(s.lastRefresh) < cool))
    .sort((a, b) => b.blockers.length - a.blockers.length || ms(a.lastRefresh) - ms(b.lastRefresh) || ms(str(a.row.created_at)) - ms(str(b.row.created_at)))
    .slice(0, Math.max(0, limit))
}

/** Real pages a post may be given as related reading, best first: other posts about the same trip, the trip page, the destination page,
 * then posts that share a tag. Only paths that exist, and never one the body already links. Pure. */
export function relatedLinksFor(row: Row, published: Row[], pkgs: PkgRow[], existing: Set<string>): FixLink[] {
  const byId = new Map(pkgs.map((p) => [p.id, p.slug]))
  const body = str(row.body)
  const have = new Set(internalHrefs(body))
  const out: FixLink[] = []
  const seen = new Set<string>()
  const add = (path: string, label: string) => {
    if (!path || seen.has(path) || have.has(path) || !existing.has(path) || label.trim().length < 2) return
    seen.add(path)
    out.push({ path, label })
  }
  const key = tripKeyOf(row, byId)
  const pkg = key ? pkgs.find((p) => p.slug === key) : undefined
  if (key) for (const p of published) if (str(p.slug) !== str(row.slug) && tripKeyOf(p, byId) === key) add(`/blog/${str(p.slug)}`, str(p.title))
  if (pkg) add(`/packages/${pkg.slug}`, `the ${pkg.name} trip page`)
  if (pkg?.destination) add(`/destinations/${generateSlug(pkg.destination)}`, `our ${pkg.destination} destination page`)
  const tags = new Set(strList(row.tags).map((t) => t.toLowerCase()))
  if (tags.size) for (const p of published) if (str(p.slug) !== str(row.slug) && strList(p.tags).some((t) => tags.has(t.toLowerCase()))) add(`/blog/${str(p.slug)}`, str(p.title))
  return out
}

/** Hub and spoke: for every trip with two or more published posts, the posts that do not yet link a sibling, with the sibling links to add (at most 2 each). Pure. */
export function hubLinkPlan(published: Row[], pkgs: PkgRow[], existing: Set<string>, limit: number): { row: Row; links: FixLink[] }[] {
  const byId = new Map(pkgs.map((p) => [p.id, p.slug]))
  const groups = new Map<string, Row[]>()
  for (const p of published) {
    const key = tripKeyOf(p, byId)
    if (key) groups.set(key, [...(groups.get(key) ?? []), p])
  }
  const plan: { row: Row; links: FixLink[] }[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const a of group) {
      const have = new Set(internalHrefs(str(a.body)))
      const links = group.filter((b) => str(b.slug) !== str(a.slug) && existing.has(`/blog/${str(b.slug)}`) && !have.has(`/blog/${str(b.slug)}`)).slice(0, 2).map((b) => ({ path: `/blog/${str(b.slug)}`, label: str(b.title) }))
      if (links.length) plan.push({ row: a, links })
    }
  }
  return plan.slice(0, Math.max(0, limit))
}

/** How many published posts were refresh-tried today (UTC day). Null when it cannot be read: nothing is refreshed then. */
export async function refreshesToday(admin: SupabaseClient, now: Date): Promise<number | null> {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const { data, error } = await admin.from('content_variants').select('slug').gte('variant_tags->>refresh_last', dayStart).limit(50)
  return error ? null : (data ?? []).length
}

const REFRESH_FIELDS: LogicalField[] = ['title', 'body', 'meta_title', 'meta_description', 'og_title', 'og_description', 'faq', 'key_takeaways']

/** Logs the change, then applies it to the live post ("log, then apply"). Nothing is written if the post was edited meanwhile. True when saved. */
async function saveRefresh(
  admin: SupabaseClient,
  row: Row,
  before: ComposedPost,
  after: ComposedPost,
  tracker: Tracker,
  calls: number,
  now: Date,
  out: { problems: string[] },
): Promise<boolean> {
  const id = str(row.id)
  const path = `/blog/${str(row.slug)}`
  const edits = buildEdits({ type: 'post', id, path, published: true }, postFields(before), postFields(after), tracker, calls)
  if (edits.length === 0) return false
  const logged = await insertEdits(admin, edits)
  if (logged.error) {
    out.problems.push(`${path}: could not log the refresh, so nothing was changed (${logged.error})`)
    return false
  }
  const v = postFields(after)
  const { data: updated, error } = await admin
    .from('posts')
    .update({
      title: v.title,
      body: v.body,
      meta_title: v.meta_title || null,
      meta_description: v.meta_description || null,
      og_title: v.og_title || null,
      og_description: v.og_description || null,
      faq: v.faq,
      key_takeaways: v.key_takeaways,
      updated_at: now.toISOString(),
    })
    .eq('id', id)
    .eq('status', 'published')
    .match(row.updated_at ? { updated_at: row.updated_at as string } : {})
    .select('id')
  if (error || !updated?.length) {
    await deleteEdits(admin, logged.ids).catch(() => undefined)
    out.problems.push(error ? `${path}: could not save the refresh (${error.message})` : `${path}: changed by someone else while the refresh was working, so it was left alone`)
    return false
  }
  await finalizeEdits(admin, logged.ids, { id, path, published: true })
  await pingIndexNow([path]).catch(() => undefined)
  return true
}

export async function refreshPublishedPosts(admin: SupabaseClient, opts: { existing: Set<string>; now?: Date; model?: ModelCall; deadlineMs?: number }): Promise<RefreshResult> {
  const out: RefreshResult = { ran: false, checked: 0, weak: 0, refreshed: 0, unchanged: 0, linked: 0, calls: 0, problems: [], note: '' }
  const now = opts.now ?? new Date()
  try {
    if ((await getSetting(admin, 'autoblog_mode')) !== 'publish') return out
    if (await isAutomationPaused(admin)) return out
    if (!(await editsLoggable(admin))) return out

    const { data: posts, error } = await admin.from('posts').select('*').eq('status', 'published').order('created_at', { ascending: true }).limit(REFRESH_READ_LIMIT)
    if (error) return { ...out, problems: [`could not read the published posts for the quality refresh (${error.message})`] }
    const published = ((posts ?? []) as Row[]).filter((r) => !isNewsSlug(str(r.slug)) && (!str(r.publish_date) || str(r.publish_date).slice(0, 10) <= now.toISOString().slice(0, 10)))
    out.checked = published.length
    if (!published.length) return out

    const { data: pkgData } = await admin.from('travel_packages').select('id, slug, name, destination, short_description, full_description, highlights, available_from, available_to').eq('status', 'published').limit(300)
    const pkgs = ((pkgData ?? []) as PkgRow[]).filter((p) => p.slug)
    const byId = new Map(pkgs.map((p) => [p.id, p.slug]))
    const { data: tagRows } = await admin.from('content_variants').select('slug, variant_tags').in('slug', published.map((r) => str(r.slug)))
    const lastBySlug = new Map(((tagRows ?? []) as { slug: string; variant_tags: { refresh_last?: string } | null }[]).map((t) => [t.slug, t.variant_tags?.refresh_last ?? null]))

    // Score every post with the same gates the writer uses.
    const scored: ScoredPost[] = []
    const grounded = new Map<string, { text: string; tripDates: TripDates | null }>()
    for (const row of published) {
      const post = composedFromRow(row)
      const g = groundingFromTrips(post, pkgs)
      grounded.set(str(row.slug), g)
      scored.push({ row, blockers: qualityBlockers(post, { now, groundingText: g.text, tripDates: g.tripDates }), lastRefresh: lastBySlug.get(str(row.slug)) ?? null })
    }
    out.weak = scored.filter((s) => s.blockers.length > 0).length

    const used = await refreshesToday(admin, now)
    if (used === null) return { ...out, problems: ['blog quality refresh skipped: could not count today\'s refreshes'] }
    const picks = selectRefreshPicks(scored, now, Math.max(0, REFRESH_PER_DAY - used))

    const model = opts.model ?? (isAiConfigured() ? modelCallFor('blog-refresh') : null)
    const budget: HealBudget | null = picks.length && model ? await openBudget(admin, now) : null
    const touched = new Set<string>()

    for (const pick of picks) {
      const row = pick.row
      const slug = str(row.slug)
      if (!(await claimDailyOnce(admin, `refresh:${slug}`, now))) continue
      out.ran = true
      touched.add(slug)
      const before = composedFromRow(row)
      const g = grounded.get(slug) ?? { text: '', tripDates: null }
      const key = tripKeyOf(row, byId)
      const pkg = key ? pkgs.find((p) => p.slug === key) : undefined
      const ctx = { now, groundingText: g.text, tripDates: g.tripDates, pkg: pkg ? { name: pkg.name, slug: pkg.slug } : null, related: relatedLinksFor(row, published, pkgs, opts.existing) }

      const mech = mechanicalFix(before, ctx)
      let next = mech.post
      const aiFields = new Set<LogicalField>()
      let calls = 0

      // The one bounded model pass: only the exact sentences code could not mend.
      const offenders = qualityOffenders(next, ctx)
      const timeLeft = opts.deadlineMs === undefined ? Number.MAX_SAFE_INTEGER : opts.deadlineMs - Date.now()
      if (offenders.length && model && budget && timeLeft >= MIN_MS_FOR_REFRESH_CALL && (await budget.take(1))) {
        calls = 1
        try {
          const text = await model(qualityRewritePrompt(offenders), 3000, REFRESH_CALL_TIMEOUT_MS)
          const parsed = text ? parseModelJson<{ rewrites?: { id: number; text: string }[] }>(text) : null
          if (parsed && Array.isArray(parsed.rewrites)) {
            const reworded = normalizePost(applyQualityRewrites(next, offenders, parsed.rewrites))
            for (const f of REFRESH_FIELDS) if (JSON.stringify(postFields(reworded)[f]) !== JSON.stringify(postFields(next)[f])) aiFields.add(f)
            next = reworded
          }
        } catch (e) {
          out.problems.push(`/blog/${slug}: the refresh rewrite call failed (${e instanceof Error ? e.message : 'unknown error'})`)
        }
      }
      out.calls += calls

      // Keep the change only if the full publish gate shows fewer blockers and nothing new.
      const gateCtx = { allowedPaths: [...opts.existing], groundingText: g.text, tripDates: g.tripDates }
      const kept = improves(autoPublishBlockers(before, now, gateCtx), autoPublishBlockers(next, now, gateCtx))
      const stamp = { refresh_last: now.toISOString() }
      if (!kept) {
        out.unchanged++
        await tagVariant(admin, slug, { ...stamp, refresh_result: 'no safe improvement found' })
        continue
      }
      const tracker = new Tracker()
      const a = postFields(before)
      const b = postFields(next)
      const linkOnly = mech.reasons.every((r) => /link/.test(r))
      for (const f of REFRESH_FIELDS) {
        if (JSON.stringify(a[f]) === JSON.stringify(b[f])) continue
        const method: EditMethod = aiFields.has(f) ? 'ai' : f === 'body' && linkOnly ? 'links' : 'fixer'
        tracker.touch(f, method, `blog quality refresh: ${[...mech.reasons, ...(aiFields.has(f) ? ['reworded flagged sentences'] : [])].join('; ') || 'quality clean-up'}`)
      }
      if (await saveRefresh(admin, row, before, next, tracker, calls, now, out)) {
        out.refreshed++
        await tagVariant(admin, slug, { ...stamp, refresh_result: 'refreshed' })
      } else {
        await tagVariant(admin, slug, { ...stamp, refresh_result: 'could not save' })
      }
    }

    // Hub and spoke: sibling posts about the same trip link to each other.
    for (const item of hubLinkPlan(published, pkgs, opts.existing, HUB_LINKS_PER_DAY)) {
      const slug = str(item.row.slug)
      if (touched.has(slug) || !(await claimDailyOnce(admin, `hub:${slug}`, now))) continue
      const before = composedFromRow(item.row)
      const after = { ...before, body: addRelatedLine(before.body, item.links, item.links.length) }
      if (after.body === before.body) continue
      out.ran = true
      const tracker = new Tracker()
      tracker.touch('body', 'links', 'hub and spoke: linked the other post(s) about the same trip so each points to the other')
      if (await saveRefresh(admin, item.row, before, after, tracker, 0, now, out)) out.linked++
    }

    out.note = `blog quality: ${out.weak} of ${out.checked} published posts below the bar, ${out.refreshed} refreshed, ${out.unchanged} left as they were, ${out.linked} sibling links added`
    return out
  } catch (e) {
    return { ...out, problems: [...out.problems, `blog quality refresh failed: ${e instanceof Error ? e.message : 'unknown error'}`] }
  }
}
