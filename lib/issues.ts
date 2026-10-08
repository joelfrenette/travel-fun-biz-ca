import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { autopilotReadiness, VIDEO_BLOCK_KEY } from '@/lib/autopilot'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeAllCrons } from '@/lib/cron-health'
import { readLastPipelineRun } from '@/lib/pipeline-log'

// ONE list of everything that needs a human, gathered from every part of the pipeline: posts that
// failed to go out, carousels and videos that failed, a paused video step, scheduled jobs that went
// quiet or reported a problem, steps of the last pass that failed, and setup that is still missing.
// Each issue says what happened in plain words, what to do about it, and carries the button that
// does it. The Autopilot page shows this list; the alert email is built from it too.
export type IssueArea = 'post' | 'carousel' | 'video' | 'system' | 'setup'
export type IssueAction = 'retry-post' | 'retry-carousel' | 'retry-video' | 'resume-video' | 'dismiss-carousel' | 'dismiss-video'

export interface Issue {
  id: string
  area: IssueArea
  title: string
  detail: string
  /** What to do, in plain words. */
  fix?: string
  actions?: { label: string; kind: IssueAction; slug?: string }[]
}

/** Turns a raw provider error into advice. Falls back to no advice rather than guessing. */
function adviceFor(error: string): string | undefined {
  if (/None of your selected networks/i.test(error)) return 'Tick a network that takes this kind of post (Facebook, LinkedIn or Bluesky for text and photo posts) in "Where it posts".'
  if (/invalid platforms/i.test(error)) return 'One selected network cannot take this kind of post. Retry now skips it automatically and only sends to networks that have not received the post yet.'
  if (/\b(401|403)\b|rejected the (api )?key|unauthor/i.test(error)) return 'The provider rejected the key. Check the key in Vercel (and that it matches the environment), then press resume or retry.'
  if (/expired|reconnect|reauth/i.test(error)) return 'An account needs to be reconnected on the provider, then retry.'
  if (/not set|missing/i.test(error)) return 'A required key is missing in Vercel.'
  return undefined
}

export async function collectIssues(admin: SupabaseClient): Promise<Issue[]> {
  const issues: Issue[] = []

  // Posts that failed to go out (text/photo post to social).
  const { data: failedPosts } = await admin.from('post_distribution').select('slug, title, last_error').eq('content_type', 'post').eq('stage', 'failed')
  for (const r of (failedPosts ?? []) as { slug: string; title: string; last_error: string | null }[]) {
    const err = r.last_error ?? 'unknown error'
    issues.push({
      id: `post:${r.slug}`,
      area: 'post',
      title: `Post to social failed: ${r.title}`,
      detail: err,
      fix: adviceFor(err),
      actions: [{ label: 'Retry', kind: 'retry-post', slug: r.slug }],
    })
  }

  // Carousels and videos that failed, or are failing and being retried.
  const { data: rows } = await admin.from('content_pipeline').select('slug, carousel_stage, video_stage, last_error').not('last_error', 'is', null)
  const slugs = (rows ?? []).map((r: { slug: string }) => r.slug)
  const { data: posts } = slugs.length ? await admin.from('posts').select('slug, title').in('slug', slugs) : { data: [] }
  const titles = new Map((posts ?? []).map((p: { slug: string; title: string }) => [p.slug, p.title]))
  for (const r of (rows ?? []) as { slug: string; carousel_stage: string; video_stage: string; last_error: string }[]) {
    const name = titles.get(r.slug) ?? r.slug
    // The shared last_error belongs to whichever part is not healthy; failed wins, then a part that is still waiting.
    const part: 'carousel' | 'video' | null =
      r.video_stage === 'failed' ? 'video' : r.carousel_stage === 'failed' ? 'carousel' : ['pending', 'rendering', 'rendered'].includes(r.video_stage) ? 'video' : ['pending', 'generated'].includes(r.carousel_stage) ? 'carousel' : null
    if (!part) continue
    const failed = (part === 'video' ? r.video_stage : r.carousel_stage) === 'failed'
    issues.push({
      id: `${part}:${r.slug}`,
      area: part,
      title: `${part === 'video' ? 'Video' : 'Carousel'} ${failed ? 'failed' : 'is having trouble'}: ${name}`,
      detail: r.last_error,
      fix: adviceFor(r.last_error) ?? (failed ? undefined : 'It will try again on the next pass.'),
      actions: failed
        ? [
            { label: 'Retry', kind: part === 'video' ? 'retry-video' : 'retry-carousel', slug: r.slug },
            { label: 'Dismiss', kind: part === 'video' ? 'dismiss-video' : 'dismiss-carousel', slug: r.slug },
          ]
        : undefined,
    })
  }

  // Video steps paused after the provider rejected the key.
  const blockedUntil = Date.parse((await getSetting(admin, VIDEO_BLOCK_KEY)) ?? '')
  if (Number.isFinite(blockedUntil) && blockedUntil > Date.now()) {
    issues.push({
      id: 'system:video-paused',
      area: 'system',
      title: 'Video making is paused',
      detail: `Shotstack rejected the API key, so video steps are paused until ${new Date(blockedUntil).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' })}.`,
      fix: 'Check SHOTSTACK_API_KEY in Vercel (a sandbox key and a production key are different), then resume.',
      actions: [{ label: 'Resume now', kind: 'resume-video' }],
    })
  }

  // Scheduled jobs that went quiet or reported a problem.
  for (const c of judgeAllCrons(await readCronRuns(admin))) {
    if (c.light === 'amber') issues.push({ id: `system:cron-${c.name}`, area: 'system', title: `Scheduled job "${c.name}" needs a look`, detail: c.label })
  }

  // Steps of the last pass that failed (the carousel/video step is covered by the rows above).
  const last = await readLastPipelineRun(admin)
  for (const st of last?.steps ?? []) {
    if (!st.ok && st.step !== 'repurpose') issues.push({ id: `system:step-${st.step}`, area: 'system', title: `The "${st.step}" step failed on the last pass`, detail: st.note, fix: adviceFor(st.note) })
  }

  // Setup that is still missing.
  const ready = await autopilotReadiness(admin)
  ready.blockers.forEach((b, i) => issues.push({ id: `setup:blocker-${i}`, area: 'setup', title: 'Setup required', detail: b }))
  ready.warnings.forEach((w, i) => issues.push({ id: `setup:warning-${i}`, area: 'setup', title: 'Setup incomplete', detail: w }))

  return issues
}

/** Runs one of the actions an issue offers. Returns an error message, or null on success. */
export async function resolveIssue(admin: SupabaseClient, kind: IssueAction, slug?: string): Promise<string | null> {
  const now = new Date().toISOString()
  if (kind === 'resume-video') {
    const { error } = await setSetting(admin, VIDEO_BLOCK_KEY, '')
    return error ?? null
  }
  if (!slug) return 'A post is required.'
  if (kind === 'retry-post') {
    // sent_platforms is kept, so a retry only goes to networks that have not received the post.
    const { error } = await admin.from('post_distribution').update({ stage: 'queued', attempts: 0, last_error: null, updated_at: now }).eq('content_type', 'post').eq('slug', slug).eq('stage', 'failed')
    return error?.message ?? null
  }
  const part = kind.endsWith('video') ? 'video' : 'carousel'
  const stageKey = part === 'video' ? 'video_stage' : 'carousel_stage'
  const { data: row } = await admin.from('content_pipeline').select('attempts').eq('slug', slug).maybeSingle()
  if (!row) return 'That post is not in the pipeline.'
  const attempts = { ...((row.attempts as Record<string, number>) ?? {}) }
  delete attempts[part]
  const patch = kind.startsWith('dismiss')
    ? { [stageKey]: 'skipped', last_error: null, updated_at: now }
    : { [stageKey]: 'pending', attempts, last_error: null, updated_at: now }
  const { error } = await admin.from('content_pipeline').update(patch).eq('slug', slug).eq(stageKey, 'failed')
  return error?.message ?? null
}
