// The SEO / AEO / GEO playbook: ONE list of best-practice steps for any site that auto-blogs, ordered by impact.
// This file is the single source of truth. scripts/export-seo-playbook.ts writes playbook.json and
// docs/seo-playbook/PLAYBOOK.md from it, so the same list can be copied into the shared autoblogging hub and other projects.
//
// Portable: this file and the lib/seo-playbook-*.ts data files import nothing from the rest of the app.
// Item ids are permanent: ticks, notes and audit results are keyed by id, so never reuse or rename one.
import { CATEGORIES, CATEGORY_LABELS, type Category, type PlaybookItem } from './seo-playbook-types'
import { ITEMS_A } from './seo-playbook-items-a'
import { ITEMS_B } from './seo-playbook-items-b'
import { ITEMS_C } from './seo-playbook-items-c'

export { CATEGORIES, CATEGORY_LABELS }
export type { Category, PlaybookItem, Automation, AppliesTo, Source } from './seo-playbook-types'

const RAW: PlaybookItem[] = [...ITEMS_A, ...ITEMS_B, ...ITEMS_C]

/** Ordered by category (the order above), then impact (biggest first), then effort (easiest first), then the order written. */
export function sortPlaybook(items: readonly PlaybookItem[]): PlaybookItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => CATEGORIES.indexOf(a.item.category) - CATEGORIES.indexOf(b.item.category) || b.item.impact - a.item.impact || a.item.effort - b.item.effort || a.i - b.i)
    .map((x) => x.item)
}

export const PLAYBOOK: PlaybookItem[] = sortPlaybook(RAW)

export function playbookById(): Map<string, PlaybookItem> {
  return new Map(PLAYBOOK.map((p) => [p.id, p]))
}

export function countByCategory(items: readonly PlaybookItem[] = PLAYBOOK): Record<Category, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
  for (const p of items) out[p.category]++
  return out
}

/** What a risky tactic looks like by its title. Every such item must carry a caution (scripts/check-seo-playbook.ts). */
export const RISKY_TITLE_RE = /(doorway|nearby cit|programmatic|guest post|director|digital pr|never buy|link exchange|service area|wikipedia|reddit|google review|rating markup|AI-written|testimonial|GPTBot)/i

// ---------------------------------------------------------------------------------------------------
// Status and score (pure; used by the admin page, the cron and the Today helper)
// ---------------------------------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown'
export type ItemStatus = CheckStatus | 'manual' | 'manual-done'

export interface CheckResult {
  status: CheckStatus
  evidence: string
  fixHint: string
}

export interface TickState {
  done: boolean
  note?: string
  at?: string
}

/** This site's kind of business: items for other kinds are listed but not scored. */
export const SITE_APPLIES: readonly string[] = ['all auto-blog sites', 'local business', 'travel']

export function appliesHere(item: PlaybookItem): boolean {
  return SITE_APPLIES.includes(item.appliesTo)
}

/** The status shown for one item. A check that has not run, or could not be read, is "unknown", never a pass. */
export function itemStatus(item: PlaybookItem, audit: Record<string, CheckResult | undefined>, ticks: Record<string, TickState | undefined>): ItemStatus {
  const tick = ticks[item.id]
  if (item.verify.kind === 'check' && item.verify.checkId) {
    const r = audit[item.verify.checkId]
    // A check that could not read anything may be confirmed by hand. A fail or warn is never overridden by a tick.
    if (r && !(r.status === 'unknown' && tick?.done)) return r.status
    return tick?.done ? 'manual-done' : 'unknown'
  }
  return tick?.done ? 'manual-done' : 'manual'
}

const POINTS: Record<ItemStatus, number> = { pass: 1, 'manual-done': 1, warn: 0.5, fail: 0, unknown: 0, manual: 0 }

/** Weighted by impact. Unknown and not-yet-done count as zero: a score is only earned by something shown to be true. 0 to 100. */
export function scoreOf(items: readonly PlaybookItem[], status: (item: PlaybookItem) => ItemStatus): number {
  let got = 0
  let total = 0
  for (const p of items) {
    if (!appliesHere(p)) continue
    total += p.impact
    got += p.impact * POINTS[status(p)]
  }
  return total === 0 ? 0 : Math.round((got / total) * 100)
}

export function needsMe(s: ItemStatus): boolean {
  return s !== 'pass' && s !== 'manual-done'
}
