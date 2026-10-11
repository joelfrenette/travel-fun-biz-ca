import type { SupabaseClient } from '@supabase/supabase-js'
import { autoPublishBlockers, findOffenders, REPAIR_MIN_MS, type ComposedPost, type PublishGateContext } from '@/lib/blog-composer'
import { slugify } from '@/lib/content-dedupe'
import { guideBlockers, parseArticle, type ComposedGuide, type GateContext } from '@/lib/guide-composer'
import { META_DESCRIPTION_MAX, META_TITLE_MAX, OG_DESCRIPTION_MAX, OG_TITLE_MAX, pageCopyBlockers, type ComposedPageCopy, type CopyGateContext } from '@/lib/page-copy-composer'
import type { GuideSection } from '@/lib/guides'
import { claimRepairSlot, editsLoggable, insertEdits, recordRepairSpend, attachEdits, deleteEdits } from '@/lib/content-edits'
import {
  classifyBlockers,
  mapFields,
  stripExternalLinks,
  MIN_MS_PER_CALL,
  repairContent,
  type ContentEdit,
  type ModelCall,
  type Offender,
  type RepairFields,
  type RepairItem,
  type RepairLimits,
  type RepairResult,
} from '@/lib/content-repair'

// Connects the shared repair core (lib/content-repair.ts) to the three places content is gated when it is written:
// a blog post (lib/autoblog-run.ts), a guide (lib/guide-run.ts) and compare / best-time page copy
// (lib/page-copy-run.ts). Each wrapper turns the composed object into RepairFields, runs the kind's own gate as the
// judge, takes a daily slot, writes the audit rows BEFORE the repaired text is used ("log, then apply"), and hands
// back the repaired object. If the audit rows cannot be written, nothing is repaired: the page is blocked as before.

export interface Repaired<T> {
  value: T
  blockers: string[]
  edits: ContentEdit[]
  /** Audit row ids to point at the saved page with finalizeEdits(). */
  logIds: string[]
  calls: number
  note: string
}

/** After the page is saved: points the audit rows at it and records whether it went live. */
export async function finalizeEdits(admin: SupabaseClient, logIds: string[], saved: { id: string; path: string; published: boolean }): Promise<void> {
  await attachEdits(admin, logIds, { content_id: saved.id, path: saved.path, published_after: saved.published })
}

interface WrapOpts {
  maxCalls: number
  deadlineMs?: number
  itemKey: string
  /** Tests inject a fake model here. */
  model?: ModelCall
}

/** The shared wrapper: skip (no spend) when a HARD blocker is present, take a slot, repair, log, report. */
async function runRepair(admin: SupabaseClient, item: RepairItem, opts: WrapOpts): Promise<{ result: RepairResult; logIds: string[]; applied: boolean; note: string }> {
  const startBlockers = item.gate(item.fields)
  const untouched = (note: string, hard: string[] = []): { result: RepairResult; logIds: string[]; applied: boolean; note: string } => ({
    result: { fields: item.fields, blockers: startBlockers, hard, edits: [], calls: 0, note },
    logIds: [],
    applied: false,
    note,
  })
  if (startBlockers.length === 0) return untouched('already clean')
  // A link to another website is mended by taking the link off (the gates also flag its address as "web address in
  // text"), so the HARD check looks at the blockers that would remain after that.
  const cls = classifyBlockers(item.gate(mapFields(item.fields, stripExternalLinks)))
  if (cls.hard.length) return untouched('held for a person (a HARD blocker)', cls.hard)
  if (!(await editsLoggable(admin))) return untouched('not repaired: the content_edits table is not set up (apply migration 0033)')
  const slot = await claimRepairSlot(admin, opts.itemKey)
  if (!slot.ok) return untouched(`not repaired: ${slot.reason ?? 'no slot'}`)

  // Anything unexpected from here on leaves the page exactly as it came in (and takes back any audit rows), so a
  // repair problem can never break the write that called it.
  let loggedIds: string[] = []
  try {
    const result = await repairContent(item, { maxCalls: opts.maxCalls, deadlineMs: opts.deadlineMs, model: opts.model })
    await recordRepairSpend(admin, result.calls)
    if (result.edits.length === 0) return { result, logIds: [], applied: false, note: result.note }

    const logged = await insertEdits(admin, result.edits)
    if (logged.error) {
      // No audit row, no edit: the page is blocked exactly as it came in.
      return { result: { fields: item.fields, blockers: startBlockers, hard: [], edits: [], calls: result.calls, note: 'not repaired' }, logIds: [], applied: false, note: `not repaired: the audit log could not be written (${logged.error})` }
    }
    loggedIds = logged.ids
    return { result, logIds: logged.ids, applied: true, note: result.note }
  } catch (e) {
    await deleteEdits(admin, loggedIds).catch(() => undefined)
    return untouched(`not repaired: ${e instanceof Error ? e.message : 'unexpected error'}`)
  }
}

// ---------------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------------

const POST_LIMITS: RepairLimits = { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }

function postFields(p: ComposedPost): RepairFields {
  return {
    title: p.title,
    body: p.body,
    meta_title: p.seo_title,
    meta_description: p.seo_description,
    og_title: p.og_title ?? '',
    og_description: p.og_description ?? '',
    faq: (p.faq ?? []).map((f) => ({ ...f })),
    key_takeaways: [...(p.key_takeaways ?? [])],
  }
}

function postFrom(base: ComposedPost, f: RepairFields): ComposedPost {
  const next: ComposedPost = {
    ...base,
    title: f.title ?? base.title,
    body: f.body,
    seo_title: f.meta_title,
    seo_description: f.meta_description,
    og_title: f.og_title,
    og_description: f.og_description,
    faq: f.faq,
    key_takeaways: f.key_takeaways,
  }
  // The FAQ and takeaways were skipped for lack of time; once they exist the post is no longer short of them.
  if (next.skipped_enrich && f.faq.length >= POST_LIMITS.faqMin && f.key_takeaways.length >= POST_LIMITS.takeMin) delete next.skipped_enrich
  // The slug follows the final title (a rewritten title must not keep a slug with its old digits).
  if (next.title !== base.title) next.slug = slugify(next.title) || base.slug
  return next
}

/** The post gate plus at most ONE model call (the same limit and deadline as before), now with the shared repair:
 * plain-code fixers first, then a generated FAQ/takeaways or a reword/delete of the sentences behind a number or
 * link blocker, then the deterministic fallback. Every change is logged before it is used. `storedBody` maps the
 * body the repair sees to the body that is saved (autoblog appends its call to action on save). */
export function buildPostItem(post: ComposedPost, now: Date, ctx: PublishGateContext, opts: { storedBody?: (body: string) => string } = {}): RepairItem {
  const allowed = new Set((ctx.allowedPaths ?? []).map((p) => p.replace(/[?#].*$/, '').replace(/\/+$/, '')))
  const map = (o: ReturnType<typeof findOffenders>[number]): Offender => ({
    field: o.field === 'seo_title' ? 'meta_title' : o.field === 'seo_description' ? 'meta_description' : o.field,
    index: o.index,
    text: o.text,
    why: o.why,
    prefix: o.prefix,
  })
  return {
    type: 'post',
    id: null,
    path: `/blog/${post.slug}`,
    fields: postFields(post),
    grounding: ctx.groundingText ?? '',
    allowedPaths: allowed,
    keyword: post.primary_keyword,
    limits: POST_LIMITS,
    gate: (f) => autoPublishBlockers(postFrom(post, f), now, ctx),
    detect: (f) => findOffenders(postFrom(post, f), ctx, now).map(map),
    storedText: opts.storedBody ? (field, text) => (field === 'body' ? opts.storedBody!(text) : text) : undefined,
  }
}

export async function repairComposedPost(
  admin: SupabaseClient,
  post: ComposedPost,
  now: Date,
  ctx: PublishGateContext,
  opts: { storedBody?: (body: string) => string; model?: ModelCall } = {},
): Promise<Repaired<ComposedPost>> {
  const item = buildPostItem(post, now, ctx, opts)
  // The post path used to skip the repair call with under REPAIR_MIN_MS left; the shared check uses MIN_MS_PER_CALL.
  const deadlineMs = ctx.deadlineMs === undefined ? undefined : ctx.deadlineMs - (REPAIR_MIN_MS - MIN_MS_PER_CALL)
  const r = await runRepair(admin, item, { maxCalls: 1, deadlineMs, itemKey: `post:${post.slug}`, model: opts.model })
  if (!r.applied) return { value: post, blockers: r.result.blockers, edits: [], logIds: [], calls: r.result.calls, note: r.note }
  return { value: postFrom(post, r.result.fields), blockers: item.gate(r.result.fields), edits: r.result.edits, logIds: r.logIds, calls: r.result.calls, note: r.note }
}

// ---------------------------------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------------------------------

export const GUIDE_LIMITS: RepairLimits = { faqMin: 4, faqMax: 6, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }

export function guideFields(g: ComposedGuide): RepairFields {
  return {
    summary: g.summary,
    body: g.body,
    meta_title: g.meta_title,
    meta_description: g.meta_description,
    og_title: g.og_title,
    og_description: g.og_description,
    faq: g.faq.map((f) => ({ ...f })),
    key_takeaways: [...g.key_takeaways],
  }
}

/** The sections of a guide from its summary and body markdown; the old ones when the text no longer parses. */
export function sectionsOf(summary: string, body: string, fallback: GuideSection[]): GuideSection[] {
  return parseArticle(`${summary}\n\n${body}`)?.sections ?? fallback
}

export function guideFrom(base: ComposedGuide, f: RepairFields): ComposedGuide {
  const summary = f.summary ?? base.summary
  return {
    ...base,
    summary,
    body: f.body,
    sections: f.body === base.body && summary === base.summary ? base.sections : sectionsOf(summary, f.body, base.sections),
    meta_title: f.meta_title,
    meta_description: f.meta_description,
    og_title: f.og_title,
    og_description: f.og_description,
    faq: f.faq,
    key_takeaways: f.key_takeaways,
  }
}

export function buildGuideItem(guide: ComposedGuide, gateCtx: GateContext, opts: { path: string; links: { path: string; label: string }[] }): RepairItem {
  return {
    type: 'guide',
    id: null,
    path: opts.path,
    fields: guideFields(guide),
    grounding: gateCtx.grounding,
    names: [...(gateCtx.names ?? []), guide.name],
    allowedPaths: gateCtx.allowedPaths,
    links: opts.links,
    keyword: guide.primary_keyword,
    limits: GUIDE_LIMITS,
    gate: (f) => guideBlockers(guideFrom(guide, f), gateCtx),
  }
}

export async function repairComposedGuide(
  admin: SupabaseClient,
  guide: ComposedGuide,
  gateCtx: GateContext,
  opts: { kind: string; slug: string; path: string; links: { path: string; label: string }[]; deadlineMs?: number; model?: ModelCall },
): Promise<Repaired<ComposedGuide>> {
  const item = buildGuideItem(guide, gateCtx, opts)
  const gate = item.gate
  const r = await runRepair(admin, item, { maxCalls: 2, deadlineMs: opts.deadlineMs, itemKey: `guide:${opts.kind}:${opts.slug}`, model: opts.model })
  if (!r.applied) return { value: guide, blockers: r.result.blockers, edits: [], logIds: [], calls: r.result.calls, note: r.note }
  // A repaired body that no longer parses into sections would leave the saved sections out of step with the text: undo it.
  if (!parseArticle(`${r.result.fields.summary ?? guide.summary}\n\n${r.result.fields.body}`)) {
    await deleteEdits(admin, r.logIds)
    return { value: guide, blockers: gate(item.fields), edits: [], logIds: [], calls: r.result.calls, note: 'not repaired: the repaired text no longer split into sections' }
  }
  return { value: guideFrom(guide, r.result.fields), blockers: gate(r.result.fields), edits: r.result.edits, logIds: r.logIds, calls: r.result.calls, note: r.note }
}

// ---------------------------------------------------------------------------------------------------
// Compare and best-time page copy
// ---------------------------------------------------------------------------------------------------

export const COPY_LIMITS: RepairLimits = { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: META_TITLE_MAX, metaDescMax: META_DESCRIPTION_MAX, ogTitleMax: OG_TITLE_MAX, ogDescMax: OG_DESCRIPTION_MAX, maxBodyLinks: 3 }

export function copyFields(c: ComposedPageCopy): RepairFields {
  return {
    body: c.intro,
    meta_title: c.meta_title,
    meta_description: c.meta_description,
    og_title: c.og_title,
    og_description: c.og_description,
    faq: c.faq.map((f) => ({ ...f })),
    key_takeaways: [...c.key_takeaways],
  }
}

export function copyFrom(base: ComposedPageCopy, f: RepairFields): ComposedPageCopy {
  return {
    ...base,
    intro: f.body,
    meta_title: f.meta_title,
    meta_description: f.meta_description,
    og_title: f.og_title,
    og_description: f.og_description,
    faq: f.faq,
    key_takeaways: f.key_takeaways,
  }
}

export function buildCopyItem(copy: ComposedPageCopy, gateCtx: CopyGateContext, opts: { path: string; links: { path: string; label: string }[] }): RepairItem {
  return {
    type: 'page_copy',
    id: null,
    path: opts.path,
    fields: copyFields(copy),
    grounding: gateCtx.grounding,
    names: [...(gateCtx.names ?? []), ...gateCtx.destinations],
    allowedPaths: gateCtx.allowedPaths,
    links: opts.links,
    keyword: copy.primary_keyword,
    limits: COPY_LIMITS,
    gate: (f) => pageCopyBlockers(copyFrom(copy, f), gateCtx),
  }
}

export async function repairComposedCopy(
  admin: SupabaseClient,
  copy: ComposedPageCopy,
  gateCtx: CopyGateContext,
  opts: { path: string; links: { path: string; label: string }[]; deadlineMs?: number; model?: ModelCall },
): Promise<Repaired<ComposedPageCopy>> {
  const item = buildCopyItem(copy, gateCtx, opts)
  const gate = item.gate
  const r = await runRepair(admin, item, { maxCalls: 2, deadlineMs: opts.deadlineMs, itemKey: `page_copy:${opts.path}`, model: opts.model })
  if (!r.applied) return { value: copy, blockers: r.result.blockers, edits: [], logIds: [], calls: r.result.calls, note: r.note }
  return { value: copyFrom(copy, r.result.fields), blockers: gate(r.result.fields), edits: r.result.edits, logIds: r.logIds, calls: r.result.calls, note: r.note }
}
