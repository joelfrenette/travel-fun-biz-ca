import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { recordCronRun } from '@/lib/cron-heartbeat'
import { isAutopilotOn, runAutopilotTick } from '@/lib/autopilot'
import { runAutoblog } from '@/lib/autoblog-run'
import { runDistribution } from '@/lib/distribution'
import { runKeywordEngineIfDue } from '@/lib/keyword-intel'
import { PIPELINE_LAST_RUN_KEY, type PipelineRun } from '@/lib/pipeline-log'
import { collectIssues } from '@/lib/issues'
import { sendThrottledAlert } from '@/lib/alerts'
import { selfHeal } from '@/lib/heal'
import { runDebriefIfDue } from '@/lib/debrief'
import { snapshotContentPerformance } from '@/lib/content-performance'
import { plainAction, HARD_WAITING_ISSUE_ID } from '@/lib/plain-steps'
import { runGuidesStep } from '@/lib/guide-run'
import { runPageCopyStep } from '@/lib/page-copy-run'
import { runHealContentIfDue } from '@/lib/content-heal-run'
import { runSourceWatchIfDue } from '@/lib/source-watch'

// ONE pipeline, run by ONE scheduler (every 15 minutes) or by one button. In order:
//   0. KEYWORDS  once a week, within a dollar cap you set, research fresh keywords for your trips.
//   1. WRITE   topic (Search Console near-misses and cached keyword research feed it), the post, its
//              title, SEO title and description, slug, tags, call-to-action link, cover image and
//              thumbnail, then publish it (all inside runAutoblog).
//   1b. GUIDES  at most a few capped guide pages a week (destinations, hotels, resorts, cruise lines, ships,
//              river cruises, yachts), published only when the quality gate passes.
//   1c. COPY    at most a few capped intros, takeaways and FAQs a week for the compare and best-time pages.
//   2. POST    the post itself to social, with a caption written for each network.
//   3. REPURPOSE  carousel, then the short video (script, stock footage, voiceover, captions,
//              render), then post both; plus housekeeping (delete old Shotstack renders).
//   4. HEAL CONTENT  once a day: SEO-score every published page and fix the cheap reasons (WP10).
// Each pass does whatever is due, so a slow video render never blocks the next post, and a pass that
// runs out of time simply continues on the next one. Nothing here is a new capability: it is the
// existing engines, sequenced, so there is nothing to click between steps.
// Scheduled passes only write the day's post from this UTC hour on (9 am Eastern), so posts do not
// go live at 3 am. The button ignores it.
const PUBLISH_HOUR_UTC = 13
// Past this much elapsed time a pass skips its remaining steps; the next pass picks them up.
const TIME_BUDGET_MS = 200_000
// A scheduled pass only starts writing the post if it has used less than this much of its time already.
const WRITE_START_BY_MS = 60_000
// The guides step can use about 140 seconds (two AI calls), the route allows 300, so it must start before this.
const GUIDES_START_BY_MS = 100_000
// The page copy step makes one AI call (80 second limit), so it must start before this.
const COPY_START_BY_MS = 60_000
// The heal step scores everything in a few seconds, then fixes a handful of pages (each at most one 45 second call);
// it stops starting pages after 60 seconds, so it must start before this to end well inside the 300 second route limit.
const HEAL_START_BY_MS = 120_000
// The weekly supplier page check can take about a minute, so housekeeping only starts it before this.
// (its own budget is 150 seconds, so a late pass leaves it for the next one to keep inside the 300 second limit)
const SOURCE_WATCH_START_BY_MS = 60_000

export { readLastPipelineRun, PIPELINE_LAST_RUN_KEY, type PipelineStep, type PipelineRun } from '@/lib/pipeline-log'

/** Runs on every pass, even when Autopilot is off or paused: the safe self-repairs, then the daily
 * brief email (once a day from 7 am). Neither may ever fail the pipeline. */
async function housekeeping(admin: SupabaseClient, run: PipelineRun, startedAt = Date.now()): Promise<void> {
  try {
    const fixed = await selfHeal(admin)
    if (fixed.length) run.steps.push({ step: 'heal', ok: true, note: fixed.join(' ') })
  } catch {
    // a repair problem is never the pipeline's problem
  }
  try {
    // Once a day (the claim inside), before the brief so the brief can use today's numbers.
    const note = await snapshotContentPerformance(admin)
    if (note) run.steps.push({ step: 'performance', ok: !/could not|failed/i.test(note), note })
  } catch {
    // a snapshot problem is never the pipeline's problem
  }
  try {
    // Once a week (the claim inside; also once on the first pass after deploy): read each supplier page behind
    // a published trip and note "cancelled", "sold out" or different dates. Free, and it never edits a trip.
    // It can take up to a minute, so a pass that has already used most of its time leaves it for the next one.
    if (Date.now() - startedAt < SOURCE_WATCH_START_BY_MS) {
      const watch = await runSourceWatchIfDue(admin)
      if (watch) run.steps.push({ step: 'source-watch', ok: watch.ok, note: watch.note })
    }
  } catch {
    // a supplier page problem is never the pipeline's problem
  }
  try {
    const sent = await runDebriefIfDue(admin)
    if (sent) run.steps.push({ step: 'debrief', ok: sent.ok, note: sent.note })
  } catch (e) {
    run.steps.push({ step: 'debrief', ok: false, note: e instanceof Error ? e.message : 'the daily brief failed' })
  }
}

/** `force` (the button) writes a new post now regardless of the daily cadence and publish hour. */
export async function runPipeline(admin: SupabaseClient, opts: { force?: boolean } = {}): Promise<PipelineRun> {
  const startedAt = Date.now()
  const run: PipelineRun = { at: new Date().toISOString(), trigger: opts.force ? 'button' : 'schedule', steps: [] }
  const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS

  if (!(await isAutopilotOn(admin))) {
    run.steps.push({ step: 'write', ok: true, note: 'Autopilot is off' })
    await housekeeping(admin, run)
    return run
  }
  if (await isAutomationPaused(admin)) {
    run.steps.push({ step: 'write', ok: true, note: 'automation is paused' })
    await housekeeping(admin, run)
    return run
  }

  // 0. KEYWORDS: the keyword engine, once a week inside the dollar cap (research, autocomplete and question
  // ideas, trend peaks, Search Console numbers, topics, the next blog ideas). The week is claimed atomically
  // before any spend; silent on every pass where nothing is due. Before migration 0032 is applied it keeps
  // the older weekly research running and reports the missing migration instead.
  try {
    const engine = await runKeywordEngineIfDue(admin)
    if (engine) run.steps.push({ step: 'keywords', ok: engine.ok, note: engine.note })
  } catch (e) {
    run.steps.push({ step: 'keywords', ok: false, note: e instanceof Error ? e.message : 'keyword research failed' })
  }

  // 1. WRITE
  if (!opts.force && new Date().getUTCHours() < PUBLISH_HOUR_UTC) {
    run.steps.push({ step: 'write', ok: true, note: `waiting for ${PUBLISH_HOUR_UTC}:00 UTC` })
  } else if (!opts.force && Date.now() - startedAt > WRITE_START_BY_MS) {
    // The weekly keyword engine ran long. Writing takes up to four minutes and the route is killed at five,
    // so the post waits for the next pass (15 minutes) rather than risk being cut off half written.
    run.steps.push({ step: 'write', ok: true, note: 'continues on the next pass (the weekly keyword engine ran long)' })
  } else {
    try {
      const result = await runAutoblog({ scheduled: !opts.force })
      run.steps.push({ step: 'write', ok: true, note: result.ran ? `wrote "${result.postSlug}"${result.published ? ' and published it' : ' as a draft'}` : result.note })
      await recordCronRun('autoblog', { ok: true, note: result.note })
    } catch (e) {
      const note = e instanceof Error ? e.message : 'write step failed'
      run.steps.push({ step: 'write', ok: false, note })
      await recordCronRun('autoblog', { ok: false, note })
    }
  }

  // 1b. GUIDES (destination, hotel, resort, cruise line, ship, river cruise and yacht pages). At most
  // guides_per_day and guides_per_week (counted from the guides table, failing closed). Writing one takes up
  // to about two minutes, so it only starts early in the pass; a late pass leaves it for the next one and
  // never delays the posting steps below beyond that.
  if (overBudget() || Date.now() - startedAt > GUIDES_START_BY_MS) {
    run.steps.push({ step: 'guides', ok: true, note: 'continues on the next pass' })
  } else {
    try {
      // The route is killed at 300 seconds: the self-repair only starts a model call with enough time left before then.
      const result = await runGuidesStep(admin, { deadlineMs: startedAt + 280_000 })
      run.steps.push({ step: 'guides', ok: result.ok, note: result.note })
    } catch (e) {
      run.steps.push({ step: 'guides', ok: false, note: e instanceof Error ? e.message : 'guides step failed' })
    }
  }

  // 1c. PAGE COPY (the real intro, takeaways and FAQ for the compare and best-time pages). At most
  // page_copy_per_day and page_copy_per_week (counted from the page_copy table, failing closed). One AI call
  // of up to about 80 seconds, so it only starts early in the pass and never delays the posting steps below.
  if (overBudget() || Date.now() - startedAt > COPY_START_BY_MS) {
    run.steps.push({ step: 'copy', ok: true, note: 'continues on the next pass' })
  } else {
    try {
      const result = await runPageCopyStep(admin, { deadlineMs: startedAt + 280_000 })
      run.steps.push({ step: 'copy', ok: result.ok, note: result.note })
    } catch (e) {
      run.steps.push({ step: 'copy', ok: false, note: e instanceof Error ? e.message : 'page copy step failed' })
    }
  }

  // 2. POST (the post itself, to social)
  if (overBudget()) {
    run.steps.push({ step: 'post', ok: true, note: 'continues on the next pass' })
  } else {
    try {
      const note = await runDistribution(admin)
      const failed = Number(/(\d+) failed/.exec(note)?.[1] ?? 0)
      run.steps.push({ step: 'post', ok: failed === 0, note })
      await recordCronRun('distribute', { ok: failed === 0, note })
    } catch (e) {
      const note = e instanceof Error ? e.message : 'post step failed'
      run.steps.push({ step: 'post', ok: false, note })
      await recordCronRun('distribute', { ok: false, note })
    }
  }

  // 3. REPURPOSE (carousel, video, their posting, housekeeping)
  if (overBudget()) {
    run.steps.push({ step: 'repurpose', ok: true, note: 'continues on the next pass' })
  } else {
    try {
      const note = await runAutopilotTick(admin)
      run.steps.push({ step: 'repurpose', ok: !note.includes('problems:'), note })
    } catch (e) {
      run.steps.push({ step: 'repurpose', ok: false, note: e instanceof Error ? e.message : 'repurpose step failed' })
    }
  }

  // 4. HEAL CONTENT (WP10): once a day, score every published post, guide and page copy for SEO (no AI), then fix the
  // cheap reasons on pages under 70 (dashes, over-long meta text, dead links, a link to a real page about the same
  // destination, and one grounded call that writes MISSING meta text, FAQ or takeaways). Last on purpose, after the
  // posting steps, so it can never delay a post; it sits here and not in housekeeping() because it can spend AI
  // credits, so it must respect Autopilot being on and not paused. The daily claim is inside; a pass that is not
  // the first of the day (or has little time left) adds nothing. It never fails the pipeline: a problem is a
  // step note, which Needs attention shows.
  if (!overBudget() && Date.now() - startedAt <= HEAL_START_BY_MS) {
    try {
      const healed = await runHealContentIfDue(admin)
      if (healed) run.steps.push({ step: 'heal-content', ok: healed.ok, note: healed.note })
    } catch (e) {
      run.steps.push({ step: 'heal-content', ok: false, note: e instanceof Error ? e.message : 'the content heal failed' })
    }
  }

  await housekeeping(admin, run, startedAt)
  await setSetting(admin, PIPELINE_LAST_RUN_KEY, JSON.stringify(run))

  // One alert email built from the single issue list (setup items are left out: those are not
  // failures). Throttled to one email per 6 hours however often the pipeline runs.
  try {
    // Pages held for a person are shown on the page and in the daily brief; they are not an emergency, so they do not
    // re-send this email every six hours for as long as they wait.
    const open = (await collectIssues(admin)).filter((i) => i.area !== 'setup' && i.id !== HARD_WAITING_ISSUE_ID)
    if (open.length) {
      await sendThrottledAlert(admin, `Autopilot: ${open.length} thing${open.length === 1 ? '' : 's'} need attention`, [
        ...open.flatMap((i) => {
          const a = plainAction(i)
          return [`* ${a.title}`, `  ${a.why}`, ...a.steps.map((s, k) => `  ${k + 1}) ${s}`), `  ${a.urlLabel}: ${a.url}`, ...(a.paste ? [`  Paste to Claude: ${a.paste}`] : []), '']
        }),
        'See everything: https://www.travelfunbiz.ca/admin/autopilot',
      ])
    }
  } catch {
    // an alert problem must never fail the pipeline
  }
  return run
}
