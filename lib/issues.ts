import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { autopilotReadiness, VIDEO_BLOCK_KEY } from '@/lib/autopilot'
import { MAIL_ERROR_KEY } from '@/lib/alerts'
import { readCronRuns } from '@/lib/cron-heartbeat'
import { judgeAllCrons } from '@/lib/cron-health'
import { readLastPipelineRun } from '@/lib/pipeline-log'
import { getProvider, getGhlAccounts } from '@/lib/social-provider'
import { ghlListFailedPosts, ghlListPublishedPosts } from '@/lib/ghl-social'
import { readEngineRun } from '@/lib/keyword-intel'
import { readGuideFailures, readGuideFailuresChecked, clearAllGuideFailures, MAX_GUIDE_ATTEMPTS } from '@/lib/guide-failures'
import { readCopyFailures, readCopyFailuresChecked, clearAllCopyFailures, MAX_COPY_ATTEMPTS, STALE_COPY_KEY } from '@/lib/page-copy-failures'
import { healLoopCard } from '@/lib/heal-loop'
import { orderWebhookFailureCount } from '@/lib/webhook-order-result'
import { readCrawlState, dismissCrawlErrors } from '@/lib/site-crawl-run'
import { undismissedErrors, pathOf as crawlPathOf } from '@/lib/site-crawl'
import { readVerifyState, failingSummary } from '@/lib/publish-verify'
import { readInspectionState, stuckNotIndexed } from '@/lib/gsc-inspect'
import { PUBLISH_VERIFY_ISSUE_ID, NOT_INDEXED_ISSUE_ID, INSPECT_PERMISSION_ISSUE_ID, AI_SPEND_ISSUE_ID, AFFILIATE_PARTNER_ISSUE_ID, CANNIBALISATION_ISSUE_ID, GUIDE_ORPHANS_ISSUE_ID, SITE_CRAWL_ISSUE_ID, HEAL_LOOP_ISSUE_ID, NEWS_SETUP_ISSUE_ID, NEWS_SOURCE_ISSUE_PREFIX, ORDER_WEBHOOK_ISSUE_ID, PROMOTION_ISSUE_ID } from '@/lib/plain-steps'
import { failingSources, newsTableReady } from '@/lib/news-ingest'
import { getNewsMode } from '@/lib/news-settings'
import { sourceByKey } from '@/lib/news-sources'
import { readCannibalisation } from '@/lib/ctr-loop'
import { readOrphanAudit } from '@/lib/guide-orphans'
import { clearAllPromotionFailures, readPromotionFailures } from '@/lib/promotion'
import { completenessScore } from '@/lib/package-completeness'
import { openFindings, dismissFindings } from '@/lib/source-watch'
import { pastTripSlugs } from '@/lib/past-trip'
import { pendingByTrip, recapsDue, snoozeTrips, studioMigrated } from '@/lib/recap-store'
import { dueTitle, studioPath } from '@/lib/recap-studio'
import { readStoredAiSpend, overCeiling, usd } from '@/lib/ai-tripwire'
import { CAPTION_FAILED_PREFIX } from '@/lib/guide-release'
import { DESK_EMAILS_KEY, parseDeskEmails } from '@/lib/lead-desk'
import { deskSmsConfigured } from '@/lib/lead-desk-store'

const LEAD_DESK_SETUP_ISSUE_ID = 'setup:lead-desk'

// ONE list of everything that needs a human, gathered from every part of the pipeline: posts that
// failed to go out, carousels and videos that failed, a paused video step, scheduled jobs that went
// quiet or reported a problem, steps of the last pass that failed, and setup that is still missing.
// Each issue says what happened in plain words, what to do about it, and carries the button that
// does it. The Autopilot page shows this list; the alert email is built from it too.
const GHL_DISMISSED_KEY = 'ghl_dismissed_failures'

export type IssueArea = 'post' | 'carousel' | 'video' | 'system' | 'setup'
export type IssueAction = 'dismiss-ghl' | 'retry-post' | 'retry-carousel' | 'retry-video' | 'resume-video' | 'dismiss-carousel' | 'dismiss-video' | 'dismiss-guides' | 'dismiss-page-copy' | 'dismiss-page-copy-stale' | 'dismiss-source-watch' | 'dismiss-promotion' | 'dismiss-site-crawl' | 'snooze-recap'

export interface Issue {
  id: string
  area: IssueArea
  title: string
  detail: string
  /** What to do, in plain words. */
  fix?: string
  actions?: { label: string; kind: IssueAction; slug?: string }[]
  /** A page to open to deal with it (a site path such as /admin/packages?edit=<id>, or a full web address). */
  link?: { label: string; href: string }
}

/** Turns a raw provider error into advice. Falls back to no advice rather than guessing. */
function adviceFor(error: string): string | undefined {
  if (/None of your selected networks/i.test(error)) return 'Tick a network that takes this kind of post in "Where it posts" (the error message lists which ones do).'
  if (/invalid platforms/i.test(error)) return 'One selected network cannot take this kind of post. Retry now skips it automatically and only sends to networks that have not received the post yet.'
  if (/\b(401|403)\b|rejected the (api )?key|unauthor/i.test(error)) return 'The provider rejected the key. Check the key in Vercel (and that it matches the environment), then press resume or retry.'
  if (/expired|reconnect|reauth/i.test(error)) return 'An account needs to be reconnected on the provider, then retry.'
  if (/not set|missing/i.test(error)) return 'A required key is missing in Vercel.'
  return undefined
}

export async function collectIssues(admin: SupabaseClient): Promise<Issue[]> {
  const issues: Issue[] = []

  // Posts that failed to go out (text/photo post to social).
  // Guide posts (slug guide-<kind>-<slug>, migration 0030) share the same ledger and read the same way; the
  // row's own title column holds the guide name.
  const { data: failedPosts } = await admin.from('post_distribution').select('slug, title, last_error').eq('content_type', 'post').eq('stage', 'failed')
  for (const r of (failedPosts ?? []) as { slug: string; title: string; last_error: string | null }[]) {
    const err = r.last_error ?? 'unknown error'
    issues.push({
      id: `post:${r.slug}`,
      area: 'post',
      title: `${r.slug.startsWith('guide-') ? 'Guide post to social failed' : 'Post to social failed'}: ${r.title}`,
      detail: err,
      fix: adviceFor(err),
      actions: [{ label: 'Retry', kind: 'retry-post', slug: r.slug }],
    })
  }

  // Guide posts about a named place that wait for a person because their caption did not pass the checks (WP18-E).
  // They are still held, not failed; fixing the guide text releases them by itself, or Approve sends them anyway.
  try {
    const { data: heldCaptions } = await admin
      .from('post_distribution')
      .select('slug, title, last_error')
      .eq('content_type', 'post')
      .eq('stage', 'held')
      .like('last_error', `${CAPTION_FAILED_PREFIX}%`)
    for (const r of (heldCaptions ?? []) as { slug: string; title: string; last_error: string | null }[]) {
      issues.push({
        id: `guide-caption:${r.slug}`,
        area: 'post',
        title: `A guide post is held back: ${r.title}`,
        detail: r.last_error ?? 'The caption did not pass the checks.',
        fix: 'Fix the wording on the guide page and it posts by itself, or press Approve on the Distribution page to post it as it is.',
        link: { label: 'Open Distribution', href: '/admin/distribution' },
      })
    }
  } catch {
    // an unreadable ledger is just not listed here
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
  // The keyword engine keeps its own last-run record (it can also be run by the button), so a problem is shown
  // once, as its own item, and the generic "keywords step failed" item is left out while it is open.
  const engine = await readEngineRun(admin).catch(() => null)
  const engineProblem = !!engine && !engine.ok
  if (engine && engineProblem) {
    issues.push({
      id: 'system:keyword-engine',
      area: 'system',
      title: engine.needsMigration ? 'The keyword engine needs one database update' : 'The keyword engine had a problem',
      detail: engine.note,
      fix: engine.needsMigration ? 'Run migration 0032 (supabase/migrations/0032_keyword_intel.sql) in the Supabase SQL editor, then press "Run the engine now" on the Keyword Research page.' : adviceFor(engine.note),
    })
  }
  for (const st of last?.steps ?? []) {
    if (st.step === 'keywords' && engineProblem) continue
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

  // Live guide pages that no other page links to (WP16). ONE item lists them all. The audit is stored and at most six
  // hours old, and it stays silent when it cannot be read (an unreadable table is never reported as "nothing links").
  try {
    const audit = await readOrphanAudit(admin)
    if (audit && audit.orphans.length > 0) {
      const names = audit.orphans.slice(0, 8).map((o) => `${o.name} (${o.path})`).join(', ')
      const more = audit.orphans.length > 8 ? ` and ${audit.orphans.length - 8} more` : ''
      issues.push({
        id: GUIDE_ORPHANS_ISSUE_ID,
        area: 'system',
        title: `${audit.orphans.length} live page${audit.orphans.length === 1 ? ' has' : 's have'} no link from any other page`,
        detail: `${names}${more}. Checked ${new Date(audit.at).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })} across ${audit.checked} live guide pages.`,
        fix: 'Open the Pages list (already filtered), set where each page sits (its country or city) or write a blog post about it, so a page links to it.',
        link: { label: 'Open the pages nothing links to', href: '/admin/guides?filter=orphans' },
      })
    }
  } catch {
    // an unreadable audit is not worth failing the list
  }

  // The site health crawl (it looks at the live site like a search engine): ONE item lists the error-severity findings. Warnings and
  // notes stay on the System Health card. Dismiss hides it until a NEW error appears. Silent when the result cannot be read.
  try {
    const crawl = await readCrawlState(admin)
    const errs = crawl ? undismissedErrors(crawl) : []
    if (crawl && errs.length > 0) {
      const lines = errs.slice(0, 5).map((f) => `${crawlPathOf(f.url)}: ${f.message}`).join(' | ')
      const more = errs.length > 5 ? ` and ${errs.length - 5} more` : ''
      issues.push({
        id: SITE_CRAWL_ISSUE_ID,
        area: 'system',
        title: `The site check found ${errs.length} problem${errs.length === 1 ? '' : 's'} a search engine would notice`,
        detail: `${lines}${more}.`,
        fix: errs[0].hint,
        link: { label: 'Open System Health', href: '/admin/system-health' },
        actions: [{ label: 'Dismiss', kind: 'dismiss-site-crawl' }],
      })
    }
  } catch {
    // an unreadable crawl result is not worth failing the list
  }

  // Pages that failed the post-publish check (lib/publish-verify.ts: fetched with no cookie, then status, canonical, one H1, JSON-LD, sitemap).
  // ONE item lists them; it disappears by itself when a later look passes. Silent when the state cannot be read ("could not read" is not a failure).
  try {
    const verify = await readVerifyState(admin)
    const failing = verify ? failingSummary(verify) : []
    if (failing.length > 0) {
      issues.push({
        id: PUBLISH_VERIFY_ISSUE_ID,
        area: 'system',
        title: `${failing.length} page${failing.length === 1 ? '' : 's'} failed the check right after going live`,
        detail: failing.slice(0, 5).map((f) => `${f.path}: ${f.reasons.join(', ')}`).join(' | ') + (failing.length > 5 ? ` and ${failing.length - 5} more` : '') + '.',
        fix: 'Open the page in a private browser window. If it shows an error, tell Claude the address. If it looks fine, wait an hour: the site looks again by itself.',
        link: { label: 'Open System Health', href: '/admin/system-health' },
      })
    }
  } catch {
    // an unreadable check result is not worth failing the list
  }

  // Pages Google says are not indexed a week after publishing (lib/gsc-inspect.ts). Informational (never emailed); silent when nothing is
  // stuck, when the permission is missing (the card on the SEO page says so) or when the state cannot be read.
  try {
    const inspect = await readInspectionState(admin)
    if (inspect?.read?.status === 'no_permission') {
      issues.push({
        id: INSPECT_PERMISSION_ISSUE_ID,
        area: 'setup',
        title: 'Google will not say which pages it has indexed yet',
        detail: inspect.read.note,
        fix: 'Add the Google service account as a user on the Search Console property (Settings, then Users and permissions), and check SEARCH_CONSOLE_SITE_URL matches that property.',
        link: { label: 'Open Google Search Console', href: 'https://search.google.com/search-console' },
      })
    }
    const stuck = inspect ? stuckNotIndexed(inspect, Date.now()) : []
    if (stuck.length > 0) {
      issues.push({
        id: NOT_INDEXED_ISSUE_ID,
        area: 'system',
        title: `For your information: ${stuck.length} page${stuck.length === 1 ? ' is' : 's are'} still not in Google a week after publishing`,
        detail: stuck.slice(0, 5).map((s) => `${s.path}: ${s.reason}`).join(' | ') + (stuck.length > 5 ? ` and ${stuck.length - 5} more` : '') + '.',
        fix: 'Nothing is broken by itself. Google decides slowly on a young site. If a reason mentions "blocked", "noindex" or a redirect, tell Claude the address. Otherwise add a link to the page from a popular page and check again in a week.',
        link: { label: 'Open Google Search Console', href: 'https://search.google.com/search-console' },
      })
    }
  } catch {
    // an unreadable inspection result is not worth failing the list
  }

  // Paid orders from GoHighLevel that could not be saved (the webhook answered 500 so GoHighLevel retries). Silent when none,
  // or when the log cannot be read.
  const failedOrders = await orderWebhookFailureCount(admin)
  if (failedOrders > 0) {
    issues.push({
      id: ORDER_WEBHOOK_ISSUE_ID,
      area: 'system',
      title: `${failedOrders} paid order${failedOrders === 1 ? '' : 's'} from GoHighLevel could not be saved`,
      detail: 'In the last 7 days the order ledger refused a write. GoHighLevel was told to retry, and a retry cannot double count an order.',
      fix: 'Wait about an hour for the retry. If it is still here tomorrow, check the orders table in Supabase and the SUPABASE_SERVICE_ROLE_KEY in Vercel, then retry the failed calls in GoHighLevel.',
    })
  }

  // Parts of a "Promote this package" click that did not work (WP15). One item lists every trip and the parts that failed.
  try {
    const promo = Object.values(await readPromotionFailures(admin))
    if (promo.length) {
      issues.push({
        id: PROMOTION_ISSUE_ID,
        area: 'system',
        title: `${promo.length} trip promotion${promo.length === 1 ? '' : 's'} had a problem`,
        detail: promo.map((f) => `${f.name}: ${f.steps.join('; ')}`).join(' | '),
        fix: 'If it says the AI key is missing or wrong, check ANTHROPIC_API_KEY in Vercel and redeploy. If it says a database update is missing, run migration 0039. Then open the trip in Packages. If only the blog ideas failed, press "Retry the blog ideas" on the Promote card. If nothing worked, press "Promote this package" again. Then click Dismiss here.',
        actions: [{ label: 'Dismiss', kind: 'dismiss-promotion' }],
      })
    }
  } catch {
    // a promotion note is never worth failing the list
  }

  // WP19: there is no longer a "held back for a person to check" item. A held draft goes through the heal loop (suggester,
  // independent QA judge, escalation ladder) and ends up published or rejected_by_heal with its reasons; what the heal did
  // is an informational line in the daily brief and a card on this page, never a task. (HARD_WAITING_ISSUE_ID stays exported
  // from lib/plain-steps.ts for the alert filter in lib/pipeline.ts.)
  // The one thing the heal loop needs a person for: it cannot read its own daily counter, so it stopped (fail closed).
  // Reaching the daily limit is NOT an issue: held drafts simply wait for tomorrow, and the card says so plainly.
  try {
    const loop = await healLoopCard(admin)
    if (!loop.readable) {
      issues.push({
        id: HEAL_LOOP_ISSUE_ID,
        area: 'system',
        title: 'The self-heal could not read its daily limit',
        detail: loop.waiting,
        fix: 'Open Supabase, then the app_settings table. The row heal_loop_calls_per_day must be a whole number from 0 to 60, and any row starting with heal_loop_calls_used must be a whole number. Then press "Heal now" on the Self-healing card.',
      })
    }
  } catch {
    // an unreadable card is not worth failing the list
  }

  // Travel news (WP20), only while it is switched on: the table is missing (a one-time setup item, amber, never emailed), or a
  // feed failed 3 times in a row (one item per feed, with plain steps). A single failed read is not an issue.
  try {
    if ((await getNewsMode(admin)) !== 'off') {
      const ready = await newsTableReady(admin)
      if (!ready.ok) {
        issues.push({
          id: NEWS_SETUP_ISSUE_ID,
          area: 'setup',
          title: 'Travel news needs one database update',
          detail: 'The news_items table does not exist yet, so the news step does nothing.',
          fix: 'Run migration 0047 (supabase/migrations/0047_news_items.sql) in the Supabase SQL editor.',
        })
      } else {
        for (const f of await failingSources(admin)) {
          const source = sourceByKey(f.key)
          issues.push({
            id: `${NEWS_SOURCE_ISSUE_PREFIX}${f.key}`,
            area: 'system',
            title: `The news feed "${f.name}" failed ${f.fails} times in a row`,
            detail: `Last problem: ${f.lastError}`,
            fix: 'Open the feed in a browser. If it shows a page of text, wait an hour. If it shows an error, ask Claude to fix the feed address.',
            ...(source ? { link: { label: 'Open the feed', href: source.feedUrl } } : {}),
          })
        }
      }
    }
  } catch {
    // a news note is never worth failing the issue list
  }

  // Search phrases where two or more of our pages get impressions (hub row 2). ONE informational item lists the top 5 and
  // names the stronger page. Stored daily by the heal; silent when it is older than a week or cannot be read.
  try {
    const record = await readCannibalisation(admin)
    if (record && record.items.length > 0 && Date.now() - Date.parse(record.at) < 8 * 86_400_000) {
      issues.push({
        id: CANNIBALISATION_ISSUE_ID,
        area: 'system',
        title: `For your information: ${record.items.length} search phrase${record.items.length === 1 ? '' : 's'} show${record.items.length === 1 ? 's' : ''} two of your pages in Google`,
        detail: record.items.map((c) => `"${c.query}": ${c.pages.slice(0, 3).map((p) => `${p.path} (${p.clicks} click${p.clicks === 1 ? '' : 's'}, ${p.impressions} views)`).join(' vs ')}; the stronger page is ${c.stronger}`).join(' | '),
        fix: 'Nothing is broken. To stop the pages sharing the clicks, link from the weaker page to the stronger one and make the weaker page about something a little different. Ignore it if both pages are meant to be there.',
      })
    }
  } catch {
    // an unreadable list is not worth failing the issue list
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

  // Published page copy that links to a trip its page no longer lists (the page already hides it; someone should rewrite it).
  try {
    const stale = (JSON.parse((await getSetting(admin, STALE_COPY_KEY)) ?? 'null') as { paths?: string[] } | null)?.paths ?? []
    if (Array.isArray(stale) && stale.length) {
      issues.push({
        id: 'system:page-copy-stale',
        area: 'system',
        title: `Page copy refers to a trip no longer listed (${stale.length} page${stale.length === 1 ? '' : 's'})`,
        detail: stale.join(' | '),
        fix: 'Those pages are showing without their written intro until it is rewritten. Delete the copy on the Autopilot page and click "Write one now". Dismiss clears this note; the daily check adds a page back if it is still affected.',
        actions: [{ label: 'Dismiss', kind: 'dismiss-page-copy-stale' }],
      })
    }
  } catch {
    // an unreadable note is not worth an alert
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
          ? 'TikTok only takes a video from a web address it has checked belongs to you. The site already copies the video onto GoHighLevel first, but TikTok still said no. Do these in order: 1) In GoHighLevel open Marketing, then Social Planner, then Settings, and check your TikTok account says Connected (if it says Expired, press Reconnect). 2) In GoHighLevel open Settings, then Private Integrations, open the token this site uses, and make sure Media Library (medias.write) is ticked. 3) Press Dismiss here, then wait for the next video. If TikTok says no again, tell Claude: the fix is to serve the video from travelfunbiz.ca and verify that address in TikTok.'
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
    // Leads the automatic retry ladder gave up on (lib/lead-retry-ladder.ts) need a person; the rest are still being retried.
    const gaveUp = (unsent as { ghl_error: string | null }[]).filter((l) => /^\[gave up\]/.test(l.ghl_error ?? '')).length
    issues.push({
      id: 'system:leads-not-forwarded',
      area: 'system',
      title: `${unsent.length} lead${unsent.length === 1 ? '' : 's'} saved but not sent to GoHighLevel`,
      detail: `Latest reason: ${reason}. They are safe on the Leads page in the admin.${gaveUp ? ` ${gaveUp} of them ${gaveUp === 1 ? 'is' : 'are'} past the automatic retries (5 tries over 3 days) and need${gaveUp === 1 ? 's' : ''} you to add ${gaveUp === 1 ? 'it' : 'them'} by hand.` : ''}`,
      fix: adviceFor(reason) ?? 'Open the Leads page, copy the contact into GoHighLevel by hand, and check the GoHighLevel keys in Vercel.',
    })
  }

  // Published trip pages with too little on them. Shown on the Autopilot page and in the brief, but NOT a
  // failure: area 'setup' is left out of the alert email, so thin pages never trigger an alert.
  try {
    const { data: trips } = await admin
      .from('travel_packages')
      .select('id, slug, name, full_description, highlights, price_includes, not_included, itinerary, ai_faqs, gallery_urls, departure_dates, available_from, available_to')
      .eq('status', 'published')
    for (const t of (trips ?? []) as ({ id: string; slug: string; name: string } & Parameters<typeof completenessScore>[0])[]) {
      const c = completenessScore(t)
      if (!c.thin) continue
      issues.push({
        id: `package:thin:${t.slug}`,
        area: 'setup',
        title: `The ${t.name} trip page is thin (score ${c.score} of 100)`,
        detail: `Missing: ${c.reasons.join('; ')}.`,
        fix: 'Drop a screenshot, a PDF or a link into the Add details box on that trip. It fills in what is empty and never overwrites what is there.',
        link: { label: 'Add details', href: `/admin/packages?edit=${t.id}` },
      })
    }
  } catch {
    // a trip page nudge is never worth failing the list
  }

  // Past trips with no recap yet (WP14). A past trip stays published; this nudge says to add the recap. Area 'setup'
  // (amber), so it never triggers an alert email, and it clears itself once the trip has a recap (or is set to live).
  // Recap Studio: ONE daily item, "N past trips need a recap" (lib/recap-studio.ts selectRecapDue: a published trip whose
  // last date passed with no recap or a thin one, not live-forced, not snoozed). "Snooze 7 days" hides them all for a week.
  // Past trips with a review waiting (something an agent or traveller sent) get their own item, and a missing migration is named.
  try {
    const due = await recapsDue(admin)
    if (due.length) {
      issues.push({
        id: 'package:recap:due',
        area: 'setup',
        title: dueTitle(due.length),
        detail: `${due.slice(0, 6).map((t) => `${t.name} (${t.why})`).join('; ')}${due.length > 6 ? `; and ${due.length - 6} more` : ''}. They stay published.`,
        fix: 'Open the Recap Studio for the first one. It takes about 5 minutes: photos, five quick questions, then one button. You can also send a link to a travel agent to fill it in. Not today? Snooze it for 7 days.',
        link: { label: 'Start the recap', href: due[0].href },
        actions: [{ label: 'Snooze 7 days', kind: 'snooze-recap' }],
      })
    }
    const names = new Map<string, string>()
    const pending = await pendingByTrip(admin)
    if (pending.length) {
      const { data: trips } = await admin.from('travel_packages').select('id, name').in('id', pending.map((p) => p.packageId))
      for (const t of (trips ?? []) as { id: string; name: string }[]) names.set(t.id, t.name)
    }
    for (const p of pending) {
      issues.push({
        id: `recap-review:${p.packageId}`,
        area: 'setup',
        title: `${p.n} recap item${p.n === 1 ? '' : 's'} to review for ${names.get(p.packageId) ?? 'a trip'}`,
        detail: 'A travel agent or a traveller sent photos, notes or a quote through a recap link. Nothing is on the site until you approve it.',
        fix: 'Open the Recap Studio and approve, edit or reject each item.',
        link: { label: 'Review', href: studioPath(p.packageId) },
      })
    }
    if (due.length && !(await studioMigrated(admin))) {
      issues.push({
        id: 'recap-studio:migration',
        area: 'setup',
        title: 'Apply migration 0053 for the Recap Studio links',
        detail: 'The agent and traveller links need the database tables from supabase/migrations/0053_recap_studio.sql. The rest of the Studio works without them.',
        fix: 'Open the Supabase SQL editor, paste the file 0053_recap_studio.sql and run it.',
      })
    }
  } catch {
    // a recap nudge is never worth failing the list
  }
  // A trip an agent sent and is waiting for Joel (WP13). One item per trip, amber (area 'setup', so it never triggers an
  // alert email). Clears itself when Joel approves it or sends it back.
  try {
    const { data: waiting } = await admin.from('package_submissions').select('package_id, agent_name, trip_name').eq('submission_state', 'submitted').not('package_id', 'is', null).order('submitted_at', { ascending: true }).limit(20)
    for (const s of (waiting ?? []) as { package_id: string; agent_name: string; trip_name: string | null }[]) {
      issues.push({
        id: `agent-submission:${s.package_id}`,
        area: 'setup',
        title: `An agent sent a trip to approve: ${s.trip_name ?? 'a new trip'}`,
        detail: `${s.agent_name} sent it. It is a draft: nothing is live until you approve it.`,
        fix: 'Open the draft, read it, fix anything that is wrong, then Approve (publishes it) or Send back with a note the agent can read.',
        link: { label: 'Open the draft', href: `/admin/packages?edit=${s.package_id}` },
      })
    }
  } catch {
    // before migration 0036 the table does not exist; no item
  }

  // The weekly supplier page check found something. Never changes a trip: it is Joel's decision.
  try {
    // A trip that already happened is never flagged (WP14): findings stored before it passed are dropped here.
    const open = await openFindings(admin)
    const past = await pastTripSlugs(admin, [...new Set(open.map((f) => f.slug))]).catch(() => new Set<string>())
    const findings = open.filter((f) => !past.has(f.slug))
    const seen = new Set<string>()
    for (const f of findings) {
      if (seen.has(f.slug)) continue
      seen.add(f.slug)
      const mine = findings.filter((x) => x.slug === f.slug)
      issues.push({
        id: `source-watch:${f.slug}`,
        area: 'setup',
        title: `Supplier page says this trip is cancelled or changed: ${f.name}`,
        detail: mine.map((x) => `${x.kind === 'cancelled' ? 'Cancelled or sold out?' : 'Dates differ?'} ${x.snippet}`).join(' | '),
        fix: 'Open the supplier page and read it. Nothing on your site was changed. If the trip really is cancelled, unpublish it or fix its dates in Packages; if the check is wrong, click Dismiss.',
        link: { label: 'Open the supplier page', href: f.url },
        actions: [{ label: 'Dismiss', kind: 'dismiss-source-watch', slug: f.slug }],
      })
    }
  } catch {
    // the weekly check's note is optional
  }

  // Guides are live but no affiliate partner is active, so the "Fun things to do" box is hidden everywhere (WP21).
  // Informational: area 'setup' never triggers an alert email. Silent when either table cannot be read
  // (for example before migration 0048).
  try {
    const guidesRes = await admin.from('guides').select('id', { count: 'exact', head: true }).eq('status', 'published')
    const partnersRes = await admin.from('affiliate_partners').select('id', { count: 'exact', head: true }).eq('status', 'active')
    if (!guidesRes.error && !partnersRes.error && (guidesRes.count ?? 0) > 0 && (partnersRes.count ?? 0) === 0) {
      issues.push({
        id: AFFILIATE_PARTNER_ISSUE_ID,
        area: 'setup',
        title: 'Add your first affiliate partner',
        detail: `${guidesRes.count} guide page${guidesRes.count === 1 ? ' is' : 's are'} live, but no affiliate partner is active, so the "Fun things to do" box is hidden on all of them.`,
        fix: 'Open Affiliate Links in the admin, add a partner (name, partner ID and the search link from its dashboard), and set it to Active.',
        link: { label: 'Open Affiliate Links', href: '/admin/affiliate-links' },
      })
    }
  } catch {
    // an optional nudge is never worth failing the list
  }

  // Lead desk setup (lib/lead-desk.ts): who gets the hot lead email, and which GoHighLevel contacts get the text. Both are optional and
  // never fail a lead; this is an amber nudge only (area 'setup' never sends the generic alert email).
  try {
    const emails = parseDeskEmails(await getSetting(admin, DESK_EMAILS_KEY))
    const sms = await deskSmsConfigured(admin)
    if (!sms || emails.length === 0) {
      issues.push({
        id: LEAD_DESK_SETUP_ISSUE_ID,
        area: 'setup',
        title: sms ? 'Lead desk emails are not set' : 'Lead desk texts are not set up',
        detail: [
          emails.length === 0 ? 'Hot lead emails go to the admin address only. Add Shelby and Leslie in the app_settings key lead_desk_alert_emails (a list of addresses).' : '',
          !sms ? 'No text message is sent for a hot lead. Add the GoHighLevel contact ids to text in the app_settings key lead_desk_alert_sms_contact_ids.' : '',
        ].filter(Boolean).join(' '),
        fix: 'In Supabase, open the app_settings table and add the key. A lead is never lost or blocked while this is empty; the desk just hears about it by email only.',
      })
    }
  } catch {
    // an optional nudge is never worth failing the list
  }

  // AI use above the daily limit (alert only, nothing is blocked). Area 'setup' so it never triggers the generic alert
  // email; the daily tripwire sends its own single email. Silent when the spend cannot be read.
  try {
    const { spend, ceiling } = await readStoredAiSpend(admin)
    if (spend !== null && overCeiling(spend, ceiling)) {
      issues.push({
        id: AI_SPEND_ISSUE_ID,
        area: 'setup',
        title: `AI use is above your daily limit (about ${usd(spend)} in 24 hours)`,
        detail: `The limit is ${usd(ceiling)}. The cost is an estimate from the AI meter, not the bill. Nothing was stopped.`,
        fix: 'Check the Anthropic console Usage page. If it looks wrong, turn Autopilot off and tell Claude. If it looks fine, raise ai_daily_ceiling_usd in the app_settings table.',
      })
    }
  } catch {
    // an optional nudge is never worth failing the list
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
  if (kind === 'snooze-recap') return snoozeTrips(admin, (await recapsDue(admin)).map((t) => t.id))
  if (kind === 'dismiss-guides') return (await clearAllGuideFailures(admin)).error ?? null
  if (kind === 'dismiss-page-copy') return (await clearAllCopyFailures(admin)).error ?? null
  if (kind === 'dismiss-promotion') return (await clearAllPromotionFailures(admin)).error ?? null
  if (kind === 'dismiss-site-crawl') return dismissCrawlErrors(admin)
  if (kind === 'dismiss-page-copy-stale') {
    // Empties the stored list but keeps the "checked at" stamps, so the daily check resumes on schedule.
    let state: Record<string, unknown> = {}
    try {
      state = JSON.parse((await getSetting(admin, STALE_COPY_KEY)) ?? '{}') ?? {}
    } catch {
      state = {}
    }
    return (await setSetting(admin, STALE_COPY_KEY, JSON.stringify({ ...state, paths: [] }))).error ?? null
  }
  if (!slug) return 'A post is required.'
  if (kind === 'dismiss-source-watch') return dismissFindings(admin, slug)
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
