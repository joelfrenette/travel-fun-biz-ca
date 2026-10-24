// Offline check for the autopilot DRY RUN (lib/dry-run.ts, lib/dry-run-shape.ts, lib/dry-run-plan.ts).
// Run: pnpm dlx tsx scripts/check-dry-run.ts   (exit 1 on a failure)
//
// Proved here, with fakes only (no database, no network, no AI):
//  - switch ON: not one real effect function is invoked, the intents are recorded instead;
//  - switch OFF: every effect passes straight through, arguments unchanged;
//  - the real choke points (alert email, social posts, topic status, automatic decisions, self-repair, publish counter, post save)
//    do nothing inside a dry pass and behave as before outside it;
//  - the rehearsal of a whole pass (planPass) calls no real effect, and reports the topic, post, social, repair and decision it would take;
//  - the daily spend ceiling line ("would exceed") and the System check line (amber after 24 hours, real hours, grade 6 wording);
//  - the settings: fail-safe read, since-time, bounded 5-pass log.
import {
  DRY_LOG_MAX, DRY_INTENTS_MAX, DRY_RUN_BANNER_BODY, DRY_RUN_BANNER_TITLE, DRY_RUN_EXPLAINER, appendDryPass, ceilingSentence, dryRunHours, dryRunSentence, judgeCeiling, parseDryLog,
  type DryPass, type EffectKind,
} from '../lib/dry-run-shape'
import { blockIfDry, guardEffects, isDryRunActive, isDryRunSwitchOn, readDryLog, recordDryPass, rehearsalEffects, setDryRun, withDryRun, type Effects } from '../lib/dry-run'
import { planPass, type PlanFacts } from '../lib/dry-run-plan'
import { sendThrottledAlert } from '../lib/alerts'
import { ghlCreatePost } from '../lib/ghl-social'
import { uploadPostSendPhotos } from '../lib/upload-post'
import { setTopicStatus } from '../lib/blog-topics'
import { appendDecisions } from '../lib/auto-decisions'
import { selfHeal } from '../lib/heal'
import { recordPublish } from '../lib/publish-cadence'
import { createPost } from '../lib/posts'
import { evaluateCheck, type CheckFacts, type WatchdogLike } from '../lib/system-check'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

// ---- a fake database: app_settings in memory, every other write counted ---------------------------------
function fakeAdmin() {
  const settings = new Map<string, string>()
  const state = { writes: 0, settingWrites: 0, reads: 0 }
  const admin = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      let key: string | null = null
      chain.select = () => chain
      chain.eq = (_c: string, v: string) => {
        key = v
        return chain
      }
      chain.maybeSingle = async () => {
        state.reads++
        return { data: table === 'app_settings' && key !== null && settings.has(key) ? { value: settings.get(key) } : null, error: null }
      }
      chain.upsert = async (row: { key: string; value: string }) => {
        if (table === 'app_settings') {
          settings.set(row.key, row.value)
          state.settingWrites++
        } else state.writes++
        return { error: null }
      }
      chain.update = () => {
        state.writes++
        return chain
      }
      chain.insert = async () => {
        state.writes++
        return { error: null }
      }
      chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null, count: 0 })
      return chain
    },
  }
  return { admin: admin as never, settings, state }
}

async function main() {
  // ---- 1. guardEffects: ON never reaches the real thing, OFF passes through --------------------------
  const names = ['publishPost', 'sendSocial', 'sendEmail', 'applyHeal', 'applyDecision', 'setTopicStatus', 'advanceCounter', 'callAi'] as const
  const calls: { name: string; arg: unknown }[] = []
  const counting = Object.fromEntries(names.map((n) => [n, async (arg: unknown) => void calls.push({ name: n, arg })])) as unknown as Effects
  const inputs: Record<(typeof names)[number], unknown> = {
    publishPost: { slug: 's', title: 'T', as: 'published' },
    sendSocial: { network: 'instagram', what: 'x' },
    sendEmail: { subject: 'S' },
    applyHeal: { what: 'h' },
    applyDecision: { policy: 'p', subject: 's' },
    setTopicStatus: { id: '1', status: 'used' },
    advanceCounter: { key: 'k' },
    callAi: { purpose: 'p' },
  }
  const seen: { kind: EffectKind; detail: string }[] = []
  const on = guardEffects(counting, () => true, (i) => void seen.push(i))
  for (const n of names) await (on[n] as (a: unknown) => Promise<void>)(inputs[n])
  expect('switch ON: no real effect function is invoked (all 8)', calls.length === 0, `${calls.length} real calls`)
  expect('switch ON: every effect is recorded as an intent', seen.length === 8 && new Set(seen.map((s) => s.kind)).size === 8, JSON.stringify(seen.map((s) => s.kind)))

  const off = guardEffects(counting, () => false, (i) => void seen.push(i))
  const before = seen.length
  for (const n of names) await (off[n] as (a: unknown) => Promise<void>)(inputs[n])
  expect('switch OFF: every effect passes straight through (all 8)', calls.length === 8 && names.every((n, i) => calls[i].name === n), `${calls.length} calls`)
  expect('switch OFF: arguments reach the real function unchanged', names.every((n, i) => calls[i].arg === inputs[n]))
  expect('switch OFF: nothing is recorded as an intent', seen.length === before)

  // The switch is asked on every call: flipping it mid-pass takes effect at once.
  let flag = false
  const flip = guardEffects(counting, () => flag, () => undefined)
  calls.length = 0
  await flip.sendEmail({ subject: 'a' })
  flag = true
  await flip.sendEmail({ subject: 'b' })
  expect('the switch is read on every call (off then on: one real call, one blocked)', calls.length === 1)

  // ---- 2. the rehearsal of a whole pass ---------------------------------------------------------------
  const FACTS: PlanFacts = {
    now: new Date('2026-10-24T15:00:00Z'),
    trigger: 'schedule',
    autopilotOn: true,
    paused: false,
    keyword: { configured: true, budgetUsd: 1, lastRunAt: null },
    write: { mode: 'publish', postsPerWeek: 7, weekday: 6, wroteToday: 0, maxPerDay: 1, slot: { allowed: true, note: 'ok' }, nudged: false, topic: { id: 't1', angle: 'Best time to visit Croatia' } },
    policies: [
      { policy: 'approve_safe_topics', label: 'Approve safe blog topics from Google data', allowed: true, room: 2, reason: 'allowed' },
      { policy: 'retry_failed_posts', label: 'Retry failed posts and resume stuck steps', allowed: true, room: 6, reason: 'allowed' },
      { policy: 'publish_passing_news', label: 'Publish news briefs that passed every check', allowed: false, room: 0, reason: 'this automatic decision is switched off' },
    ],
    topicsPending: 3,
    distribution: { mode: 'auto', platforms: ['instagram', 'facebook'], queued: [{ slug: 'a', title: 'Post A' }, { slug: 'b', title: 'Post B' }], held: 0, failed: 1 },
    repurpose: { carouselsPending: 1, videosPending: 1, videosPerWeek: 3 },
    leadsUnsent: 2,
    newsMode: 'publish',
    alerts: { open: 2, throttled: false },
    spend: { spendUsd: 4.5, ceilingUsd: 5 },
  }
  calls.length = 0
  const passOn = await planPass(FACTS, guardEffects(counting, () => true, () => undefined))
  expect('planPass with the switch ON invokes no real effect', calls.length === 0, `${calls.length} real calls`)
  const rehearsal = await withDryRun(() => planPass(FACTS, rehearsalEffects()))
  const kinds = new Set(rehearsal.intents.map((i) => i.kind))
  expect('rehearsal reports the post it would publish', rehearsal.intents.some((i) => i.kind === 'publish-post' && i.detail.includes('Best time to visit Croatia') && i.detail.startsWith('Publish')))
  expect('rehearsal reports the topic it would use up', rehearsal.intents.some((i) => i.kind === 'topic-status' && i.detail.includes('t1')))
  expect('rehearsal reports the social posts it would send', rehearsal.intents.filter((i) => i.kind === 'social-post').length === 2)
  expect('rehearsal reports the repair it would apply', rehearsal.intents.some((i) => i.kind === 'heal-write' && i.detail.includes('2 leads')))
  expect('rehearsal reports the automatic decisions it would take', rehearsal.intents.filter((i) => i.kind === 'apply-decision').length === 2)
  expect('rehearsal reports the alert email it would send', rehearsal.intents.some((i) => i.kind === 'email'))
  expect('rehearsal reports the publish counter it would move', rehearsal.intents.some((i) => i.kind === 'counter'))
  expect('rehearsal says "would call AI" and counts the calls instead of making them', kinds.has('ai-call') && rehearsal.result.aiCalls === rehearsal.intents.filter((i) => i.kind === 'ai-call').length && rehearsal.result.aiCalls >= 2)
  expect('every intent names its step', rehearsal.intents.every((i) => i.step.length > 0 && i.step !== 'dry run'))
  expect('planPass is deterministic for the same facts', JSON.stringify(passOn.steps) === JSON.stringify(rehearsal.result.steps))
  const quiet = await withDryRun(() => planPass({ ...FACTS, autopilotOn: false }, rehearsalEffects()))
  expect('Autopilot off: no post, no social, no AI in the rehearsal', !quiet.intents.some((i) => ['publish-post', 'social-post', 'ai-call', 'topic-status', 'apply-decision'].includes(i.kind)))
  const paused = await withDryRun(() => planPass({ ...FACTS, paused: true }, rehearsalEffects()))
  expect('Paused: no post, no social, no AI in the rehearsal', !paused.intents.some((i) => ['publish-post', 'social-post', 'ai-call'].includes(i.kind)))
  const early = await withDryRun(() => planPass({ ...FACTS, now: new Date('2026-10-24T08:00:00Z') }, rehearsalEffects()))
  expect('before the publish hour: the post waits, like the real pass', !early.intents.some((i) => i.kind === 'publish-post') && early.result.steps.some((s) => s.step === 'write' && /13:00 UTC/.test(s.note)))
  const review = await withDryRun(() => planPass({ ...FACTS, distribution: { ...FACTS.distribution, mode: 'prepare', held: 2, queued: [] } }, rehearsalEffects()))
  expect('review mode: nothing would be sent to social', !review.intents.some((i) => i.kind === 'social-post'))

  // ---- 3. the choke points ----------------------------------------------------------------------------
  const realFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  process.env.RESEND_API_KEY = 'test-key'
  process.env.ADMIN_EMAIL = 'admin@example.test'
  try {
    expect('outside a dry run the gate is inert', !isDryRunActive() && blockIfDry('email', 'x') === false)

    const a = fakeAdmin()
    const dry = await withDryRun(async () => {
      const mail = await sendThrottledAlert(a.admin, 'Subject', ['line'])
      const ghl = await ghlCreatePost({ accountIds: ['a'], text: 'hello', mediaUrls: ['https://example.test/a.png'] })
      const up = await uploadPostSendPhotos({ user: 'u', platforms: ['instagram'], text: 'hello', imageUrls: ['https://example.test/a.png'] })
      await setTopicStatus(a.admin, 't1', 'used', {})
      await appendDecisions(a.admin, [{ at: '2026-10-24T15:00:00Z', policy: 'approve_safe_topics', subject: 'x', action: 'Approved', undo: null } as never])
      const healed = await selfHeal(a.admin)
      const rec = await recordPublish(a.admin, 'post', 'post:x')
      const post = await createPost({ title: 'T', slug: 't', body: 'b', status: 'published' } as never)
      return { mail, ghl, up, healed, rec, post }
    })
    expect('dry run: no email request is made', fetchCalls === 0, `${fetchCalls} fetches`)
    expect('dry run: no database write at all (content tables and settings)', a.state.writes === 0 && a.state.settingWrites === 0, JSON.stringify(a.state))
    expect('dry run: the choke points return harmless answers', dry.result.mail === 'throttled' && dry.result.ghl.dormant === true && dry.result.up.dormant === true && dry.result.healed.length === 0 && !dry.result.rec.error && dry.result.post.id === 'dry-run')
    const got = new Set(dry.intents.map((i) => i.kind))
    expect('dry run: each choke point recorded what it would have done', ['email', 'social-post', 'topic-status', 'apply-decision', 'heal-write', 'counter', 'publish-post'].every((k) => got.has(k as EffectKind)), JSON.stringify([...got]))

    // Outside a dry run the same calls behave as before.
    const b = fakeAdmin()
    const mail = await sendThrottledAlert(b.admin, 'Subject', ['line'])
    expect('switch OFF: the alert email is requested and the throttle moves', mail === 'sent' && fetchCalls === 1 && b.settings.has('autopilot_last_alert_at'), `${mail} ${fetchCalls}`)
    await setTopicStatus(b.admin, 't1', 'used', {})
    expect('switch OFF: a topic status change is written', b.state.writes === 1)
    await appendDecisions(b.admin, [{ at: '2026-10-24T15:00:00Z', policy: 'approve_safe_topics', subject: 'x', action: 'Approved', undo: null } as never])
    expect('switch OFF: an automatic decision is logged', b.settings.has('auto_decisions'))
    const rec = await recordPublish(b.admin, 'post', 'post:x')
    expect('switch OFF: the publish counter moves', !rec.error && b.settings.has('publish_cadence_log'))
  } finally {
    globalThis.fetch = realFetch
  }

  // ---- 4. the daily spend ceiling ---------------------------------------------------------------------
  const over = judgeCeiling(4.5, 5, 0.8)
  expect('ceiling: spend plus planned above the limit would exceed', over.wouldExceed === true)
  expect('ceiling: the sentence says "Would exceed the daily limit"', ceilingSentence(over).startsWith('Would exceed the daily limit'))
  expect('ceiling: under the limit is inside it', judgeCeiling(1, 5, 0.5).wouldExceed === false && ceilingSentence(judgeCeiling(1, 5, 0.5)).startsWith('Within the limit'))
  expect('ceiling: exactly at the limit is not over it', judgeCeiling(4.5, 5, 0.5).wouldExceed === false)
  expect('ceiling: an unreadable spend is unknown, never a zero', judgeCeiling(null, 5, 1).wouldExceed === null && /could not be read/.test(ceilingSentence(judgeCeiling(null, 5, 1))))
  expect('ceiling: the rehearsal passes the planned dollars through', rehearsal.result.plannedUsd > 0)

  // ---- 5. the wording (grade 6 or lower, no long dash, no jargon) -------------------------------------
  const syllables = (word: string): number => {
    const w = word.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!w) return 0
    if (/^\d+$/.test(w)) return 1
    let n = (w.replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length
    if (/[^aeiou]le$/.test(w)) n++
    return Math.max(1, n)
  }
  const grade = (s: string): number => {
    const words = s.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w))
    if (!words.length) return 0
    const syl = words.reduce((n, w) => n + syllables(w), 0)
    return 0.39 * words.length + 11.8 * (syl / words.length) - 15.59
  }
  const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
  const JARGON = ['stage', 'heartbeat', 'cron', 'watchdog', 'endpoint', 'null', 'undefined', 'json', 'schema', 'latency', 'threshold', 'pipeline', 'cadence', 'api', 'webhook', 'queue', 'throttle', 'token']
  const texts: { where: string; text: string }[] = [
    ...[25, 30, 1, 100].map((h) => ({ where: `system check line (${h} h)`, text: dryRunSentence(h) })),
    { where: 'banner title', text: DRY_RUN_BANNER_TITLE },
    { where: 'banner body', text: DRY_RUN_BANNER_BODY },
    { where: 'explainer', text: DRY_RUN_EXPLAINER },
    { where: 'ceiling over', text: ceilingSentence(over) },
    { where: 'ceiling under', text: ceilingSentence(judgeCeiling(1, 5, 0.5)) },
    { where: 'ceiling unknown', text: ceilingSentence(judgeCeiling(null, 5, 1)) },
  ]
  const hard = texts.flatMap((t) => sentencesOf(t.text).map((s) => ({ where: t.where, s, g: grade(s) }))).filter((x) => x.g > 6)
  expect('every dry run sentence reads at grade 6 or lower', hard.length === 0, hard.map((x) => `${x.where}: "${x.s}" grade ${x.g.toFixed(1)}`).join(' | '))
  expect('no long dash in any dry run text', texts.every((t) => !/[—–]/.test(t.text)))
  const jargon = texts.flatMap((t) => JARGON.filter((j) => new RegExp(`(^|[^a-z])${j}s?([^a-z]|$)`, 'i').test(t.text)).map((j) => `${t.where}: ${j}`))
  expect('no jargon word in any dry run text', jargon.length === 0, jargon.join(' | '))
  expect('the system check line says nothing is being published', /^Autopilot is in dry run\. Nothing is going live\./.test(dryRunSentence(30)) && dryRunSentence(30).includes('30 hours') && dryRunSentence(1).includes('1 hour.'))

  // ---- 6. the System check (amber after 24 hours, real hours) -----------------------------------------
  const NOW = new Date('2026-10-24T15:00:00Z')
  const wd = (stage: string, status: WatchdogLike['status'], evidence: WatchdogLike['evidence']): WatchdogLike => ({ stage, status, evidence })
  const base: CheckFacts = {
    now: NOW,
    watchdog: { at: NOW.toISOString(), checks: [wd('production', 'ok', { hours_since_last_blog_post: 20, threshold_hours: 72, guides_published_48h: 3 })] },
    crawl: null, seo: null, jobs: null, ai: null, orders: null, gateSkips7d: null, decisions: null,
  }
  const prod = (f: CheckFacts) => evaluateCheck(f).stages.find((s) => s.id === 'production')!
  expect('system check: no dry run leaves the Production row alone', prod(base).light === 'green' && !/dry run/i.test(prod(base).sentence))
  expect('system check: dry run for 10 hours does not warn yet', prod({ ...base, dryRunHours: 10 }).light === 'green')
  expect('system check: exactly 24 hours does not warn yet', prod({ ...base, dryRunHours: 24 }).light === 'green')
  const amber = prod({ ...base, dryRunHours: 30 })
  expect('system check: dry run for 30 hours is amber', amber.light === 'amber')
  expect('system check: the sentence carries the real hours', amber.sentence === dryRunSentence(30) && amber.sentence.includes('30 hours'))
  expect('system check: it points to the Autopilot page', amber.needs?.href === '/admin/autopilot')
  expect('system check: not-in-dry-run (null) changes nothing', prod({ ...base, dryRunHours: null }).light === 'green')
  const redBase: CheckFacts = { ...base, watchdog: { at: NOW.toISOString(), checks: [wd('production', 'bad', { hours_since_last_blog_post: 100, threshold_hours: 72, guides_published_48h: 0 })] } }
  expect('system check: a red Production row stays red in dry run', prod({ ...redBase, dryRunHours: 30 }).light === 'red')

  // ---- 7. the switch and the log ----------------------------------------------------------------------
  const broken = { from() { throw new Error('down') } } as never
  expect('an unreadable switch counts as OFF (fail safe)', (await isDryRunSwitchOn(broken)) === false)
  const s = fakeAdmin()
  expect('the switch defaults to off', (await isDryRunSwitchOn(s.admin)) === false)
  await setDryRun(s.admin, true, new Date('2026-10-23T09:00:00Z'))
  expect('turning it on stores on and the start time', (await isDryRunSwitchOn(s.admin)) && s.settings.get('autopilot_dry_run_since') === '2026-10-23T09:00:00.000Z')
  await setDryRun(s.admin, true, new Date('2026-10-24T09:00:00Z'))
  expect('turning it on again keeps the first start time', s.settings.get('autopilot_dry_run_since') === '2026-10-23T09:00:00.000Z')
  expect('hours are whole hours since the start', dryRunHours(s.settings.get('autopilot_dry_run_since'), NOW) === 30 && dryRunHours('junk', NOW) === null && dryRunHours(null, NOW) === null)
  await setDryRun(s.admin, false)
  expect('turning it off clears the start time', !(await isDryRunSwitchOn(s.admin)) && s.settings.get('autopilot_dry_run_since') === '')

  const mk = (i: number, n = 1): DryPass => ({
    at: `2026-10-24T0${i}:00:00Z`, trigger: 'schedule', steps: [{ step: 'write', note: 'x'.repeat(900) }],
    intents: Array.from({ length: n }, (_, k) => ({ kind: 'email' as const, step: 'alerts', detail: 'd'.repeat(500) + k })), aiCalls: 0,
    ceiling: judgeCeiling(1, 5, 0),
  })
  let log: DryPass[] = []
  for (let i = 0; i < 8; i++) log = appendDryPass(log, mk(i, 100))
  expect(`the log keeps the newest ${DRY_LOG_MAX} passes`, log.length === DRY_LOG_MAX && log[0].at.includes('T03') && log[4].at.includes('T07'))
  expect('a pass is bounded (intents, text length)', log.every((p) => p.intents.length === DRY_INTENTS_MAX && p.intents.every((i) => i.detail.length <= 200) && p.steps.every((x) => x.note.length <= 400)))
  expect('a junk log reads as empty', parseDryLog('nope').length === 0 && parseDryLog('{"a":1}').length === 0 && parseDryLog(null).length === 0)
  const store = fakeAdmin()
  for (let i = 0; i < 7; i++) await recordDryPass(store.admin, mk(i))
  expect('recordDryPass stores at most 5 passes in app_settings', (await readDryLog(store.admin)).length === 5 && store.state.writes === 0)

  console.log(failures === 0 ? '\nAll dry run checks passed.' : `\n${failures} dry run check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
