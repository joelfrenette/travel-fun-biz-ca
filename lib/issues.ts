import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { autopilotReadiness, VIDEO_BLOCK_KEY } from '@/lib/autopilot'
import { MAIL_ERROR_KEY } from '@/lib/alerts'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeAllCrons } from '@/lib/cron-health'
import { readLastPipelineRun } from '@/lib/pipeline-log'
import { getProvider, getGhlAccounts } from '@/lib/social-provider'
import { ghlListFailedPosts, ghlListPublishedPosts } from '@/lib/ghl-social'
import { readGuideFailures, readGuideFailuresChecked, clearAllGuideFailures, MAX_GUIDE_ATTEMPTS } from '@/lib/guide-failures'
import { readCopyFailures, readCopyFailuresChecked, clearAllCopyFailures, MAX_COPY_ATTEMPTS } from '@/lib/page-copy-failures'

// ONE list of everything that needs a human, gathered from every part of the pipeline: posts that
// failed to go out, carousels and videos that failed, a paused video step, scheduled jobs that went
// quiet or reported a problem, steps of the last pass that failed, and setup that is still missing.
// Each issue says what happened in plain words, what to do about it, and carries the button that
// does it. The Autopilot page shows this list; the alert email is built from it too.
const GHL_DISMISSED_KEY = 'ghl_dismissed_failures'

export type IssueArea = 'post' | 'carousel' | 'video' | 'system' | 'setup'
export type IssueAction = 'dismiss-ghl' | 'retry-post' | 'retry-carousel' | 'retry-video' | 'resume-video' | 'dismiss-carousel' | 'dismiss-video' | 'dismiss-guides' | 'dismiss-page-copy'

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
  // The dedicated guide item below replaces the step item only when the failure list was readable and has
  // entries; otherwise the step item is the only trace, so it stays.
  const guideRead = await readGuideFailuresChecked(admin)
  const guideItemCovers = !guideRead.error && Object.keys(guideRead.failures).length > 0
  const copyRead = await readCopyFailuresChecked(admin)
  const copyItemCovers = !copyRead.error && Object.keys(copyRead.failures).length > 0
  for (const st of last?.steps ?? []) {
    // An email delivery failure is shown once, as "Emails from Aiva are not being delivered" below.
    // A failed guide WRITE has its own item below (it names the guide and the reason); any other guides-step
    // failure (for example the table cannot be read) still shows here.
    if (!st.ok && st.step !== 'repurpose' && !(st.step === 'guides' && guideItemCovers && /^could not write/.test(st.note)) && !(st.step === 'copy' && copyItemCovers && /^could not write/.test(st.note)) && !(st.step === 'debrief' && /Resend said/.test(st.note))) issues.push({ id: `system:step-${st.step}`, area: 'system', title: `The "${st.step}" step failed on the last pass`, detail: st.note, fix: adviceFor(st.note) })
  }

  // Guide pages (destinations, hotels, ships ...) that could not be written. One item lists them all.
  const guideFailures = Object.values(await readGuideFailures(admin))
  if (guideFailures.length) {
    issues.push({
      id: 'system:guides-failing',
      area: 'system',
      title: `${guideFailures.length} guide page${guideFailures.length === 1 ? '' : 's'} could not be written`,
      detail: guideFailures.map((f) => `${f.name} (${f.kind}, tried ${f.n} time${f.n === 1 ? '' : 's'}): ${f.last}`).join(' | '),
      fix: `A guide is skipped after ${MAX_GUIDE_ATTEMPTS} failed tries so it cannot keep spending AI credits. Check ANTHROPIC_API_KEY in Vercel; click Dismiss to let them be tried again.`,
      actions: [{ label: 'Dismiss', kind: 'dismiss-guides' }],
    })
  }

  // Compare and best-time page copy that could not be written. One item lists them all.
  const copyFailures = Object.values(await readCopyFailures(admin))
  if (copyFailures.length) {
    issues.push({
      id: 'system:page-copy-failing',
      area: 'system',
      title: `${copyFailures.length} page${copyFailures.length === 1 ? '' : 's'} could not get written copy`,
      detail: copyFailures.map((f) => `${f.path} (tried ${f.n} time${f.n === 1 ? '' : 's'}): ${f.last}`).join(' | '),
      fix: `A page is skipped after ${MAX_COPY_ATTEMPTS} failed tries so it cannot keep spending AI credits. Check ANTHROPIC_API_KEY in Vercel; click Dismiss to let them be tried again.`,
      actions: [{ label: 'Dismiss', kind: 'dismiss-page-copy' }],
    })
  }

  // Posts GoHighLevel accepted and then failed to publish (the network's rejection arrives later), for
  // the accounts you ticked only - the same GoHighLevel location holds other businesses' accounts.
  if ((await getProvider(admin)) === 'ghl') {
    const ours = new Set((await getGhlAccounts(admin)).map((a) => a.id))
    let dismissed: string[] = []
    try {
      dismissed = JSON.parse((await getSetting(admin, GHL_DISMISSED_KEY)) ?? '[]')
    } catch {
      dismissed = []
    }
    // Self-healing: a failure is hidden once the same network has the same blog post (and kind of post)
    // published AFTER it, so a retry that worked clears the old error without anyone clicking Dismiss.
    // If the published list cannot be read, nothing is hidden (the error stays visible).
    const blogSlugOf = (t: string) => /\/blog\/([a-z0-9][a-z0-9-]*)/i.exec(t)?.[1] ?? null
    const published = await ghlListPublishedPosts(3)
    for (const f of await ghlListFailedPosts(3)) {
      if (!ours.has(f.accountId) || dismissed.includes(f.id)) continue
      const slug = blogSlugOf(f.text)
      if (slug && published.some((p) => p.platform === f.platform && p.kind === f.kind && p.accountId === f.accountId && blogSlugOf(p.text) === slug && p.at > f.at)) continue
      issues.push({
        id: `ghl:${f.id}`,
        area: 'post',
        title: `${f.platform[0].toUpperCase()}${f.platform.slice(1)} rejected a post from GoHighLevel`,
        detail: f.error,
        fix: /verified domain/i.test(f.error)
          ? 'TikTok only takes videos hosted on a domain it trusts. The video is now hosted on GoHighLevel first (needs the media library permission on your GHL token), so a new video should go through.'
          : adviceFor(f.error),
        // Dismiss only: a one-click re-send of a single network was built and then removed (2026-10-09),
        // because the QA review found it could double-post and every fix made it more complex.
        actions: [{ label: 'Dismiss', kind: 'dismiss-ghl', slug: f.id }],
      })
    }
  }

  // Email that could not be delivered (alerts and the daily brief). An email problem cannot be reported
  // by email, so it is shown here, and cleared the next time an email goes through.
  const mailError = (await getSetting(admin, MAIL_ERROR_KEY))?.trim()
  if (mailError) {
    issues.push({
      id: 'system:mail-blocked',
      area: 'system',
      title: 'Emails from Aiva are not being delivered',
      detail: mailError,
      fix: 'Verify your domain in Resend, or point the emails at the Resend account owner address. Steps are in the daily brief and below.',
    })
  }

  // Leads that were saved here but never reached GoHighLevel. They are safe in the leads table, but
  // nobody is following them up in the CRM until they are sent on.
  const { data: unsent } = await admin.from('leads').select('ghl_error, created_at').eq('is_test', false).eq('forwarded_to_ghl', false).gte('created_at', new Date(Date.now() - 14 * 86_400_000).toISOString()).order('created_at', { ascending: false }).limit(50)
  if (unsent?.length) {
    const reason = (unsent[0] as { ghl_error: string | null }).ghl_error ?? 'no reason recorded'
    issues.push({
      id: 'system:leads-not-forwarded',
      area: 'system',
      title: `${unsent.length} lead${unsent.length === 1 ? '' : 's'} saved but not sent to GoHighLevel`,
      detail: `Latest reason: ${reason}. They are safe on the Leads page in the admin.`,
      fix: adviceFor(reason) ?? 'Open the Leads page, copy the contact into GoHighLevel by hand, and check the GoHighLevel keys in Vercel.',
    })
  }

  // Setup that is still missing.
  const ready = await autopilotReadiness(admin)
  ready.blockers.forEach((b, i) => issues.push({ id: `setup:blocker-${i}`, area: 'setup', title: 'Setup required', detail: b }))
  ready.warnings.forEach((w, i) => issues.push({ id: `setup:warning-${i}`, area: 'setup', title: 'Setup incomplete', detail: w }))

  return issues
}

async function dismissGhl(admin: SupabaseClient, id: string): Promise<string | null> {
  let list: string[] = []
  try {
    list = JSON.parse((await getSetting(admin, GHL_DISMISSED_KEY)) ?? '[]')
  } catch {
    list = []
  }
  const { error } = await setSetting(admin, GHL_DISMISSED_KEY, JSON.stringify([...new Set([...list, id])].slice(-200)))
  return error ?? null
}

/** Runs one of the actions an issue offers. Returns an error message, or null on success. */
export async function resolveIssue(admin: SupabaseClient, kind: IssueAction, slug?: string): Promise<string | null> {
  const now = new Date().toISOString()
  if (kind === 'resume-video') {
    const { error } = await setSetting(admin, VIDEO_BLOCK_KEY, '')
    return error ?? null
  }
  if (kind === 'dismiss-guides') return (await clearAllGuideFailures(admin)).error ?? null
  if (kind === 'dismiss-page-copy') return (await clearAllCopyFailures(admin)).error ?? null
  if (!slug) return 'A post is required.'
  if (kind === 'dismiss-ghl') return dismissGhl(admin, slug)
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
