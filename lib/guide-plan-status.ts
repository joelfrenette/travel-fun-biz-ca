import type { SupabaseClient } from '@supabase/supabase-js'
import { companyCandidatesFromSuppliers, planStatusRows, summarizePlan, type CompanyCandidate, type PlanStatusRow, type PlanSummary } from '@/lib/guide-plan'

// Read-only admin views for the planned destination guides and for companies and hotels in stored package data.
// Nothing here writes, spends AI credits or changes a setting. A read that fails returns null so the admin can say
// "could not be read" instead of showing a made-up zero.

/** The owner's do-not-recreate list ("kind:slug" values in app_settings.guide_excluded). Null when it cannot be read. */
async function readExcluded(admin: SupabaseClient): Promise<Set<string> | null> {
  const { data, error } = await admin.from('app_settings').select('value').eq('key', 'guide_excluded').maybeSingle()
  if (error) return null
  try {
    const list = (data as { value: string | null } | null)?.value ? JSON.parse(String((data as { value: string }).value)) : []
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return null
  }
}

/** The status of every planned destination guide plus the totals, or null when the guides table cannot be read. */
export async function readPlanStatus(admin: SupabaseClient): Promise<{ rows: PlanStatusRow[]; summary: PlanSummary } | null> {
  try {
    const [{ data, error }, excluded] = await Promise.all([admin.from('guides').select('kind, slug, status').eq('kind', 'destinations'), readExcluded(admin)])
    if (error || !excluded) return null
    const rows = planStatusRows((data ?? []) as { kind: string; slug: string; status: string | null }[], excluded)
    return { rows, summary: summarizePlan(rows) }
  } catch {
    return null
  }
}

export interface UnguidedCompanies {
  /** Cruise lines, river cruise lines, hotels and resorts named in the supplier field of published packages that have no guide yet. */
  candidates: CompanyCandidate[]
  /** Supplier names whose own words do not say what they are (tour operators and brands): shown for a person to decide, never written. */
  unmapped: string[]
}

/** Companies and hotels found in published packages (the `supplier` field) that have no guide yet. Read only. Null when it cannot be read. */
export async function listUnguidedCompanies(admin: SupabaseClient): Promise<UnguidedCompanies | null> {
  try {
    const [pkgs, guides, excluded] = await Promise.all([
      admin.from('travel_packages').select('name, supplier, destination, category').eq('status', 'published'),
      admin.from('guides').select('kind, slug'),
      readExcluded(admin),
    ])
    if (pkgs.error || guides.error || !excluded) return null
    const have = new Set([...((guides.data ?? []) as { kind: string; slug: string }[]).map((g) => `${g.kind}:${g.slug}`), ...excluded])
    const found = companyCandidatesFromSuppliers((pkgs.data ?? []) as { name: string | null; supplier: string | null; destination: string | null; category: string | null }[])
    return { candidates: found.candidates.filter((c) => !have.has(`${c.kind}:${c.slug}`)), unmapped: found.unmapped }
  } catch {
    return null
  }
}
