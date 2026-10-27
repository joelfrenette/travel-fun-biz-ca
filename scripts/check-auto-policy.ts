// Offline self-check for the automatic decisions (lib/auto-decisions.ts, lib/auto-policies.ts), the funnel watchdog
// (lib/funnel-watchdog.ts), the exceptions list (lib/hitl-exceptions.ts) and the network pause (lib/network-pause.ts).
// An in-memory fake of the Supabase client stands in for the database. No network, no AI call, no posting.
// Run: pnpm dlx tsx scripts/check-auto-policy.ts
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fakeAdmin, type Db, type Row } from './fake-admin'
import {
  ALL_POLICIES,
  APPROVED_POLICIES,
  DECISIONS_KEY,
  MAX_DECISIONS,
  POLICY_CAPS,
  actionsToday,
  appendDecisions,
  boundDecisions,
  decision,
  gateDecision,
  parseDecisions,
  policyEnabled,
  policyGate,
  policyKey,
  readDecisions,
  readPolicySwitches,
  setPolicySwitch,
  undoAutoDecision,
  type AutoDecision,
} from '../lib/auto-decisions'
import {
  MAX_AUTO_RETRIES,
  NEWS_COOLING_HOURS,
  RETRY_WAITS_MS,
  classifySendError,
  newsDraftVerdict,
  postRetryVerdict,
  releaseVerdict,
  runApproveSafeTopics,
  runAutoPolicies,
  runPublishPassingNews,
  runReleaseHeldPosts,
  runRetryFailedPosts,
  settledNote,
  settledPostVerdict,
  splitSetupBlocked,
  safeTopicVerdict,
  stepResumeVerdict,
  type FailedPostRow,
  type FailedStepRow,
  type NewsDraftFacts,
  type TopicCandidate,
  type TopicContext,
} from '../lib/auto-policies'
import { THRESHOLDS, evaluateFunnel, networkStreaks, runFunnelWatchdog, AUTOBLOG_NUDGE_KEY, autoblogNudgePending, type WatchdogFacts } from '../lib/funnel-watchdog'
import { buildExceptions } from '../lib/hitl-exceptions'
import { NETWORK_PAUSES_KEY, parsePauses, pausedNow } from '../lib/network-pause'
import { resolvePostingTarget } from '../lib/social-provider'
import { AUTO_HOLD_PREFIX, CAPTION_FAILED_PREFIX } from '../lib/guide-release'
import { createNewsPost } from '../lib/news-publish'
import { buildNhcBrief } from '../lib/news-nhc'
import { sourceByKey } from '../lib/news-sources'
import { SITE_ID } from '../lib/site'

let failed = 0
function check(label: string, ok: boolean, extra?: string) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` :: ${extra}` : ''}`)
}

const ROOT = join(__dirname, '..')
const LONG_DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const HOUR = 3_600_000
const NOW = new Date('2026-10-21T14:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const world = (settings: Record<string, string> = {}, tables: Record<string, Row[]> = {}) => {
  const db: Db = { tables: { app_settings: Object.entries(settings).map(([key, value]) => ({ key, value })), ...tables } }
  return { db, admin: fakeAdmin(db) }
}
const rowsOf = (db: Db, t: string) => db.tables[t] ?? []
const setting = (db: Db, key: string) => rowsOf(db, 'app_settings').find((r) => r.key === key)?.value as string | undefined
const logOf = (db: Db): AutoDecision[] => parseDecisions(setting(db, DECISIONS_KEY))

async function main() {
  // ================================================================================================
  // Static facts
  // ================================================================================================
  {
    const files = ['lib/auto-decisions.ts', 'lib/auto-policies.ts', 'lib/funnel-watchdog.ts', 'lib/hitl-exceptions.ts', 'lib/network-pause.ts', 'app/api/admin/auto-decisions/route.ts', 'components/admin/auto-decisions-card.tsx', 'scripts/check-auto-policy.ts']
    check('files: every new file exists and none contains a long dash', files.every((f) => existsSync(join(ROOT, f))) && files.every((f) => !LONG_DASH.test(read(f))))
    const route = read('app/api/admin/auto-decisions/route.ts')
    const handlers = route.split(/export async function /).slice(1)
    check('route: GET and POST both exist and each calls isAuthorized before anything else', handlers.length === 2 && handlers.every((h) => /^(GET|POST)\(request: Request\) \{\s*\n\s*if \(!isAuthorized\(request\)\) return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)/.test(h)))
    const vercel = JSON.parse(read('vercel.json')) as { crons?: { path: string }[] }
    check('no new cron: vercel.json still has exactly the two existing jobs', (vercel.crons ?? []).map((c) => c.path).sort().join() === '/api/cron/autopilot,/api/cron/gsc-snapshot')
    check('wiring: the pipeline runs the automatic decisions before the posting step, and the daily cron runs the watchdog', /runAutoPolicies/.test(read('lib/pipeline.ts')) && read('lib/pipeline.ts').indexOf('runAutoPolicies(admin)') < read('lib/pipeline.ts').indexOf('runDistribution(admin)') && /runFunnelWatchdog/.test(read('app/api/cron/gsc-snapshot/route.ts')))
    check('wiring: the posting target honours a network pause (both providers)', (read('lib/social-provider.ts').match(/pausedNetworks\(/g) ?? []).length === 2)
    check('wiring: the card is on the Content Autopilot page', /AutoDecisionsCard/.test(read('app/admin/autopilot/page.tsx')))
    check('no AI call or posting in the policies: no callAnthropic, no sendPhotos, no sendVideo in the new lib files', ['lib/auto-decisions.ts', 'lib/auto-policies.ts', 'lib/funnel-watchdog.ts', 'lib/hitl-exceptions.ts'].every((f) => !/callAnthropic|sendPhotos|sendVideo|modelCallFor/.test(read(f))))
    check('the four approved policies are on by default and the watchdog has its own switch', APPROVED_POLICIES.length === 4 && ALL_POLICIES.length === 5 && ALL_POLICIES.every((p) => policyKey(p) === `auto_policy_${p}`))
  }

  // ================================================================================================
  // The gate: pause, switches, caps
  // ================================================================================================
  {
    const on = { paused: false, toggle: null, usedToday: 0, cap: 2 }
    check('gate: allowed when not paused, switch unset, under the cap', gateDecision(on).allowed && gateDecision(on).room === 2)
    check('gate: Pause all automation stops it', !gateDecision({ ...on, paused: true }).allowed)
    check('gate: a pause switch that cannot be read stops it (fail closed for acting)', !gateDecision({ ...on, paused: null }).allowed)
    check('gate: a policy switch that cannot be read stops it', !gateDecision({ ...on, toggle: undefined }).allowed)
    check("gate: only the exact text 'off' switches a policy off", !gateDecision({ ...on, toggle: 'off' }).allowed && gateDecision({ ...on, toggle: 'OFF' }).allowed && gateDecision({ ...on, toggle: 'false' }).allowed && gateDecision({ ...on, toggle: 'on' }).allowed && gateDecision({ ...on, toggle: '' }).allowed && policyEnabled(undefined) && !policyEnabled('off'))
    check('gate: the per-day cap leaves room for the rest and then stops', gateDecision({ ...on, usedToday: 1 }).room === 1 && !gateDecision({ ...on, usedToday: 2 }).allowed && !gateDecision({ ...on, usedToday: 5 }).allowed)
    check('caps: topics 2 a day (as approved)', POLICY_CAPS.approve_safe_topics === 2)

    const { admin } = world({ automation_paused: 'true' })
    check('policyGate: reads the kill switch from app_settings', !(await policyGate(admin, 'retry_failed_posts', NOW)).allowed)
    const { admin: off } = world({ [policyKey('approve_safe_topics')]: 'off' })
    check('policyGate: reads each policy switch from app_settings', !(await policyGate(off, 'approve_safe_topics', NOW)).allowed && (await policyGate(off, 'release_held_posts', NOW)).allowed)
    const entries = [decision('approve_safe_topics', 'a', 'Approved a', 'why', null, NOW), decision('approve_safe_topics', 'b', 'Approved b', 'why', null, NOW)]
    const { admin: capped, db: cdb } = world({ [DECISIONS_KEY]: JSON.stringify(entries) })
    check('policyGate: counts today from the log (2 of 2 used means stop)', !(await policyGate(capped, 'approve_safe_topics', NOW)).allowed && (await policyGate(capped, 'approve_safe_topics', new Date(NOW.getTime() + 24 * HOUR))).allowed)
    void cdb
    check('caps: a refusal line does not use up the day', actionsToday([decision('retry_failed_posts', 'x', 'Needs Joel: x', 'y', null, NOW)], 'retry_failed_posts', NOW) === 0)

    const sw = world({})
    await setPolicySwitch(sw.admin, 'release_held_posts', false)
    const list = await readPolicySwitches(sw.admin)
    check('switches: setPolicySwitch writes off, the list shows it, the others stay on', setting(sw.db, 'auto_policy_release_held_posts') === 'off' && list.find((s) => s.policy === 'release_held_posts')?.on === false && list.filter((s) => s.on).length === 4)
  }

  // ================================================================================================
  // The log: bound, corrupt fallback, append-only
  // ================================================================================================
  {
    const many = Array.from({ length: 130 }, (_, i) => decision('retry_failed_posts', `p${i}`, 'a', 'b', null, new Date(NOW.getTime() + i * 1000)))
    const bounded = boundDecisions(many)
    check('log: kept to the newest 100, oldest dropped', bounded.length === MAX_DECISIONS && bounded[0].subject === 'p30' && bounded[99].subject === 'p129')
    const { admin, db } = world({ [DECISIONS_KEY]: JSON.stringify(many.slice(0, 100)) })
    await appendDecisions(admin, [decision('retry_failed_posts', 'new1', 'a', 'b', null, NOW), decision('retry_failed_posts', 'new2', 'a', 'b', null, NOW)])
    const after = logOf(db)
    check('log: appending past 100 drops the oldest two and keeps order', after.length === 100 && after[99].subject === 'new2' && after[0].subject === 'p2')
    for (const bad of ['{not json', '{"a":1}', 'null', '"text"', '[1,2,3]', '[{"at":"x"}]']) check(`log: corrupt value ${JSON.stringify(bad).slice(0, 14)} reads as empty`, parseDecisions(bad).length === 0)
    const mixed = parseDecisions(JSON.stringify([{ at: 'nope' }, decision('approve_safe_topics', 'k', 'a', 'b', { kind: 'topic-pending', ref: '1' }, NOW), { ...decision('approve_safe_topics', 'k2', 'a', 'b', null, NOW), policy: 'made_up' }]))
    check('log: one good entry survives two bad ones; an unknown policy is dropped', mixed.length === 1 && mixed[0].undo?.kind === 'topic-pending')
    const { admin: corrupt, db: cdb } = world({ [DECISIONS_KEY]: '{oops' })
    await appendDecisions(corrupt, [decision('retry_failed_posts', 'z', 'a', 'b', null, NOW)])
    check('log: a corrupt log is replaced by a fresh one on the next write, never an error', logOf(cdb).length === 1)
    const failing = fakeAdmin({ tables: { app_settings: [] }, failWrites: { app_settings: 'disk full' } })
    let threw = false
    try {
      await appendDecisions(failing, [decision('retry_failed_posts', 'z', 'a', 'b', null, NOW)])
    } catch {
      threw = true
    }
    check('log: a log that cannot be written never throws (fail open)', !threw)
    check('log: every entry has at, policy, subject, action, reason and undo', Object.keys(decision('retry_failed_posts', 's', 'a', 'r', null, NOW)).sort().join() === 'action,at,policy,reason,subject,undo')
    check('log: readDecisions returns [] when the read itself fails', (await readDecisions({ from: () => { throw new Error('boom') } } as never)).length === 0)
  }

  // ================================================================================================
  // Error classification (policy 1)
  // ================================================================================================
  {
    const cls = (t: string | null) => classifySendError(t).cls
    for (const t of ['429 Too Many Requests', 'Upload-Post said 503 Service Unavailable', 'rate limit reached, try again later', 'fetch failed', 'The cover image could not be checked (decode failed), so nothing was posted.', 'ECONNRESET', '502 Bad Gateway', 'render did not finish within 30 minutes']) check(`classify: "${t.slice(0, 40)}" is self-fixable`, cls(t) === 'self-fixable')
    for (const t of ['401 Unauthorized', 'The access token has expired, reconnect Instagram', 'UPLOAD_POST_API_KEY is not set', 'Forbidden: permission denied', 'instagram: 400 Invalid media aspect ratio', 'facebook: rejected as spam', '422 caption too long', 'None of your selected networks takes an image post', 'duplicate content', null, '', 'something odd nobody has seen']) check(`classify: ${JSON.stringify(t)} needs a person`, cls(t) === 'needs-person')
    for (const t of ['request timed out', 'Upload-Post accepted this but has not confirmed it posted yet', '504 Gateway Timeout', '500 Internal Server Error']) check(`classify: "${t.slice(0, 40)}" may already have posted (ambiguous)`, cls(t) === 'ambiguous')
    check('classify: a sign-in problem wins over a temporary-sounding word', cls('403 forbidden, try again') === 'needs-person')
    // A TikTok title over 90 is shortened at send time, so a retry passes (real failure text 2026-10-26).
    const tiktokLong = 'tiktok: TikTok title is too long (346 characters, counted the way TikTok does: an emoji counts as 2). Maximum allowed is 90. Please shorten it.'
    check('classify: a TikTok title that is too long is self-fixable (the send path shortens it)', cls(tiktokLong) === 'self-fixable' && cls('tiktok/instagram: ' + tiktokLong.slice(8)) === 'self-fixable')
    check('classify: an Instagram caption that is too long still needs a person', cls('instagram: caption is too long') === 'needs-person')
    check('classify: a TikTok title error next to a real refusal still needs a person', cls(tiktokLong + '; instagram: 403 forbidden') === 'needs-person')
    const setupErr = tiktokLong + '; pinterest: Pinterest Board ID is required when uploading to Pinterest.'
    check('setup: the Pinterest board error is split out, the rest is kept', splitSetupBlocked(setupErr).blocked[0] === 'pinterest' && cls(splitSetupBlocked(setupErr).rest) === 'self-fixable')
    check('setup: an error with no setup problem is untouched', splitSetupBlocked('429 rate limit').blocked.length === 0 && splitSetupBlocked(null).rest === '')
  }

  // ================================================================================================
  // Policy 1: retry verdicts
  // ================================================================================================
  {
    const failedRow = (over: Partial<FailedPostRow> = {}): FailedPostRow => ({ slug: 'post-a', stage: 'failed', last_error: '429 rate limit', sent_platforms: [], updated_at: ago(30 * 60_000), ...over })
    const v = (row: FailedPostRow, n = 0, vetoed = false) => postRetryVerdict(row, n, NOW, vetoed).act
    check('retry: waits are 15 minutes, 2 hours, 12 hours and there are three of them', RETRY_WAITS_MS[0] === 15 * 60_000 && RETRY_WAITS_MS[1] === 2 * HOUR && RETRY_WAITS_MS[2] === 12 * HOUR && MAX_AUTO_RETRIES === 3)
    check('retry: first retry after 15 minutes', v(failedRow({ updated_at: ago(16 * 60_000) })) === 'retry' && v(failedRow({ updated_at: ago(10 * 60_000) })) === 'wait')
    check('retry: second retry needs 2 hours, not 1', v(failedRow({ updated_at: ago(HOUR) }), 1) === 'wait' && v(failedRow({ updated_at: ago(2.1 * HOUR) }), 1) === 'retry')
    check('retry: third retry needs 12 hours, not 5', v(failedRow({ updated_at: ago(5 * HOUR) }), 2) === 'wait' && v(failedRow({ updated_at: ago(13 * HOUR) }), 2) === 'retry')
    check('retry: after three retries it becomes a card for Joel', v(failedRow({ updated_at: ago(40 * HOUR) }), 3) === 'card')
    check('retry: must NOT retry a row that already reached a network (no duplicate post)', v(failedRow({ sent_platforms: ['instagram'], updated_at: ago(5 * HOUR) })) === 'card')
    const tikTok = 'tiktok: TikTok title is too long (352 characters, counted the way TikTok does: an emoji counts as 2). Maximum allowed is 90. Please shorten it.'
    check('retry: a row that reached other networks IS retried when only the repaired TikTok title failed (the sender skips networks already reached)', v(failedRow({ last_error: tikTok, sent_platforms: ['bluesky', 'x', 'facebook'], updated_at: ago(5 * HOUR) })) === 'retry')
    check('retry: a row that reached a network is still a card when a different error is mixed in with the TikTok one', v(failedRow({ last_error: `${tikTok}; facebook: 422 content rejected`, sent_platforms: ['bluesky'], updated_at: ago(5 * HOUR) })) === 'card')
    check('retry: an empty error on a row that reached a network is still a card', v(failedRow({ last_error: '', sent_platforms: ['bluesky'], updated_at: ago(5 * HOUR) })) === 'card')
    check('retry: must NOT retry an auth or setup error, or a content rejection (card)', v(failedRow({ last_error: '401 token expired', updated_at: ago(5 * HOUR) })) === 'card' && v(failedRow({ last_error: 'facebook: 422 content rejected', updated_at: ago(5 * HOUR) })) === 'card')
    check('retry: must NOT retry a timeout that may have posted (card)', v(failedRow({ last_error: 'request timed out', updated_at: ago(5 * HOUR) })) === 'card')
    check('retry: a person-undone retry is skipped, and a non-failed row is skipped', v(failedRow({ updated_at: ago(5 * HOUR) }), 0, true) === 'skip' && v(failedRow({ stage: 'queued', updated_at: ago(5 * HOUR) })) === 'skip')

    const step = (over: Partial<FailedStepRow> = {}): FailedStepRow => ({ slug: 'post-a', part: 'carousel', last_error: 'could not generate a grounded carousel', updated_at: ago(3 * HOUR), sent: [], ...over })
    const sv = (row: FailedStepRow, n = 0) => stepResumeVerdict(row, n, NOW, false).act
    check('step: a failed carousel older than 2 hours is resumed once', sv(step()) === 'retry' && sv(step({ updated_at: ago(HOUR) })) === 'wait')
    check('step: after one resume it escalates to a card', sv(step(), 1) === 'card')
    check('step: a step that already reached a network is never resumed', sv(step({ sent: ['instagram'] })) === 'card')
    check('step: a video whose render finished is not re-rendered by itself (credit), a render that never finished is', sv(step({ part: 'video', last_error: 'Shotstack render failed: bad clip' })) === 'card' && sv(step({ part: 'video', last_error: 'render did not finish within 30 minutes' })) === 'retry')
    check('step: a sign-in style error is a card', sv(step({ last_error: '401 unauthorized' })) === 'card')
  }

  // ================================================================================================
  // Policy 1: the runner
  // ================================================================================================
  {
    const failedPost = (slug: string, over: Row = {}): Row => ({ content_type: 'post', slug, title: slug, stage: 'failed', attempts: 3, last_error: '503 Service Unavailable', sent_platforms: [], created_at: ago(30 * HOUR), updated_at: ago(3 * HOUR), ...over })
    const requeue = (db: Db) => async (slug: string) => {
      const r = rowsOf(db, 'post_distribution').find((x) => x.slug === slug)
      if (r) r.stage = 'queued'
      return null
    }
    const base = { distribution_mode: 'auto' }

    {
      const { admin, db } = world(base, { post_distribution: [failedPost('ok-1'), failedPost('partly', { sent_platforms: ['instagram'] }), failedPost('auth', { last_error: '401 token expired' }), failedPost('fresh', { updated_at: ago(60_000) })] })
      const r = await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      const stages = Object.fromEntries(rowsOf(db, 'post_distribution').map((x) => [x.slug, x.stage]))
      check('run: only the safe row is re-queued; partial, auth and too-fresh rows are not', r.acted === 1 && stages['ok-1'] === 'queued' && stages.partly === 'failed' && stages.auth === 'failed' && stages.fresh === 'failed')
      const log = logOf(db)
      const retried = log.find((e) => e.subject === 'ok-1')
      check('run: the retry is logged with a reason and an undo', !!retried && retried.undo?.kind === 'requeue-post' && retried.undo.ref === 'ok-1' && /retry 1 of 3/.test(retried.reason))
      check('run: the rows that need a person are logged once as "Needs Joel", with no undo', log.filter((e) => e.action.startsWith('Needs Joel')).map((e) => e.subject).sort().join() === 'auth,partly' && log.filter((e) => e.action.startsWith('Needs Joel')).every((e) => e.undo === null))
      await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      check('run: a second pass does not log the same card again', logOf(db).filter((e) => e.action.startsWith('Needs Joel')).length === 2)

      // The real failure of 2026-10-26: TikTok title too long plus Pinterest board missing. Pinterest is paused, the post is retried.
      {
        const real = 'tiktok: TikTok title is too long (346 characters). Maximum allowed is 90. Please shorten it.; pinterest: Pinterest Board ID is required when uploading to Pinterest.'
        const w = world(base, { post_distribution: [failedPost('germany', { last_error: real, updated_at: ago(30 * 60_000) })] })
        const rr = await runRetryFailedPosts(w.admin, NOW, { retryPost: requeue(w.db) })
        const pauses = parsePauses(setting(w.db, NETWORK_PAUSES_KEY))
        check('real failure: the post is re-queued by itself, not shown to Joel', rr.acted === 1 && rowsOf(w.db, 'post_distribution')[0].stage === 'queued' && !logOf(w.db).some((e) => e.action.startsWith('Needs Joel')))
        check('real failure: Pinterest is paused for a week and the pause has an undo', !!pauses.pinterest && Date.parse(pauses.pinterest.until) - NOW.getTime() >= 7 * 24 * HOUR - 1000 && logOf(w.db).some((e) => e.subject === 'pinterest' && e.undo?.kind === 'unpause-network'))
      }

      // 2026-10-27: posts that reached every network except Pinterest (no board id) were shown as failures forever. They are settled as done.
      {
        const pin = 'pinterest: Pinterest Board ID is required when uploading to Pinterest.'
        const six = ['bluesky', 'x', 'threads', 'facebook', 'instagram', 'tiktok']
        const pv = (over: Partial<FailedPostRow> = {}, vetoed = false) => settledPostVerdict({ slug: 'g', stage: 'failed', last_error: pin, sent_platforms: six, updated_at: ago(5 * HOUR), ...over }, vetoed)
        check('settle: a post that reached six networks and only lacks the Pinterest board is settled', pv().settle === true)
        check('settle: not when nothing was sent (the post never went out)', pv({ sent_platforms: [] }).settle === false)
        check('settle: not when another failure is mixed in', pv({ last_error: `${pin}; facebook: 422 content rejected` }).settle === false && pv({ last_error: `tiktok: TikTok title is too long (346 characters). Maximum allowed is 90.; ${pin}` }).settle === false)
        check('settle: not for a person-undone settle, a non-failed row, or an error that is not a setup error', pv({}, true).settle === false && pv({ stage: 'queued' }).settle === false && pv({ last_error: '503 Service Unavailable' }).settle === false && pv({ last_error: null }).settle === false)
        check('settle: the saved note names the networks reached and the one skipped', /bluesky, x/.test(settledNote(['pinterest'], six)) && /pinterest was skipped/.test(settledNote(['pinterest'], six)))

        const w = world(base, { post_distribution: [failedPost('italy', { last_error: pin, sent_platforms: six, updated_at: ago(5 * HOUR) }), failedPost('mixed', { last_error: `${pin}; facebook: 422 content rejected`, sent_platforms: ['bluesky'], updated_at: ago(5 * HOUR) })] })
        const sr = await runRetryFailedPosts(w.admin, NOW, { retryPost: requeue(w.db) })
        const settled = rowsOf(w.db, 'post_distribution').find((x) => x.slug === 'italy')
        const entry = logOf(w.db).find((e) => e.subject === 'italy' && e.action === 'Settled the post as done') as AutoDecision
        check('settle run: the Pinterest-only post becomes done with a note, the mixed one stays failed and becomes a card', sr.acted === 1 && settled?.stage === 'done' && /was skipped/.test(String(settled.last_error)) && rowsOf(w.db, 'post_distribution').find((x) => x.slug === 'mixed')?.stage === 'failed' && logOf(w.db).some((e) => e.subject === 'mixed' && e.action.startsWith('Needs Joel')))
        check('settle run: the settle is logged with an Undo that reopens the post', !!entry && entry.undo?.kind === 'reopen-post' && entry.undo.ref === 'italy')
        const ur = await undoAutoDecision(w.admin, entry)
        check('settle undo: the post is failed again with a note, and cannot be reopened twice', ur.ok && rowsOf(w.db, 'post_distribution').find((x) => x.slug === 'italy')?.stage === 'failed' && !(await undoAutoDecision(w.admin, logOf(w.db).find((e) => e.subject === 'italy' && e.action === 'Settled the post as done') as AutoDecision)).ok)
        await runRetryFailedPosts(w.admin, NOW, { retryPost: requeue(w.db) })
        check('settle undo: a reopened post is never settled again by itself', rowsOf(w.db, 'post_distribution').find((x) => x.slug === 'italy')?.stage === 'failed')
      }

      // Sends Upload-Post accepted but had not confirmed are checked every pass instead of waiting for a person to press Sync.
      {
        const syncing = world(base, {})
        const rs = await runRetryFailedPosts(syncing.admin, NOW, { syncPending: async () => ({ resolved: 3, stillPending: 1, checkFailed: 0, total: 4 }) })
        const line = logOf(syncing.db).find((e) => e.subject === 'upload-post-sync')
        check('sync: confirmed held posts are reported in the log with a plain reason and no undo', rs.acted === 3 && !!line && /4 accepted posts/.test(line.action) && line.undo === null)
        const quiet = world(base, {})
        const rq = await runRetryFailedPosts(quiet.admin, NOW, { syncPending: async () => ({ resolved: 0, stillPending: 2, checkFailed: 0, total: 2 }) })
        check('sync: nothing resolved means nothing is logged', rq.acted === 0 && logOf(quiet.db).length === 0)
        const broke = world(base, { post_distribution: [failedPost('after-sync-error')] })
        const rb = await runRetryFailedPosts(broke.admin, NOW, { syncPending: async () => { throw new Error('Upload-Post is down') }, retryPost: requeue(broke.db) })
        check('sync: a status read that throws never stops the rest of the policy', rb.acted === 1 && rowsOf(broke.db, 'post_distribution')[0].stage === 'queued')
      }

      const u = await undoAutoDecision(admin, retried as AutoDecision)
      check('undo: the retry is put back to failed (not re-sent) and says so', u.ok && rowsOf(db, 'post_distribution').find((x) => x.slug === 'ok-1')?.stage === 'failed')
      check('undo: it is marked undone in the log and cannot be undone twice', !!logOf(db).find((e) => e.subject === 'ok-1')?.undone_at && !(await undoAutoDecision(admin, logOf(db).find((e) => e.subject === 'ok-1') as AutoDecision)).ok)
      const again = await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      check('undo: a post whose retry a person undid is never retried again', again.acted === 0 && rowsOf(db, 'post_distribution').find((x) => x.slug === 'ok-1')?.stage === 'failed')
    }
    {
      const { admin, db } = world(base, { post_distribution: [failedPost('late', { updated_at: ago(3 * HOUR) })] })
      const sneaky = await runRetryFailedPosts(admin, NOW, { retryPost: async (slug) => { rowsOf(db, 'post_distribution').find((x) => x.slug === slug)!.stage = 'queued'; return null } })
      const entry = logOf(db).find((e) => e.subject === 'late') as AutoDecision
      rowsOf(db, 'post_distribution')[0].sent_platforms = ['bluesky']
      const u = await undoAutoDecision(admin, entry)
      check('undo: refuses to move a row that has already reached a network back to failed', sneaky.acted === 1 && !u.ok && rowsOf(db, 'post_distribution')[0].stage === 'queued')
    }
    {
      const { admin, db } = world({ ...base, automation_paused: 'true' }, { post_distribution: [failedPost('p1')] })
      const r = await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      check('run: Pause all automation stops retries and writes nothing', r.acted === 0 && rowsOf(db, 'post_distribution')[0].stage === 'failed' && logOf(db).length === 0)
      const w2 = world({ ...base, [policyKey('retry_failed_posts')]: 'off' }, { post_distribution: [failedPost('p1')] })
      check('run: the policy switch off stops retries', (await runRetryFailedPosts(w2.admin, NOW, { retryPost: requeue(w2.db) })).acted === 0 && w2.db.tables.post_distribution[0].stage === 'failed')
      const w3 = world({ distribution_mode: 'prepare' }, { post_distribution: [failedPost('p1')] })
      check('run: only in auto mode (review mode never posts by itself)', (await runRetryFailedPosts(w3.admin, NOW, { retryPost: requeue(w3.db) })).acted === 0)
    }
    {
      const rows = Array.from({ length: 9 }, (_, i) => failedPost(`many-${i}`))
      const { admin, db } = world(base, { post_distribution: rows })
      const r = await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      check(`run: the daily cap of ${POLICY_CAPS.retry_failed_posts} holds (9 eligible, ${POLICY_CAPS.retry_failed_posts} retried)`, r.acted === POLICY_CAPS.retry_failed_posts && rowsOf(db, 'post_distribution').filter((x) => x.stage === 'queued').length === POLICY_CAPS.retry_failed_posts)
    }
    {
      const { admin, db } = world(base, { post_distribution: [failedPost('d1')] })
      await runRetryFailedPosts(admin, NOW)
      const row = rowsOf(db, 'post_distribution')[0]
      check('run: the default retry path is the existing retry-post action (queued, attempts reset, sent_platforms kept)', row.stage === 'queued' && row.attempts === 0 && Array.isArray(row.sent_platforms) && (row.sent_platforms as string[]).length === 0)
    }
    {
      // growing waits across passes: retry 1 now, a second failure 30 minutes later waits for 2 hours
      const { admin, db } = world(base, { post_distribution: [failedPost('g1')] })
      await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      const row = rowsOf(db, 'post_distribution')[0]
      row.stage = 'failed'
      row.updated_at = ago(HOUR)
      const r2 = await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      check('run: the second retry waits 2 hours since the new failure', r2.acted === 0 && row.stage === 'failed')
      row.updated_at = ago(3 * HOUR)
      const r3 = await runRetryFailedPosts(admin, NOW, { retryPost: requeue(db) })
      check('run: and goes out once 2 hours have passed', r3.acted === 1 && row.stage === 'queued')
    }
    {
      const pipe = (over: Row = {}): Row => ({ slug: 'pp-1', carousel_stage: 'failed', video_stage: 'skipped', attempts: { carousel: 3 }, last_error: 'could not generate a grounded carousel', carousel_sent: [], video_sent: [], created_at: ago(30 * HOUR), updated_at: ago(3 * HOUR), ...over })
      const calls: string[] = []
      const { admin, db } = world(base, { content_pipeline: [pipe(), pipe({ slug: 'pp-2', carousel_sent: ['instagram'] }), pipe({ slug: 'pp-3', last_error: '403 forbidden' }), pipe({ slug: 'pp-4', updated_at: ago(30 * 60_000) })] })
      const r = await runRetryFailedPosts(admin, NOW, { retryStep: async (part, slug) => { calls.push(`${part}:${slug}`); return null } })
      check('steps: only the stuck, safe, nothing-sent step is resumed (once)', calls.join() === 'carousel:pp-1' && r.acted === 1)
      const log = logOf(db)
      check('steps: partly-sent and forbidden steps become cards; a resumed step is logged', log.some((e) => e.subject === 'pp-1:carousel' && /Resumed/.test(e.action)) && log.some((e) => e.subject === 'pp-2:carousel' && e.action.startsWith('Needs Joel')) && log.some((e) => e.subject === 'pp-3:carousel' && e.action.startsWith('Needs Joel')))
      await runRetryFailedPosts(admin, NOW, { retryStep: async (part, slug) => { calls.push(`${part}:${slug}`); return null } })
      check('steps: a step resumed once is not resumed again (it escalates)', calls.length === 1)
    }
  }

  // ================================================================================================
  // Policy 2: safe topics
  // ================================================================================================
  {
    const gsc = [
      { key: 'rhine river cruise', position: 12.4, impressions: 240 },
      { key: 'danube cruise tips', position: 3, impressions: 90 },
      { key: 'alaska cruise packing', position: 31, impressions: 5 },
    ]
    const researched = [
      { key: 'rhine river cruise', position: 0, impressions: 900 },
      { key: 'danube cruise tips', position: 0, impressions: 400 },
      { key: 'alaska cruise packing', position: 0, impressions: 100 },
    ]
    const ctx = (over: Partial<TopicContext> = {}): TopicContext => ({ gsc, researched, posts: [], titles: [], packageDest: new Map(), ...over })
    const cand = (over: Partial<TopicCandidate> = {}): TopicCandidate => ({ id: 't1', angle: 'A post that answers the search rhine river cruise', keyword: 'rhine river cruise', keywords: null, package_slug: null, status: 'suggested', ...over })
    const ok = (c: TopicCandidate, x = ctx(), vetoed = false) => safeTopicVerdict(c, x, NOW, vetoed).approve
    check('topics: a striking-distance keyword with research volume and no clash is approved, with a plain reason', ok(cand()) && /position 12\.4/.test(safeTopicVerdict(cand(), ctx(), NOW, false).reason))
    check('topics: any impressions count as support (position 3 with 90 impressions)', ok(cand({ keyword: 'danube cruise tips', angle: 'danube cruise tips answered' })))
    check('topics: must NOT approve a keyword Search Console has never shown', !ok(cand({ keyword: 'iceland winter getaway', angle: 'iceland winter getaway' })))
    check('topics: must NOT approve a keyword with no research volume behind it', !ok(cand(), ctx({ researched: [] })))
    check('topics: must NOT approve when a post already targets the same keyword', !ok(cand(), ctx({ posts: [{ slug: 'old', title: 'Rhine cruise guide', primary_keyword: 'rhine river cruise' }] })))
    check('topics: must NOT approve a topic whose angle repeats an existing title', !ok(cand({ angle: 'The Complete Rhine River Cruise Guide' }), ctx({ titles: [{ title: 'The Complete Rhine River Cruise Guide' }] })))
    check('topics: must NOT touch a rejected, used or already approved topic', !ok(cand({ status: 'rejected' })) && !ok(cand({ status: 'used' })) && !ok(cand({ status: 'approved' })))
    check('topics: must NOT approve one a person undid', !ok(cand(), ctx(), true))
    check('topics: must NOT approve a topic with no keyword', !ok(cand({ keyword: '' })))

    const gscRow = (key: string, position: number, impressions: number): Row => ({ kind: 'query', day: NOW.toISOString().slice(0, 10), key, position, impressions })
    const kw = (keyword: string, volume: number | null): Row => ({ keyword, volume, country: SITE_ID })
    const topic = (id: string, keyword: string, over: Row = {}): Row => ({ id, angle: `Answer the search ${keyword}`, keyword, keywords: null, package_slug: null, status: 'suggested', created_at: ago(5 * HOUR), ...over })
    const tables = (): Record<string, Row[]> => ({
      blog_topic_queue: [topic('a', 'rhine river cruise'), topic('b', 'danube cruise tips'), topic('c', 'seine river cruise'), topic('d', 'alaska cruise packing'), topic('e', 'rhine rejected topic', { status: 'rejected' }), topic('f', 'no google data topic')],
      gsc_rankings: [gscRow('rhine river cruise', 12, 240), gscRow('danube cruise tips', 9, 120), gscRow('seine river cruise', 15, 60), gscRow('alaska cruise packing', 30, 0), gscRow('rhine rejected topic', 10, 500)],
      keyword_research: [kw('rhine river cruise', 900), kw('danube cruise tips', 300), kw('seine river cruise', 200), kw('alaska cruise packing', 100), kw('rhine rejected topic', 100)],
      posts: [],
      travel_packages: [],
    })
    const { admin, db } = world({}, tables())
    const r = await runApproveSafeTopics(admin, NOW)
    const statusOf = (id: string) => rowsOf(db, 'blog_topic_queue').find((x) => x.id === id)?.status
    const approved = rowsOf(db, 'blog_topic_queue').filter((x) => x.status === 'approved').map((x) => x.id)
    check('topics run: at most 2 a day (3 qualify, 2 approved) and the ones with the best Google support go first', r.acted === 2 && approved.length === 2 && approved.includes('a') && approved.includes('b'), approved.join())
    check('topics run: a rejected topic stays rejected even with strong Google data; unsupported ones stay suggested', statusOf('e') === 'rejected' && statusOf('d') === 'suggested' && statusOf('f') === 'suggested' && statusOf('c') === 'suggested')
    const log = logOf(db)
    check('topics run: each approval is logged with an undo back to pending', log.length === 2 && log.every((e) => e.policy === 'approve_safe_topics' && e.undo?.kind === 'topic-pending'))
    const second = await runApproveSafeTopics(admin, NOW)
    check('topics run: a second pass the same day approves nothing more (cap)', second.acted === 0 && rowsOf(db, 'blog_topic_queue').filter((x) => x.status === 'approved').length === 2)
    const u = await undoAutoDecision(admin, log.find((e) => e.subject === 'rhine river cruise') as AutoDecision)
    check('undo: the topic goes back to suggested (pending) and stays there', u.ok && statusOf('a') === 'suggested')
    const tomorrow = await runApproveSafeTopics(admin, new Date(NOW.getTime() + 24 * HOUR))
    check('undo: the next day the undone topic is not approved again, the next best one is', statusOf('a') === 'suggested' && tomorrow.acted === 1 && statusOf('c') === 'approved', `${tomorrow.note} ${statusOf('c')}`)
    const used = world({}, { ...tables(), blog_topic_queue: [topic('a', 'rhine river cruise')] })
    used.db.tables.blog_topic_queue[0].status = 'approved'
    used.db.tables.blog_topic_queue[0].used_slug = 'written-post'
    check('undo: refuses when a post was already written from the topic', !(await undoAutoDecision(used.admin, { ...decision('approve_safe_topics', 'rhine river cruise', 'a', 'b', { kind: 'topic-pending', ref: 'a' }, NOW) })).ok)
    const paused = world({ automation_paused: 'true' }, tables())
    check('topics run: Pause all automation approves nothing', (await runApproveSafeTopics(paused.admin, NOW)).acted === 0 && !paused.db.tables.blog_topic_queue.some((x) => x.status === 'approved'))
    const noGsc = world({}, { ...tables(), gsc_rankings: [] })
    check('topics run: with no Search Console data nothing is approved (never guess)', (await runApproveSafeTopics(noGsc.admin, NOW)).acted === 0)
    const full = world({}, { ...tables(), blog_topic_queue: [...tables().blog_topic_queue, ...Array.from({ length: 10 }, (_, i) => topic(`ap${i}`, `already approved ${i}`, { status: 'approved' }))] })
    check('topics run: with 10 approved topics already waiting, nothing more is approved', (await runApproveSafeTopics(full.admin, NOW)).acted === 0)
  }

  // ================================================================================================
  // Policy 3: news
  // ================================================================================================
  {
    const f = (over: Partial<NewsDraftFacts> = {}): NewsDraftFacts => ({ mode: 'publish', ageHours: 3, vetoed: false, sourceAllowed: true, stillRelevant: true, stale: false, draftIntact: true, problems: [], review: 'ok', publishedToday: 0, perDay: 2, ...over })
    const pub = (o: Partial<NewsDraftFacts> = {}) => newsDraftVerdict(f(o)).publish
    check(`news verdict: a clean, cooled, reviewed draft inside the daily limit is published (cooling is ${NEWS_COOLING_HOURS} hours)`, pub() && NEWS_COOLING_HOURS === 2)
    check('news verdict: must NOT publish before the 2 hour cooling', !pub({ ageHours: 1.9 }) && pub({ ageHours: 2 }))
    check('news verdict: must NOT publish in draft or off mode', !pub({ mode: 'draft' }) && !pub({ mode: 'off' }))
    check('news verdict: must NOT publish a brief that fails any check (stays a draft for Joel)', !pub({ problems: ['wording: unsupported claim'] }))
    check('news verdict: must NOT publish without the independent review passing (none, deferred or rejected)', !pub({ review: 'none' }) && !pub({ review: 'deferred' }) && !pub({ review: 'rejected' }))
    check('news verdict: must NOT publish over the per-day limit, a stale item, a de-listed source, or an edited-out-of-shape draft', !pub({ publishedToday: 2 }) && !pub({ stale: true }) && !pub({ sourceAllowed: false }) && !pub({ stillRelevant: false }) && !pub({ draftIntact: false }))
    check('news verdict: must NOT publish one a person undid', !pub({ vetoed: true }))

    // End to end with a plain-code hurricane brief (no model, no spend): save it as a draft, then let the policy publish it.
    const nhc = sourceByKey('nhc-pacific')!
    const published = ago(5 * HOUR)
    const REAL = 'Issued at 800 AM MST Sun Oct 18 2026 000 WTPZ31 KNHC 181432 TCPEP1 BULLETIN Hurricane Trudy Advisory Number 21 NWS National Hurricane Center Miami FL EP212026 800 AM MST Sun Oct 18 2026 ...TRUDY EXPECTED TO MOVE AWAY FROM THE COAST OF MEXICO THIS AFTERNOON... ...HEAVY RAINS AND GUSTY WINDS IN PORTIONS OF SOUTHWEST AND WEST-CENTRAL MEXICO... SUMMARY OF 800 AM MST...1500 UTC...INFORMATION ---------------------------------------------- LOCATION...19.1N 106.8W ABOUT 115 MI...185 KM SW OF CABO CORRIENTES MEXICO ABOUT 165 MI...265 KM W OF MANZANILLO MEXICO MAXIMUM SUSTAINED WINDS...105 MPH...165 KM.'
    const item = { id: 'n1', title: 'Hurricane Trudy Public Advisory Number 21', url: 'https://www.nhc.noaa.gov/text/MIATCPEP1.shtml', published_at: published, fetched_at: published, category: 'storm' as const }
    const facts = { sourceName: 'the US National Hurricane Center', tier: nhc.tier, title: item.title, summary: REAL, url: item.url, publishedAt: published, category: 'storm' as const }
    const built = buildNhcBrief(facts, 'nhc-pacific')
    if (!built.ok) {
      check('news run: the plain-code hurricane brief could be built for the fixture', false, built.reason)
    } else {
      const newsRow = (decidedAt: string): Row => ({ id: 'n1', source_key: 'nhc-pacific', guid: 'g1', url: item.url, title: item.title, summary_raw: facts.summary, published_at: published, fetched_at: published, category: 'storm', tier: nhc.tier, status: 'queued', reject_reason: null, post_slug: null, decided_at: decidedAt })
      const make = async (settings: Record<string, string>, decidedAt: string) => {
        const w = world({ travel_news_mode: 'publish', travel_news_per_day: '2', ...settings }, { news_items: [newsRow(decidedAt)], posts: [], content_edits: [] })
        const saved = await createNewsPost(w.admin, { item, facts, brief: built.brief, publish: false, calls: 0, now: new Date(decidedAt) })
        ;(w.db.tables.news_items[0] as Row).post_slug = saved.slug
        return { ...w, slug: saved.slug as string, saved }
      }
      const a = await make({}, ago(3 * HOUR))
      check('news run: the fixture draft was saved as a draft', a.saved.ok && !a.saved.published && rowsOf(a.db, 'posts')[0]?.status === 'draft', a.saved.note)
      const pings: string[][] = []
      const r = await runPublishPassingNews(a.admin, NOW, { ping: async (p) => { pings.push(p) } })
      const post = rowsOf(a.db, 'posts')[0]
      check('news run: a template brief that cooled for 3 hours is published through the existing publish path (audit row first)', r.acted === 1 && post.status === 'published' && rowsOf(a.db, 'content_edits').some((e) => e.field === 'status' && e.after === 'published'), r.note)
      check('news run: the feed item is marked published and the page is pinged', a.db.tables.news_items[0].status === 'published' && pings.length === 1)
      const e = logOf(a.db)[0]
      check('news run: logged with an undo that unpublishes', logOf(a.db).length === 1 && e.policy === 'publish_passing_news' && e.undo?.kind === 'unpublish-news' && e.undo.ref === a.slug)
      const u = await undoAutoDecision(a.admin, e)
      check('undo: the brief goes back to a draft and its feed item is turned down so the news step cannot publish it again', u.ok && rowsOf(a.db, 'posts')[0].status === 'draft' && a.db.tables.news_items[0].status === 'rejected', u.message)
      check('undo: a second undo is refused', !(await undoAutoDecision(a.admin, logOf(a.db)[0])).ok)

      const cold = await make({}, ago(30 * 60_000))
      check('news run: must NOT publish a draft still inside its 2 hour cooling', (await runPublishPassingNews(cold.admin, NOW, { ping: async () => undefined })).acted === 0 && rowsOf(cold.db, 'posts')[0].status === 'draft')
      const draftMode = await make({ travel_news_mode: 'draft' }, ago(3 * HOUR))
      check('news run: must NOT publish when news is in draft mode', (await runPublishPassingNews(draftMode.admin, NOW)).acted === 0 && rowsOf(draftMode.db, 'posts')[0].status === 'draft')
      const paused = await make({ automation_paused: 'true' }, ago(3 * HOUR))
      check('news run: Pause all automation publishes nothing', (await runPublishPassingNews(paused.admin, NOW)).acted === 0 && rowsOf(paused.db, 'posts')[0].status === 'draft')
      const off = await make({ [policyKey('publish_passing_news')]: 'off' }, ago(3 * HOUR))
      check('news run: the policy switch off publishes nothing', (await runPublishPassingNews(off.admin, NOW)).acted === 0)
      const limit = await make({ travel_news_per_day: '0' }, ago(3 * HOUR))
      check('news run: a daily news number of 0 publishes nothing', (await runPublishPassingNews(limit.admin, NOW)).acted === 0)
      const edited = await make({}, ago(3 * HOUR))
      rowsOf(edited.db, 'posts')[0].body = 'Someone rewrote this by hand.'
      check('news run: must NOT publish a draft that was edited out of shape (stays a draft for Joel)', (await runPublishPassingNews(edited.admin, NOW)).acted === 0 && rowsOf(edited.db, 'posts')[0].status === 'draft')
      const failing = await make({}, ago(3 * HOUR))
      rowsOf(failing.db, 'posts')[0].meta_description = 'A different description that no longer matches the brief at all.'
      check('news run: must NOT publish when the saved description no longer matches the brief', (await runPublishPassingNews(failing.admin, NOW)).acted === 0)
      const noEditLog = await make({}, ago(3 * HOUR))
      noEditLog.db.failWrites = { content_edits: 'down' }
      const nel = await runPublishPassingNews(noEditLog.admin, NOW)
      check('news run: if the audit row cannot be written the draft stays a draft (log, then apply)', nel.acted === 0 && rowsOf(noEditLog.db, 'posts')[0].status === 'draft')
      const gone = await make({}, ago(3 * HOUR))
      gone.db.tables.news_items[0].status = 'rejected'
      check('news run: a feed item a person or a check turned down is never touched', (await runPublishPassingNews(gone.admin, NOW)).acted === 0 && rowsOf(gone.db, 'posts')[0].status === 'draft')
    }
  }

  // ================================================================================================
  // Policy 4: held posts
  // ================================================================================================
  {
    const hf = (over: Partial<Parameters<typeof releaseVerdict>[0]> = {}) => ({ mode: 'auto', hours: 24, slug: 'guide-hotels-x', created_at: ago(30 * HOUR), last_error: `${AUTO_HOLD_PREFIX} a named place waits 24 hours`, sent_platforms: [] as string[], vetoed: false, captionProblems: [] as string[], cover: 'pass' as const, guessedName: false, ...over })
    const rel = (over: Partial<Parameters<typeof releaseVerdict>[0]> = {}) => releaseVerdict(hf(over), NOW).release
    check('release verdict: an auto-held post that waited 24 hours with a clean caption and cover is released', rel())
    check('release verdict: must NOT release before the hold time', !rel({ created_at: ago(20 * HOUR) }) && rel({ created_at: ago(24 * HOUR) }))
    check('release verdict: must NOT release a manual (prepare mode) hold: no Auto-hold note', !rel({ last_error: null }) && !rel({ last_error: 'Held by a person' }))
    check('release verdict: a post whose caption failed an earlier check is looked at again and released once it passes', rel({ last_error: `${CAPTION_FAILED_PREFIX} superlative` }))
    check('release verdict: must NOT release with a caption problem, a failed or unchecked cover, or a guessed property name', !rel({ captionProblems: ['number not in the facts: 7'] }) && !rel({ cover: 'fail' }) && !rel({ cover: 'unknown' }) && !rel({ guessedName: true }))
    check('release verdict: must NOT release when the hold time is 0 (never), outside auto mode, after any network send, or if a person undid it', !rel({ hours: 0 }) && !rel({ mode: 'prepare' }) && !rel({ sent_platforms: ['x'] }) && !rel({ vetoed: true }))

    const held = (slug: string, path: string, over: Row = {}): Row => ({ content_type: 'post', slug, title: slug, path, stage: 'held', attempts: 0, last_error: `${AUTO_HOLD_PREFIX} a named place waits 24 hours`, sent_platforms: [], created_at: ago(30 * HOUR), updated_at: ago(30 * HOUR), ...over })
    const guide = (slug: string, over: Row = {}): Row => ({ kind: 'hotels', slug, name: `Hotel ${slug}`, summary: null, hero_image_url: null, og_title: null, meta_description: 'A calm riverside stay with a spa.', faq: [], key_takeaways: [], status: 'published', quality_notes: null, ...over })
    const covers: string[] = []
    const cover = async (kind: 'guide' | 'trip', slug: string) => {
      covers.push(`${kind}:${slug}`)
      return slug.includes('badcover') ? ('fail' as const) : ('pass' as const)
    }
    const { admin, db } = world({ distribution_mode: 'auto' }, {
      post_distribution: [
        held('guide-hotels-good', '/hotels/good'),
        held('guide-hotels-manual', '/hotels/manual', { last_error: null }),
        held('guide-hotels-claim', '/hotels/claim', { created_at: ago(30 * HOUR) }),
        held('guide-hotels-badcover', '/hotels/badcover'),
        held('guide-hotels-guessed', '/hotels/guessed'),
        held('guide-hotels-young', '/hotels/young', { created_at: ago(2 * HOUR) }),
      ],
      guides: [guide('good'), guide('manual'), guide('claim', { meta_description: 'The best hotel in the world.' }), guide('badcover'), guide('guessed', { quality_notes: 'held for review: this name was taken from a trip title, so check it is a real property before you publish' }), guide('young')],
    })
    const r = await runReleaseHeldPosts(admin, NOW, { cover })
    const stage = (slug: string) => rowsOf(db, 'post_distribution').find((x) => x.slug === slug)?.stage
    check('release run: only the clean, aged, auto-held, good-cover post is released', r.acted === 1 && stage('guide-hotels-good') === 'queued' && stage('guide-hotels-manual') === 'held' && stage('guide-hotels-claim') === 'held' && stage('guide-hotels-badcover') === 'held' && stage('guide-hotels-guessed') === 'held' && stage('guide-hotels-young') === 'held', r.note)
    check('release run: the visual check ran only for rows that passed every other check', !covers.includes('guide:guide-hotels-claim') && !covers.includes('guide:guide-hotels-guessed') && covers.includes('guide:guide-hotels-good'), covers.join())
    const e = logOf(db)[0]
    check('release run: logged with an undo that holds it again', logOf(db).length === 1 && e.undo?.kind === 'rehold-post' && e.subject === 'guide-hotels-good')
    const u = await undoAutoDecision(admin, e)
    const after = rowsOf(db, 'post_distribution').find((x) => x.slug === 'guide-hotels-good') as Row
    check('undo: the post is held again with a manual note (no Auto-hold prefix), so it is never auto-released again', u.ok && after.stage === 'held' && !String(after.last_error).startsWith(AUTO_HOLD_PREFIX))
    const again = await runReleaseHeldPosts(admin, new Date(NOW.getTime() + 24 * HOUR), { cover })
    check('undo: it stays held on the next day (a different, newly aged post may still go)', stage('guide-hotels-good') === 'held' && !logOf(db).slice(1).some((e) => e.subject === 'guide-hotels-good'), String(again.acted))
    const u2 = world({ distribution_mode: 'auto' }, { post_distribution: [held('guide-hotels-sent', '/hotels/good', { stage: 'queued', sent_platforms: ['instagram'] })] })
    check('undo: refuses to hold again a post that already reached a network', !(await undoAutoDecision(u2.admin, { ...decision('release_held_posts', 'guide-hotels-sent', 'a', 'b', { kind: 'rehold-post', ref: 'guide-hotels-sent' }, NOW) })).ok)
    const prep = world({ distribution_mode: 'prepare' }, { post_distribution: [held('guide-hotels-good', '/hotels/good')], guides: [guide('good')] })
    check('release run: prepare mode releases nothing', (await runReleaseHeldPosts(prep.admin, NOW, { cover })).acted === 0)
    const zero = world({ distribution_mode: 'auto', guide_social_release_hours: '0' }, { post_distribution: [held('guide-hotels-good', '/hotels/good')], guides: [guide('good')] })
    check('release run: a hold time of 0 means only a person releases', (await runReleaseHeldPosts(zero.admin, NOW, { cover })).acted === 0)
    const pz = world({ distribution_mode: 'auto', automation_paused: 'true' }, { post_distribution: [held('guide-hotels-good', '/hotels/good')], guides: [guide('good')] })
    check('release run: Pause all automation releases nothing', (await runReleaseHeldPosts(pz.admin, NOW, { cover })).acted === 0)
    const lim = world({ distribution_mode: 'auto' }, { post_distribution: [held('guide-hotels-a', '/hotels/a'), held('guide-hotels-b', '/hotels/b')], guides: [guide('a'), guide('b')] })
    check('release run: one guide post a day (the existing guide limit)', (await runReleaseHeldPosts(lim.admin, NOW, { cover })).acted === 1)
    const noCover = world({ distribution_mode: 'auto' }, { post_distribution: [held('guide-hotels-a', '/hotels/a')], guides: [guide('a')] })
    check('release run: a cover check that cannot run releases nothing', (await runReleaseHeldPosts(noCover.admin, NOW, { cover: async () => 'unknown' })).acted === 0)
  }

  // ================================================================================================
  // The four together
  // ================================================================================================
  {
    const { admin } = world({ automation_paused: 'true' })
    check('all four: with Pause all automation on, nothing is decided and the run does not throw', (await runAutoPolicies(admin, NOW)).length >= 0)
  }

  // ================================================================================================
  // The funnel watchdog: thresholds with fixtures
  // ================================================================================================
  {
    const healthy = (): WatchdogFacts => ({
      now: NOW, paused: false, autopilotOn: true, autoblogMode: 'publish', hoursSinceBlogPost: 20, blogEverPublished: true, hoursSinceNudge: null,
      guidesPublished48h: 2, guidesWaiting: 5, guideCaps: { today: 0, week: 3, perDay: 1, perWeek: 5 },
      belowBar: { count: 2, total: 40 }, belowBarPrev: 2,
      distributionMode: 'auto', sends36h: 4, queuedRows: 1, recentPosts7d: 3, networks: ['instagram', 'facebook'], pauses: {}, networkStreaks: { instagram: 0, facebook: 0 },
      newPagesMissingFromSitemap: 0, indexNowConfigured: true, indexNowLastAgeHours: 5, strikingPages: 3,
      armsUnderperforming: 0, optimizerNeedsData: false, zeroLeadPages: [], visitTrackingOn: true, visits48h: 300,
    })
    const run = (over: Partial<WatchdogFacts>) => evaluateFunnel({ ...healthy(), ...over })
    const stage = (checks: ReturnType<typeof run>, s: string) => checks.find((c) => c.stage === s)!
    const base = run({})
    check('watchdog: a healthy funnel is seven green checks, each with evidence numbers and an action', base.length === 7 && base.every((c) => c.status === 'ok' && Object.keys(c.evidence).length > 0 && c.action.length > 0 && !c.plan), base.filter((c) => c.status !== 'ok').map((c) => c.stage).join())

    // production
    check(`production: ${THRESHOLDS.blogQuietHours} hours is still fine, 73 hours is amber with a nudge planned`, stage(run({ hoursSinceBlogPost: 72 }), 'production').status === 'ok' && stage(run({ hoursSinceBlogPost: 73 }), 'production').status === 'warn' && stage(run({ hoursSinceBlogPost: 73 }), 'production').plan?.kind === 'nudge-autoblog')
    const nudged = stage(run({ hoursSinceBlogPost: 100, hoursSinceNudge: 10 }), 'production')
    check('production: nudged once already and still silent is red, "needs Joel", and nudges nothing more', nudged.status === 'bad' && /^Needs Joel/.test(nudged.action) && !nudged.plan)
    check('production: nudged more than 72 hours ago may be nudged again', stage(run({ hoursSinceBlogPost: 100, hoursSinceNudge: 80 }), 'production').plan?.kind === 'nudge-autoblog')
    check('production: a quiet blog is fine when the writer is off, Autopilot is off or automation is paused (no nudge)', ['off', 'draft'].every((m) => !stage(run({ hoursSinceBlogPost: 200, autoblogMode: m }), 'production').plan) && !stage(run({ hoursSinceBlogPost: 200, autopilotOn: false }), 'production').plan && !stage(run({ hoursSinceBlogPost: 200, paused: true }), 'production').plan)
    check('production: no guide in 48 hours with candidates waiting and room in the limit is amber (reported, no repair)', stage(run({ guidesPublished48h: 0 }), 'production').status === 'warn' && !stage(run({ guidesPublished48h: 0 }), 'production').plan)
    check('production: no guide but the weekly limit is used is fine (the limiter is working)', stage(run({ guidesPublished48h: 0, guideCaps: { today: 0, week: 5, perDay: 1, perWeek: 5 } }), 'production').status === 'ok')
    check('production: no guide and nothing waiting is fine', stage(run({ guidesPublished48h: 0, guidesWaiting: 0 }), 'production').status === 'ok')
    check('production: an unreadable post time is "could not be read", amber, never a pass', stage(run({ hoursSinceBlogPost: null }), 'production').unreadable === true && stage(run({ hoursSinceBlogPost: null }), 'production').status === 'warn' && stage(run({ hoursSinceBlogPost: null }), 'production').evidence.hours_since_last_blog_post === null)
    check('production: unreadable guide counts are amber, not zero', stage(run({ guidesPublished48h: null }), 'production').status === 'warn')

    // quality
    check('quality: first check just records the starting point', stage(run({ belowBarPrev: null }), 'quality').status === 'ok')
    check(`quality: a rise of ${THRESHOLDS.qualityRise} is amber and left to the refresh loop; a smaller rise is fine`, stage(run({ belowBar: { count: 5, total: 40 }, belowBarPrev: 2 }), 'quality').status === 'warn' && /refresh loop/.test(stage(run({ belowBar: { count: 5, total: 40 }, belowBarPrev: 2 }), 'quality').action) && stage(run({ belowBar: { count: 4, total: 40 }, belowBarPrev: 2 }), 'quality').status === 'ok')
    check('quality: rising and a quarter of all posts is red', stage(run({ belowBar: { count: 12, total: 40 }, belowBarPrev: 6 }), 'quality').status === 'bad')
    check('quality: a high but steady count is not an alarm', stage(run({ belowBar: { count: 20, total: 40 }, belowBarPrev: 20 }), 'quality').status === 'ok')
    check('quality: unreadable is amber', stage(run({ belowBar: null }), 'quality').unreadable === true)

    // distribution
    check(`distribution: ${THRESHOLDS.sendQuietHours} hours with zero sends while rows are queued and networks are fine is red, needs Joel`, stage(run({ sends36h: 0 }), 'distribution').status === 'bad' && /^Needs Joel/.test(stage(run({ sends36h: 0 }), 'distribution').action))
    check('distribution: zero sends with nothing queued and no posts this week is fine', stage(run({ sends36h: 0, queuedRows: 0, recentPosts7d: 0 }), 'distribution').status === 'ok')
    check('distribution: zero sends but posts exist is flagged even with an empty queue', stage(run({ sends36h: 0, queuedRows: 0, recentPosts7d: 2 }), 'distribution').status === 'bad')
    check('distribution: no usable network is red and needs Joel', stage(run({ sends36h: 0, networks: [], networkStreaks: {} }), 'distribution').status === 'bad')
    const stuckPause = stage(run({ sends36h: 0, pauses: { facebook: { since: ago(10 * HOUR), until: new Date(NOW.getTime() + 14 * HOUR).toISOString(), strikes: 1 } } }), 'distribution')
    check('distribution: zero sends while a network is paused ends the pause (resume)', stuckPause.status === 'warn' && stuckPause.plan?.kind === 'resume-networks')
    const three = stage(run({ networkStreaks: { instagram: 0, facebook: 3 } }), 'distribution')
    check('distribution: a network that failed 3 times in a row is paused for 24 hours', three.status === 'warn' && three.plan?.kind === 'pause-network' && three.plan.network === 'facebook' && three.plan.strikes === 1)
    check('distribution: 2 failures in a row is not yet a pause', stage(run({ networkStreaks: { instagram: 0, facebook: 2 } }), 'distribution').status === 'ok')
    const afterPause = { facebook: { since: ago(30 * HOUR), until: ago(6 * HOUR), strikes: 1 } }
    check('distribution: after a pause ends, ONE more failure (the auto-test) pauses it again', stage(run({ pauses: afterPause, networkStreaks: { instagram: 0, facebook: 1 } }), 'distribution').plan?.strikes === 2)
    check('distribution: after a pause ends and the test passes (no failure), nothing happens', stage(run({ pauses: afterPause, networkStreaks: { instagram: 0, facebook: 0 } }), 'distribution').status === 'ok')
    const strikes2 = stage(run({ pauses: { facebook: { since: ago(30 * HOUR), until: ago(6 * HOUR), strikes: 2 } }, networkStreaks: { instagram: 0, facebook: 1 } }), 'distribution')
    check('distribution: after two pauses it stops pausing and asks Joel to reconnect the network', strikes2.status === 'bad' && !strikes2.plan && /^Needs Joel/.test(strikes2.action))
    check('distribution: a network already paused is not paused again', stage(run({ pauses: { facebook: { since: ago(HOUR), until: new Date(NOW.getTime() + 23 * HOUR).toISOString(), strikes: 1 } }, networkStreaks: { instagram: 0, facebook: 5 } }), 'distribution').plan === undefined)
    check('distribution: review mode (prepare) is fine, no sends expected', stage(run({ distributionMode: 'prepare', sends36h: 0 }), 'distribution').status === 'ok')
    check('distribution: unreadable counts are amber', stage(run({ sends36h: null }), 'distribution').unreadable === true && stage(run({ networks: null }), 'distribution').unreadable === true)

    // discovery
    check('discovery: a new page missing from the sitemap is amber and runs the IndexNow catch-up', stage(run({ newPagesMissingFromSitemap: 2 }), 'discovery').status === 'warn' && stage(run({ newPagesMissingFromSitemap: 2 }), 'discovery').plan?.kind === 'indexnow-catchup')
    check(`discovery: an IndexNow catch-up older than ${THRESHOLDS.indexNowStaleHours} hours is stale; 36 is not`, stage(run({ indexNowLastAgeHours: 40 }), 'discovery').plan?.kind === 'indexnow-catchup' && stage(run({ indexNowLastAgeHours: 36 }), 'discovery').status === 'ok')
    check('discovery: an unreadable sitemap is amber, not "0 missing"', stage(run({ newPagesMissingFromSitemap: null }), 'discovery').unreadable === true)
    check('discovery: striking-distance pages are reported and left to the click-rate loop', /click-rate loop/.test(stage(run({ strikingPages: 4 }), 'discovery').summary))

    // clicks, conversion, measurement
    check('clicks: an underperforming style is amber and left to the optimizer; not enough data is fine; unreadable is amber', stage(run({ armsUnderperforming: 2 }), 'clicks').status === 'warn' && /optimizer/.test(stage(run({ armsUnderperforming: 2 }), 'clicks').action) && stage(run({ optimizerNeedsData: true, armsUnderperforming: 3 }), 'clicks').status === 'ok' && stage(run({ armsUnderperforming: null }), 'clicks').unreadable === true)
    const conv = stage(run({ zeroLeadPages: [{ path: '/blog/x', visits: 140 }, { path: '/blog/y', visits: 110 }] }), 'conversion')
    check(`conversion: pages with ${THRESHOLDS.conversionMinVisits}+ visits and zero leads are reported as a card candidate (needs Joel), nothing changed`, conv.status === 'warn' && /^Needs Joel/.test(conv.action) && conv.evidence.top_page === '/blog/x' && !conv.plan)
    check('conversion: unreadable is amber', stage(run({ zeroLeadPages: null }), 'conversion').unreadable === true)
    check('measurement: tracking on with zero rows in 48 hours is red', stage(run({ visits48h: 0 }), 'measurement').status === 'bad')
    check('measurement: tracking off is fine, an unreadable count is amber (never a zero)', stage(run({ visitTrackingOn: false, visits48h: 0 }), 'measurement').status === 'ok' && stage(run({ visits48h: null }), 'measurement').unreadable === true && stage(run({ visitTrackingOn: null }), 'measurement').unreadable === true)

    // network streaks (pure)
    const row = (stage: string, err: string | null, sent: string[], mins: number) => ({ stage, sent_platforms: sent, last_error: err, updated_at: ago(mins * 60_000) })
    const rows = [row('failed', 'facebook: 503', [], 10), row('failed', 'facebook: 503; instagram: ok', ['instagram'], 20), row('queued', 'facebook: 429', [], 30), row('done', null, ['facebook'], 40), row('failed', 'facebook: 500', [], 50)]
    check('streaks: counts consecutive failures newest first and stops at a clean send', networkStreaks(rows, ['facebook', 'instagram'], {}).facebook === 3)
    check('streaks: a send that reached the network ends the streak even inside a failed row', networkStreaks(rows, ['instagram'], {}).instagram === 0)
    check('streaks: only failures after a pause ended count', networkStreaks(rows, ['facebook'], { facebook: { since: ago(HOUR), until: ago(15 * 60_000), strikes: 1 } }).facebook === 1)
    check('streaks: x and twitter are the same network', networkStreaks([row('failed', 'twitter: 503', [], 5)], ['x'], {}).x === 1)

    // the run: report only when paused; repairs and log when allowed
    const watchWorld = (settings: Record<string, string>) =>
      world({ autopilot_mode: 'on', autoblog_mode: 'publish', distribution_mode: 'auto', ...settings }, {
        posts: [{ id: 'old', slug: 'old-post', status: 'published', created_at: ago(100 * HOUR), publish_date: '2026-10-17' }],
        guides: [],
        post_distribution: [],
        site_visits: [{ id: 'v1', created_at: ago(2 * HOUR), landing_path: '/' }],
        leads: [],
      })
    const sitemap = async () => ['/', '/blog/old-post']
    const w1 = watchWorld({})
    const res = await runFunnelWatchdog(w1.admin, { now: NOW, sitemapPaths: sitemap, catchup: async () => ({ ok: true, note: 'sent 0' }) })
    const prod = res.record.checks.find((c) => c.stage === 'production')!
    check('watchdog run: 100 hours with no post nudges the writer once and logs it', setting(w1.db, AUTOBLOG_NUDGE_KEY) === NOW.toISOString() && prod.status === 'warn' && logOf(w1.db).some((e) => e.policy === 'funnel_watchdog' && /blog writer/.test(e.action)) && res.record.checks.length === 7)
    check('watchdog run: the result is saved for the card and a plan field is never stored', !!setting(w1.db, 'funnel_watchdog_last') && !('plan' in prod))
    check('watchdog run: the nudge is picked up by the pipeline once and then expires after 24 hours', (await autoblogNudgePending(w1.admin, NOW)) && !(await autoblogNudgePending(w1.admin, new Date(NOW.getTime() + 25 * HOUR))))
    const res2 = await runFunnelWatchdog(w1.admin, { now: new Date(NOW.getTime() + 2 * HOUR), sitemapPaths: sitemap })
    check('watchdog run: asked again two hours later it does NOT nudge twice (red, needs Joel)', res2.record.checks.find((c) => c.stage === 'production')?.status === 'bad' && logOf(w1.db).filter((e) => /blog writer/.test(e.action)).length === 1)
    const w2 = watchWorld({ automation_paused: 'true' })
    const res3 = await runFunnelWatchdog(w2.admin, { now: NOW, sitemapPaths: sitemap })
    check('watchdog run: with Pause all automation on it reports only, makes no repair and writes no nudge', setting(w2.db, AUTOBLOG_NUDGE_KEY) === undefined && res3.record.checks.length === 7 && logOf(w2.db).every((e) => e.action.startsWith('Needs Joel')))
    const w3 = watchWorld({ [policyKey('funnel_watchdog')]: 'off' })
    await runFunnelWatchdog(w3.admin, { now: NOW, sitemapPaths: sitemap })
    check('watchdog run: the watchdog switch off makes no repair', setting(w3.db, AUTOBLOG_NUDGE_KEY) === undefined)

    // network pause end to end
    const w4 = world({ autopilot_mode: 'on', distribution_mode: 'auto', distribution_provider: 'upload-post', distribution_accounts: 'prof', distribution_platforms: 'instagram,facebook' }, {
      posts: [{ id: 'p', slug: 'fresh', status: 'published', created_at: ago(2 * HOUR) }],
      post_distribution: [
        { content_type: 'post', slug: 'a', stage: 'failed', sent_platforms: [], last_error: 'facebook: 503', updated_at: ago(3 * HOUR) },
        { content_type: 'post', slug: 'b', stage: 'failed', sent_platforms: [], last_error: 'facebook: 503', updated_at: ago(4 * HOUR) },
        { content_type: 'post', slug: 'c', stage: 'failed', sent_platforms: [], last_error: 'facebook: 503', updated_at: ago(5 * HOUR) },
        { content_type: 'post', slug: 'd', stage: 'done', sent_platforms: ['instagram'], last_error: null, updated_at: ago(2 * HOUR) },
      ],
    })
    process.env.UPLOAD_POST_API_KEY = 'test-key-not-real'
    const before = await resolvePostingTarget(w4.admin)
    check('network pause: before the watchdog, both networks are in the posting target', before.target?.platforms.join() === 'instagram,facebook', JSON.stringify(before))
    await runFunnelWatchdog(w4.admin, { now: NOW, sitemapPaths: sitemap })
    const pauses = parsePauses(setting(w4.db, NETWORK_PAUSES_KEY))
    check('network pause: three failures in a row pause facebook for 24 hours and log it with an undo', pausedNow(pauses, NOW).join() === 'facebook' && pauses.facebook.strikes === 1 && Date.parse(pauses.facebook.until) - NOW.getTime() === 24 * HOUR && logOf(w4.db).some((e) => e.subject === 'facebook' && e.undo?.kind === 'unpause-network'))
    // The posting target reads the real clock, so a pause that lasts into the real future is written by hand for this part.
    const savedPauses = setting(w4.db, NETWORK_PAUSES_KEY)
    w4.db.tables.app_settings.find((r) => r.key === NETWORK_PAUSES_KEY)!.value = JSON.stringify({ facebook: { since: new Date().toISOString(), until: new Date(Date.now() + 2 * HOUR).toISOString(), strikes: 1 } })
    const during = await resolvePostingTarget(w4.admin)
    check('network pause: while paused, the posting target leaves facebook out and still posts to instagram', during.target?.platforms.join() === 'instagram', JSON.stringify(during))
    w4.db.tables.app_settings.find((r) => r.key === NETWORK_PAUSES_KEY)!.value = savedPauses as string
    const ent = logOf(w4.db).find((e) => e.subject === 'facebook') as AutoDecision
    const un = await undoAutoDecision(w4.admin, ent)
    const afterUndo = await resolvePostingTarget(w4.admin)
    check('undo: facebook posts again straight away', un.ok && afterUndo.target?.platforms.join() === 'instagram,facebook')
    check('network pause: a pause ends by itself', pausedNow(pauses, new Date(NOW.getTime() + 25 * HOUR)).length === 0)
    check('network pause: an unreadable or corrupt pause row pauses nothing', parsePauses('{bad').constructor === Object && Object.keys(parsePauses('{bad')).length === 0 && Object.keys(parsePauses('[1]')).length === 0)
  }

  // ================================================================================================
  // Exceptions only
  // ================================================================================================
  {
    const items = buildExceptions(
      {
        failedPosts: [
          { slug: 'auth-post', stage: 'failed', last_error: '401 token expired', sent_platforms: [], updated_at: ago(5 * HOUR) },
          { slug: 'retryable', stage: 'failed', last_error: '503', sent_platforms: [], updated_at: ago(5 * HOUR) },
          { slug: 'partly', stage: 'failed', last_error: '503', sent_platforms: ['x'], updated_at: ago(5 * HOUR) },
        ],
        retries: {},
        failedSteps: [{ slug: 'pp', part: 'carousel', last_error: '403 forbidden', updated_at: ago(5 * HOUR), sent: [] }],
        heldCaptionFailed: [{ slug: 'guide-hotels-q', title: 'Hotel Q', last_error: `${CAPTION_FAILED_PREFIX} superlative or rating claim (best)` }],
        suggestedTopics: 3,
        waitingNewsDrafts: 0,
        watchdog: { at: NOW.toISOString(), checks: evaluateFunnel({ ...({} as WatchdogFacts), now: NOW, paused: false, autopilotOn: true, autoblogMode: 'publish', hoursSinceBlogPost: 10, blogEverPublished: true, hoursSinceNudge: null, guidesPublished48h: 1, guidesWaiting: 0, guideCaps: null, belowBar: { count: 1, total: 10 }, belowBarPrev: 1, distributionMode: 'auto', sends36h: 0, queuedRows: 3, recentPosts7d: 1, networks: ['instagram'], pauses: {}, networkStreaks: { instagram: 0 }, newPagesMissingFromSitemap: 0, indexNowConfigured: false, indexNowLastAgeHours: null, strikingPages: 0, armsUnderperforming: 0, optimizerNeedsData: true, zeroLeadPages: [], visitTrackingOn: false, visits48h: 0 }) },
      },
      NOW,
    )
    const ids = items.map((i) => i.id)
    check('exceptions: auth failure, partly sent post, forbidden step, caption-failed hold, waiting topics and a red funnel stage are listed', ['post:auth-post', 'post:partly', 'step:pp:carousel', 'held:guide-hotels-q', 'topics:waiting', 'watchdog:distribution'].every((id) => ids.includes(id)), ids.join())
    check('exceptions: a post the system can still retry by itself is NOT shown to Joel', !ids.includes('post:retryable'))
    check('exceptions: nothing is invented for an empty news list, and every item has a plain why, a next step and a severity', !ids.includes('news:waiting') && items.every((i) => i.why.length > 0 && i.nextStep.length > 0 && ['bad', 'warn', 'info'].includes(i.severity)))
    check('exceptions: worst first (red before amber before info)', items[0].severity === 'bad' && items[items.length - 1].severity === 'info')
    check('exceptions: no long dashes in any text', !LONG_DASH.test(JSON.stringify(items)))
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
