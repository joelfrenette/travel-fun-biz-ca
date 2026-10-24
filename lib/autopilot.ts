import { buildGroundingText } from '@/lib/post-grounding'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused, setAutomationPaused } from '@/lib/automation-kill-switch'
import { isDue, recapsDue, recapSlug, recapFacts, RECAP_LAST_DAY } from '@/lib/fanout-plan'
import { allEnrolmentsSince, utcDayStart, SOCIAL_ENROLMENTS_PER_DAY_CEILING } from '@/lib/news-distribution'
import { recordCaptions } from '@/lib/caption-log'
import { commentPromptLine } from '@/lib/reel-questions'
import { AUTOBLOG_MODE_KEY } from '@/lib/autoblog-run'
import { setAutoblogAiImageFallback } from '@/lib/blog-image'
import { getDistributionMode, setDistributionMode, getDistributionAccounts, getDistributionPlatforms, setTailoredCaptionsEnabled } from '@/lib/distribution'
import { generateAndSaveCarousel, gateCarouselCover, carouselKey, type CarouselSlide } from '@/lib/carousel'
import { recordGateEvents, type GateEvent } from '@/lib/visual-gate-stats'
import { visualTags } from '@/lib/cover-gate'
import { generateVideoScript, capScriptDuration, reelCoverTitleFor, detectHookFormula, HOOK_FORMULAS } from '@/lib/video-script'
import { photoIdOf } from '@/lib/social-cover'
import { steeredRotate } from '@/lib/optimizer-run'
import { tagVariant } from '@/lib/content-variants'
import { rotateStyle, hashtagCapFor, readRecentVariantValues, readVariantTag } from '@/lib/hook-styles'
import { buildVideoEdit, submitRender, getRenderStatus, deleteRenderAssets, detectShotstackEnv, isShotstackConfigured, shotstackEnv, REEL_COVER_TEMPLATE, type BeatVisual } from '@/lib/shotstack'
import { findBrollForBeats, isPexelsConfigured } from '@/lib/pexels'
import { gateReelFrames } from '@/lib/reel-frame-gate'
import { uploadPostConfigured, type UploadPostSendResult } from '@/lib/upload-post'
import { resolvePostingTarget, getProvider, platformsFor, sentPlatformsOf, type PostingTarget } from '@/lib/social-provider'
import { ghlSocialMissing } from '@/lib/ghl-social'
import { fitCaptionWithLink, tightestLimit, buildFallbackCaption, buildVideoCaption, repairCaptionCta, networkSupportsLinks } from '@/lib/social-captions'
import { socialLink } from '@/lib/utm'
import { SITE_URL, SITE_NAME, absoluteUrl } from '@/lib/site'
import { isAiConfigured } from '@/lib/ai-verify'
import { isImageAiConfigured } from '@/lib/image-ai-gen'

// Autopilot: ONE switch that runs the whole content chain with no further clicks. Turning it on
// applies a preset to the existing engine settings (autoblog publish, distribution auto, tailored
// captions, AI cover fallback) and starts the per-post repurposing pipeline below; turning it off
// switches the engines off again. Every guard that already existed still applies (quality gate,
// number-grounding, posts/week cadence, the master kill switch) - autopilot removes clicks, not
// safety checks.
export const AUTOPILOT_KEY = 'autopilot_mode'
export const VIDEOS_PER_WEEK_KEY = 'autopilot_videos_per_week'
export const DEFAULT_VIDEOS_PER_WEEK = 3

const MAX_ATTEMPTS = 3
// Only posts published in this window get repurposed: turning autopilot on must never flood social
// with a backlog of old posts.
const ENROLL_WINDOW_DAYS = 3
// Rows older than this stop being worked on (a stuck row can't be retried forever).
const ACTIVE_WINDOW_DAYS = 7
const RENDER_TIMEOUT_MS = 30 * 60 * 1000
// Shotstack keeps hosted renders until deleted. By the time this has passed, the video has long
// since been posted (or its sandbox preview reviewed), so the hosted copy is only costing storage.
const RENDER_RETENTION_MS = 48 * 60 * 60 * 1000
// Heavy steps are skipped once a run has used this much of its time budget.
const SOFT_DEADLINE_MS = 150_000
// After Shotstack rejects the key (401/403) video steps pause this long instead of burning an AI
// script call per row per run; rows stay pending and resume by themselves once the key works.
export const VIDEO_BLOCK_KEY = 'autopilot_video_blocked_until'
const VIDEO_BLOCK_MS = 6 * 60 * 60 * 1000

// Which Upload-Post networks take a multi-image post / a vertical video. A configured platform
// outside these lists simply isn't used for that asset type.
const CAROUSEL_PLATFORMS = ['instagram', 'linkedin', 'facebook', 'tiktok']
const VIDEO_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'facebook']

export async function isAutopilotOn(admin: SupabaseClient): Promise<boolean> {
  return (await getSetting(admin, AUTOPILOT_KEY)) === 'on'
}

export async function getVideosPerWeek(admin: SupabaseClient): Promise<number> {
  const n = Number(await getSetting(admin, VIDEOS_PER_WEEK_KEY))
  return Number.isInteger(n) && n >= 0 && n <= 14 ? n : DEFAULT_VIDEOS_PER_WEEK
}

export async function setVideosPerWeek(admin: SupabaseClient, n: number): Promise<{ error?: string }> {
  if (!Number.isInteger(n) || n < 0 || n > 14) return { error: 'videos per week must be a whole number from 0 to 14' }
  return setSetting(admin, VIDEOS_PER_WEEK_KEY, String(n))
}

export interface Readiness {
  /** Autopilot refuses to turn on while any of these are unmet. */
  blockers: string[]
  /** Autopilot runs, but part of the chain is inert until these are fixed. */
  warnings: string[]
}

export async function autopilotReadiness(admin: SupabaseClient): Promise<Readiness> {
  const blockers: string[] = []
  const warnings: string[] = []
  if (!isAiConfigured()) blockers.push('ANTHROPIC_API_KEY is not set in Vercel - nothing can be written without it.')
  if (!process.env.CRON_SECRET) blockers.push('CRON_SECRET is not set in Vercel - the scheduled jobs refuse to run without it.')
  const provider = await getProvider(admin)
  if (provider === 'ghl') {
    const missing = ghlSocialMissing()
    if (missing.length) warnings.push(`GoHighLevel posting needs ${missing.join(', ')} in Vercel - nothing will post until they are set.`)
    else if (!(await resolvePostingTarget(admin)).target) warnings.push('No GoHighLevel accounts ticked in the "Where it posts" box below - nothing will post until you choose some.')
  } else if (!uploadPostConfigured()) {
    warnings.push('UPLOAD_POST_API_KEY is not set - content will be created but nothing will post to social.')
  } else if (!(await resolvePostingTarget(admin)).target) {
    warnings.push('No Upload-Post profile or accounts chosen in the "Where it posts" box below - nothing will post until both are set.')
  }
  if (!isPexelsConfigured()) warnings.push('PEXELS_API_KEY is not set - no cover photos and no video b-roll.')
  if (!isImageAiConfigured()) warnings.push('OPENAI_API_KEY is not set - the AI cover-image fallback is inert.')
  if (!isShotstackConfigured()) warnings.push('SHOTSTACK_API_KEY is not set - no videos will be made.')
  else {
    await detectShotstackEnv(admin)
    if (shotstackEnv() === 'stage') warnings.push('Shotstack is on the free sandbox key: videos render with a watermark and are NOT posted. Use a production key to post them.')
  }
  return { blockers, warnings }
}

/** The one switch. On: applies the preset below (distribution goes to "auto" unless it is already
 * in "prepare" review mode, which is kept). Off: switches both engines off again. */
export async function setAutopilot(admin: SupabaseClient, on: boolean): Promise<{ error?: string }> {
  if (on) {
    const { blockers } = await autopilotReadiness(admin)
    if (blockers.length) return { error: blockers.join(' ') }
    const steps = [
      setAutomationPaused(admin, false),
      setSetting(admin, AUTOBLOG_MODE_KEY, 'publish'),
      // Keep review mode if you are already in it: posts then wait for your approval and carousels/
      // videos are made but not posted, until you set Distribution to Auto yourself.
      (await getDistributionMode(admin)) === 'prepare' ? Promise.resolve({} as { error?: string }) : setDistributionMode(admin, 'auto'),
      setTailoredCaptionsEnabled(admin, true),
      setAutoblogAiImageFallback(admin, true),
      setSetting(admin, AUTOPILOT_KEY, 'on'),
    ]
    const failed = (await Promise.all(steps)).find((r) => r.error)
    return failed ?? {}
  }
  const steps = [setSetting(admin, AUTOBLOG_MODE_KEY, 'off'), setDistributionMode(admin, 'off'), setSetting(admin, AUTOPILOT_KEY, 'off')]
  const failed = (await Promise.all(steps)).find((r) => r.error)
  return failed ?? {}
}

export interface PipelineRow {
  slug: string
  carousel_stage: 'pending' | 'generated' | 'posted' | 'failed' | 'skipped'
  video_stage: 'pending' | 'rendering' | 'rendered' | 'posted' | 'sandbox' | 'failed' | 'skipped'
  render_id: string | null
  video_url: string | null
  video_caption: string | null
  video_cleaned_at: string | null
  carousel_sent: string[] | null
  video_sent: string[] | null
  attempts: Record<string, number>
  last_error: string | null
  created_at: string
  updated_at: string
}

const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

async function enrollRecentPosts(admin: SupabaseClient): Promise<number> {
  const { data: posts } = await admin.from('posts').select('slug').eq('status', 'published').gte('publish_date', daysAgoIso(ENROLL_WINDOW_DAYS).slice(0, 10))
  // Travel news posts (slug "news-...", WP20) are short text briefs: no carousel and no paid video render is made for them.
  const slugs = (posts ?? []).map((p: { slug: string }) => p.slug).filter((s: string) => !s.startsWith('news-'))
  if (!slugs.length) return 0
  const { data: existing } = await admin.from('content_pipeline').select('slug').in('slug', slugs)
  const have = new Set((existing ?? []).map((r: { slug: string }) => r.slug))
  const fresh = slugs.filter((s: string) => !have.has(s))
  if (fresh.length) await admin.from('content_pipeline').upsert(fresh.map((slug: string) => ({ slug })), { onConflict: 'slug', ignoreDuplicates: true })
  return fresh.length
}

interface PostFacts {
  slug: string
  title: string
  body: string
  cover_image_url: string | null
  meta_description: string | null
  publish_date?: string | null
  primary_keyword?: string | null
  faq?: unknown
  key_takeaways?: unknown
  tags?: unknown
}

/** Day 7 of the fan-out calendar: enrols ONE recap post ("you asked, here is the answer") for a post published 7 to 10 days ago that has a real FAQ
 * answer. It is an image post (a composed "you asked" card, never text only) in the normal distribution ledger (slug recap-<post slug>), so every existing gate applies: distribution mode (prepare
 * holds it), the kill switch, caption problems and the shared daily enrolment ceiling. At most one recap a day, never above the ceiling, so no
 * posting cap is raised. Never throws. Returns a short note, or '' when nothing was enrolled. */
export async function enrollFanoutRecaps(admin: SupabaseClient, now: Date = new Date()): Promise<string> {
  try {
    const mode = await getDistributionMode(admin)
    if (mode === 'off' || (await isAutomationPaused(admin))) return ''
    const dayStart = utcDayStart(now)
    const { count: recapsToday, error: recapErr } = await admin.from('post_distribution').select('slug', { count: 'exact', head: true }).like('slug', 'recap-%').gte('created_at', dayStart)
    if (recapErr || (recapsToday ?? 0) >= 1) return ''
    const all = await allEnrolmentsSince(admin, dayStart)
    if (all === null || all >= SOCIAL_ENROLMENTS_PER_DAY_CEILING) return ''
    const from = new Date(now.getTime() - RECAP_LAST_DAY * 86_400_000).toISOString().slice(0, 10)
    const to = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
    const { data } = await admin.from('posts').select('slug, title, publish_date, faq, tags').eq('status', 'published').gte('publish_date', from).lte('publish_date', to)
    const posts = ((data ?? []) as Array<{ slug: string; title: string; publish_date: string | null; faq: unknown; tags: unknown }>).filter((p) => !!recapFacts(p))
    if (!posts.length) return ''
    const { data: existing } = await admin.from('post_distribution').select('slug').in('slug', posts.map((p) => recapSlug(p.slug)))
    const taken = new Set(((existing ?? []) as Array<{ slug: string }>).map((r) => r.slug))
    const pick = recapsDue(posts.map((p) => ({ slug: p.slug, publishedAt: p.publish_date })), new Set(taken), now, 1)[0]
    if (!pick) return ''
    const post = posts.find((p) => p.slug === pick)
    if (!post) return ''
    const { error } = await admin.from('post_distribution').insert({ content_type: 'post', slug: recapSlug(pick), title: post.title, stage: mode === 'prepare' ? 'held' : 'queued' })
    return error ? '' : `recap post enrolled for ${pick}`
  } catch (err) {
    console.error('[autopilot] recap enrol failed:', err instanceof Error ? err.message : err)
    return ''
  }
}

async function loadPost(admin: SupabaseClient, slug: string): Promise<PostFacts | null> {
  const { data } = await admin.from('posts').select('slug, title, body, cover_image_url, meta_description, publish_date, primary_keyword, faq, key_takeaways, tags, status').eq('slug', slug).maybeSingle()
  return data && data.status === 'published' ? (data as PostFacts) : null
}

interface AutopilotTarget {
  target: PostingTarget
  carouselPlatforms: string[]
  videoPlatforms: string[]
}

/** Posting only happens in distribution mode "auto" with a provider fully set up - the same gate
 * the text/photo distribution uses. Otherwise content is still created, just not sent. */
async function postingTarget(admin: SupabaseClient): Promise<AutopilotTarget | null> {
  if ((await getDistributionMode(admin)) !== 'auto') return null
  const { target } = await resolvePostingTarget(admin)
  if (!target) return null
  return {
    target,
    carouselPlatforms: platformsFor('photo', target.platforms, target.provider).filter((p) => CAROUSEL_PLATFORMS.includes(p)),
    videoPlatforms: platformsFor('video', target.platforms, target.provider).filter((p) => VIDEO_PLATFORMS.includes(p)),
  }
}

// Every link carries the post it points to (campaign), the format that carried it (source) and the
// style variant used (content), so a signup or lead can be credited to the post and to the carousel
// or video style that produced it. The network is not tagged: a carousel or video goes to all its
// networks in ONE send with ONE caption, so the network is not known when the caption is built.
const postLink = (slug: string, format: 'carousel' | 'video', variant?: string | null) =>
  socialLink(`${SITE_URL}/blog/${slug}`, format, slug, format === 'video' ? 'video' : 'carousel', variant)


/** Housekeeping, independent of the Autopilot switch: deletes Shotstack's hosted files for any
 * render that finished 48+ hours ago, so rendered videos do not accumulate against your storage. A
 * failed delete is retried on the next run; the row is only marked cleaned once Shotstack confirms. */
export async function cleanupOldRenders(admin: SupabaseClient): Promise<string | null> {
  if (!isShotstackConfigured()) return null
  const { data } = await admin
    .from('content_pipeline')
    .select('slug, render_id')
    .not('render_id', 'is', null)
    .is('video_cleaned_at', null)
    .in('video_stage', ['posted', 'sandbox', 'failed'])
    .lt('updated_at', new Date(Date.now() - RENDER_RETENTION_MS).toISOString())
    .limit(10)
  const rows = (data ?? []) as Array<{ slug: string; render_id: string }>
  let cleaned = 0
  for (const r of rows) {
    const res = await deleteRenderAssets(r.render_id)
    if (!res.ok) continue
    cleaned++
    await admin.from('content_pipeline').update({ video_cleaned_at: new Date().toISOString(), video_url: null }).eq('slug', r.slug)
  }
  return rows.length ? `cleaned ${cleaned}/${rows.length} old Shotstack renders` : null
}

export async function runAutopilotTick(admin: SupabaseClient): Promise<string> {
  const cleanup = await cleanupOldRenders(admin).catch(() => null)
  const { note } = await runAutopilotMain(admin)
  // Trip Page Kit: at most one thin trip page per pass, only while autopilot is on and automation is not paused.
  let kitNote: string | null = null
  if (await isAutopilotOn(admin).catch(() => false)) kitNote = await import('@/lib/trip-kit-run').then((m) => m.autopilotTripKitStep(admin)).catch(() => null)
  return [note, cleanup, kitNote].filter(Boolean).join('; ')
}

async function runAutopilotMain(admin: SupabaseClient): Promise<{ note: string; problems: string[] }> {
  const startedAt = Date.now()
  if (!(await isAutopilotOn(admin))) return { note: 'autopilot is off', problems: [] }
  if (await isAutomationPaused(admin)) return { note: 'automation is paused', problems: [] }

  const enrolled = await enrollRecentPosts(admin)
  const recapNote = await enrollFanoutRecaps(admin)
  const { data: rowsRaw } = await admin
    .from('content_pipeline')
    .select('*')
    .gte('created_at', daysAgoIso(ACTIVE_WINDOW_DAYS))
    .or('carousel_stage.in.(pending,generated),video_stage.in.(pending,rendering,rendered)')
    .order('created_at', { ascending: true })
    .limit(20)
  const rows = (rowsRaw ?? []) as PipelineRow[]
  if (!rows.length) return { note: `${enrolled} enrolled, nothing to do${recapNote ? `; ${recapNote}` : ''}`, problems: [] }

  const target = await postingTarget(admin)
  const notes: string[] = []
  const save = async (row: PipelineRow, patch: Partial<PipelineRow>) => {
    // The in-memory row must carry the new updated_at too: the render-timeout check below measures
    // from it, and a stale value made a render that had just been submitted look 30 minutes old.
    const updated_at = new Date().toISOString()
    Object.assign(row, patch, { updated_at })
    await admin.from('content_pipeline').update({ ...patch, updated_at }).eq('slug', row.slug)
  }
  const fail = async (row: PipelineRow, key: 'carousel' | 'video', error: string, permanent: boolean) => {
    const attempts = { ...row.attempts, [key]: (row.attempts[key] ?? 0) + 1 }
    const stageKey = key === 'carousel' ? 'carousel_stage' : 'video_stage'
    await save(row, { attempts, last_error: error.slice(0, 300), ...(permanent || attempts[key] >= MAX_ATTEMPTS ? { [stageKey]: 'failed' } : {}) } as Partial<PipelineRow>)
    notes.push(`${row.slug}: ${key} - ${error}`.slice(0, 160))
  }

  // Videos already started in the last week count toward the weekly cap (each render spends credits).
  const videosPerWeek = await getVideosPerWeek(admin)
  const { count: startedCount } = await admin
    .from('content_pipeline')
    .select('slug', { count: 'exact', head: true })
    .not('render_id', 'is', null)
    .gte('created_at', daysAgoIso(7))
  let videoSlots = Math.max(0, videosPerWeek - (startedCount ?? 0))
  let carouselBudget = 1
  let videoSubmitBudget = 1
  if (isShotstackConfigured()) await detectShotstackEnv(admin)
  const blockedUntil = Date.parse((await getSetting(admin, VIDEO_BLOCK_KEY)) ?? '')
  if (Number.isFinite(blockedUntil) && blockedUntil > Date.now()) videoSubmitBudget = 0

  for (const row of rows) {
    // ---- Carousel: generate, then post ----
    if (row.carousel_stage === 'pending' && carouselBudget > 0 && Date.now() - startedAt < SOFT_DEADLINE_MS) {
      carouselBudget--
      const post = await loadPost(admin, row.slug)
      if (post) {
        try {
          const slides = await generateAndSaveCarousel(admin, post)
          if (slides) await save(row, { carousel_stage: 'generated' })
          else await fail(row, 'carousel', 'could not generate a grounded carousel', false)
        } catch (e) {
          await fail(row, 'carousel', e instanceof Error ? e.message : 'carousel error', false)
        }
      }
    }
    const carouselTargets = target ? target.carouselPlatforms.filter((p) => !(row.carousel_sent ?? []).includes(p)) : []
    if (row.carousel_stage === 'generated' && target && target.carouselPlatforms.length && carouselTargets.length === 0) {
      await save(row, { carousel_stage: 'posted', last_error: null })
    }
    if (row.carousel_stage === 'generated' && target && carouselTargets.length && Date.now() - startedAt < SOFT_DEADLINE_MS) {
      const post = await loadPost(admin, row.slug)
      // Visual quality gate: slide 1 (and any teal fact card) is rendered and checked before the carousel can be posted.
      // A cover that fails is retried with the next photo and a shorter headline (twice), then the carousel is skipped:
      // stage 'skipped', never posted. A check that cannot run leaves the stage as it is for the next tick.
      let gatePassed = false
      if (post) {
        const gated = await gateCarouselCover(admin, post, { base: SITE_URL, hasTime: () => Date.now() - startedAt < SOFT_DEADLINE_MS })
        const retryEvents: GateEvent[] = Array.from({ length: gated.retries }, () => 'retry' as const)
        if (gated.status === 'skip') {
          // last_error stays empty on purpose: a skip is counted in the Visual quality tile, it is not a Needs attention item.
          await save(row, { carousel_stage: 'skipped', last_error: null })
          await recordGateEvents(admin, [...retryEvents, 'skip'], { slug: row.slug, surface: 'carousel', reason: gated.reasons.join('; ') })
          await tagVariant(admin, row.slug, visualTags('carousel', 'red-block-v1', { ok: false, reasons: gated.reasons, retries: gated.retries }, gated.photoId))
        } else if (gated.status === 'pass') {
          gatePassed = true
          await recordGateEvents(admin, [...retryEvents, 'pass'])
          await tagVariant(admin, row.slug, { ...visualTags('carousel', 'red-block-v1', { ok: true, reasons: [], retries: gated.retries }, gated.photoId), ...(gated.hasFact ? { 'fact_template:carousel': 'teal-fact' } : {}) })
        } else {
          await recordGateEvents(admin, gated.status === 'deferred' ? [...retryEvents, 'deferred'] : retryEvents)
        }
      }
      // Read after the gate: a retry rewrites slide 1 in the stored deck.
      const raw = gatePassed ? await getSetting(admin, carouselKey(row.slug)) : null
      const slides = raw ? (JSON.parse(raw) as CarouselSlide[]) : []
      if (post && gatePassed && slides.length) {
        const carouselLink = postLink(row.slug, 'carousel', await readVariantTag(admin, row.slug, 'carousel_hook'))
        const carouselLimit = tightestLimit(carouselTargets)
        // Hook, one description line, fixed call to action, link and up to 3 hashtags; the old title + description text if that is not possible.
        const captionBase =
          buildFallbackCaption(
            {
              title: post.title,
              metaDescription: post.meta_description,
              faqQuestions: Array.isArray(post.faq) ? (post.faq as Array<{ q?: unknown }>).map((f) => f?.q) : [],
              keyTakeaways: Array.isArray(post.key_takeaways) ? post.key_takeaways : [],
              tags: Array.isArray(post.tags) ? post.tags : [],
            },
            carouselTargets[0],
            carouselLink,
            { networks: carouselTargets, limit: carouselLimit, hashtagCap: Math.min(...carouselTargets.map(hashtagCapFor)) },
          ) ?? fitCaptionWithLink([post.title, post.meta_description].filter(Boolean).join('\n\n'), carouselLink, carouselLimit)
        // Whatever text was built, a missing link or call to action is repaired with the standard CTA line (a shared send with any
        // clickable network keeps the link; bio-only targets get "link in bio").
        const caption = repairCaptionCta(captionBase, { network: carouselTargets.find(networkSupportsLinks) ?? carouselTargets[0], link: carouselLink, limit: carouselLimit })
        const result = await target.target.sendPhotos(carouselTargets, caption, slides.map((_, i) => absoluteUrl(`/carousel/${row.slug}/${i + 1}`)))
        await settlePost(row, 'carousel', result, carouselTargets, save, fail, notes)
        if (result.ok) await recordCaptions(admin, [{ slug: row.slug, network: carouselTargets.join('/'), format: 'carousel', style: (await readVariantTag(admin, row.slug, 'carousel_hook')) ?? 'fallback', text: caption }])
      }
    }

    // ---- Video: submit render ----
    if (row.video_stage === 'pending' && isShotstackConfigured() && isAiConfigured() && videoSlots > 0 && videoSubmitBudget > 0 && Date.now() - startedAt < SOFT_DEADLINE_MS) {
      videoSubmitBudget--
      const post = await loadPost(admin, row.slug)
      // Fan-out calendar: the reel is due on day 2 after publishing (inside 72 hours). Not due yet means the row waits, no budget is used.
      if (post && !isDue({ slug: post.slug, publishedAt: post.publish_date }, 'reel', new Date())) {
        videoSubmitBudget++
      } else if (post) {
        try {
          // The hook formula rotates over the last 5 videos so consecutive videos do not open the same way.
          const preferred = await steeredRotate(admin, 'all', 'reel', await readRecentVariantValues(admin, 'video_hook', 12), HOOK_FORMULAS)
          const script = await generateVideoScript(post.title, post.meta_description || '', preferred, buildGroundingText(post.key_takeaways, post.faq) || undefined, { body: post.body, primaryKeyword: post.primary_keyword })
          if (!script) {
            await fail(row, 'video', 'could not write a video script', false)
          } else {
            const capped = capScriptDuration(script)
            // Pre-submit text check: the reel cover headline must pass the cover rules and the 5 word limit (the post title's
            // own phrases are tried first). If nothing valid exists the reel is skipped before any render credit is spent.
            const reelCover = reelCoverTitleFor(capped, post.title)
            if (!reelCover.ok) {
              await save(row, { video_stage: 'skipped', last_error: null })
              await recordGateEvents(admin, ['skip'], { slug: row.slug, surface: 'reel', reason: reelCover.reasons.join('; ') })
              await tagVariant(admin, row.slug, visualTags('reel', REEL_COVER_TEMPLATE, { ok: false, reasons: reelCover.reasons }, photoIdOf(post.cover_image_url)))
              continue
            }
            // One clip per beat: searches name the post's subject type (river cruise, ship deck, old town ...), unrelated clips are
            // rejected, and no clip repeats inside the reel or from the last reels (lib/broll-select.ts).
            const clips = await findBrollForBeats(capped.beats, { keyword: post.primary_keyword, title: post.title })
            const visuals: BeatVisual[] = clips.map((c) => ({ videoUrl: c?.url }))
            const submitted = await submitRender(buildVideoEdit(capped, visuals, post.cover_image_url ?? undefined, reelCover.title, SITE_NAME.toUpperCase(), { platform: !target || target.videoPlatforms.length === 0 || target.videoPlatforms.some((p) => !networkSupportsLinks(p)) ? 'instagram' : 'youtube' }))
            if (submitted.ok && submitted.renderId) {
              videoSlots--
              const hookUsed = capped.usedFallback ? 'fallback' : (detectHookFormula(capped.hook, preferred) ?? 'fallback')
              await save(row, { video_stage: 'rendering', render_id: submitted.renderId, video_caption: buildVideoCaption({ title: capped.title, description: [capped.description, commentPromptLine({ title: post.title, keyword: post.primary_keyword })].filter(Boolean).join('\n\n'), hashtags: capped.hashtags }, postLink(row.slug, 'video', hookUsed), tightestLimit(VIDEO_PLATFORMS)) })
              await tagVariant(admin, row.slug, { video_hook: hookUsed, hook_style_at: new Date().toISOString(), ...visualTags('reel', REEL_COVER_TEMPLATE, { ok: true, reasons: [] }, photoIdOf(post.cover_image_url)) })
              await recordGateEvents(admin, ['pass'])
            } else if (submitted.status === 401 || submitted.status === 403) {
              await setSetting(admin, VIDEO_BLOCK_KEY, new Date(Date.now() + VIDEO_BLOCK_MS).toISOString())
              notes.push(`Shotstack rejected the API key (${submitted.error}) - check SHOTSTACK_API_KEY. Video steps paused for 6 hours.`)
            } else {
              await fail(row, 'video', submitted.error ?? 'Shotstack rejected the render', false)
            }
          }
        } catch (e) {
          await fail(row, 'video', e instanceof Error ? e.message : 'video error', false)
        }
      }
    }

    // ---- Video: poll render, then post ----
    if (row.video_stage === 'rendering' && row.render_id) {
      const status = await getRenderStatus(row.render_id)
      if (status.ok && status.status === 'done' && status.url) {
        // Post-render frame gate: look at the poster (cover) and the end card still Shotstack saved with the render. A failing cover
        // is never posted. The credit is already spent, so this is a silent, counted skip (the Visual quality tile), never an
        // alert. No still, or a fetch that fails twice, means "unknown": the reel goes on as before.
        const frames = shotstackEnv() === 'v1' ? await gateReelFrames({ posterUrl: status.poster, endUrl: status.thumbnail }) : null
        if (frames && frames.verdict === 'fail') {
          await save(row, { video_stage: 'skipped', last_error: null })
          await recordGateEvents(admin, ['skip'], { slug: row.slug, surface: 'reel', reason: frames.reasons.join('; ') })
          continue
        }
        // Sandbox renders carry Shotstack's watermark: keep the URL for review, never post it.
        await save(row, { video_url: status.url, video_stage: shotstackEnv() === 'v1' ? 'rendered' : 'sandbox' })
      } else if (status.ok && status.status === 'failed') {
        await fail(row, 'video', `Shotstack render failed: ${status.error ?? 'unknown reason'}`, true)
      } else if (Date.now() - Date.parse(row.updated_at) > RENDER_TIMEOUT_MS) {
        await fail(row, 'video', 'render did not finish within 30 minutes', true)
      }
    }
    const videoTargets = target ? target.videoPlatforms.filter((p) => !(row.video_sent ?? []).includes(p)) : []
    if (row.video_stage === 'rendered' && row.video_url && target && target.videoPlatforms.length && videoTargets.length === 0) {
      await save(row, { video_stage: 'posted', last_error: null })
    }
    if (row.video_stage === 'rendered' && row.video_url && target && videoTargets.length && Date.now() - startedAt < SOFT_DEADLINE_MS) {
      const result = await target.target.sendVideo(videoTargets, row.video_caption ?? row.slug, row.video_url)
      await settlePost(row, 'video', result, videoTargets, save, fail, notes)
      if (result.ok) await recordCaptions(admin, [{ slug: row.slug, network: videoTargets.join('/'), format: 'video', style: (await readVariantTag(admin, row.slug, 'video_hook')) ?? 'fallback', text: row.video_caption ?? row.slug }])
    }
  }

  return { note: `${enrolled} enrolled, ${rows.length} active${recapNote ? `; ${recapNote}` : ''}${notes.length ? `; problems: ${notes.join(' | ')}` : ''}`, problems: notes }
}

async function settlePost(
  row: PipelineRow,
  key: 'carousel' | 'video',
  result: UploadPostSendResult,
  platforms: string[],
  save: (row: PipelineRow, patch: Partial<PipelineRow>) => Promise<void>,
  fail: (row: PipelineRow, key: 'carousel' | 'video', error: string, permanent: boolean) => Promise<void>,
  notes: string[],
): Promise<void> {
  const stageKey = key === 'carousel' ? 'carousel_stage' : 'video_stage'
  const sentKey = key === 'carousel' ? 'carousel_sent' : 'video_sent'
  if (result.dormant) return
  // Remember which networks were reached, even when others failed, so a retry never re-posts to them.
  const reached = result.ok ? platforms : sentPlatformsOf(result, platforms)
  const sent = [...new Set([...((row[sentKey] as string[] | null) ?? []), ...reached])]
  if (result.ok) {
    await save(row, { [stageKey]: 'posted', [sentKey]: sent, last_error: result.confirmed === false ? 'The provider accepted this but has not confirmed it posted yet.' : null } as Partial<PipelineRow>)
    return
  }
  await save(row, { [sentKey]: sent } as Partial<PipelineRow>)
  // Failed sends are never retried automatically (a timeout may still have created the post, and a
  // duplicate public post is worse than a missed one); the retry button only resends to networks
  // that were not reached.
  await fail(row, key, result.error ?? 'The provider did not post it', true)
  notes.push(`${row.slug}: ${key} post failed`)
}
