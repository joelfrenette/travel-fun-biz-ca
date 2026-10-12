import type { SupabaseClient } from '@supabase/supabase-js'
import type { ComposedPost, PublishGateContext } from '@/lib/blog-composer'
import type { ComposedGuide, GateContext } from '@/lib/guide-composer'
import type { ComposedPageCopy, CopyGateContext } from '@/lib/page-copy-composer'
import type { ModelCall } from '@/lib/content-repair'
import { buildCopyItem, buildGuideItem, buildPostItem, copyFrom, guideFrom, postFields, postFrom } from '@/lib/content-repair-adapters'
import { deleteEdits } from '@/lib/content-edits'
import { parseArticle } from '@/lib/guide-composer'
import { healItem, type HealBudget, type HealOutcome, type HealTarget } from '@/lib/heal-loop'

// Growth loop WP19: connects the shared heal loop (lib/heal-loop.ts) to the three kinds of page it heals, in the same
// shape as the repair wrappers in lib/content-repair-adapters.ts. Each wrapper takes the composed object, runs the loop
// with the kind's own gate as the law, and hands back the healed object. Nothing here publishes anything: the caller
// decides that, after reading `outcome.status`.

export interface Healed<T> {
  /** The healed object when outcome.status is 'healed'; otherwise the object that came in, unchanged. */
  value: T
  outcome: HealOutcome
  /** Audit rows to point at the saved page with finalizeEdits(). Empty unless the text changed. */
  logIds: string[]
}

interface CommonOpts {
  model?: ModelCall
  deadlineMs?: number
  now?: Date
  budget?: HealBudget
  /** The independent judge must pass the text even when the gate is already clean (a held row that may have been parked by a person). */
  requireJudge?: boolean
}

// ---- posts ----

export async function healComposedPost(
  admin: SupabaseClient,
  post: ComposedPost,
  now: Date,
  ctx: PublishGateContext,
  opts: CommonOpts & {
    storedBody?: (body: string) => string
    /** Ladder (c): write the whole post again with these failure reasons as constraints. */
    regenerate?: (reasons: string[]) => Promise<ComposedPost | null>
    /** True for a post that is already saved: its address must not change when the title does. */
    keepSlug?: boolean
  } = {},
): Promise<Healed<ComposedPost>> {
  const item = buildPostItem(post, now, ctx, { storedBody: opts.storedBody })
  const target: HealTarget = {
    type: 'post',
    key: `post:${post.slug}`,
    path: `/blog/${post.slug}`,
    item,
    brief: ctx.groundingText ?? '',
    regenerateWhole: opts.regenerate
      ? async (reasons) => {
          const fresh = await opts.regenerate!(reasons)
          return fresh ? postFields(fresh) : null
        }
      : undefined,
  }
  const run = await healItem(admin, target, { model: opts.model, deadlineMs: opts.deadlineMs ?? ctx.deadlineMs, now: opts.now ?? now, budget: opts.budget, requireJudge: opts.requireJudge })
  if (run.outcome.status !== 'healed') return { value: post, outcome: run.outcome, logIds: run.logIds }
  const next = postFrom(post, run.outcome.fields)
  if (opts.keepSlug) next.slug = post.slug
  return { value: next, outcome: run.outcome, logIds: run.logIds }
}

// ---- guides ----

export async function healComposedGuide(
  admin: SupabaseClient,
  guide: ComposedGuide,
  gateCtx: GateContext,
  opts: CommonOpts & { kind: string; slug: string; path: string; links: { path: string; label: string }[] },
): Promise<Healed<ComposedGuide>> {
  const item = buildGuideItem(guide, gateCtx, { path: opts.path, links: opts.links })
  const target: HealTarget = { type: 'guide', key: `guide:${opts.kind}:${opts.slug}`, path: opts.path, item, brief: gateCtx.grounding }
  const run = await healItem(admin, target, { model: opts.model, deadlineMs: opts.deadlineMs, now: opts.now, budget: opts.budget, requireJudge: opts.requireJudge })
  if (run.outcome.status !== 'healed') return { value: guide, outcome: run.outcome, logIds: run.logIds }
  // A healed body that no longer splits into sections would leave the saved sections out of step with the text: undo it.
  if (!parseArticle(`${run.outcome.fields.summary ?? guide.summary}\n\n${run.outcome.fields.body}`)) {
    await deleteEdits(admin, run.logIds)
    return {
      value: guide,
      outcome: { ...run.outcome, status: 'rejected_by_heal', fields: item.fields, edits: [], reasons: ['the healed text no longer split into sections'], note: 'the healed text no longer split into sections' },
      logIds: [],
    }
  }
  return { value: guideFrom(guide, run.outcome.fields), outcome: run.outcome, logIds: run.logIds }
}

// ---- compare and best-time page copy ----

export async function healComposedCopy(
  admin: SupabaseClient,
  copy: ComposedPageCopy,
  gateCtx: CopyGateContext,
  opts: CommonOpts & { path: string; links: { path: string; label: string }[] },
): Promise<Healed<ComposedPageCopy>> {
  const item = buildCopyItem(copy, gateCtx, { path: opts.path, links: opts.links })
  const target: HealTarget = { type: 'page_copy', key: `page_copy:${opts.path}`, path: opts.path, item, brief: gateCtx.grounding }
  const run = await healItem(admin, target, { model: opts.model, deadlineMs: opts.deadlineMs, now: opts.now, budget: opts.budget, requireJudge: opts.requireJudge })
  if (run.outcome.status !== 'healed') return { value: copy, outcome: run.outcome, logIds: run.logIds }
  return { value: copyFrom(copy, run.outcome.fields), outcome: run.outcome, logIds: run.logIds }
}

/** One plain sentence about a heal outcome that did not end in a publish, for notes and held-back reasons. */
export function healNoteOf(outcome: HealOutcome): string {
  if (outcome.status === 'rejected_by_heal') return `Rejected by heal: ${outcome.reasons.slice(0, 3).join('; ') || outcome.note}`
  if (outcome.status === 'deferred') return `heal waiting: ${outcome.reasons[0] ?? outcome.note}`
  return ''
}
