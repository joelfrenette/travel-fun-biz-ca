import type { SupabaseClient } from '@supabase/supabase-js'
import { CATEGORIES, CATEGORY_LABELS, PLAYBOOK, appliesHere, itemStatus, needsMe, scoreOf, sortPlaybook, type Category, type CheckResult, type ItemStatus, type PlaybookItem } from '@/lib/seo-playbook'
import { readAudit, type AuditView } from '@/lib/seo-playbook-audit'
import { readCustom, readTicks, tipToItem, type CustomTip, type TickMap } from '@/lib/seo-playbook-store'

// What the SEO and GEO Manager page shows: every item with its current status, plus a score per category and overall.
// buildView is pure (the test feeds it fixtures); loadView reads the stored audit, ticks and pasted tips.

export interface ViewItem extends PlaybookItem {
  status: ItemStatus
  evidence: string
  fixHint: string
  done: boolean
  note: string
  custom: boolean
  scored: boolean
  needsMe: boolean
}

export interface CategorySummary {
  id: Category
  label: string
  count: number
  score: number
}

export interface SeoView {
  auditAt: string | null
  auditMs: number
  overall: number
  total: number
  counts: Record<ItemStatus, number>
  categories: CategorySummary[]
  items: ViewItem[]
  customCount: number
}

export function buildView(audit: AuditView, ticks: TickMap, custom: CustomTip[]): SeoView {
  const items = sortPlaybook([...PLAYBOOK, ...custom.map(tipToItem)])
  const customIds = new Set(custom.map((c) => c.id))
  const results: Record<string, CheckResult | undefined> = audit.results
  const status = (p: PlaybookItem) => itemStatus(p, results, ticks)
  const counts: Record<ItemStatus, number> = { pass: 0, warn: 0, fail: 0, unknown: 0, manual: 0, 'manual-done': 0 }
  const view: ViewItem[] = items.map((p) => {
    const s = status(p)
    counts[s]++
    const r = p.verify.kind === 'check' && p.verify.checkId ? results[p.verify.checkId] : undefined
    return {
      ...p,
      status: s,
      evidence: r?.evidence ?? '',
      fixHint: r?.fixHint ?? '',
      done: ticks[p.id]?.done === true,
      note: ticks[p.id]?.note ?? '',
      custom: customIds.has(p.id),
      scored: appliesHere(p),
      needsMe: needsMe(s),
    }
  })
  return {
    auditAt: audit.at,
    auditMs: audit.ms,
    overall: scoreOf(items, status),
    total: items.length,
    counts,
    categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c], count: items.filter((p) => p.category === c).length, score: scoreOf(items.filter((p) => p.category === c), status) })),
    items: view,
    customCount: custom.length,
  }
}

export async function loadView(admin: SupabaseClient): Promise<SeoView> {
  const [audit, ticks, custom] = await Promise.all([readAudit(admin), readTicks(admin), readCustom(admin)])
  return buildView(audit, ticks, custom)
}
