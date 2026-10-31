import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import {
  advisoryLinkForGuide,
  advisorySitemapEntries,
  buildAdvisoryView,
  buildIndexRows,
  isCountrySlug,
  type AdvisoryView,
  type IndexRow,
  type SitemapEntry,
} from '@/lib/country-advisory'
import { getAdvisoryMode, listPublishedAdvisories, readAdvisoryLog, readAdvisoryRow, readLogsBySlug } from '@/lib/country-advisory-store'

// What the PUBLIC routes read. Every function returns null / [] unless app_settings.country_advisories_mode is exactly 'on', so with the
// mode off (or log, or unreadable) no page exists, nothing is listed, and nothing is linked.

/** The page for one country, or null (a 404): mode not on, a bad slug, no row, a draft row, or a database problem. */
export async function loadAdvisoryPage(slug: string, now: Date = new Date(), client?: SupabaseClient): Promise<AdvisoryView | null> {
  if (!isCountrySlug(slug)) return null
  try {
    const admin = client ?? getSupabaseAdmin()
    if ((await getAdvisoryMode(admin)) !== 'on') return null
    const row = await readAdvisoryRow(admin, slug)
    if (!row || row.status !== 'published') return null
    return buildAdvisoryView(row, await readAdvisoryLog(admin, slug), now)
  } catch {
    return null
  }
}

/** The index, or null when the mode is not on. An empty list is a real answer (the page then says there is nothing yet and is noindex). */
export async function loadAdvisoryIndex(client?: SupabaseClient): Promise<IndexRow[] | null> {
  try {
    const admin = client ?? getSupabaseAdmin()
    if ((await getAdvisoryMode(admin)) !== 'on') return null
    const rows = await listPublishedAdvisories(admin)
    const logs = await readLogsBySlug(admin, rows.map((r) => r.slug))
    return buildIndexRows(rows, logs)
  } catch {
    return null
  }
}

/** Sitemap lines: [] unless the mode is 'on' and at least one published page has data. Never throws. */
export async function loadAdvisorySitemap(client?: SupabaseClient): Promise<SitemapEntry[]> {
  try {
    const admin = client ?? getSupabaseAdmin()
    const mode = await getAdvisoryMode(admin)
    if (mode !== 'on') return []
    const rows = await listPublishedAdvisories(admin)
    return advisorySitemapEntries(mode, rows, await readLogsBySlug(admin, rows.map((r) => r.slug)))
  } catch {
    return []
  }
}

/** The advisory page a destination guide links to, or null. Mode on, a published page with data, and the guide is the row's hand-set
 * guide_slug or has the same slug as the country. */
export async function loadAdvisoryLinkForGuide(guideSlug: string, client?: SupabaseClient): Promise<{ name: string; path: string; label: string } | null> {
  try {
    const admin = client ?? getSupabaseAdmin()
    const mode = await getAdvisoryMode(admin)
    if (mode !== 'on') return null
    return advisoryLinkForGuide(mode, guideSlug, await listPublishedAdvisories(admin))
  } catch {
    return null
  }
}
