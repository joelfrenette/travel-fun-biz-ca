import type { SupabaseClient } from '@supabase/supabase-js'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { claimDailyOnce, deleteEdits, editsLoggable, insertEdits } from '@/lib/content-edits'
import { finalizeEdits } from '@/lib/content-repair-adapters'
import type { ContentEdit } from '@/lib/content-repair'
import { guideBlockers, groundingText, type ComposedGuide, type GateContext } from '@/lib/guide-composer'
import { pageCopyBlockers, copyGroundingText, linkedPackageSlugs, type ComposedPageCopy, type CopyGateContext } from '@/lib/page-copy-composer'
import { MODE_HOLD_NOTE } from '@/lib/guide-list'
import { buildBrief, GUESSED_PROPERTY_NOTE, getGuidePublishMode, getGuideCaps, isGuessedPropertyNote } from '@/lib/guide-run'
import { checkCadence, guideCadenceKey, guideLimits, recordPublish } from '@/lib/publish-cadence'
import { buildCopyBrief, getPageCopyPublishMode } from '@/lib/page-copy-run'
import { guidePath, isRetryableRejected, rejectionCountFor, type GuideCandidate, type GuideKind } from '@/lib/guides'
import { bumpRejectionCount, clearGuideFailure, readGuideFailuresChecked } from '@/lib/guide-failures'
import { healComposedCopy, healComposedGuide, healNoteOf, type Healed } from '@/lib/heal-targets'
import type { HealBudget, HealOutcome, LadderStep } from '@/lib/heal-loop'
import { SAFE_PAGE_NOTE, isSafePageNote } from '@/lib/guide-repairs'
import { pingIndexNow } from '@/lib/indexnow'
import type { ModelCall } from '@/lib/content-repair'

// Growth loop WP19: the daily heal-content step also gives the held GUIDES and held PAGE COPY a go at the heal loop
// (lib/heal-loop.ts), the same way lib/blog-reheal.ts does for blog drafts. A guide or page copy row that the quality
// gate held back (its quality_notes name the reasons) is rebuilt from the same real facts the writer had, run through
// the loop, and then one of three things happens:
//   healed     the text is saved (every change logged first, so Undo works). It is then PUBLISHED, with the publish
//              itself logged as a status edit, unless the page must stay a draft (see below);
//   rejected   the row is marked rejected_by_heal with the reasons (guides: review_state 'rejected'), and it no longer
//              uses a slot;
//   deferred   nothing could be done today (out of budget or time, the AI down): it is looked at again next time.
//
// A guide whose name was taken from a package title (isGuessedProperty, WP15/WP16) can have its TEXT healed, but it is
// NEVER published here: its note keeps the "taken from a trip title" marker, which this file refuses to publish.

/** Held guides given a go per day (still bounded by heal_loop_calls_per_day, which stops the loop when the day's calls are used). */
export const GUIDES_HEALED_PER_DAY = 6
export const COPY_HEALED_PER_DAY = 2
/** Only rows this young are looked at (older held rows were reviewed or abandoned). */
export const HEAL_DRAFT_MAX_AGE_DAYS = 30
const PER_ITEM_MS = 180_000
/** A row whose last change is more than this long after it was created was touched by a person (or a later step). */
export const PARKED_AFTER_MS = 10 * 60_000
const READ_LIMIT = 200

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const faqList = (v: unknown): { q: string; a: string }[] =>
  Array.isArray(v) ? v.filter((x): x is { q: string; a: string } => !!x && typeof (x as { q?: unknown }).q === 'string' && typeof (x as { a?: unknown }).a === 'string').map((x) => ({ q: x.q, a: x.a })) : []

export interface DraftHealResult {
  tried: number
  published: number
  healedDraft: number
  rejected: number
  deferred: number
  calls: number
  problems: string[]
  note: string
}

const emptyResult = (note = ''): DraftHealResult => ({ tried: 0, published: 0, healedDraft: 0, rejected: 0, deferred: 0, calls: 0, problems: [], note })

/** The "Rejected by heal:" prefix healNoteOf writes. A row with it is finished. */
export const REJECTED_PREFIX = 'Rejected by heal:'

/** Is this held guide or page copy row due a go at the heal loop? Pure. `modeHoldNote` is the note a clean row gets in draft
 * mode, which is not a problem to fix. */
export function isHealDraftCandidate(row: Row, now: Date, modeHoldNotes: string[], retry?: { rejections: (row: Row) => number }): boolean {
  if (row.status !== 'draft' || row.source !== 'ai') return false
  const notes = str(row.quality_notes).trim()
  if (!notes) return false
  // A draft the heal itself rejected (guides only: the caller passes `retry`) comes back under the writer's own bounds: untouched for
  // REJECTED_RETRY_DAYS and fewer than MAX_GUIDE_REJECTIONS rejections so far. A draft a person rejected never does (no heal note).
  const healRejected = row.review_state === 'rejected' || notes.startsWith(REJECTED_PREFIX)
  if (healRejected) {
    if (!retry || row.review_state !== 'rejected') return false
    if (!isRetryableRejected({ status: str(row.status), review_state: str(row.review_state), updated_at: str(row.updated_at), quality_notes: notes }, now, rejectionCountFor(retry.rejections(row)))) return false
  }
  // A guessed property name whose text was already healed waits for a person to check the name; nothing is left to heal.
  if (notes === GUESSED_PROPERTY_NOTE) return false
  if (modeHoldNotes.includes(notes)) return false
  const created = Date.parse(str(row.created_at))
  if (!Number.isFinite(created) || now.getTime() - created > HEAL_DRAFT_MAX_AGE_DAYS * 86_400_000) return false
  // A row someone edited after the writer saved it (updated_at well after created_at) may have been parked on purpose:
  // the heal leaves it alone. The writer sets both stamps within moments of each other.
  // (A heal-rejected draft was last touched by the heal itself, so it is not "parked"; its own retry rule above applies.)
  const updated = Date.parse(str(row.updated_at))
  if (!healRejected && Number.isFinite(updated) && updated - created > PARKED_AFTER_MS) return false
  return true
}

/** Which guide rows the admin script (scripts/heal-guides-now.ts) may hand to the heal. Looser than the daily runner on age, the
 * once-a-day claim and the retry bounds (an admin who runs it by hand means it), but it keeps the rules that protect a person's decision:
 * only AI-written pages; a draft with no note (a guide someone unpublished on purpose) and a draft a PERSON rejected are left alone; a
 * clean mode hold is not a problem to fix. A live guide is taken only when it is marked rejected. Pure. */
export function isNowCandidate(row: Row, modeHoldNotes: string[]): boolean {
  if (row.source !== 'ai') return false
  if (row.status === 'published') return row.review_state === 'rejected'
  const notes = str(row.quality_notes).trim()
  if (!notes || modeHoldNotes.includes(notes)) return false
  if (row.review_state === 'rejected' && !notes.startsWith(REJECTED_PREFIX)) return false
  return true
}

export function selectHealDrafts(rows: Row[], now: Date, limit: number, modeHoldNotes: string[], retry?: { rejections: (row: Row) => number }): Row[] {
  return rows
    .filter((r) => isHealDraftCandidate(r, now, modeHoldNotes, retry))
    .sort((a, b) => Date.parse(str(a.created_at)) - Date.parse(str(b.created_at)))
    .slice(0, Math.max(0, limit))
}

/** A saved guide row as the composer's guide shape, so the same gate and loop can run on it. Pure. */
export function composedGuideFromRow(row: Row): ComposedGuide {
  return {
    name: str(row.name),
    summary: str(row.summary),
    body: str(row.body),
    sections: (Array.isArray(row.sections) ? row.sections : []) as ComposedGuide['sections'],
    faq: faqList(row.faq),
    key_takeaways: strList(row.key_takeaways),
    meta_title: str(row.meta_title),
    meta_description: str(row.meta_description),
    og_title: str(row.og_title),
    og_description: str(row.og_description),
    primary_keyword: str(row.primary_keyword),
    secondary_keywords: strList(row.secondary_keywords),
    hero_query: '',
  }
}

export function composedCopyFromRow(row: Row): ComposedPageCopy {
  return {
    intro: str(row.intro),
    faq: faqList(row.faq),
    key_takeaways: strList(row.key_takeaways),
    meta_title: str(row.meta_title),
    meta_description: str(row.meta_description),
    og_title: str(row.og_title),
    og_description: str(row.og_description),
    primary_keyword: str(row.primary_keyword),
  }
}

export interface GuideBriefParts {
  ctx: GateContext
  links: { path: string; label: string }[]
}
export interface CopyBriefParts {
  ctx: CopyGateContext
  links: { path: string; label: string }[]
}

interface HealDraftOpts {
  now?: Date
  model?: ModelCall
  /** The caller's own deadline (Date.now() scale); each item gets at most PER_ITEM_MS of it. */
  deadlineMs?: number
  /** Tests inject the brief here; the default builds it from the database like the writer does. */
  guideBrief?: (row: Row, admin: SupabaseClient) => Promise<GuideBriefParts | null>
  copyBrief?: (row: Row, admin: SupabaseClient) => Promise<CopyBriefParts | null>
  limit?: number
  /** Tests (and the admin script) inject a budget; the default opens today's persistent one. */
  budget?: HealBudget
}

async function defaultGuideBrief(row: Row, admin: SupabaseClient): Promise<GuideBriefParts | null> {
  const cand: GuideCandidate = { kind: str(row.kind) as GuideKind, name: str(row.name), slug: str(row.slug), parent_slug: str(row.parent_slug) || null, origin: 'seed' }
  const built = await buildBrief(admin, cand)
  return {
    ctx: { grounding: groundingText(built.brief), allowedPaths: built.allowedPaths, names: [...(built.brief.parentName ? [built.brief.parentName] : []), ...built.brief.links.map((l) => l.label)] },
    links: built.brief.links,
  }
}

async function defaultCopyBrief(row: Row, admin: SupabaseClient): Promise<CopyBriefParts | null> {
  const built = await buildCopyBrief(admin, { path: str(row.path), type: str(row.page_type) as 'compare' | 'best-time' })
  if (!built) return null
  const brief = built.brief
  return {
    ctx: { grounding: copyGroundingText(brief), destinations: brief.destinations.map((d) => d.name), names: brief.links.map((l) => l.label), allowedPaths: built.allowedPaths },
    links: brief.links,
  }
}

/** Adds the "nobody changed this row since I read it" condition to an update. A row whose updated_at changed (an admin edited
 * or published it while the loop was running) matches nothing, so the heal never overwrites a person's edit. */
function guarded<T extends { eq: (c: string, v: unknown) => T; is: (c: string, v: null) => T }>(q: T, expectedUpdatedAt: unknown): T {
  return expectedUpdatedAt ? q.eq('updated_at', expectedUpdatedAt) : q.is('updated_at', null)
}

/** Logs the publish, then makes it. No audit row, no publish. Returns an error text, or null when it worked. */
async function publishLogged(admin: SupabaseClient, table: 'guides' | 'page_copy', type: 'guide' | 'page_copy', row: Row, path: string, textEditIds: string[], now: Date, expectedUpdatedAt: unknown, note: string | null = null): Promise<string | null> {
  const id = str(row.id)
  const reason = note && isSafePageNote(note) ? 'the heal rebuilt the page as a safe page (only stored facts) that passes the full publish gate, so it published it' : 'the text now passes the full publish gate and the independent QA review, so the heal published it'
  const statusEdit: ContentEdit = { content_type: type, content_id: id, path, field: 'status', reason, before: 'draft', after: 'published', method: 'fixer', published_after: true, cost_usd: 0 }
  const logged = await insertEdits(admin, [statusEdit])
  if (logged.error) return `the publish could not be logged (${logged.error})${/check constraint/i.test(logged.error) ? '; apply migration 0043' : ''}`
  // A row a person or the heal had marked rejected is no longer rejected once it is live.
  const clearRejected = table === 'guides' && !!row.review_state ? { review_state: null } : {}
  const { data, error } = await guarded(admin.from(table).update({ status: 'published', quality_notes: note, ...clearRejected, updated_at: now.toISOString() }).eq('id', id).eq('status', 'draft'), expectedUpdatedAt).select('id')
  if (error || !data?.length) {
    await deleteEdits(admin, logged.ids).catch(() => undefined)
    return error ? `could not publish (${error.message})` : 'it was published, changed or removed by someone else meanwhile'
  }
  await finalizeEdits(admin, [...textEditIds, ...logged.ids], { id, path, published: true })
  return null
}

function sectionsColumns(f: ComposedGuide): Row {
  return { summary: f.summary, body: f.body, sections: f.sections, faq: f.faq, key_takeaways: f.key_takeaways, meta_title: f.meta_title || null, meta_description: f.meta_description || null, og_title: f.og_title || null, og_description: f.og_description || null }
}

export type GuideRowAction = 'published' | 'healed_draft' | 'healed_live' | 'rejected' | 'deferred' | 'clean' | 'skipped' | 'failed'

export interface GuideRowResult {
  path: string
  kind: string
  slug: string
  action: GuideRowAction
  /** The heal loop's own status when it ran. */
  status: HealOutcome['status'] | 'not_run'
  ladder: LadderStep[]
  rounds: number
  calls: number
  note: string
  problems: string[]
}

/** Read-only: the gate's current blockers for one saved guide row, and whether its name was guessed from a trip title (so it could never
 * be published by the heal). Rebuilds the facts from the database like the heal does; makes no AI call and writes nothing. Never throws. */
export async function describeGuideRow(admin: SupabaseClient, row: Row, opts: { guideBrief?: HealDraftOpts['guideBrief'] } = {}): Promise<{ blockers: string[]; guessed: boolean; error: string | null }> {
  const guessed = isGuessedPropertyNote(str(row.quality_notes))
  try {
    const parts = await (opts.guideBrief ?? defaultGuideBrief)(row, admin)
    if (!parts) return { blockers: [], guessed, error: 'could not rebuild its facts' }
    return { blockers: guideBlockers(composedGuideFromRow(row), parts.ctx), guessed, error: null }
  } catch (e) {
    return { blockers: [], guessed, error: e instanceof Error ? e.message : 'unknown error' }
  }
}

/** The production path for ONE saved guide row: rebuild its facts, run the heal loop, save the result exactly as the daily runner does
 * (every change logged to content_edits first so Undo works, then the status change). Used by healHeldGuides and by
 * scripts/heal-guides-now.ts, so the two can never drift. `skipClaim` lifts only the once-a-day claim (an admin who runs it by hand
 * means it); everything else, including the guessed-name rule (such a guide is never published here), is unchanged. A published row
 * (a guide marked rejected that is already live) gets the healed text and its rejected flag cleared; no status change is made.
 * Counters are added to `out` when given. Never throws. */
export async function healGuideRow(
  admin: SupabaseClient,
  row: Row,
  opts: { now?: Date; model?: ModelCall; deadlineMs?: number; guideBrief?: HealDraftOpts['guideBrief']; budget?: HealBudget; skipClaim?: boolean },
  out: DraftHealResult = emptyResult(),
): Promise<GuideRowResult> {
  const now = opts.now ?? new Date()
  const kind = str(row.kind) as GuideKind
  const slug = str(row.slug)
  const path = guidePath(kind, slug)
  const base: GuideRowResult = { path, kind, slug, action: 'skipped', status: 'not_run', ladder: [], rounds: 0, calls: 0, note: '', problems: [] }
  try {
    if (!opts.skipClaim && !(await claimDailyOnce(admin, `heal:guide:${kind}:${slug}`, now))) return { ...base, note: 'already tried today' }
    out.tried++
    const parts = await (opts.guideBrief ?? defaultGuideBrief)(row, admin)
    if (!parts) {
      out.problems.push(`${path}: could not rebuild its facts`)
      return { ...base, action: 'failed', note: 'could not rebuild its facts', problems: ['could not rebuild its facts'] }
    }
    const guide = composedGuideFromRow(row)
    const guessed = isGuessedPropertyNote(str(row.quality_notes))
    const blockers = guideBlockers(guide, parts.ctx)
    // A gate-clean row (stale held reasons) still goes past the independent judge before it can go live.
    const healed: Healed<ComposedGuide> = await healComposedGuide(admin, guide, parts.ctx, {
      kind,
      slug,
      path,
      links: parts.links,
      now,
      model: opts.model,
      budget: opts.budget,
      requireJudge: blockers.length === 0,
      deadlineMs: Math.min(Date.now() + PER_ITEM_MS, opts.deadlineMs ?? Number.MAX_SAFE_INTEGER),
    })
    out.calls += healed.outcome.calls
    const before = { ...out, problems: [...out.problems] }
    const action = await applyHealedRow(admin, 'guides', 'guide', row, path, healed.outcome, healed.logIds, healed.outcome.status === 'healed' ? sectionsColumns(healed.value) : null, guessed, now, out, (note) => ({ quality_notes: note, review_state: 'rejected' }), GUESSED_PROPERTY_NOTE)
    // A draft that was already rejected and is rejected again uses up one of its bounded retries (same counter the writer uses).
    if (action === 'rejected' && row.review_state === 'rejected') await bumpRejectionCount(admin, `${kind}:${slug}`, { name: str(row.name), kind, reason: 'a rejected draft was healed again and rejected again' }).catch(() => undefined)
    return {
      ...base,
      action,
      status: healed.outcome.status,
      ladder: healed.outcome.ladder,
      rounds: healed.outcome.rounds,
      calls: healed.outcome.calls,
      note: healed.outcome.note,
      problems: out.problems.slice(before.problems.length),
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : 'unknown error'
    out.problems.push(`${path}: ${why}`)
    return { ...base, action: 'failed', note: why, problems: [why] }
  }
}

/** Gives held guides their go at the heal loop. Never throws. */
export async function healHeldGuides(admin: SupabaseClient, opts: HealDraftOpts = {}): Promise<DraftHealResult> {
  const out = emptyResult()
  const now = opts.now ?? new Date()
  try {
    if ((await getGuidePublishMode(admin)) !== 'publish') return { ...out, note: 'held guides not re-checked (guides are not in publish mode)' }
    if (await isAutomationPaused(admin)) return { ...out, note: 'held guides not re-checked (automation is paused)' }
    if (!(await editsLoggable(admin))) return { ...out, problems: ['held guides not re-checked: apply migration 0033'], note: 'held guides not re-checked' }
    const { data, error } = await admin.from('guides').select('*').eq('status', 'draft').eq('source', 'ai').order('created_at', { ascending: true }).limit(READ_LIMIT)
    if (error) return { ...out, problems: [`could not read the guides (${error.message})`], note: 'held guides not re-checked' }
    // Rejected-by-heal drafts are eligible again under the writer's bounds (2 days quiet, at most MAX_GUIDE_REJECTIONS). If the counter
    // cannot be read they stay out: fail closed, so an unreadable counter can never mean unlimited retries.
    const counted = await readGuideFailuresChecked(admin)
    const retry = counted.error ? undefined : { rejections: (row: Row) => counted.failures[`${str(row.kind)}:${str(row.slug)}`]?.n ?? 0 }
    const picks = selectHealDrafts((data ?? []) as Row[], now, opts.limit ?? GUIDES_HEALED_PER_DAY, [MODE_HOLD_NOTE], retry)
    if (!picks.length) return { ...out, note: 'no held guides waiting' }

    // The shared publishing limiter (lib/publish-cadence.ts): a held guide that could go live is only given its go (and its AI spend)
    // when a slot is free under guides_per_day / guides_per_week (rolling) and the 90 minute gap. Otherwise it stays a draft and is
    // looked at again on the next run: deferred, never rejected. A guide whose name was guessed from a trip title is never published
    // here, so it does not need a slot.
    const limits = guideLimits(await getGuideCaps(admin))
    let waitNote = ''
    for (const [i, row] of picks.entries()) {
      if (!isGuessedPropertyNote(str(row.quality_notes))) {
        const slot = await checkCadence(admin, 'guide', limits, now)
        if (!slot.allowed) {
          // Everything after this one needs the same slot, so stop here: nothing is claimed for today and no AI call is made.
          out.deferred += picks.length - i
          waitNote = slot.note
          break
        }
      }
      const r = await healGuideRow(admin, row, { now, model: opts.model, deadlineMs: opts.deadlineMs, guideBrief: opts.guideBrief, budget: opts.budget }, out)
      // A safe page is kept out of search (noindex, no sitemap entry), so it is not announced either.
      if (r.action === 'published' && !r.ladder.includes('safe-page')) await pingIndexNow([r.path, '/sitemap.xml']).catch(() => undefined)
    }
    out.note = `held guides: ${out.tried} re-checked, ${out.published} published, ${out.healedDraft} healed but kept as drafts, ${out.rejected} rejected, ${out.deferred} waiting${waitNote ? ` (publishing slot: ${waitNote})` : ''}`
    return out
  } catch (e) {
    return { ...out, problems: [...out.problems, `held guides re-check failed: ${e instanceof Error ? e.message : 'unknown error'}`], note: out.note || 'held guides re-check failed' }
  }
}

/** Gives held page copy its go at the heal loop. Never throws. */
export async function healHeldCopy(admin: SupabaseClient, opts: HealDraftOpts = {}): Promise<DraftHealResult> {
  const out = emptyResult()
  const now = opts.now ?? new Date()
  try {
    if ((await getPageCopyPublishMode(admin)) !== 'publish') return { ...out, note: 'held page copy not re-checked (page copy is not in publish mode)' }
    if (await isAutomationPaused(admin)) return { ...out, note: 'held page copy not re-checked (automation is paused)' }
    if (!(await editsLoggable(admin))) return { ...out, problems: ['held page copy not re-checked: apply migration 0033'], note: 'held page copy not re-checked' }
    const { data, error } = await admin.from('page_copy').select('*').eq('status', 'draft').eq('source', 'ai').order('created_at', { ascending: true }).limit(READ_LIMIT)
    if (error) return { ...out, problems: [`could not read the page copy (${error.message})`], note: 'held page copy not re-checked' }
    const picks = selectHealDrafts((data ?? []) as Row[], now, opts.limit ?? COPY_HEALED_PER_DAY, ['held for review (page_copy_publish_mode=draft)'])
    if (!picks.length) return { ...out, note: 'no held page copy waiting' }

    for (const row of picks) {
      const path = str(row.path)
      if (!(await claimDailyOnce(admin, `heal:page_copy:${path}`, now))) continue
      out.tried++
      const parts = await (opts.copyBrief ?? defaultCopyBrief)(row, admin)
      if (!parts) {
        out.problems.push(`${path}: its page is gone or its facts could not be rebuilt`)
        continue
      }
      const copy = composedCopyFromRow(row)
      const blockers = pageCopyBlockers(copy, parts.ctx)
      const healed: Healed<ComposedPageCopy> = await healComposedCopy(admin, copy, parts.ctx, { path, links: parts.links, now, model: opts.model, requireJudge: blockers.length === 0, deadlineMs: Math.min(Date.now() + PER_ITEM_MS, opts.deadlineMs ?? Number.MAX_SAFE_INTEGER) })
      out.calls += healed.outcome.calls
      const v = healed.value
      const columns: Row | null =
        healed.outcome.status === 'healed'
          ? { intro: v.intro, linked_slugs: linkedPackageSlugs(v.intro), faq: v.faq, key_takeaways: v.key_takeaways, meta_title: v.meta_title || null, meta_description: v.meta_description || null, og_title: v.og_title || null, og_description: v.og_description || null }
          : null
      await applyHealedRow(admin, 'page_copy', 'page_copy', row, path, healed.outcome, healed.logIds, columns, false, now, out, (note) => ({ quality_notes: note }), '')
      if (out.published && healed.outcome.status === 'healed') await pingIndexNow([path, '/sitemap.xml']).catch(() => undefined)
    }
    out.note = `held page copy: ${out.tried} re-checked, ${out.published} published, ${out.rejected} rejected, ${out.deferred} waiting`
    return out
  } catch (e) {
    return { ...out, problems: [...out.problems, `held page copy re-check failed: ${e instanceof Error ? e.message : 'unknown error'}`], note: out.note || 'held page copy re-check failed' }
  }
}

/** Saves what the heal decided for one row (see the file comment). `columns` is the healed text, or null when nothing was healed.
 * Returns what happened to the row. A row that is already live (a published guide marked rejected) gets the healed text and loses its
 * rejected flag, with no status change. A healed safe page is published with the safe-page note in quality_notes. */
async function applyHealedRow(
  admin: SupabaseClient,
  table: 'guides' | 'page_copy',
  type: 'guide' | 'page_copy',
  row: Row,
  path: string,
  outcome: HealOutcome,
  logIds: string[],
  columns: Row | null,
  guessed: boolean,
  now: Date,
  out: DraftHealResult,
  rejectedPatch: (note: string) => Row,
  guessedNote: string,
): Promise<GuideRowAction> {
  const id = str(row.id)
  const stamp = { updated_at: now.toISOString() }
  const rowStatus = str(row.status) || 'draft'
  const safeNote = outcome.status === 'healed' && outcome.ladder.includes('safe-page') ? SAFE_PAGE_NOTE : null
  if (outcome.status === 'deferred') {
    // Not a failure: the heal could not reach it today (out of budget or time, the AI down). It is tried again.
    out.deferred++
    return 'deferred'
  }
  if (outcome.status === 'rejected_by_heal') {
    out.rejected++
    const patch = rejectedPatch([healNoteOf(outcome), guessed ? guessedNote : ''].filter(Boolean).join('; '))
    let { error } = await guarded(admin.from(table).update({ ...patch, ...stamp }).eq('id', id), row.updated_at)
    // Until migration 0041 is applied a guide has no review_state column: the note and the rejected list still say it.
    if (error && 'review_state' in patch && /review_state|column|schema cache/i.test(error.message)) {
      const { review_state: _drop, ...rest } = patch
      void _drop
      ;({ error } = await guarded(admin.from(table).update({ ...rest, ...stamp }).eq('id', id), row.updated_at))
    }
    if (error) {
      out.problems.push(`${path}: could not mark it rejected (${error.message})`)
      return 'failed'
    }
    return 'rejected'
  }
  // A live guide is never replaced by the generic safe page (it would lose its real text and drop out of the index): leave it as it was.
  if (safeNote && rowStatus === 'published') {
    await deleteEdits(admin, logIds).catch(() => undefined)
    out.deferred++
    return 'deferred'
  }
  // healed, or already clean
  let expected: unknown = row.updated_at
  if (outcome.status === 'healed' && columns) {
    const { data, error } = await guarded(admin.from(table).update({ ...columns, ...stamp }).eq('id', id).eq('status', rowStatus), expected).select('id')
    if (error || !data?.length) {
      // Nothing was written: take the audit rows back. Zero rows means a person changed or published the row meanwhile: skip it.
      await deleteEdits(admin, logIds).catch(() => undefined)
      out.problems.push(error ? `${path}: could not save the healed text (${error.message})` : `${path}: changed by someone else while the heal was working, so the heal left it alone`)
      return 'failed'
    }
    expected = stamp.updated_at
  }
  const clearRejected = table === 'guides' && row.review_state ? { review_state: null } : {}
  if (guessed) {
    // A name taken from a trip title is never published by the heal; the text is better, the page still waits for a person to check the name.
    if (outcome.status === 'healed') {
      await guarded(admin.from(table).update({ quality_notes: guessedNote, ...clearRejected, ...stamp }).eq('id', id), expected)
      await finalizeEdits(admin, logIds, { id, path, published: false })
      out.healedDraft++
      return 'healed_draft'
    }
    return 'clean'
  }
  if (rowStatus === 'published') {
    // Already live (a published guide that was marked rejected): the healed text is saved above; the rejected flag goes.
    await guarded(admin.from(table).update({ quality_notes: safeNote, ...clearRejected, ...stamp }).eq('id', id), expected)
    await finalizeEdits(admin, logIds, { id, path, published: true })
    out.healedDraft++
    return 'healed_live'
  }
  const problem = await publishLogged(admin, table, type, row, path, logIds, now, expected, safeNote)
  if (problem) {
    out.problems.push(`${path}: ${problem}`)
    // The text repair (if any) is real and stays; the page just is not published this time.
    if (outcome.status === 'healed') {
      await finalizeEdits(admin, logIds, { id, path, published: false })
      out.healedDraft++
      return 'healed_draft'
    }
    return 'failed'
  }
  out.published++
  // A guide that is live no longer "could not be written": drop its old failure record so the warning clears.
  if (table === 'guides') await clearGuideFailure(admin, `${str(row.kind)}:${str(row.slug)}`).catch(() => undefined)
  // The go-live time for the shared publishing limiter (lib/publish-cadence.ts). Page copy has no limiter.
  if (table === 'guides') await recordPublish(admin, 'guide', guideCadenceKey(str(row.kind), str(row.slug)), now)
  return 'published'
}
