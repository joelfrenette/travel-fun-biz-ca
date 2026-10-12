import type { SupabaseClient } from '@supabase/supabase-js'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { claimDailyOnce, deleteEdits, editsLoggable, insertEdits } from '@/lib/content-edits'
import { finalizeEdits } from '@/lib/content-repair-adapters'
import type { ContentEdit } from '@/lib/content-repair'
import { guideBlockers, groundingText, type ComposedGuide, type GateContext } from '@/lib/guide-composer'
import { pageCopyBlockers, copyGroundingText, linkedPackageSlugs, type ComposedPageCopy, type CopyGateContext } from '@/lib/page-copy-composer'
import { MODE_HOLD_NOTE } from '@/lib/guide-list'
import { buildBrief, GUESSED_PROPERTY_NOTE, getGuidePublishMode, isGuessedPropertyNote } from '@/lib/guide-run'
import { buildCopyBrief, getPageCopyPublishMode } from '@/lib/page-copy-run'
import { guidePath, type GuideCandidate, type GuideKind } from '@/lib/guides'
import { healComposedCopy, healComposedGuide, healNoteOf, type Healed } from '@/lib/heal-targets'
import type { HealOutcome } from '@/lib/heal-loop'
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

export const GUIDES_HEALED_PER_DAY = 2
export const COPY_HEALED_PER_DAY = 2
/** Only rows this young are looked at (older held rows were reviewed or abandoned). */
export const HEAL_DRAFT_MAX_AGE_DAYS = 30
const PER_ITEM_MS = 180_000
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

/** The outcome for a held row whose reasons are out of date: the gate is clean now, so there is nothing to heal. */
const cleanOutcome = (): HealOutcome => ({ status: 'already_clean', fields: { body: '', meta_title: '', meta_description: '', og_title: '', og_description: '', faq: [], key_takeaways: [] }, blockers: [], reasons: [], rounds: 0, ladder: [], calls: 0, judgeRuns: 0, edits: [], log: [], note: 'already clean' })

const emptyResult = (note = ''): DraftHealResult => ({ tried: 0, published: 0, healedDraft: 0, rejected: 0, deferred: 0, calls: 0, problems: [], note })

/** The "Rejected by heal:" prefix healNoteOf writes. A row with it is finished. */
export const REJECTED_PREFIX = 'Rejected by heal:'

/** Is this held guide or page copy row due a go at the heal loop? Pure. `modeHoldNote` is the note a clean row gets in draft
 * mode, which is not a problem to fix. */
export function isHealDraftCandidate(row: Row, now: Date, modeHoldNotes: string[]): boolean {
  if (row.status !== 'draft' || row.source !== 'ai') return false
  if (row.review_state === 'rejected') return false
  const notes = str(row.quality_notes).trim()
  if (!notes) return false
  if (notes.startsWith(REJECTED_PREFIX)) return false
  // A guessed property name whose text was already healed waits for a person to check the name; nothing is left to heal.
  if (notes === GUESSED_PROPERTY_NOTE) return false
  if (modeHoldNotes.includes(notes)) return false
  const created = Date.parse(str(row.created_at))
  if (!Number.isFinite(created) || now.getTime() - created > HEAL_DRAFT_MAX_AGE_DAYS * 86_400_000) return false
  return true
}

export function selectHealDrafts(rows: Row[], now: Date, limit: number, modeHoldNotes: string[]): Row[] {
  return rows
    .filter((r) => isHealDraftCandidate(r, now, modeHoldNotes))
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

/** Logs the publish, then makes it. No audit row, no publish. Returns an error text, or null when it worked. */
async function publishLogged(admin: SupabaseClient, table: 'guides' | 'page_copy', type: 'guide' | 'page_copy', row: Row, path: string, textEditIds: string[], now: Date): Promise<string | null> {
  const id = str(row.id)
  const statusEdit: ContentEdit = { content_type: type, content_id: id, path, field: 'status', reason: 'the text now passes the full publish gate and the independent QA review, so the heal published it', before: 'draft', after: 'published', method: 'fixer', published_after: true, cost_usd: 0 }
  const logged = await insertEdits(admin, [statusEdit])
  if (logged.error) return `the publish could not be logged (${logged.error})${/check constraint/i.test(logged.error) ? '; apply migration 0043' : ''}`
  const { data, error } = await admin.from(table).update({ status: 'published', quality_notes: null, updated_at: now.toISOString() }).eq('id', id).eq('status', 'draft').select('id')
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
    const picks = selectHealDrafts((data ?? []) as Row[], now, opts.limit ?? GUIDES_HEALED_PER_DAY, [MODE_HOLD_NOTE])
    if (!picks.length) return { ...out, note: 'no held guides waiting' }

    for (const row of picks) {
      const kind = str(row.kind) as GuideKind
      const slug = str(row.slug)
      const path = guidePath(kind, slug)
      if (!(await claimDailyOnce(admin, `heal:guide:${kind}:${slug}`, now))) continue
      out.tried++
      const parts = await (opts.guideBrief ?? defaultGuideBrief)(row, admin)
      if (!parts) {
        out.problems.push(`${path}: could not rebuild its facts`)
        continue
      }
      const guide = composedGuideFromRow(row)
      const guessed = isGuessedPropertyNote(str(row.quality_notes))
      const blockers = guideBlockers(guide, parts.ctx)
      let healed: Healed<ComposedGuide>
      if (blockers.length === 0) {
        // The held reasons are out of date (the text was edited, or the rules changed): nothing to heal.
        healed = { value: guide, logIds: [], outcome: cleanOutcome() }
      } else {
        healed = await healComposedGuide(admin, guide, parts.ctx, { kind, slug, path, links: parts.links, now, model: opts.model, deadlineMs: Math.min(Date.now() + PER_ITEM_MS, opts.deadlineMs ?? Number.MAX_SAFE_INTEGER) })
      }
      out.calls += healed.outcome.calls
      await applyHealedRow(admin, 'guides', 'guide', row, path, healed.outcome, healed.logIds, healed.outcome.status === 'healed' ? sectionsColumns(healed.value) : null, guessed, now, out, (note) => ({ quality_notes: note, review_state: 'rejected' }), GUESSED_PROPERTY_NOTE)
      if (out.published && healed.outcome.status === 'healed') await pingIndexNow([path, '/sitemap.xml']).catch(() => undefined)
    }
    out.note = `held guides: ${out.tried} re-checked, ${out.published} published, ${out.healedDraft} healed but kept as drafts, ${out.rejected} rejected, ${out.deferred} waiting`
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
      let healed: Healed<ComposedPageCopy>
      if (blockers.length === 0) {
        healed = { value: copy, logIds: [], outcome: cleanOutcome() }
      } else {
        healed = await healComposedCopy(admin, copy, parts.ctx, { path, links: parts.links, now, model: opts.model, deadlineMs: Math.min(Date.now() + PER_ITEM_MS, opts.deadlineMs ?? Number.MAX_SAFE_INTEGER) })
      }
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

/** Saves what the heal decided for one row (see the file comment). `columns` is the healed text, or null when nothing was healed. */
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
): Promise<void> {
  const id = str(row.id)
  const stamp = { updated_at: now.toISOString() }
  if (outcome.status === 'deferred') {
    // Not a failure: the heal could not reach it today (out of budget or time, the AI down). It is tried again.
    out.deferred++
    return
  }
  if (outcome.status === 'rejected_by_heal') {
    out.rejected++
    const patch = rejectedPatch([healNoteOf(outcome), guessed ? guessedNote : ''].filter(Boolean).join('; '))
    let { error } = await admin.from(table).update({ ...patch, ...stamp }).eq('id', id)
    // Until migration 0041 is applied a guide has no review_state column: the note and the rejected list still say it.
    if (error && 'review_state' in patch && /review_state|column|schema cache/i.test(error.message)) {
      const { review_state: _drop, ...rest } = patch
      void _drop
      ;({ error } = await admin.from(table).update({ ...rest, ...stamp }).eq('id', id))
    }
    if (error) out.problems.push(`${path}: could not mark it rejected (${error.message})`)
    return
  }
  // healed, or already clean
  if (outcome.status === 'healed' && columns) {
    const { error } = await admin.from(table).update({ ...columns, ...stamp }).eq('id', id).eq('status', 'draft')
    if (error) {
      await deleteEdits(admin, logIds).catch(() => undefined)
      out.problems.push(`${path}: could not save the healed text (${error.message})`)
      return
    }
  }
  if (guessed) {
    // A name taken from a trip title is never published by the heal; the text is better, the page still waits for a person to check the name.
    if (outcome.status === 'healed') {
      await admin.from(table).update({ quality_notes: guessedNote, ...stamp }).eq('id', id)
      await finalizeEdits(admin, logIds, { id, path, published: false })
      out.healedDraft++
    }
    return
  }
  const problem = await publishLogged(admin, table, type, row, path, logIds, now)
  if (problem) {
    out.problems.push(`${path}: ${problem}`)
    // The text repair (if any) is real and stays; the page just is not published this time.
    if (outcome.status === 'healed') {
      await finalizeEdits(admin, logIds, { id, path, published: false })
      out.healedDraft++
    }
    return
  }
  out.published++
}
