// Offline self-check for the loop-discipline build: the shared publishing limiter (lib/publish-cadence.ts), the extra autoblog posts a
// day setting, the heal retry bound, the guide spend line, the effective posting networks and the Bing coverage summary.
// No network, no database, no AI. Run: pnpm dlx tsx scripts/check-publish-cadence.ts
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakeAdmin, type Db } from './fake-admin'
import {
  CADENCE_LOG_KEY,
  MIN_GAP_MINUTES,
  checkCadence,
  dedupeEvents,
  evaluateCadence,
  guideCadenceKey,
  guideLimits,
  parseLedger,
  postLimits,
  readPublishEvents,
  recordPublish,
  type CadenceLimits,
} from '../lib/publish-cadence'
import { clampMaxPerDay, mayWriteAnotherToday, MAX_MAX_PER_DAY, setAutoblogMaxPerDay, getAutoblogMaxPerDay } from '../lib/autoblog-cadence'
import { describeGuideSpend, perPublished, readGuideSpend, sumFeatures } from '../lib/guide-spend'
import { describeEffective, effectiveNetworks, MAINSTREAM_NETWORKS, type EffectiveInput } from '../lib/effective-networks'
import { describeBing, fetchBingCoverage, parseBingDate, parseCrawlStats, readBingCoverage, runBingCoverage, BING_COVERAGE_KEY } from '../lib/bing-coverage'
import { isHealDraftCandidate, REJECTED_PREFIX } from '../lib/heal-drafts'
import { MAX_GUIDE_REJECTIONS, REJECTED_RETRY_DAYS } from '../lib/guides'
import { activePlatformsOf } from '../lib/social-provider'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const T0 = Date.parse('2026-10-22T09:00:00.000Z')

async function main() {
  // ---- A: the pure rule ------------------------------------------------------------------------------------------
  {
    const lim: CadenceLimits = { perDay: 3, perWeek: 14, minGapMinutes: 0 }
    const ev = (n: number, at = T0) => Array.from({ length: n }, (_x, i) => ({ key: `g:${i}`, at }))
    check('A: nothing published yet is allowed', evaluateCadence([], lim, T0).allowed === true)
    check('A: 2 of 3 in the last 24 hours is allowed', evaluateCadence(ev(2), lim, T0 + HOUR).allowed === true)
    const d3 = evaluateCadence(ev(3), lim, T0 + HOUR)
    check('A: 3 of 3 in the last 24 hours is blocked, named "day", with the time the oldest one falls out', !d3.allowed && d3.reason === 'day' && d3.retryAfter === new Date(T0 + DAY).toISOString(), JSON.stringify(d3))
    check('A: the day is ROLLING (24h), not "since midnight": 23h59m later still blocked, 24h later allowed', !evaluateCadence(ev(3), lim, T0 + DAY - MIN).allowed && evaluateCadence(ev(3), lim, T0 + DAY).allowed)
    const wk = Array.from({ length: 14 }, (_x, i) => ({ key: `g:${i}`, at: T0 + i * 11 * HOUR }))
    const w = evaluateCadence(wk, { perDay: 3, perWeek: 14, minGapMinutes: 0 }, T0 + 14 * 11 * HOUR)
    check('A: 14 in the last 7 days is blocked by the weekly limit', !w.allowed && w.reason === 'week', JSON.stringify(w))
    const gap = evaluateCadence([{ key: 'a', at: T0 }], { perDay: 10, perWeek: 50, minGapMinutes: 90 }, T0 + 89 * MIN)
    check('A: 89 minutes after the last publish is too soon (gap 90), the retry time is exactly 90 minutes after', !gap.allowed && gap.reason === 'gap' && gap.retryAfter === new Date(T0 + 90 * MIN).toISOString(), JSON.stringify(gap))
    check('A: 90 minutes after is allowed', evaluateCadence([{ key: 'a', at: T0 }], { perDay: 10, perWeek: 50, minGapMinutes: 90 }, T0 + 90 * MIN).allowed)
    check('A: a limit of 0 means nothing is published (guides switched off)', !evaluateCadence([], { perDay: 0, perWeek: 5, minGapMinutes: 0 }, T0).allowed)
    check('A: a null limit means this limiter adds no cap (posts use the gap only)', evaluateCadence(ev(50), { perDay: null, perWeek: null, minGapMinutes: 0 }, T0).allowed)
    check('A: the same page listed twice counts once (ledger plus table)', dedupeEvents([{ key: 'x', at: 1 }, { key: 'x', at: 5 }, { key: 'y', at: 2 }]).length === 2 && dedupeEvents([{ key: 'x', at: 1 }, { key: 'x', at: 5 }]).find((e) => e.key === 'x')?.at === 5)
    check('A: the guide limits are the existing numbers plus the 90 minute stagger; posts get the stagger only', JSON.stringify(guideLimits({ perDay: 3, perWeek: 14 })) === JSON.stringify({ perDay: 3, perWeek: 14, minGapMinutes: MIN_GAP_MINUTES }) && MIN_GAP_MINUTES === 90 && postLimits().perDay === null && postLimits().perWeek === null && postLimits().minGapMinutes === 90)
    check('A: the blocked message says deferred, never dropped or failed', !d3.allowed && /deferred, not dropped/.test(d3.note) && !/fail/i.test(d3.note))
    check('A: a malformed ledger is ignored, not thrown', parseLedger('{nope', 'guide').length === 0 && parseLedger('[{"t":"guide","k":"a","at":"bad"},{"t":"post","k":"b","at":"2026-10-22T00:00:00Z"}]', 'guide').length === 0)
  }

  // ---- B: a burst of 10 attempts publishes only the allowed count --------------------------------------------------
  {
    const run = async (limits: CadenceLimits, attempts: number, stepMs: number, db: Db = { tables: { app_settings: [], guides: [] } }) => {
      const admin = fakeAdmin(db)
      let published = 0
      let deferred = 0
      for (let i = 0; i < attempts; i++) {
        const now = new Date(T0 + i * stepMs)
        const d = await checkCadence(admin, 'guide', limits, now)
        if (d.allowed) {
          await recordPublish(admin, 'guide', guideCadenceKey('destinations', `d${i}`), now)
          published++
        } else deferred++
      }
      return { published, deferred, admin, db }
    }
    const b1 = await run({ perDay: 3, perWeek: 14, minGapMinutes: 0 }, 10, 0)
    check('B: a burst of 10 at the same instant with guides_per_day=3 publishes exactly 3, defers 7', b1.published === 3 && b1.deferred === 7, JSON.stringify({ p: b1.published, d: b1.deferred }))
    const b2 = await run({ perDay: 3, perWeek: 14, minGapMinutes: 90 }, 10, 0)
    check('B: with the 90 minute stagger a burst at the same instant publishes exactly 1', b2.published === 1 && b2.deferred === 9, JSON.stringify({ p: b2.published }))
    const b3 = await run({ perDay: 3, perWeek: 14, minGapMinutes: 90 }, 10, 15 * MIN)
    check('B: the autopilot asks every 15 minutes for 2.5 hours: 2 go out (at 0 and 90 minutes), the rest wait', b3.published === 2, JSON.stringify({ p: b3.published }))
    const b4 = await run({ perDay: 1, perWeek: 5, minGapMinutes: 90 }, 10, 3 * HOUR)
    check('B: the old default of 1 a day: 10 attempts over 30 hours publish 2 (hour 0 and hour 24), not 10', b4.published === 2, JSON.stringify({ p: b4.published }))
    const b5 = await run({ perDay: 5, perWeek: 5, minGapMinutes: 0 }, 20, 12 * HOUR)
    const ledger5 = parseLedger(String(b5.db.tables.app_settings.find((r) => r.key === CADENCE_LOG_KEY)?.value ?? '[]'), 'guide').map((e) => e.at)
    const worstWeek = Math.max(...ledger5.map((t) => ledger5.filter((u) => u >= t && u - t < 7 * DAY).length))
    check('B: the weekly limit holds over every rolling 7 days (5 a week, attempts every 12 hours for 10 days: 10 go out, never more than 5 in any week)', b5.published === 10 && worstWeek === 5, JSON.stringify({ p: b5.published, worstWeek }))
    check('B: the ledger keeps the go-live times (one row per publish)', (JSON.parse(String(b1.db.tables.app_settings.find((r) => r.key === CADENCE_LOG_KEY)?.value ?? '[]')) as unknown[]).length === 3)
  }

  // ---- C: deferred items are retried next tick --------------------------------------------------------------------
  {
    const db: Db = { tables: { app_settings: [], guides: [] } }
    const admin = fakeAdmin(db)
    const limits: CadenceLimits = { perDay: 3, perWeek: 14, minGapMinutes: 90 }
    // three published at t0, t0+91m, t0+182m
    for (const m of [0, 91, 182]) await recordPublish(admin, 'guide', guideCadenceKey('destinations', `d${m}`), new Date(T0 + m * MIN))
    const blocked = await checkCadence(admin, 'guide', limits, new Date(T0 + 273 * MIN))
    check('C: the 4th inside 24 hours is deferred (day) with the exact next slot', !blocked.allowed && blocked.reason === 'day' && blocked.retryAfter === new Date(T0 + DAY).toISOString(), JSON.stringify(blocked))
    const sameItemLater = await checkCadence(admin, 'guide', limits, new Date(T0 + DAY + 1 * MIN))
    check('C: the same item, asked again after the slot opens, is published (retried by the next tick, not lost)', sameItemLater.allowed === true, JSON.stringify(sameItemLater))
    const unreadable = await checkCadence({ from: () => { throw new Error('db down') } } as unknown as SupabaseClient, 'guide', limits, new Date(T0))
    check('C: FAIL CLOSED: an unreadable history defers (reason unreadable), it never publishes', !unreadable.allowed && unreadable.reason === 'unreadable' && /deferred, not dropped/.test(unreadable.note), JSON.stringify(unreadable))
    check('C: a failed ledger write is reported, not thrown', 'error' in (await recordPublish(fakeAdmin({ tables: { app_settings: [] }, failWrites: { app_settings: 'read only' } }), 'guide', 'x')))
  }

  // ---- D: healing a guide that is ALREADY live does not count -------------------------------------------------------
  {
    const now = new Date(T0)
    const db: Db = {
      tables: {
        app_settings: [],
        guides: [
          // live for 20 days, healed just now (updated_at is recent): must NOT be counted
          { kind: 'destinations', slug: 'old-live', status: 'published', source: 'ai', created_at: new Date(T0 - 20 * DAY).toISOString(), updated_at: new Date(T0 - 5 * MIN).toISOString() },
          // a draft that is still a draft: not a publish
          { kind: 'destinations', slug: 'a-draft', status: 'draft', source: 'ai', created_at: new Date(T0 - 2 * HOUR).toISOString(), updated_at: new Date(T0 - 2 * HOUR).toISOString() },
          // written and published 3 hours ago: counts once
          { kind: 'destinations', slug: 'new-live', status: 'published', source: 'ai', created_at: new Date(T0 - 3 * HOUR).toISOString(), updated_at: new Date(T0 - 3 * HOUR).toISOString() },
        ],
      },
    }
    const admin = fakeAdmin(db)
    const events = (await readPublishEvents(admin, 'guide', now.getTime())) ?? []
    check('D: only the guide that really went live in the window is counted (a live heal and a draft are not)', events.length === 1 && events[0].key === guideCadenceKey('destinations', 'new-live'), JSON.stringify(events))
    // an old draft published by the heal today is counted through the ledger, once, at the publish time (not its old created_at)
    await recordPublish(admin, 'guide', guideCadenceKey('destinations', 'old-draft'), new Date(T0 - HOUR))
    const after = (await readPublishEvents(admin, 'guide', now.getTime())) ?? []
    check('D: a held draft the heal published an hour ago is counted once, at its publish time', after.length === 2 && after.some((e) => e.key === guideCadenceKey('destinations', 'old-draft') && e.at === T0 - HOUR), JSON.stringify(after))
    const heal = src('lib/heal-drafts.ts')
    const liveBranch = heal.slice(heal.indexOf("if (rowStatus === 'published') {\n    // Already live"), heal.indexOf('const problem = await publishLogged'))
    check('D: the healed-live branch never records a publish', liveBranch.length > 50 && !/recordPublish/.test(liveBranch))
    check('D: only the draft-to-published path records a publish', (heal.match(/recordPublish\(/g) ?? []).length === 1 && heal.indexOf('recordPublish(') > heal.indexOf('const problem = await publishLogged'))
    check('D: safe-page enrichment (live pages only) and the backfill planner never publish a draft, so they are not limited', !/recordPublish|checkCadence/.test(src('lib/safe-enrich.ts')) && !/status: 'published'/.test(src('lib/guide-backfill.ts')))
  }

  // ---- E: every automatic publisher asks the limiter -------------------------------------------------------------
  {
    const guideRun = src('lib/guide-run.ts')
    check('E: the guide writer asks the limiter before it spends AI, and again right before it saves a published guide', /const slot = await checkCadence\(admin, 'guide', limits\)[\s\S]*?const result = await writeGuide/.test(guideRun) && /if \(publishing\) \{\s*const slot = await checkCadence/.test(guideRun))
    check('E: the guide writer records the go-live time', /if \(publishing\) await recordPublish\(admin, 'guide'/.test(guideRun))
    check('E: the held-guide heal asks the limiter before it claims or calls the AI', /checkCadence\(admin, 'guide', limits, now\)[\s\S]*?const r = await healGuideRow/.test(src('lib/heal-drafts.ts')))
    const reheal = src('lib/blog-reheal.ts')
    check('E: the blog re-check asks the limiter just before it publishes and records the publish', /checkCadence\(admin, 'post', postLimits\(\), now\)/.test(reheal) && /recordPublish\(admin, 'post'/.test(reheal))
    const auto = src('lib/autoblog-run.ts')
    check('E: the blog writer asks the limiter (scheduled runs, publish mode) and records the publish', /checkCadence\(admin, 'post', postLimits\(\)\)/.test(auto) && /recordPublish\(admin, 'post'/.test(auto))
    check('E: the admin "Run now" and manual publish are not blocked (the limiter sits inside the scheduled branch)', /if \(opts\.scheduled\) \{[\s\S]*?checkCadence\(admin, 'post'/.test(auto) && !/checkCadence/.test(src('app/api/admin/guides/[id]/route.ts')) && !/checkCadence/.test(src('app/api/admin/guides/list/route.ts')))
    check('E: the social catch-up (guide-distribution) queues posts, publishes nothing, and keeps its own 1 a day cap', /GUIDE_ENROLMENTS_PER_DAY = 1/.test(src('lib/guide-distribution.ts')) && !/status: 'published'/.test(src('lib/guide-distribution.ts')))
  }

  // ---- F: autoblog posts a day -------------------------------------------------------------------------------------
  {
    check('F: the default is 1 and any bad value falls back to 1', clampMaxPerDay(null) === 1 && clampMaxPerDay('') === 1 && clampMaxPerDay('0') === 1 && clampMaxPerDay('4') === 1 && clampMaxPerDay('2.5') === 1 && clampMaxPerDay('abc') === 1 && clampMaxPerDay('1') === 1)
    check('F: 2 and 3 are accepted and 3 is the cap', clampMaxPerDay('2') === 2 && clampMaxPerDay('3') === 3 && MAX_MAX_PER_DAY === 3)
    check('F: the first post of the day is always allowed (the old rule)', mayWriteAnotherToday(0, 1, false) && mayWriteAnotherToday(0, 3, false))
    check('F: default 1: a second post is never allowed, even with approved topics waiting', !mayWriteAnotherToday(1, 1, true))
    check('F: max 2 or 3: an extra post only when an approved topic is waiting, and never past the cap', mayWriteAnotherToday(1, 2, true) && !mayWriteAnotherToday(1, 2, false) && mayWriteAnotherToday(2, 3, true) && !mayWriteAnotherToday(2, 2, true) && !mayWriteAnotherToday(3, 3, true))
    const db: Db = { tables: { app_settings: [] } }
    const admin = fakeAdmin(db)
    check('F: the setter refuses 0, 4, 1.5 and text, and saves nothing', (await setAutoblogMaxPerDay(admin, 0)).error !== undefined && (await setAutoblogMaxPerDay(admin, 4)).error !== undefined && (await setAutoblogMaxPerDay(admin, 1.5)).error !== undefined && db.tables.app_settings.length === 0)
    check('F: the setter saves 2 and the reader returns it; an unset value reads as 1', (await getAutoblogMaxPerDay(fakeAdmin({ tables: { app_settings: [] } }))) === 1 && !(await setAutoblogMaxPerDay(admin, 2)).error && (await getAutoblogMaxPerDay(admin)) === 2)
    const auto = src('lib/autoblog-run.ts')
    check('F: an extra post comes only from the approved queue (never the AI-freeform fallback)', /if \(extraOnly && !topic\) return/.test(auto) && auto.indexOf('if (extraOnly && !topic)') < auto.indexOf('pickKeywordTopic(admin, existingPosts)'))
    const api = src('app/api/admin/blog/autoblog-cadence/route.ts')
    check('F: the API is behind isAuthorized on both verbs and validates 1 to 3 before saving', (api.match(/isAuthorized\(request\)/g) ?? []).length === 2 && /body\.maxPerDay < 1 \|\| body\.maxPerDay > 3/.test(api))
    check('F: the Blog Automation card shows the selector', /autoblog-max-per-day/.test(src('components/admin/posts-automation-card.tsx')))
  }

  // ---- G: heal retries are bounded ---------------------------------------------------------------------------------
  {
    const now = new Date(T0)
    const row = (over: Record<string, unknown> = {}) => ({ id: 'g', kind: 'destinations', slug: 'x', status: 'draft', source: 'ai', review_state: 'rejected', quality_notes: `${REJECTED_PREFIX} still blocked`, created_at: new Date(T0 - 5 * DAY).toISOString(), updated_at: new Date(T0 - 3 * DAY).toISOString(), ...over })
    const retryWith = (n: number) => ({ rejections: () => n })
    check('G: constants: a rejected draft is retried at most once more (2 rejections in all) and only after 2 quiet days', MAX_GUIDE_REJECTIONS === 2 && REJECTED_RETRY_DAYS === 2)
    check('G: a draft rejected once (no retry yet) may be retried after 3 quiet days', isHealDraftCandidate(row(), now, [], retryWith(0)) === true)
    check('G: but not on the day after it was rejected', isHealDraftCandidate(row({ updated_at: new Date(T0 - 1 * DAY).toISOString() }), now, [], retryWith(0)) === false)
    check('G: a draft rejected TWICE is not retried, however long it has waited (7 days, 20 days)', !isHealDraftCandidate(row({ updated_at: new Date(T0 - 7 * DAY).toISOString() }), now, [], retryWith(1)) && !isHealDraftCandidate(row({ updated_at: new Date(T0 - 20 * DAY).toISOString() }), now, [], retryWith(1)))
    check('G: if the rejection counter cannot be read, no rejected draft is retried (fail closed)', !isHealDraftCandidate(row(), now, [], undefined))
    check('G: a draft a PERSON rejected (no heal note) is never retried by the heal', !isHealDraftCandidate(row({ quality_notes: 'not accurate' }), now, [], retryWith(0)))
    const heal = src('lib/heal-drafts.ts')
    check('G: the second heal rejection is counted in the same store the writer uses', /bumpRejectionCount\(admin, `\$\{kind\}:\$\{slug\}`/.test(heal))
    check('G: the whole loop is also bounded by the daily call budget and 3 rejections a day (existing)', /MAX_REJECTS_PER_DAY = 3/.test(src('lib/heal-loop.ts')) && /HEAL_CALLS_DEFAULT = 40/.test(src('lib/heal-loop.ts')))
  }

  // ---- H: AI spend line --------------------------------------------------------------------------------------------
  {
    check('H: sumFeatures adds only the named features, to the cent', sumFeatures([{ feature: 'guide-composer', est_cost_usd: '1.234' }, { feature: 'heal-loop', est_cost_usd: 2 }, { feature: 'other', est_cost_usd: 9 }, { feature: 'guide-composer', est_cost_usd: 'x' }], ['guide-composer']) === 1.23)
    check('H: per published guide divides, and is null (not 0) when nothing was published or a part is unknown', perPublished(2, 4, 3) === 2 && perPublished(2, 4, 0) === null && perPublished(null, 4, 3) === null && perPublished(2, null, 3) === null && perPublished(2, 4, null) === null)
    const since = (h: number) => new Date(T0 - h * HOUR).toISOString()
    const db: Db = {
      tables: {
        api_calls: [
          { ts: since(2), feature: 'guide-composer', est_cost_usd: 1.5 },
          { ts: since(30), feature: 'heal-loop', est_cost_usd: 3.25 },
          { ts: since(30), feature: 'content-repair', est_cost_usd: 0.25 },
          { ts: since(24 * 9), feature: 'heal-loop', est_cost_usd: 50 },
          { ts: since(2), feature: 'blog-composer', est_cost_usd: 7 },
        ],
        app_settings: [],
        guides: [{ kind: 'destinations', slug: 'a', status: 'published', source: 'ai', created_at: since(5) }, { kind: 'destinations', slug: 'b', status: 'published', source: 'ai', created_at: since(48) }],
      },
    }
    const s = await readGuideSpend(fakeAdmin(db), T0)
    check('H: compose 1.50, heal 3.50 (older than 7 days and other features left out), 2 published, 2.50 per guide', s.composeUsd === 1.5 && s.healUsd === 3.5 && s.published === 2 && s.perPublishedUsd === 2.5, JSON.stringify(s))
    check('H: the line reads "AI spend last 7 days (estimate): compose / heal / published guides"', /AI spend last 7 days \(estimate\): compose \$1\.50 \/ heal \$3\.50 \/ published guides 2/.test(describeGuideSpend(s)), describeGuideSpend(s))
    const broken = { from: (t: string) => (t === 'api_calls' ? { select: () => ({ in: () => ({ gte: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'no table' } }) }) }) }) } : fakeAdmin(db).from(t)) } as unknown as SupabaseClient
    const sb = await readGuideSpend(broken, T0)
    check('H: an unreadable meter is "could not be read", never a fake zero', sb.composeUsd === null && sb.healUsd === null && sb.perPublishedUsd === null && /compose could not be read \/ heal could not be read/.test(describeGuideSpend(sb)), describeGuideSpend(sb))
    check('H: no spend object at all reads as could not be read', /could not be read/.test(describeGuideSpend(null)))
    const api = src('app/api/admin/posts/automation/route.ts')
    check('H: the automation API reads it inside a catch (a failure becomes null) and the card shows it', /readGuideSpend\(admin\)\.catch\(\(\) => null\)/.test(api) && /describeGuideSpend/.test(src('components/admin/guides-automation-card.tsx')))
  }

  // ---- I: effective networks ---------------------------------------------------------------------------------------
  {
    const base: EffectiveInput = {
      provider: 'ghl',
      ghl: {
        configured: true,
        missing: [],
        accounts: [
          { id: 'a1', platform: 'instagram', name: 'IG', active: true, expired: false },
          { id: 'a2', platform: 'linkedin', name: 'LI', active: true, expired: false },
          { id: 'a3', platform: 'x', name: 'X', active: true, expired: false },
          { id: 'a4', platform: 'tiktok', name: 'TT', active: true, expired: false },
          { id: 'a5', platform: 'pinterest', name: 'PI', active: true, expired: true },
          { id: 'a6', platform: 'threads', name: 'TH', active: true, expired: false },
        ],
        selected: [{ id: 'a1', platform: 'instagram' }, { id: 'a2', platform: 'linkedin' }, { id: 'a3', platform: 'twitter' }, { id: 'a4', platform: 'tiktok' }, { id: 'a5', platform: 'pinterest' }],
        error: null,
      },
      upload: { configured: true, profilesError: null, profiles: [], selectedProfile: '', selectedPlatforms: ['bluesky'] },
    }
    const e = effectiveNetworks(base)
    check('I: with GoHighLevel the list is the ticked accounts (instagram, x, linkedin, tiktok), NOT the stale Upload-Post "bluesky"', e.networks.join(',') === 'instagram,x,linkedin,tiktok' && !e.networks.includes('bluesky'), JSON.stringify(e.networks))
    check('I: the stale list is named as ignored', e.notes.some((n) => /Bluesky/.test(n) && /ignored/.test(n)), JSON.stringify(e.notes))
    const fb = e.missing.find((m) => m.platform === 'facebook')
    check('I: Facebook missing says it is not connected in GoHighLevel', !!fb && /not connected in GoHighLevel/.test(fb.reason), JSON.stringify(fb))
    const pi = e.missing.find((m) => m.platform === 'pinterest')
    check('I: an expired ticked account is not counted as posting and the reason says reconnect', !e.networks.includes('pinterest') && !!pi && /expired/.test(pi.reason) && /reconnect/.test(pi.reason), JSON.stringify(pi))
    const th = e.missing.find((m) => m.platform === 'threads')
    check('I: a connected but unticked network says tick it', !!th && /connected in GoHighLevel but not ticked/.test(th.reason))
    check('I: TikTok through GoHighLevel carries the video-only note', e.notes.some((n) => /TikTok.*videos only/.test(n)))
    check('I: every mainstream network is either posting or listed with a reason', MAINSTREAM_NETWORKS.every((p) => e.networks.includes(p) || e.missing.some((m) => m.platform === p && m.reason.length > 10)))
    const sender = activePlatformsOf('ghl', base.ghl.selected.filter((s) => s.id !== 'a5').map((s) => ({ ...s, name: s.id })), ['bluesky']).map((p) => (p === 'twitter' ? 'x' : p)).sort().join(',')
    check('I: it agrees with the real sender (activePlatformsOf) for the accounts that are ready', sender === [...e.networks].sort().join(','), sender)
    const notSet = effectiveNetworks({ ...base, ghl: { ...base.ghl, configured: false, missing: ['GHL_PRIVATE_TOKEN'] } })
    check('I: GoHighLevel not set up: no networks and the reason names the missing setting', notSet.networks.length === 0 && notSet.missing.every((m) => /GHL_PRIVATE_TOKEN/.test(m.reason)))
    const unread = effectiveNetworks({ ...base, ghl: { ...base.ghl, accounts: [], error: 'Could not reach GoHighLevel.' } })
    check('I: if GoHighLevel cannot be read, ticked accounts are kept and the reasons say so honestly', unread.networks.includes('instagram') && !!unread.missing.find((m) => m.platform === 'facebook' && /could not be read/.test(m.reason)))
    check('I: the sentence for the top of the card', describeEffective(e) === 'Posts go to Instagram, X, LinkedIn, TikTok through GoHighLevel.', describeEffective(e))
    const up = effectiveNetworks({
      ...base,
      provider: 'upload-post',
      upload: { configured: true, profilesError: null, profiles: [{ username: 'tfb', accounts: [{ platform: 'Facebook' }, { platform: 'instagram', status: 'needs reconnect' }] }], selectedProfile: 'tfb', selectedPlatforms: ['facebook', 'instagram'] },
    })
    check('I: Upload-Post: only connected, healthy, ticked networks post; a needs-reconnect one is listed with its reason', up.networks.join(',') === 'facebook' && !!up.missing.find((m) => m.platform === 'instagram' && /reconnected/.test(m.reason)) && up.notes.some((n) => /ignored while Upload-Post/.test(n)))
    const api = src('app/api/admin/posting/route.ts')
    check('I: the posting API returns the effective list and the card shows it', /effective: \{ \.\.\.effective/.test(api) && /Not receiving posts yet/.test(src('components/admin/posting-card.tsx')))
  }

  // ---- J: Bing coverage -----------------------------------------------------------------------------------------------
  {
    const day = (n: number) => `/Date(${T0 - n * DAY})/`
    const body = { d: [{ Date: day(2), CrawledPages: 10, CrawlErrors: 1, InIndex: 100 }, { Date: day(0), CrawledPages: 30, CrawlErrors: 2, InIndex: 120 }, { Date: day(20), CrawledPages: 999, InIndex: 5 }] }
    const p = parseCrawlStats(body)
    check('J: the newest day wins; crawled in 7 days sums only the last week; indexed is the newest', !!p && p.crawledLatest === 30 && p.crawled7d === 40 && p.indexed === 120 && p.crawlErrors === 2 && p.asOf === new Date(T0).toISOString().slice(0, 10), JSON.stringify(p))
    check('J: an unreadable body is null, not zeros', parseCrawlStats({ d: [] }) === null && parseCrawlStats('nope') === null && parseCrawlStats({ d: [{ Date: 'x' }] }) === null && parseBingDate('/Date(1700000000000)/') === 1700000000000)
    const ok = await fetchBingCoverage({ apiKey: 'k', siteUrl: 'https://example.ca', now: new Date(T0), fetchImpl: (async (u: string) => { check('J: the call is the documented GetCrawlStats URL with the key and site', /^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetCrawlStats\?/.test(u) && /apikey=k/.test(u) && /siteUrl=https%3A%2F%2Fexample\.ca/.test(u)); return new Response(JSON.stringify(body), { status: 200 }) }) as unknown as typeof fetch })
    check('J: a good answer is status ok', ok.status === 'ok' && ok.indexed === 120)
    const empty = await fetchBingCoverage({ apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ d: [] }), { status: 200 })) as unknown as typeof fetch })
    check('J: an answer with nothing readable is "unknown" with a reason, never a guessed number', empty.status === 'unknown' && empty.indexed === null && /no crawl or index numbers/.test(empty.note))
    const err = await fetchBingCoverage({ apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ Message: 'InvalidApiKey' }), { status: 401 })) as unknown as typeof fetch })
    check('J: an error answer is "unknown" with Bing\'s message', err.status === 'unknown' && /InvalidApiKey/.test(err.note))
    const boom = await fetchBingCoverage({ apiKey: 'k', fetchImpl: (async () => { throw new Error('network') }) as unknown as typeof fetch })
    check('J: a network failure never throws', boom.status === 'unknown')
    const saved: Db = { tables: { app_settings: [] } }
    const prevKey = process.env.BING_WEBMASTER_API_KEY
    delete process.env.BING_WEBMASTER_API_KEY
    const none = await runBingCoverage(fakeAdmin(saved), { fetchImpl: (async () => { throw new Error('must not be called') }) as unknown as typeof fetch })
    check('J: without BING_WEBMASTER_API_KEY nothing is called and nothing is written', none === '' && saved.tables.app_settings.length === 0)
    process.env.BING_WEBMASTER_API_KEY = 'k'
    const ran = await runBingCoverage(fakeAdmin(saved), { now: new Date(T0), fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch })
    if (prevKey === undefined) delete process.env.BING_WEBMASTER_API_KEY
    else process.env.BING_WEBMASTER_API_KEY = prevKey
    const stored = await readBingCoverage(fakeAdmin(saved))
    check('J: with a key the summary is stored under bing_coverage_snapshot and reads back', /Bing: 40 pages crawled/.test(ran) && saved.tables.app_settings.some((r) => r.key === BING_COVERAGE_KEY) && stored.coverage?.indexed === 120, ran)
    check('J: the page line reads "Bing: crawled, indexed (as reported)"', /^Bing: crawled 40 pages in 7 days, indexed 120 \(as reported by Bing, as of /.test(describeBing(stored.coverage)), describeBing(stored.coverage))
    check('J: an unreadable store says could not be read; no key says not connected', describeBing(null, 'x') === 'Bing: could not be read' && /not connected/.test(describeBing(null, undefined, false)))
    const cron = src('app/api/cron/gsc-snapshot/route.ts')
    check('J: it runs inside the existing daily cron (no new cron) behind its own try/catch', /runBingCoverage\(getSupabaseAdmin\(\)\)/.test(cron) && !/bing/i.test(src('vercel.json')) && (JSON.parse(src('vercel.json')).crons as unknown[]).length === 2)
    check('J: the Search Rankings page shows the line', /bingLine/.test(src('app/admin/rankings/page.tsx')) && /describeBing/.test(src('app/api/admin/rankings/route.ts')))
  }

  // ---- K: house rules ------------------------------------------------------------------------------------------------
  {
    const dash = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
    const files = ['lib/publish-cadence.ts', 'lib/guide-spend.ts', 'lib/effective-networks.ts', 'lib/bing-coverage.ts', 'components/admin/posting-card.tsx', 'components/admin/posts-automation-card.tsx', 'app/api/admin/blog/autoblog-cadence/route.ts']
    check('K: no long dashes in the new copy', files.every((f) => !dash.test(src(f))), files.filter((f) => dash.test(src(f))).join(','))
    check('K: the new setting key is read through getSetting and its default is unchanged (1)', /DEFAULT_MAX_PER_DAY = 1/.test(src('lib/autoblog-cadence.ts')))
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall publish-cadence checks passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
