import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused, setAutomationPaused } from '@/lib/automation-kill-switch'
import { AUTOBLOG_MODE_KEY } from '@/lib/autoblog-run'
import { setAutoblogAiImageFallback } from '@/lib/blog-image'
import { getDistributionMode, setDistributionMode, getDistributionAccounts, getDistributionPlatforms, setTailoredCaptionsEnabled } from '@/lib/distribution'
import { generateAndSaveCarousel, carouselKey, type CarouselSlide } from '@/lib/carousel'
import { generateVideoScript, capScriptDuration } from '@/lib/video-script'
import { buildVideoEdit, submitRender, getRenderStatus, deleteRenderAssets, isShotstackConfigured, shotstackEnv, type BeatVisual } from '@/lib/shotstack'
import { findBrollClip, isPexelsConfigured } from '@/lib/pexels'
import { uploadPostConfigured, uploadPostSendPhotos, uploadPostSendVideo, type UploadPostSendResult } from '@/lib/upload-post'
import { fitCaption, tightestLimit } from '@/lib/social-captions'
import { utmLink } from '@/lib/utm'
import { SITE_URL, absoluteUrl } from '@/lib/site'
import { isAiConfigured } from '@/lib/ai-verify'
import { isImageAiConfigured } from '@/lib/image-ai-gen'
import { sendThrottledAlert } from '@/lib/alerts'

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
  if (!uploadPostConfigured()) warnings.push('UPLOAD_POST_API_KEY is not set - content will be created but nothing will post to social.')
  const [accounts, platforms] = await Promise.all([getDistributionAccounts(admin), getDistributionPlatforms(admin)])
  if (uploadPostConfigured() && (!accounts[0] || platforms.length === 0)) {
    warnings.push('No Upload-Post profile or accounts chosen in the "Where it posts" box below - nothing will post until both are set.')
  }
  if (!isPexelsConfigured()) warnings.push('PEXELS_API_KEY is not set - no cover photos and no video b-roll.')
  if (!isImageAiConfigured()) warnings.push('OPENAI_API_KEY is not set - the AI cover-image fallback is inert.')
  if (!isShotstackConfigured()) warnings.push('SHOTSTACK_API_KEY is not set - no videos will be made.')
  else if (shotstackEnv() === 'stage') warnings.push('Shotstack is in sandbox mode (SHOTSTACK_ENV is not "v1"): videos render with a watermark and are NOT posted. Set SHOTSTACK_ENV=v1 with your production key to post them.')
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
  attempts: Record<string, number>
  last_error: string | null
  created_at: string
  updated_at: string
}

const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

async function enrollRecentPosts(admin: SupabaseClient): Promise<number> {
  const { data: posts } = await admin.from('posts').select('slug').eq('status', 'published').gte('publish_date', daysAgoIso(ENROLL_WINDOW_DAYS).slice(0, 10))
  const slugs = (posts ?? []).map((p: { slug: string }) => p.slug)
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
}

async function loadPost(admin: SupabaseClient, slug: string): Promise<PostFacts | null> {
  const { data } = await admin.from('posts').select('slug, title, body, cover_image_url, meta_description, status').eq('slug', slug).maybeSingle()
  return data && data.status === 'published' ? (data as PostFacts) : null
}

interface PostingTarget {
  user: string
  carouselPlatforms: string[]
  videoPlatforms: string[]
}

/** Posting only happens in distribution mode "auto" with a profile and platforms saved - the same
 * gate the text/photo distribution uses. Otherwise content is still created, just not sent. */
async function postingTarget(admin: SupabaseClient): Promise<PostingTarget | null> {
  if ((await getDistributionMode(admin)) !== 'auto' || !uploadPostConfigured()) return null
  const [accounts, platforms] = await Promise.all([getDistributionAccounts(admin), getDistributionPlatforms(admin)])
  const user = accounts[0]
  if (!user) return null
  const lower = platforms.map((p) => p.toLowerCase())
  return { user, carouselPlatforms: lower.filter((p) => CAROUSEL_PLATFORMS.includes(p)), videoPlatforms: lower.filter((p) => VIDEO_PLATFORMS.includes(p)) }
}

const postLink = (slug: string) => utmLink(`${SITE_URL}/blog/${slug}`, { source: 'upload-post', medium: 'social', campaign: 'autopilot' })


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
  const { note, problems } = await runAutopilotMain(admin)
  let alert = ''
  if (problems.length) {
    const result = await sendThrottledAlert(admin, 'Autopilot hit a problem', [
      'Content Autopilot reported:',
      ...problems.map((p) => `- ${p}`),
      '',
      'Details and recent posts: https://www.travelfunbiz.ca/admin/autopilot',
    ])
    alert = result === 'sent' ? '; alert emailed' : ''
  }
  return [note, cleanup].filter(Boolean).join('; ') + alert
}

async function runAutopilotMain(admin: SupabaseClient): Promise<{ note: string; problems: string[] }> {
  const startedAt = Date.now()
  if (!(await isAutopilotOn(admin))) return { note: 'autopilot is off', problems: [] }
  if (await isAutomationPaused(admin)) return { note: 'automation is paused', problems: [] }

  const enrolled = await enrollRecentPosts(admin)
  const { data: rowsRaw } = await admin
    .from('content_pipeline')
    .select('*')
    .gte('created_at', daysAgoIso(ACTIVE_WINDOW_DAYS))
    .or('carousel_stage.in.(pending,generated),video_stage.in.(pending,rendering,rendered)')
    .order('created_at', { ascending: true })
    .limit(20)
  const rows = (rowsRaw ?? []) as PipelineRow[]
  if (!rows.length) return { note: `${enrolled} enrolled, nothing to do`, problems: [] }

  const target = await postingTarget(admin)
  const notes: string[] = []
  const save = async (row: PipelineRow, patch: Partial<PipelineRow>) => {
    Object.assign(row, patch)
    await admin.from('content_pipeline').update({ ...patch, updated_at: new Date().toISOString() }).eq('slug', row.slug)
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
    if (row.carousel_stage === 'generated' && target && target.carouselPlatforms.length && Date.now() - startedAt < SOFT_DEADLINE_MS) {
      const post = await loadPost(admin, row.slug)
      const raw = await getSetting(admin, carouselKey(row.slug))
      const slides = raw ? (JSON.parse(raw) as CarouselSlide[]) : []
      if (post && slides.length) {
        const caption = fitCaption([post.title, post.meta_description, postLink(row.slug)].filter(Boolean).join('\n\n'), tightestLimit(target.carouselPlatforms))
        const result = await uploadPostSendPhotos({ user: target.user, platforms: target.carouselPlatforms, text: caption, imageUrls: slides.map((_, i) => absoluteUrl(`/carousel/${row.slug}/${i + 1}`)) })
        await settlePost(row, 'carousel', result, 'posted', save, fail, notes)
      }
    }

    // ---- Video: submit render ----
    if (row.video_stage === 'pending' && isShotstackConfigured() && isAiConfigured() && videoSlots > 0 && videoSubmitBudget > 0 && Date.now() - startedAt < SOFT_DEADLINE_MS) {
      videoSubmitBudget--
      const post = await loadPost(admin, row.slug)
      if (post) {
        try {
          const script = await generateVideoScript(post.title, post.meta_description || '')
          if (!script) {
            await fail(row, 'video', 'could not write a video script', false)
          } else {
            const capped = capScriptDuration(script)
            const clips = await Promise.all(capped.beats.map((b) => findBrollClip(b.brollSearchTerms.join(' '))))
            const visuals: BeatVisual[] = clips.map((c) => ({ videoUrl: c?.url }))
            const submitted = await submitRender(buildVideoEdit(capped, visuals, post.cover_image_url ?? undefined))
            if (submitted.ok && submitted.renderId) {
              videoSlots--
              const tail = [capped.title, capped.description, capped.hashtags.join(' '), postLink(row.slug)].filter(Boolean).join('\n\n')
              await save(row, { video_stage: 'rendering', render_id: submitted.renderId, video_caption: fitCaption(tail, tightestLimit(VIDEO_PLATFORMS)) })
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
        // Sandbox renders carry Shotstack's watermark: keep the URL for review, never post it.
        await save(row, { video_url: status.url, video_stage: shotstackEnv() === 'v1' ? 'rendered' : 'sandbox' })
      } else if (status.ok && status.status === 'failed') {
        await fail(row, 'video', `Shotstack render failed: ${status.error ?? 'unknown reason'}`, true)
      } else if (Date.now() - Date.parse(row.updated_at) > RENDER_TIMEOUT_MS) {
        await fail(row, 'video', 'render did not finish within 30 minutes', true)
      }
    }
    if (row.video_stage === 'rendered' && row.video_url && target && target.videoPlatforms.length && Date.now() - startedAt < SOFT_DEADLINE_MS) {
      const result = await uploadPostSendVideo({ user: target.user, platforms: target.videoPlatforms, text: row.video_caption ?? row.slug, videoUrl: row.video_url })
      await settlePost(row, 'video', result, 'posted', save, fail, notes)
    }
  }

  return { note: `${enrolled} enrolled, ${rows.length} active${notes.length ? `; problems: ${notes.join(' | ')}` : ''}`, problems: notes }
}

async function settlePost(
  row: PipelineRow,
  key: 'carousel' | 'video',
  result: UploadPostSendResult,
  doneStage: 'posted',
  save: (row: PipelineRow, patch: Partial<PipelineRow>) => Promise<void>,
  fail: (row: PipelineRow, key: 'carousel' | 'video', error: string, permanent: boolean) => Promise<void>,
  notes: string[],
): Promise<void> {
  const stageKey = key === 'carousel' ? 'carousel_stage' : 'video_stage'
  if (result.ok) {
    await save(row, { [stageKey]: doneStage, last_error: result.confirmed === false ? 'Upload-Post accepted this but has not confirmed it posted yet.' : null } as Partial<PipelineRow>)
    return
  }
  if (result.dormant) return
  // A failed send is never blindly retried unless Upload-Post confirmed it is safe: a timeout may
  // still have created the post, and a duplicate public post is worse than a missed one.
  await fail(row, key, result.error ?? 'Upload-Post did not post it', result.retryable === false)
  notes.push(`${row.slug}: ${key} post failed`)
}
