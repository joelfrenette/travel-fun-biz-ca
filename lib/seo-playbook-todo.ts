import type { SupabaseClient } from '@supabase/supabase-js'
import { loadView, type SeoView, type ViewItem } from '@/lib/seo-playbook-view'

// Candidates for a Today card of kind 'seo-fix': the highest-impact items the audit shows as FAILING (not warnings,
// not unknown). The card registry in lib/today-cards.ts is not part of this branch's base; the orchestrator wires
// 'seo-fix' with the actions 'Do it' (open `href`) and 'Later' (snooze 7 days) when that file exists.

export const SEO_FIX_MIN_IMPACT = 4
export const SEO_FIX_MAX = 3

export interface SeoFixCandidate {
  id: string
  title: string
  why: string
  hint: string
  impact: number
  effort: number
  /** Where "Do it" goes: the admin page that fixes it, else the item on the manager page. */
  href: string
}

export function topSeoFixes(items: readonly ViewItem[], max = SEO_FIX_MAX): SeoFixCandidate[] {
  return items
    .filter((p) => p.status === 'fail' && p.scored && p.impact >= SEO_FIX_MIN_IMPACT)
    .sort((a, b) => b.impact - a.impact || a.effort - b.effort || a.id.localeCompare(b.id))
    .slice(0, max)
    .map((p) => ({ id: p.id, title: p.title, why: p.why, hint: p.fixHint || p.how[0] || '', impact: p.impact, effort: p.effort, href: p.fixHref ?? `/admin/seo-manager#${p.id}` }))
}

export function seoFixesFromView(view: SeoView, max = SEO_FIX_MAX): SeoFixCandidate[] {
  return topSeoFixes(view.items, max)
}

/** For the Today builder. Never throws: an unreadable audit gives no candidates. */
export async function readSeoFixCandidates(admin: SupabaseClient, max = SEO_FIX_MAX): Promise<SeoFixCandidate[]> {
  try {
    return seoFixesFromView(await loadView(admin), max)
  } catch {
    return []
  }
}
