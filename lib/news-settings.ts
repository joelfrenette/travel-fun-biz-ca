import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'

// Growth loop WP20: the two switches of the travel news auto-poster, both in app_settings (no redeploy to change them).

export type NewsMode = 'off' | 'draft' | 'publish'
export const NEWS_MODE_KEY = 'travel_news_mode'
export const NEWS_PER_DAY_KEY = 'travel_news_per_day'
export const NEWS_PER_DAY_DEFAULT = 2
export const NEWS_PER_DAY_HARD_MAX = 6

/** off: nothing is read or written. draft: feeds are read and briefs are written, checked and saved as DRAFT posts;
 * nothing goes live. publish: a brief that passes the gate and the judge goes live and is posted to social. Unset means
 * draft, so nothing can publish until a person switches it to publish. */
export function parseNewsMode(raw: string | null | undefined): NewsMode {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'off' || v === 'publish' ? v : 'draft'
}

export async function getNewsMode(admin: SupabaseClient): Promise<NewsMode> {
  return parseNewsMode(await getSetting(admin, NEWS_MODE_KEY))
}

export async function setNewsMode(admin: SupabaseClient, mode: NewsMode): Promise<{ error?: string }> {
  if (mode !== 'off' && mode !== 'draft' && mode !== 'publish') return { error: 'the mode must be off, draft or publish' }
  return setSetting(admin, NEWS_MODE_KEY, mode)
}

/** News briefs per day. Unset or not a whole number means 2; above 6 is cut to 6; 0 stops the writing (feeds are still read). Pure. */
export function parseNewsPerDay(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return NEWS_PER_DAY_DEFAULT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return NEWS_PER_DAY_DEFAULT
  return Math.min(NEWS_PER_DAY_HARD_MAX, n)
}

/** The daily number, or null when it could not be read (callers then write nothing: fail closed). */
export async function getNewsPerDay(admin: SupabaseClient): Promise<number | null> {
  const r = await getSettingStrict(admin, NEWS_PER_DAY_KEY)
  return r.error ? null : parseNewsPerDay(r.value)
}

export async function setNewsPerDay(admin: SupabaseClient, n: number): Promise<{ error?: string }> {
  if (!Number.isInteger(n) || n < 0 || n > NEWS_PER_DAY_HARD_MAX) return { error: `the daily number must be a whole number from 0 to ${NEWS_PER_DAY_HARD_MAX}` }
  return setSetting(admin, NEWS_PER_DAY_KEY, String(n))
}
