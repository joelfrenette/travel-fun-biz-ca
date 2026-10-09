import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { uploadPostGetStatus } from '@/lib/upload-post'
import { resolvePostingTarget, platformsFor, type PostingTarget } from '@/lib/social-provider'
import { utmLink } from '@/lib/utm'
import { SITE_URL } from '@/lib/site'
import { fitCaption, tightestLimit, generatePlatformCaptions, type PlatformCaptions } from '@/lib/social-captions'
import type { UploadPostSendResult } from '@/lib/upload-post'

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
  provider_request_id: string | null
  provider_job_id: string | null
  /** Networks this post has already reached, so a retry never re-posts to them. */
  sent_platforms: string[] | null
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

// Tailored per-platform captions (lib/social-captions.ts) are a genuinely new, recurring Anthropic
// call stacked on top of whatever autoblog already costs - not covered by Phase 0's "AI composer
// is in scope" decision by itself, since that was about writing the post, not posting it. Its own
// explicit toggle, default off, same "a considered admin decision, never a silent default" rule as
// the AI image fallback (lib/blog-image.ts). Off means every platform just gets the one shared,
// mechanically-fitted caption - the real behavior before tailoring existed.
const TAILORED_CAPTIONS_KEY = 'distribution_tailored_captions'

export async function getTailoredCaptionsEnabled(admin: SupabaseClient): Promise<boolean> {
  return (await getSetting(admin, TAILORED_CAPTIONS_KEY)) === 'on'
}

export async function setTailoredCaptionsEnabled(admin: SupabaseClient, on: boolean): Promise<{ error?: string }> {
  return setSetting(admin, TAILORED_CAPTIONS_KEY, on ? 'on' : 'off')
}

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
  const { target, reason } = await resolvePostingTarget(admin)
  if (!target) return reason ?? 'posting is not set up'

  if (!(await acquireDistributionLock(admin))) return 'another distribution run is already in progress'
  try {
    const tailoredCaptionsOn = await getTailoredCaptionsEnabled(admin)
    return await runDistributionLocked(admin, target, tailoredCaptionsOn)
  } finally {
    await releaseDistributionLock(admin)
  }
}

/** Sends to every platform. When `captions` has a genuinely tailored entry for a platform, that
 * platform gets its own Upload-Post call with its own text (Upload-Post's confirmed API has no
 * per-platform text field, so distinct voice per network means one call per network, not one
 * shared call - see lib/social-captions.ts's header comment for the quota tradeoff this implies).
 * Any platform missing from `captions` (AI unconfigured, or that network's slot came back empty)
 * falls back to the one shared caption in a single combined call, same as before tailoring existed -
 * never fewer platforms reached just because tailoring partially failed. */
async function sendTailored(
  send: (platforms: string[], text: string) => Promise<UploadPostSendResult>,
  platforms: string[],
  captions: PlatformCaptions | null,
  sharedCaption: string,
): Promise<UploadPostSendResult & { sent: string[] }> {
  const tailoredPlatforms = platforms.filter((p) => captions?.[p])
  const fallbackPlatforms = platforms.filter((p) => !captions?.[p])

  const calls: Promise<{ platforms: string[]; result: UploadPostSendResult }>[] = []
  for (const p of tailoredPlatforms) {
    calls.push(send([p], captions![p]).then((result) => ({ platforms: [p], result })))
  }
  if (fallbackPlatforms.length > 0) {
    calls.push(send(fallbackPlatforms, sharedCaption).then((result) => ({ platforms: fallbackPlatforms, result })))
  }
  const outcomes = await Promise.all(calls)

  // Aggregate across every sub-call into the same shape one combined call used to return - ok
  // only if every platform's own attempt succeeded; non-retryable if any one is (a partial retry
  // risks re-posting to the platforms that already succeeded); confirmed:false if any one needs
  // manual verification.
  const results: NonNullable<UploadPostSendResult['results']> = {}
  let ok = true
  let confirmed = true
  let retryable = true
  const errors: string[] = []
  // Collected separately from the single requestId/jobId fields on UploadPostSendResult (which
  // only fit one sub-call) - tailored sending can make several calls, each with its own id to
  // poll later (see syncPendingDistribution below), so every one needs to be kept, not just the
  // last one seen.
  const requestIds: string[] = []
  const jobIds: string[] = []
  for (const { platforms: sentTo, result } of outcomes) {
    Object.assign(results, result.results ?? {})
    if (!result.ok) {
      ok = false
      if (result.retryable === false) retryable = false
      if (result.error) errors.push(`${sentTo.join('/')}: ${result.error}`)
    }
    if (result.confirmed === false) confirmed = false
    if (result.requestId) requestIds.push(result.requestId)
    if (result.jobId) jobIds.push(result.jobId)
  }
  return {
    sent: outcomes.flatMap((o) => o.platforms.filter((p) => (o.result.results && p in o.result.results ? o.result.results[p].ok : o.result.ok))),
    ok,
    confirmed,
    retryable,
    results,
    error: errors.length ? errors.join('; ') : undefined,
    requestId: requestIds.length ? requestIds.join(',') : undefined,
    jobId: jobIds.length ? jobIds.join(',') : undefined,
  }
}

async function runDistributionLocked(admin: SupabaseClient, target: PostingTarget, tailoredCaptionsOn: boolean): Promise<string> {
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
      const link = utmLink(`${SITE_URL}/blog/${row.slug}`, { source: 'social', medium: 'social', campaign: row.slug, content: post?.cover_image_url ? 'post-photo' : 'post-text' })
      const title = post?.title || row.title
      // Only networks that accept this kind of post, and never ones this post already reached.
      const kind = post?.cover_image_url ? 'photo' : 'text'
      const already = row.sent_platforms ?? []
      const platforms = platformsFor(kind, target.platforms, target.provider).filter((p) => !already.includes(p))
      if (platforms.length === 0) {
        const anySent = already.length > 0
        await admin
          .from('post_distribution')
          .update({
            stage: anySent ? 'done' : 'failed',
            last_error: anySent ? null : `None of your selected networks takes a ${kind} post (selected: ${target.platforms.join(', ') || 'none'}). Tick a network that does, such as Facebook, LinkedIn or Bluesky.`,
            updated_at: new Date().toISOString(),
          })
          .eq('content_type', 'post')
          .eq('slug', row.slug)
        if (anySent) posted++
        else failed++
        continue
      }
      const rawCaption = [title, post?.meta_description, link].filter(Boolean).join('\n\n')
      // Mechanical limit check against the tightest of the target platforms' real character
      // limits (lib/social-captions.ts) - the fallback/shared-call path sends this same caption to
      // every network that didn't get its own tailored one, so it has to fit all of them.
      const sharedCaption = fitCaption(rawCaption, tightestLimit(platforms))
      // One model call writes every platform's own tailored caption, only when the admin has
      // explicitly turned this on (distribution_tailored_captions) - off, or AI unconfigured, or
      // the call failed, all mean every platform falls back to the shared caption above. Never
      // blocks distribution over this, same rule as every other AI step in this project.
      const tailored = tailoredCaptionsOn ? await generatePlatformCaptions(title, post?.meta_description ?? null, link, platforms) : null
      const send = (p: string[], text: string) =>
        post?.cover_image_url ? target.sendPhotos(p, text, [post.cover_image_url]) : target.sendText(p, text)
      const result = await sendTailored(send, platforms, tailored, sharedCaption)
      const sentPlatforms = [...new Set([...already, ...result.sent])]

      if (result.ok && result.confirmed === false) {
        // Upload-Post accepted the request (202 / job_id / scheduled) but hasn't confirmed it
        // posted yet. The request/job id is saved so syncPendingDistribution (below) can resolve
        // this later via uploadPostGetStatus - held in the meantime so an admin also sees it in
        // the queue and can verify manually instead of it silently vanishing as if confirmed.
        needsReview++
        await admin
          .from('post_distribution')
          .update({
            stage: 'held',
            last_error: 'Upload-Post accepted this but has not confirmed it posted yet - verify manually, or wait for the next sync.',
            provider_request_id: result.requestId ?? null,
            provider_job_id: result.jobId ?? null,
            sent_platforms: sentPlatforms,
            updated_at: new Date().toISOString(),
          })
          .eq('content_type', 'post')
          .eq('slug', row.slug)
      } else if (result.ok) {
        await admin.from('post_distribution').update({ stage: 'done', sent_platforms: sentPlatforms, updated_at: new Date().toISOString() }).eq('content_type', 'post').eq('slug', row.slug)
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
            sent_platforms: sentPlatforms,
            last_error: (result.error || 'The provider did not confirm every network posted').slice(0, 300),
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

/** Resolves "held, needs review" rows (an async send Upload-Post accepted but hadn't confirmed
 * yet) by polling the real request/job id saved when that happened - the "stuck-forever" gotcha
 * this is specifically here to avoid: an "already resolved, don't re-check" guard that only looks
 * at whether a result column is non-null would go permanently blind the moment ANY writer (this
 * function, a future one, a manual edit) puts something non-null there first. This checks
 * `provider_request_id`/`provider_job_id` being set (Upload-Post's own confirmed id fields) as the
 * "is this actually resolvable" signal instead, not a generic "has this row been touched" flag.
 * Manual-only for now (no cron wired in) - admin-triggered via the Distribution page, same
 * "credit-costing/external calls are admin-triggered" discipline as the rest of this phase, even
 * though checking status itself is free; the posts it's resolving are not. */
export async function syncPendingDistribution(admin: SupabaseClient): Promise<string> {
  const { data: rows, error } = await admin
    .from('post_distribution')
    .select('*')
    .eq('content_type', 'post')
    .eq('stage', 'held')
    .or('provider_request_id.not.is.null,provider_job_id.not.is.null')
    .limit(20)
  if (error) throw new Error(`post_distribution: ${error.message}`)
  if (!rows || rows.length === 0) return 'nothing pending to sync'

  let resolved = 0
  let stillPending = 0
  let checkFailed = 0
  for (const row of rows as DistributionRow[]) {
    const ids = [...(row.provider_request_id?.split(',') ?? []), ...(row.provider_job_id?.split(',') ?? [])].filter(Boolean)
    if (ids.length === 0) continue
    try {
      // Every id this row's send touched has to confirm success for the row to resolve "done" -
      // same all-or-nothing rule runDistributionLocked itself uses.
      const statuses = await Promise.all(
        ids.map((id) => (row.provider_request_id?.split(',').includes(id) ? uploadPostGetStatus({ requestId: id }) : uploadPostGetStatus({ jobId: id }))),
      )
      // A confirmed 404 ("Upload-Post has no record of this id" - it expired, or the id was never
      // valid) is a different signal from a transient check failure: this row can never resolve
      // via this id again, no matter how many more times it's synced. Without this branch it would
      // fall into the generic !ok path below and sit in "held" forever, re-checked on every sync
      // but never progressing - exactly the stuck-forever gotcha this function exists to avoid.
      if (statuses.some((s) => s.status === 'not_found')) {
        await admin
          .from('post_distribution')
          .update({
            stage: 'failed',
            last_error: 'Upload-Post no longer has a record of this request (it may have expired) - it cannot be auto-resolved; check the Distribution admin page.',
            updated_at: new Date().toISOString(),
          })
          .eq('content_type', 'post')
          .eq('slug', row.slug)
        resolved++
        continue
      }
      if (statuses.some((s) => !s.ok)) {
        checkFailed++
        continue
      }
      // Prefer completed/total (confirmed numeric fields, lib/upload-post.ts) over the `status`
      // string, whose real vocabulary isn't confirmed by a live call the way completed/total is -
      // not done until every network Upload-Post is tracking for this id has a result.
      const stillWaiting = statuses.some((s) => typeof s.completed === 'number' && typeof s.total === 'number' && s.completed < s.total)
      if (stillWaiting || statuses.every((s) => !s.results || Object.keys(s.results).length === 0)) {
        stillPending++
        continue
      }
      const allResults = statuses.flatMap((s) => Object.values(s.results ?? {}))
      const allOk = allResults.length > 0 && allResults.every((r) => r.ok)
      await admin
        .from('post_distribution')
        .update({
          stage: allOk ? 'done' : 'failed',
          last_error: allOk ? null : 'Upload-Post confirmed this did not post to every network - check the Distribution admin page.',
          updated_at: new Date().toISOString(),
        })
        .eq('content_type', 'post')
        .eq('slug', row.slug)
      resolved++
    } catch {
      checkFailed++
    }
  }
  return `${resolved} resolved, ${stillPending} still pending, ${checkFailed} could not be checked, ${rows.length} rows had a saved id`
}
