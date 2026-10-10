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
import { plainAction } from '@/lib/plain-steps'
import { runGuidesStep } from '@/lib/guide-run'

// ONE pipeline, run by ONE scheduler (every 15 minutes) or by one button. In order:
//   0. KEYWORDS  once a week, within a dollar cap you set, research fresh keywords for your trips.
//   1. WRITE   topic (Search Console near-misses and cached keyword research feed it), the post, its
//              title, SEO title and description, slug, tags, call-to-action link, cover image and
//              thumbnail, then publish it (all inside runAutoblog).
//   1b. GUIDES  at most a few capped guide pages a week (destinations, hotels, resorts, cruise lines, ships,
//              river cruises, yachts), published only when the quality gate passes.
//   2. POST    the post itself to social, with a caption written for each network.
//   3. REPURPOSE  carousel, then the short video (script, stock footage, voiceover, captions,
//              render), then post both; plus housekeeping (delete old Shotstack renders).
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

export { readLastPipelineRun, PIPELINE_LAST_RUN_KEY, type PipelineStep, type PipelineRun } from '@/lib/pipeline-log'

/** Runs on every pass, even when Autopilot is off or paused: the safe self-repairs, then the daily
 * brief email (once a day from 7 am). Neither may ever fail the pipeline. */
async function housekeeping(admin: SupabaseClient, run: PipelineRun): Promise<void> {
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
      const result = await runGuidesStep(admin)
      run.steps.push({ step: 'guides', ok: result.ok, note: result.note })
    } catch (e) {
      run.steps.push({ step: 'guides', ok: false, note: e instanceof Error ? e.message : 'guides step failed' })
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

  await housekeeping(admin, run)
  await setSetting(admin, PIPELINE_LAST_RUN_KEY, JSON.stringify(run))

  // One alert email built from the single issue list (setup items are left out: those are not
  // failures). Throttled to one email per 6 hours however often the pipeline runs.
  try {
    const open = (await collectIssues(admin)).filter((i) => i.area !== 'setup')
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
