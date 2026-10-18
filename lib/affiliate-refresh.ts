import type { SupabaseClient } from '@supabase/supabase-js'
import { clearAffiliateRulesCache } from '@/lib/affiliate-rules'
import { rescanSite } from '@/lib/affiliate-usage'

// WP22: every create, edit, ON, OFF and delete of an affiliate link or a word-link rule must show on the whole site at once.
// Pages link words at display time, so nothing stored changes; what has to be refreshed is (1) the in-memory rules read of
// this server, (2) the cached pages (Incremental Static Regeneration), and (3) the usage report.

export interface RefreshDeps {
  /** Drops cached pages. Default: revalidatePath('/', 'layout') from next/cache. */
  revalidate?: () => void | Promise<void>
  /** Recomputes the usage report. Default: rescanSite. */
  rescan?: (admin: SupabaseClient) => Promise<{ ok: boolean }>
}

async function defaultRevalidate(): Promise<void> {
  const { revalidatePath } = await import('next/cache')
  revalidatePath('/', 'layout')
}

export interface RefreshResult {
  rules: true
  pages: boolean
  usage: boolean
}

/** Never throws: a failed refresh must not turn a saved change into an error. The result says what worked. */
export async function refreshAfterChange(admin: SupabaseClient, deps: RefreshDeps = {}): Promise<RefreshResult> {
  clearAffiliateRulesCache()
  let pages = false
  try {
    await (deps.revalidate ?? defaultRevalidate)()
    pages = true
  } catch {
    pages = false
  }
  let usage = false
  try {
    usage = (await (deps.rescan ?? rescanSite)(admin)).ok
  } catch {
    usage = false
  }
  return { rules: true, pages, usage }
}
