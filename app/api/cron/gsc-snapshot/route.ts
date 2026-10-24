import { NextResponse } from 'next/server'
import { cronUnauthorized } from '@/lib/cron-auth'
import { withCronHeartbeat } from '@/lib/cron-heartbeat'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { takeRankingSnapshot } from '@/lib/rankings-snapshot'
import { connectKeywordsToRankingPages } from '@/lib/keyword-pages'
import { runCronWatchdog } from '@/lib/cron-watchdog'
import { runAiTripwire } from '@/lib/ai-tripwire'
import { runBingCoverage } from '@/lib/bing-coverage'
import { runOptimizer } from '@/lib/optimizer-run'
import { runSiteCrawl, CRAWL_BUDGET_MS } from '@/lib/site-crawl-run'
import { AUDIT_BUDGET_MS, runSeoPlaybookAudit } from '@/lib/seo-playbook-audit'
import { revalidatePath } from 'next/cache'

// Factory Phase 5: SEO/indexing. Dormant by the same two switches as every other cron here:
// CRON_SECRET must be set (cronUnauthorized 503s until then), and Search Console itself must be
// configured (GOOGLE_SERVICE_ACCOUNT_KEY + GA4_PROPERTY_ID's sibling, SEARCH_CONSOLE_SITE_URL) or
// takeRankingSnapshot just reports that and writes nothing.
export const dynamic = 'force-dynamic'
// Search Console query/page data + the snapshot write grow with how much content exists -
// sized explicitly rather than relying on the platform default.
export const maxDuration = 60

async function handle(request: Request) {
  const denied = cronUnauthorized(request)
  if (denied) return denied
  const startedAt = Date.now()
  try {
    const note = await takeRankingSnapshot(getSupabaseAdmin())
    // Then connect every keyword that has no target page yet to the page Google really shows for it.
    // A failure here never fails the snapshot itself.
    let connected = ''
    try {
      const n = await connectKeywordsToRankingPages(getSupabaseAdmin())
      if (n) connected = `; connected ${n} keyword${n === 1 ? '' : 's'} to the page they rank on`
    } catch (e) {
      console.error('[cron:gsc-snapshot] keyword connection failed:', e)
    }
    // Watchdog: tell Joel if the 15-minute autopilot cron has gone quiet. runCronWatchdog never throws,
    // and the extra try/catch keeps it from ever breaking the snapshot.
    let watchdog = ''
    try {
      const w = await runCronWatchdog(getSupabaseAdmin())
      if (w) watchdog = `; ${w}`
    } catch (e) {
      console.error('[cron:gsc-snapshot] watchdog failed:', e)
    }
    // AI spend tripwire: one email a day at most if the last 24 hours cost more than ai_daily_ceiling_usd.
    // Alert only, never blocks anything; runAiTripwire never throws.
    let tripwire = ''
    try {
      const t = await runAiTripwire(getSupabaseAdmin())
      if (t) tripwire = `; ${t}`
    } catch (e) {
      console.error('[cron:gsc-snapshot] ai tripwire failed:', e)
    }
    // Bing crawled/indexed summary: only when BING_WEBMASTER_API_KEY is set, one read-only call (8 second limit), kept in app_settings.
    // runBingCoverage never throws; the extra try/catch keeps it from ever breaking the snapshot.
    let bing = ''
    try {
      const b = await runBingCoverage(getSupabaseAdmin())
      if (b) bing = `; ${b}`
    } catch (e) {
      console.error('[cron:gsc-snapshot] bing coverage failed:', e)
    }
    // The Optimizer: counts newly settled social sends, retires clear losers, saves its state. No AI call and no posting; runOptimizer never throws.
    let learning = ''
    try {
      const o = await runOptimizer(getSupabaseAdmin())
      if (o) learning = `; ${o}`
    } catch (e) {
      console.error('[cron:gsc-snapshot] optimizer failed:', e)
    }
    // Site health crawl: one rotating window of the live sitemap (at most 40 pages, 6 s each, 4 at a time), their links, and at most 5
    // safe repairs (logged with Undo, none while automation is paused). Own 40 second budget; started only when enough of this
    // function's 60 seconds is left. runSiteCrawl never throws; the extra try/catch keeps it from ever breaking the snapshot.
    let crawl = ''
    try {
      const left = 56_000 - (Date.now() - startedAt)
      if (left < 12_000) {
        crawl = '; site crawl skipped (time budget already used)'
      } else {
        const c = await runSiteCrawl(getSupabaseAdmin(), { deadlineMs: Date.now() + Math.min(CRAWL_BUDGET_MS, left - 4_000) })
        crawl = `; ${c.note}`
        for (const p of c.changedPaths) {
          try {
            revalidatePath(p)
          } catch {
            // a cache miss must not fail the step
          }
        }
      }
    } catch (e) {
      console.error('[cron:gsc-snapshot] site crawl failed:', e)
    }
    // SEO playbook audit: read-only checks of the live site (sitemap, robots, llms.txt, redirects, a few sample pages) plus the stored
    // crawl and Search Console state, kept in app_settings. Own 20 second budget, started only when enough of the 60 seconds is left
    // (it runs after the crawl, which it reads). runSeoPlaybookAudit never throws; the extra try/catch keeps it from ever breaking the snapshot.
    let playbook = ''
    try {
      const left = 57_000 - (Date.now() - startedAt)
      if (left < 6_000) {
        playbook = '; SEO playbook audit skipped (time budget already used)'
      } else {
        const a = await runSeoPlaybookAudit(getSupabaseAdmin(), { deadlineMs: Date.now() + Math.min(AUDIT_BUDGET_MS, left - 2_000) })
        playbook = `; ${a.note}`
      }
    } catch (e) {
      console.error('[cron:gsc-snapshot] seo playbook audit failed:', e)
    }
    return NextResponse.json({ ok: true, result: `${note}${connected}${watchdog}${tripwire}${bing}${learning}${crawl}${playbook}` })
  } catch (error) {
    // Without this, a cron failure's real cause only ever existed in the JSON body sent back to
    // Vercel's own caller - the Logs tab showed the request but no error text at all (found
    // 2026-09-28 debugging a real gsc-snapshot failure with nothing to go on but a 500).
    console.error('[cron:gsc-snapshot]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export const GET = withCronHeartbeat('gsc-snapshot', handle)
