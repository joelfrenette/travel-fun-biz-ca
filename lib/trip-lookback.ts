import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { isPastTrip } from '@/lib/past-trip'
import { pastSafeText, splitGallery } from '@/lib/past-trip-kit'
import type { GuidePostSource } from '@/lib/guide-post-source'

// "Look back at <trip>": when a trip turns into a recap, ONE social post is DRAFTED for a person to review. Never posted by
// itself: the row waits in the existing review queue (post_distribution, stage 'held', no Auto-hold note, and a slug that no
// automatic release looks at). It needs a real trip photo that the Recap Studio put in the gallery (that is the permission
// step); with none, no draft is made, and a post is never text only. Off unless the trip social setting is exactly 'true',
// and it follows the Distribution mode (off) and the automation pause like every other trip post.

export const LOOKBACK_PREFIX = 'lookback-'
export const lookbackSlug = (tripSlug: string): string => `${LOOKBACK_PREFIX}${tripSlug}`
export const lookbackDoneKey = (tripSlug: string): string => `lookback_drafted:${tripSlug}`
export const lookbackTitle = (name: string): string => `Look back at ${name}`
export const LOOKBACKS_PER_DAY = 1

export interface LookbackTrip {
  slug: string
  name: string
  status: string
  available_to: string | null
  recap_mode?: string | null
  gallery_urls?: string[] | null
  recap_summary?: string | null
  recap_highlights?: string[] | null
}

/** Why a look-back draft may not be made for this trip, in plain words. Empty means it may. Pure. */
export function lookbackBlockers(trip: LookbackTrip, alreadyDrafted: boolean, today?: string): string[] {
  const out: string[] = []
  if (trip.status !== 'published') out.push('the trip is not published')
  if (!isPastTrip(trip, today)) out.push('the trip has not happened yet')
  if (splitGallery(trip.gallery_urls, trip.slug).real.length === 0) out.push('no real trip photo with permission (Recap Studio) yet, and a post is never text only')
  if (alreadyDrafted) out.push('a look-back draft was already made for this trip')
  return out
}

/** The post fields the posting pass reads, for a past trip that has a real photo; null otherwise (so nothing is ever sent for it). Pure. */
export function lookbackSource(trip: LookbackTrip & { meta_description?: string | null; short_description?: string | null }): GuidePostSource | null {
  const photo = splitGallery(trip.gallery_urls, trip.slug).real[0]
  if (!photo) return null
  const recap = pastSafeText(trip.recap_summary)
  const points = (trip.recap_highlights ?? []).filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => `- ${pastSafeText(h)}`).filter((h) => h.length > 2)
  const grounding = [recap ? `- ${recap}` : '', ...points].filter(Boolean).join('\n').slice(0, 1500)
  return {
    title: lookbackTitle(trip.name),
    cover_image_url: photo,
    meta_description: pastSafeText(trip.meta_description) || recap.split(/(?<=[.!?])\s/)[0] || pastSafeText(trip.short_description) || null,
    grounding: grounding || undefined,
  }
}

/** The one trip to draft next: eligible, most recently finished first, then slug. Pure. */
export function pickLookbackTrip(trips: readonly LookbackTrip[], drafted: ReadonlySet<string>, today?: string): LookbackTrip | null {
  const eligible = trips.filter((t) => lookbackBlockers(t, drafted.has(t.slug), today).length === 0)
  eligible.sort((a, b) => (b.available_to ?? '').localeCompare(a.available_to ?? '') || (a.slug < b.slug ? -1 : 1))
  return eligible[0] ?? null
}

/** One draft try, called from the trip posting pass. Returns '' when nothing was done, else a short log note. Never throws. */
export async function runLookBackDraft(admin: SupabaseClient, mode: string, now: Date = new Date()): Promise<string> {
  try {
    if (mode !== 'prepare' && mode !== 'auto') return ''
    if ((await getSetting(admin, 'trip_social_posts')) !== 'true') return ''
    if (await isAutomationPaused(admin)) return ''
    const today = now.toISOString().slice(0, 10)

    const { count, error: countError } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', `${LOOKBACK_PREFIX}%`).gte('created_at', `${today}T00:00:00.000Z`)
    if (countError || count === null || count >= LOOKBACKS_PER_DAY) return ''

    const cols = 'slug, name, status, available_to, gallery_urls'
    let res = await admin.from('travel_packages').select(`${cols}, recap_mode`).eq('status', 'published')
    if (res.error) res = (await admin.from('travel_packages').select(cols).eq('status', 'published')) as typeof res
    if (res.error) return ''
    const trips = (res.data ?? []) as LookbackTrip[]
    const candidates = trips.filter((t) => isPastTrip(t, today) && splitGallery(t.gallery_urls, t.slug).real.length > 0)
    const drafted = new Set<string>()
    for (const t of candidates) if (await getSetting(admin, lookbackDoneKey(t.slug))) drafted.add(t.slug)
    const pick = pickLookbackTrip(candidates, drafted, today)
    if (!pick) return ''

    const { error } = await admin.from('post_distribution').insert({ content_type: 'post', slug: lookbackSlug(pick.slug), title: lookbackTitle(pick.name), path: `/packages/${pick.slug}`, stage: 'held' })
    if (error) return ''
    await setSetting(admin, lookbackDoneKey(pick.slug), now.toISOString())
    return `look-back draft ${lookbackSlug(pick.slug)}`
  } catch (e) {
    console.error('[trip-lookback] draft failed:', e instanceof Error ? e.message : e)
    return ''
  }
}
