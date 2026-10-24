import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { isAutopilotOn, getVideosPerWeek } from '@/lib/autopilot'
import { AUTOBLOG_MODE_KEY, postsWrittenToday } from '@/lib/autoblog-run'
import { getAutoblogPostsPerWeek, getAutoblogMaxPerDay, isPublishDayDue, currentWeekday } from '@/lib/autoblog-cadence'
import { dueApprovedTopics } from '@/lib/blog-topics'
import { checkCadence, postLimits } from '@/lib/publish-cadence'
import { getDistributionMode, listDistributionQueue, getDistributionPlatforms } from '@/lib/distribution'
import { APPROVED_POLICIES, POLICY_LABELS, policyGate } from '@/lib/auto-decisions'
import { getKeywordBudget, readKeywordRefreshInfo } from '@/lib/keyword-refresh'
import { isKeywordDataConfigured } from '@/lib/keywords'
import { getNewsMode } from '@/lib/news-settings'
import { collectIssues } from '@/lib/issues'
import { HARD_WAITING_ISSUE_ID, CANNIBALISATION_ISSUE_ID, NOT_INDEXED_ISSUE_ID } from '@/lib/plain-steps'
import { readAiSpend } from '@/lib/ai-tripwire'
import { LAST_ALERT_KEY, THROTTLE_MS } from '@/lib/alerts'
import { autoblogNudgePending } from '@/lib/funnel-watchdog'
import { rehearsalEffects, setDryStep, withDryRun, type Effects } from '@/lib/dry-run'
import { PLANNED_AI_USD, judgeCeiling, type DryPass, type DryStepNote } from '@/lib/dry-run-shape'

// The rehearsal of ONE autopilot pass (lib/pipeline.ts runs this instead of the real steps while the dry run switch is on).
// It mirrors the order and the decisions of runPipeline, but only READS: every "would do" goes through the typed Effects
// (lib/dry-run.ts), which in a rehearsal records the intent and calls nothing real. No AI call, no write to a content table,
// no social post, no email, no automatic decision, no counter moved.
//
// What is rehearsed in detail: keywords, write (mode, publish hour, publish day, daily count, publish spacing, which topic), the
// automatic decisions (each policy's switch and daily room), post to social (the real queue), carousels and videos (counts),
// self-repair (leads that never reached GoHighLevel), and the alert email (the real open items and the 6 hour throttle).
// What is only named, not detailed: the guides, page copy, travel news and content heal steps (each has its own caps and
// "is it due" claim inside its own module; they are reported as "would run if due, may call the AI").

/** Same value as runPipeline: scheduled passes only write from this UTC hour. */
const PUBLISH_HOUR_UTC = 13
/** An old keyword week is due again after this long. */
const KEYWORD_WEEK_MS = 7 * 86_400_000

export interface PlanFacts {
  now: Date
  trigger: 'schedule' | 'button'
  autopilotOn: boolean
  paused: boolean
  keyword: { configured: boolean; budgetUsd: number; lastRunAt: string | null }
  write: {
    mode: 'off' | 'draft' | 'publish'
    postsPerWeek: number
    weekday: number
    wroteToday: number | null
    maxPerDay: number
    /** Publish spacing in publish mode: null when not applicable. */
    slot: { allowed: boolean; note: string } | null
    nudged: boolean
    /** The next approved topic that is due, or null. */
    topic: { id: string; angle: string } | null
  }
  policies: { policy: string; label: string; allowed: boolean; room: number; reason: string }[]
  topicsPending: number
  distribution: {
    mode: 'off' | 'prepare' | 'auto'
    platforms: string[]
    queued: { slug: string; title: string }[]
    held: number
    failed: number
  }
  repurpose: { carouselsPending: number; videosPending: number; videosPerWeek: number }
  leadsUnsent: number | null
  newsMode: 'off' | 'draft' | 'publish'
  alerts: { open: number; throttled: boolean }
  spend: { spendUsd: number | null; ceilingUsd: number }
}

/** Pure: the rehearsal. Everything it "does" goes through `fx`; it returns the step notes and the AI calls it would make. */
export async function planPass(f: PlanFacts, fx: Effects): Promise<{ steps: DryStepNote[]; aiCalls: number; plannedUsd: number }> {
  const steps: DryStepNote[] = []
  let aiCalls = 0
  let plannedUsd = 0
  const say = (step: string, note: string) => {
    steps.push({ step, note })
  }
  const willCallAi = async (step: string, purpose: string, usd: number) => {
    aiCalls += 1
    plannedUsd += usd
    await fx.callAi({ purpose, estUsd: usd })
    void step
  }

  // Housekeeping runs whether or not Autopilot is on, so it is rehearsed at the end for every path.
  const housekeeping = async () => {
    setDryStep('heal')
    if (f.leadsUnsent === null) say('heal', 'Self-repair: could not count the leads that never reached GoHighLevel.')
    else if (f.leadsUnsent > 0) {
      say('heal', `Self-repair: would re-send ${f.leadsUnsent} lead${f.leadsUnsent === 1 ? '' : 's'} that never reached GoHighLevel.`)
      await fx.applyHeal({ what: `Re-send ${f.leadsUnsent} lead${f.leadsUnsent === 1 ? '' : 's'} to GoHighLevel` })
    } else say('heal', 'Self-repair: nothing is waiting.')
    setDryStep('debrief')
    say('debrief', 'Daily brief email, performance snapshot, publish check and the other once-a-day jobs are not run in a dry run.')
  }

  const alertStep = async () => {
    setDryStep('alerts')
    if (f.alerts.open === 0) say('alerts', 'Alert email: nothing needs attention, so no email.')
    else if (f.alerts.throttled) say('alerts', `Alert email: ${f.alerts.open} item${f.alerts.open === 1 ? '' : 's'} need attention, but one went out in the last 6 hours, so none would be sent.`)
    else {
      say('alerts', `Alert email: would email about ${f.alerts.open} item${f.alerts.open === 1 ? '' : 's'} that need attention.`)
      await fx.sendEmail({ subject: `Autopilot: ${f.alerts.open} thing${f.alerts.open === 1 ? '' : 's'} need${f.alerts.open === 1 ? 's' : ''} attention` })
    }
  }

  if (!f.autopilotOn) {
    say('write', 'Autopilot is off, so nothing would be written or posted.')
    await housekeeping()
    await alertStep()
    return { steps, aiCalls, plannedUsd }
  }
  if (f.paused) {
    say('write', 'Automation is paused (Pause all automation is on), so nothing would be written or posted.')
    await housekeeping()
    await alertStep()
    return { steps, aiCalls, plannedUsd }
  }

  // 0. KEYWORDS
  setDryStep('keywords')
  const lastKw = Date.parse(f.keyword.lastRunAt ?? '')
  const kwDue = !Number.isFinite(lastKw) || f.now.getTime() - lastKw >= KEYWORD_WEEK_MS
  if (!f.keyword.configured) say('keywords', 'Keyword research: no keyword data account is set up, so nothing would run.')
  else if (f.keyword.budgetUsd <= 0) say('keywords', 'Keyword research: the weekly budget is off, so nothing would run.')
  else if (!kwDue) say('keywords', 'Keyword research: already done this week.')
  else {
    say('keywords', `Keyword research: would run now, up to $${f.keyword.budgetUsd.toFixed(2)} of paid lookups.`)
    await willCallAi('keywords', `weekly keyword research (up to $${f.keyword.budgetUsd.toFixed(2)})`, Math.min(f.keyword.budgetUsd, PLANNED_AI_USD.keywords))
  }

  // 1. WRITE
  setDryStep('write')
  const w = f.write
  const button = f.trigger === 'button'
  // The button and the funnel watchdog's one extra run both skip the day, daily count and spacing rules (runAutoblog scheduled: false).
  const manual = button || w.nudged
  if (w.mode === 'off') say('write', 'Write: the blog writer is off, so no post would be written.')
  else if (!button && f.now.getUTCHours() < PUBLISH_HOUR_UTC) say('write', `Write: waiting for ${PUBLISH_HOUR_UTC}:00 UTC, so nothing would be written yet.`)
  else if (!manual && !isPublishDayDue(w.postsPerWeek, w.weekday)) say('write', `Write: not a publish day at ${w.postsPerWeek} posts a week.`)
  else if (!manual && w.wroteToday === null) say('write', 'Write: could not check whether a post was already written today, so nothing would be written.')
  else if (!manual && (w.wroteToday ?? 0) > 0 && (w.wroteToday ?? 0) >= w.maxPerDay) say('write', `Write: already wrote ${w.wroteToday} post${w.wroteToday === 1 ? '' : 's'} today (the limit is ${w.maxPerDay}).`)
  else if (!manual && (w.wroteToday ?? 0) > 0 && !w.topic) say('write', 'Write: an extra post today is only written from an approved topic, and none is waiting.')
  else if (!manual && w.mode === 'publish' && w.slot && !w.slot.allowed) say('write', `Write: publishing would be put off (${w.slot.note}).`)
  else {
    const title = w.topic ? w.topic.angle : '(a topic from keyword research or the AI)'
    say('write', w.topic ? `Write: would write "${w.topic.angle}" from your approved topics and ${w.mode === 'publish' ? 'publish it' : 'save it as a draft'}.` : `Write: would pick a topic from keyword research or ask the AI for one, write it and ${w.mode === 'publish' ? 'publish it' : 'save it as a draft'}.`)
    if (!w.topic) await willCallAi('write', 'choose a topic (keyword research or an AI suggestion)', 0.02)
    await willCallAi('write', `write the post "${title}" with its title, meta text, slug, tags and cover image`, PLANNED_AI_USD.write)
    await fx.publishPost({ slug: '(new post)', title, as: w.mode === 'publish' ? 'published' : 'draft' })
    if (w.topic) await fx.setTopicStatus({ id: w.topic.id, status: 'used' })
    if (w.mode === 'publish') await fx.advanceCounter({ key: 'publish_cadence_log' })
  }

  // 1b to 1d. Only named, not detailed.
  setDryStep('guides')
  say('guides', 'Guides, page copy and heal content: each would run only if it is due and inside its own weekly and daily limits. They may call the AI. Not rehearsed in detail.')
  setDryStep('news')
  say('news', f.newsMode === 'off' ? 'Travel news: the mode is off, so nothing would run.' : `Travel news: the mode is ${f.newsMode}. It would read the allowed feeds and may call the AI. Not rehearsed in detail.`)

  // 1e. AUTOMATIC DECISIONS
  setDryStep('auto')
  const parts: string[] = []
  for (const p of f.policies) {
    if (!p.allowed) {
      parts.push(`${p.label}: would not act (${p.reason})`)
      continue
    }
    if (p.policy === 'approve_safe_topics' && f.topicsPending > 0) {
      const n = Math.min(p.room, f.topicsPending)
      parts.push(`${p.label}: would act on up to ${n} topic${n === 1 ? '' : 's'}`)
      await fx.applyDecision({ policy: p.policy, subject: `up to ${n} safe topic${n === 1 ? '' : 's'} from the pending list` })
    } else if (p.policy === 'retry_failed_posts' && f.distribution.failed > 0) {
      const n = Math.min(p.room, f.distribution.failed)
      parts.push(`${p.label}: would act on up to ${n} failed post${n === 1 ? '' : 's'}`)
      await fx.applyDecision({ policy: p.policy, subject: `retry up to ${n} failed post${n === 1 ? '' : 's'}` })
    } else {
      parts.push(`${p.label}: allowed, room for ${p.room}, nothing found yet to act on`)
    }
  }
  say('auto', parts.length ? `Automatic decisions: ${parts.join('. ')}.` : 'Automatic decisions: none to check.')

  // 2. POST
  setDryStep('post')
  const d = f.distribution
  if (d.mode === 'off') say('post', 'Post to social: distribution is off, so nothing would be sent.')
  else if (d.mode === 'prepare') say('post', `Post to social: review mode. ${d.held} post${d.held === 1 ? ' is' : 's are'} waiting for your OK on the Distribution page. Nothing would be sent.`)
  else if (d.queued.length === 0) say('post', 'Post to social: nothing is queued.')
  else {
    const batch = d.queued.slice(0, 5)
    say('post', `Post to social: would send ${batch.length} queued post${batch.length === 1 ? '' : 's'} to ${d.platforms.join(', ') || 'the chosen accounts'}.`)
    for (const row of batch) await fx.sendSocial({ network: d.platforms.join(', ') || 'chosen accounts', what: `"${row.title}" (${row.slug})` })
  }

  // 3. REPURPOSE
  setDryStep('repurpose')
  const r = f.repurpose
  say('repurpose', `Carousel and video: ${r.carouselsPending} carousel${r.carouselsPending === 1 ? '' : 's'} and ${r.videosPending} video${r.videosPending === 1 ? '' : 's'} are waiting (videos per week: ${r.videosPerWeek}). A dry run makes and posts none of them.`)

  await housekeeping()
  await alertStep()
  return { steps, aiCalls, plannedUsd }
}

// ---------------------------------------------------------------------------------------------------
// Reading the facts (read only)
// ---------------------------------------------------------------------------------------------------

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Reads everything the rehearsal needs. READ ONLY: selects and settings reads, nothing else. A read that fails becomes the safest answer. */
export async function readPlanFacts(admin: SupabaseClient, trigger: 'schedule' | 'button', now: Date = new Date()): Promise<PlanFacts> {
  const rawMode = await safe(() => getSetting(admin, AUTOBLOG_MODE_KEY), null)
  const mode: 'off' | 'draft' | 'publish' = rawMode === 'draft' || rawMode === 'publish' ? rawMode : 'off'

  const [autopilotOn, paused, kwBudget, kwInfo, postsPerWeek, maxPerDay, wroteToday, dueTopics, nudged] = await Promise.all([
    safe(() => isAutopilotOn(admin), false),
    safe(() => isAutomationPaused(admin), true),
    safe(() => getKeywordBudget(admin), 0),
    safe(() => readKeywordRefreshInfo(admin), { lastRunAt: null as string | null, log: [] }),
    safe(() => getAutoblogPostsPerWeek(admin), 3),
    safe(() => getAutoblogMaxPerDay(admin), 1),
    safe(() => postsWrittenToday(admin as never), null as number | null),
    safe(() => dueApprovedTopics(admin), []),
    safe(() => autoblogNudgePending(admin, now), false),
  ])
  const slot = mode === 'publish' ? await safe(async () => {
    const s = await checkCadence(admin, 'post', postLimits(), now)
    return { allowed: s.allowed, note: s.allowed ? 'ok' : s.note }
  }, { allowed: false, note: 'could not read the publishing history' }) : null

  const policies = await Promise.all(
    APPROVED_POLICIES.map(async (policy) => {
      const g = await policyGate(admin, policy, now)
      return { policy: policy as string, label: POLICY_LABELS[policy], allowed: g.allowed, room: g.room, reason: g.reason }
    }),
  )
  const topicsPending = await safe(async () => {
    const { count, error } = await admin.from('blog_topic_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    return error ? 0 : count ?? 0
  }, 0)

  const dMode = await safe(() => getDistributionMode(admin), 'off' as const)
  const queue = dMode === 'off' ? [] : await safe(() => listDistributionQueue(admin), [])
  const platforms = await safe(() => getDistributionPlatforms(admin), [] as string[])

  const repurpose = await safe(async () => {
    const { data } = await admin.from('content_pipeline').select('carousel_stage, video_stage').limit(200)
    const rows = (data ?? []) as { carousel_stage: string; video_stage: string }[]
    return {
      carouselsPending: rows.filter((x) => x.carousel_stage === 'pending').length,
      videosPending: rows.filter((x) => x.video_stage === 'pending').length,
      videosPerWeek: await getVideosPerWeek(admin),
    }
  }, { carouselsPending: 0, videosPending: 0, videosPerWeek: 0 })

  const leadsUnsent = await safe(async () => {
    const { count, error } = await admin
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('forwarded_to_ghl', false)
      .lt('created_at', new Date(now.getTime() - 5 * 60_000).toISOString())
      .gt('created_at', new Date(now.getTime() - 48 * 3_600_000).toISOString())
    return error ? null : count ?? 0
  }, null as number | null)

  const open = await safe(
    async () => (await collectIssues(admin)).filter((i) => i.area !== 'setup' && i.id !== HARD_WAITING_ISSUE_ID && i.id !== CANNIBALISATION_ISSUE_ID && i.id !== NOT_INDEXED_ISSUE_ID).length,
    0,
  )
  const lastAlert = Date.parse((await safe(() => getSetting(admin, LAST_ALERT_KEY), null)) ?? '')
  const throttled = Number.isFinite(lastAlert) && now.getTime() - lastAlert < THROTTLE_MS

  const spend = await readAiSpend(admin, now.getTime())

  return {
    now,
    trigger,
    autopilotOn,
    paused,
    keyword: { configured: isKeywordDataConfigured(), budgetUsd: kwBudget, lastRunAt: kwInfo.lastRunAt },
    write: { mode, postsPerWeek, weekday: currentWeekday(now), wroteToday, maxPerDay, slot, nudged, topic: dueTopics[0] ? { id: dueTopics[0].id, angle: dueTopics[0].angle } : null },
    policies,
    topicsPending,
    distribution: {
      mode: dMode,
      platforms,
      queued: queue.filter((r) => r.stage === 'queued').map((r) => ({ slug: r.slug, title: r.title })),
      held: queue.filter((r) => r.stage === 'held').length,
      failed: queue.filter((r) => r.stage === 'failed').length,
    },
    repurpose,
    leadsUnsent,
    newsMode: await safe(() => getNewsMode(admin), 'off' as const),
    alerts: { open, throttled },
    spend: { spendUsd: spend.spend, ceilingUsd: spend.ceiling },
  }
}

/** One whole dry pass: read the facts, rehearse inside the gate, judge the ceiling. Makes no outside effect. */
export async function runDryPass(admin: SupabaseClient, trigger: 'schedule' | 'button', now: Date = new Date()): Promise<DryPass> {
  const facts = await readPlanFacts(admin, trigger, now)
  const { result, intents } = await withDryRun(() => planPass(facts, rehearsalEffects()))
  const ceiling = judgeCeiling(facts.spend.spendUsd, facts.spend.ceilingUsd, result.plannedUsd)
  return { at: now.toISOString(), trigger, steps: result.steps, intents, aiCalls: result.aiCalls, ceiling }
}
