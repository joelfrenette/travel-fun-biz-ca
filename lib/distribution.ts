import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { uploadPostConfigured, uploadPostSendPhotos, uploadPostSendText } from '@/lib/upload-post'
import { utmLink } from '@/lib/utm'
import { SITE_URL } from '@/lib/site'

// Factory Phase 12: the dormant distribution ledger + mode gate. See migration 0011 for why the
// provider-specific columns (video, per-network post ids, captions) are deliberately not here yet
// — this only tracks WHICH published posts are enrolled to go out once a real posting provider is
// wired in, and a manual off/prepare/auto switch, same pattern as autoblog_mode (lib/autoblog-run.ts).
export type DistributionMode = 'off' | 'prepare' | 'auto'
export const DISTRIBUTION_MODE_KEY = 'distribution_mode'
export const DISTRIBUTION_ACCOUNTS_KEY = 'distribution_accounts'

export interface DistributionRow {
  content_type: 'post'
  slug: string
  title: string
  stage: 'queued' | 'held' | 'done' | 'failed'
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

/** `app_settings.distribution_mode`: off (default — nothing gets enrolled), prepare (enroll but
 * require manual approval before anything could ever post), auto (enroll and — once a real
 * provider exists — post automatically). Off until an admin explicitly changes it. */
export async function getDistributionMode(admin: SupabaseClient): Promise<DistributionMode> {
  const raw = await getSetting(admin, DISTRIBUTION_MODE_KEY)
  return raw === 'prepare' || raw === 'auto' ? raw : 'off'
}

export async function setDistributionMode(admin: SupabaseClient, mode: DistributionMode): Promise<{ error?: string }> {
  return setSetting(admin, DISTRIBUTION_MODE_KEY, mode)
}

/** Free-text, comma-separated account identifiers — kept provider-agnostic on purpose (nobody has
 * picked GHL Social Planner vs Ayrshare vs Upload-Post yet, and each names accounts differently).
 * Empty means nothing is allowed to post regardless of mode, once posting code exists at all. */
export function parseAccountsCsv(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function getDistributionAccounts(admin: SupabaseClient): Promise<string[]> {
  return parseAccountsCsv(await getSetting(admin, DISTRIBUTION_ACCOUNTS_KEY))
}

export async function setDistributionAccounts(admin: SupabaseClient, accounts: string[]): Promise<{ error?: string }> {
  return setSetting(admin, DISTRIBUTION_ACCOUNTS_KEY, accounts.map((a) => a.trim()).filter(Boolean).join(','))
}

// Provider decided 2026-09-27: Upload-Post (lib/upload-post.ts). accounts[0] is read as the
// Upload-Post profile ("user") to post from; platforms is which networks on that profile to send
// to (Upload-Post needs an explicit list, not "all"). Kept as its own setting rather than folding
// into distribution_accounts, since a profile and a platform list are different shapes of thing.
export const DISTRIBUTION_PLATFORMS_KEY = 'distribution_platforms'
const MAX_ATTEMPTS = 3

// Same pattern as autoblog's acquireRunLock/releaseRunLock (lib/autoblog-run.ts): there's no admin
// "run now" button wired to runDistribution today (only app/api/cron/distribute/route.ts calls
// it), so the live blast radius is narrower than autoblog's - but a retried/overlapping cron
// invocation, or anyone hitting the cron URL twice with a valid CRON_SECRET, could otherwise
// select and send the same queued rows twice and double-post to live social accounts. Added now
// so this is already in place before distribution_mode is ever flipped to "auto".
const DISTRIBUTION_RUN_LOCK_KEY = 'distribution_run_lock'
const DISTRIBUTION_RUN_LOCK_STALE_MS = 10 * 60 * 1000

async function acquireDistributionLock(admin: SupabaseClient): Promise<boolean> {
  const existing = await getSetting(admin, DISTRIBUTION_RUN_LOCK_KEY)
  if (existing) {
    const since = Date.parse(existing)
    if (!Number.isNaN(since) && Date.now() - since < DISTRIBUTION_RUN_LOCK_STALE_MS) return false
  }
  await setSetting(admin, DISTRIBUTION_RUN_LOCK_KEY, new Date().toISOString())
  return true
}

async function releaseDistributionLock(admin: SupabaseClient): Promise<void> {
  await setSetting(admin, DISTRIBUTION_RUN_LOCK_KEY, '')
}

export async function getDistributionPlatforms(admin: SupabaseClient): Promise<string[]> {
  return parseAccountsCsv(await getSetting(admin, DISTRIBUTION_PLATFORMS_KEY))
}

export async function setDistributionPlatforms(admin: SupabaseClient, platforms: string[]): Promise<{ error?: string }> {
  return setSetting(admin, DISTRIBUTION_PLATFORMS_KEY, platforms.map((p) => p.trim().toLowerCase()).filter(Boolean).join(','))
}

/** Enrolls a published post once distribution is on (prepare or auto) — a no-op when mode is
 * "off" or the post is already enrolled, so it's always safe to call on every publish. `prepare`
 * mode enrolls straight into `held` (needs an admin to release it before anything could ever post
 * once a provider exists); `auto` enrolls into `queued`. Never throws — a distribution-ledger
 * write failure must never block publishing the post itself. */
export async function enrollIfDue(admin: SupabaseClient, slug: string, title: string): Promise<void> {
  try {
    const mode = await getDistributionMode(admin)
    if (mode === 'off') return
    if (await isAutomationPaused(admin)) return
    const { data: existing } = await admin.from('post_distribution').select('slug').eq('content_type', 'post').eq('slug', slug).maybeSingle()
    if (existing) return
    await admin.from('post_distribution').insert({ content_type: 'post', slug, title, stage: mode === 'prepare' ? 'held' : 'queued' })
  } catch (err) {
    console.error('[distribution] enroll failed:', err instanceof Error ? err.message : err)
  }
}

export async function listDistributionQueue(admin: SupabaseClient): Promise<DistributionRow[]> {
  const { data, error } = await admin.from('post_distribution').select('*').order('created_at', { ascending: false }).limit(200)
  if (error) throw new Error(error.message)
  return data ?? []
}

/** Moves a held row to queued (admin approval) or a queued row to held (admin pause). Nothing
 * else is legal from the admin UI — done/failed only become reachable once real posting code
 * exists to set them. */
export async function setDistributionStage(admin: SupabaseClient, slug: string, stage: 'queued' | 'held'): Promise<void> {
  const { error } = await admin.from('post_distribution').update({ stage, updated_at: new Date().toISOString() }).eq('content_type', 'post').eq('slug', slug)
  if (error) throw new Error(error.message)
}

/** Posts every queued row via Upload-Post, oldest first, up to 5 per run (a small business's
 * daily blog output never queues more than that; a hard cap here is boring insurance, not a
 * real limit). The approval gate is the enrollment stage, not this function: "prepare" mode
 * enrolls a new post into `held`, and it only becomes `queued` (postable) once an admin clicks
 * Approve; "auto" mode skips that click by enrolling straight into `queued`. Either way, a
 * `queued` row is one that's cleared to post - only "off" (nothing enrolled, and this never
 * runs) or the kill switch stop it. A network Upload-Post didn't confirm counts as a failure,
 * retried up to MAX_ATTEMPTS times across future runs, then left as `failed` for a human to
 * look at. Never throws - a distribution failure must never break the cron for the next queued
 * post. */
export async function runDistribution(admin: SupabaseClient): Promise<string> {
  if (await isAutomationPaused(admin)) return 'automation is paused'
  const mode = await getDistributionMode(admin)
  if (mode === 'off') return 'distribution mode is off'
  if (!uploadPostConfigured()) return 'UPLOAD_POST_API_KEY is not set'

  const [accounts, platforms] = await Promise.all([getDistributionAccounts(admin), getDistributionPlatforms(admin)])
  const user = accounts[0]
  if (!user) return 'no Upload-Post profile set (distribution_accounts)'
  if (!platforms.length) return 'no platforms set (distribution_platforms)'

  if (!(await acquireDistributionLock(admin))) return 'another distribution run is already in progress'
  try {
    return await runDistributionLocked(admin, user, platforms)
  } finally {
    await releaseDistributionLock(admin)
  }
}

async function runDistributionLocked(admin: SupabaseClient, user: string, platforms: string[]): Promise<string> {
  const { data: rows, error } = await admin
    .from('post_distribution')
    .select('*')
    .eq('content_type', 'post')
    .eq('stage', 'queued')
    .order('created_at', { ascending: true })
    .limit(5)
  if (error) throw new Error(`post_distribution: ${error.message}`)
  if (!rows || rows.length === 0) return 'nothing queued'

  let posted = 0
  let failed = 0
  let needsReview = 0
  for (const row of rows as DistributionRow[]) {
    try {
      const { data: post } = await admin.from('posts').select('title, cover_image_url, meta_description').eq('slug', row.slug).maybeSingle()
      const link = utmLink(`${SITE_URL}/blog/${row.slug}`, { source: 'upload-post', medium: 'social', campaign: 'distribution' })
      const caption = [post?.title || row.title, post?.meta_description, link].filter(Boolean).join('\n\n')
      const result = post?.cover_image_url
        ? await uploadPostSendPhotos({ user, platforms, text: caption, imageUrls: [post.cover_image_url] })
        : await uploadPostSendText({ user, platforms, text: caption })

      if (result.ok && result.confirmed === false) {
        // Upload-Post accepted the request (202 / job_id / scheduled) but hasn't confirmed it
        // posted yet. There's no poller wired up to resolve this later (uploadPostGetStatus has
        // no caller), so don't mark it "done" - route it to "held" so an admin sees it in the
        // queue and can verify manually instead of it silently vanishing as if confirmed.
        needsReview++
        await admin
          .from('post_distribution')
          .update({
            stage: 'held',
            last_error: 'Upload-Post accepted this but has not confirmed it posted yet - verify manually, then re-queue or leave held.',
            updated_at: new Date().toISOString(),
          })
          .eq('content_type', 'post')
          .eq('slug', row.slug)
      } else if (result.ok) {
        await admin.from('post_distribution').update({ stage: 'done', updated_at: new Date().toISOString() }).eq('content_type', 'post').eq('slug', row.slug)
        posted++
      } else {
        failed++
        const attempts = row.attempts + 1
        // A non-retryable failure (permanent validation error, or a timeout that may have already
        // posted) must not be re-queued for another attempt - it either can never self-resolve or
        // retrying risks a duplicate post. Send it straight to "failed" for a human to look at.
        const retryable = result.retryable !== false
        await admin
          .from('post_distribution')
          .update({
            stage: retryable && attempts < MAX_ATTEMPTS ? 'queued' : 'failed',
            attempts,
            last_error: (result.error || 'Upload-Post did not confirm every network posted').slice(0, 300),
            updated_at: new Date().toISOString(),
          })
          .eq('content_type', 'post')
          .eq('slug', row.slug)
      }
    } catch (err) {
      failed++
      const attempts = row.attempts + 1
      await admin
        .from('post_distribution')
        .update({
          stage: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
          attempts,
          last_error: (err instanceof Error ? err.message : 'unknown error').slice(0, 300),
          updated_at: new Date().toISOString(),
        })
        .eq('content_type', 'post')
        .eq('slug', row.slug)
    }
  }
  return `${posted} posted, ${failed} failed, ${needsReview} needs review, ${rows.length} attempted`
}
