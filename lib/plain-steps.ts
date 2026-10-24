import type { Issue } from '@/lib/issues'
import { SITE_URL } from '@/lib/site'

// Turns one open problem into something a non-technical person can act on: what happened, why it
// matters, a few short steps with the exact links to click, and a ready-made message to paste to
// Claude when the fix is a code change. Used by the daily brief and the alert email, so both say the
// same thing. Plain words on purpose (about a grade-5 reading level); no jargon without a gloss.
export const CHECKLIST_URL = 'https://claude.ai/artifact/PN6caspQe9V6RUUsJ2vNcw'

export interface PlainAction {
  id: string
  title: string
  why: string
  steps: string[]
  url: string
  urlLabel: string
  /** A message to copy and paste to Claude when the fix needs code. */
  paste?: string
}

/** The Needs attention item for drafts the safety checks held back for a person (WP10). Lives here, not in
 * lib/issues.ts, because the Autopilot page (a client component) imports this file and must not pull in the server code. */
export const HARD_WAITING_ISSUE_ID = 'system:content-hard-waiting'

/** The Needs attention item for the self-heal loop when it cannot read its daily AI-call counter (WP19). It fails closed:
 * no automatic rewriting runs until the counter can be read. Lives here for the same reason as the ids above. */
export const HEAL_LOOP_ISSUE_ID = 'system:heal-loop-unreadable'

/** The Needs attention item for parts of a "Promote this package" click that did not work (WP15). Same reason as above. */
export const PROMOTION_ISSUE_ID = 'system:promotion-failing'

/** The Needs attention item for paid orders from GoHighLevel that could not be saved to the ledger. Same reason as above. */
export const ORDER_WEBHOOK_ISSUE_ID = 'system:order-webhook-failed'

/** The Needs attention item for live guide pages that no other page links to (WP16). Same reason as above. */
export const GUIDE_ORPHANS_ISSUE_ID = 'system:guide-orphans'

/** The Needs attention item for error-severity findings of the site health crawl. Same reason as the ids above for living here. */
export const SITE_CRAWL_ISSUE_ID = 'system:site-crawl'

/** The Needs attention item for a page that failed the post-publish check (fetched with no cookie: status, canonical, one H1, JSON-LD, sitemap).
 * Same reason as the ids above for living here. */
export const PUBLISH_VERIFY_ISSUE_ID = 'system:publish-verify'

/** The Needs attention item for pages Google could not index (URL Inspection feedback). Informational: it never sends the alert email.
 * Same reason as the ids above for living here. */
export const NOT_INDEXED_ISSUE_ID = 'system:not-indexed'

/** The setup item shown while Google refuses the URL Inspection question (the service account is not a user on the Search Console property).
 * Amber, never an alert email. Same reason as the ids above for living here. */
export const INSPECT_PERMISSION_ISSUE_ID = 'setup:gsc-inspect-permission'

/** The Needs attention item that lists search phrases where two of our pages compete (hub row 2). INFORMATIONAL: nothing
 * is broken, so it is left out of the alert email like the item above. Same reason as the ids above for living here. */
export const CANNIBALISATION_ISSUE_ID = 'system:keyword-cannibalisation'

/** The Needs attention item for a travel news feed that failed 3 times in a row (WP20). One item per feed: the id is this prefix
 * plus the source key. Same reason as the ids above for living here. */
export const NEWS_SOURCE_ISSUE_PREFIX = 'system:news-source:'

/** The setup item for travel news when its table does not exist yet (migration 0047). Amber setup item, never an alert email. */
export const NEWS_SETUP_ISSUE_ID = 'setup:news-migration'

/** The informational setup item shown while guides are published but no affiliate partner is active (WP21). Amber, never an alert email. */
export const AFFILIATE_PARTNER_ISSUE_ID = 'setup:affiliate-partner'

/** The informational item shown while the last 24 hours of AI use is above the daily limit (ai_daily_ceiling_usd). Area 'setup'
 * (amber), so it never sends the generic alert email; the tripwire sends its own single email. Same reason as above for living here. */
export const AI_SPEND_ISSUE_ID = 'setup:ai-spend'

/** The page anchor of one issue on the Content Autopilot page, so an email can link straight to it. */
export const issueAnchor = (id: string) => `issue-${id.replace(/[^a-z0-9]+/gi, '-')}`

const adminLink = (path: string) => `${SITE_URL}${path}`

/** The message to paste to Claude for one problem. One wording, used by the daily brief, the alert email
 * and the Copy button on the Content Autopilot page. */
export function claudeFixMessage(title: string, detail: string): string {
  return `Please fix this on TravelFunBiz.ca. Problem: ${title}. What it says: ${detail}. Look into it, fix it if you can, and tell me in simple words what you did.`
}

export function plainAction(i: Issue): PlainAction {
  const autopilot = (id: string) => `${adminLink('/admin/autopilot')}#${issueAnchor(id)}`
  const text = `${i.title} ${i.detail}`
  const paste = claudeFixMessage(i.title, i.detail)

  if (i.id === 'system:mail-blocked' || i.id === 'system:step-debrief' || /verify a domain|testing emails/i.test(text)) {
    return {
      id: i.id,
      title: 'Emails from Aiva cannot reach your Gmail yet',
      why: 'Resend (the email sender) only lets a new account email its owner until a domain is checked. So the daily brief and the alert emails are being refused.',
      steps: [
        'FAST FIX (works in 2 minutes): open Vercel, then your project, then Settings, then Environment Variables.',
        'Click Add New. Name: NOTIFY_TO_EMAIL. Value: the email you signed up to Resend with (Resend named it as info@travelfunbiz.com). Save, then click Redeploy. The emails will arrive there. You can set up a forward to Gmail in your email program.',
        'BEST FIX (so they come to Gmail): open Resend at resend.com/domains and sign in.',
        'Click "Add Domain", type travelfunbiz.ca, and click Add.',
        'Resend shows a list of DNS records (Type, Name, Value). Keep that page open.',
        'Open the place where travelfunbiz.ca is managed (Vercel, then Domains, or the company you bought it from). Add each record exactly as Resend shows it.',
        'Go back to Resend and click Verify. It can take up to an hour.',
        'In Vercel Environment Variables, add ALERT_FROM_EMAIL with the value: Aiva from TravelFunBiz.ca <aiva@travelfunbiz.ca>   Then remove NOTIFY_TO_EMAIL and Redeploy.',
      ],
      url: 'https://resend.com/domains',
      urlLabel: 'Open Resend domains',
      paste: 'Please help me finish verifying travelfunbiz.ca in Resend so Aiva can email joelfrenette@gmail.com. Check the DNS records I pasted and tell me if anything is missing.',
    }
  }
  if (/expired|reconnect|reauth/i.test(text)) {
    return {
      id: i.id,
      title: i.title,
      why: 'A social account lost its sign-in, so nothing can post to it.',
      steps: ['Open GoHighLevel and sign in.', 'Click the gear icon (Settings), then Integrations, then Social Planner.', 'Find the account marked "expired" and click Reconnect.', 'Sign in to that social account when it asks.', 'Come back to this page and click Dismiss.'],
      url: 'https://app.gohighlevel.com',
      urlLabel: 'Open GoHighLevel',
      paste,
    }
  }
  if (i.id.startsWith('ghl:')) {
    return {
      id: i.id,
      title: i.title,
      why: 'GoHighLevel took the post, but the social network said no afterwards.',
      steps: ['Open the Content Autopilot page with the link below.', 'Read the red box. It says why the network said no.', 'If you can already see the post live on that network, click Dismiss. Nothing else is needed.', 'If it is NOT live, copy the message below and paste it to Claude.'],
      url: autopilot(i.id),
      urlLabel: 'Open this problem',
      paste,
    }
  }
  if (i.id === 'system:video-paused') {
    return {
      id: i.id,
      title: i.title,
      why: 'Shotstack said our key is wrong, so video making is paused.',
      steps: ['Open Shotstack and sign in.', 'Click "API Keys".', 'Copy the key from the row that says PRODUCTION (not Sandbox).', 'Open Vercel, then your project, then Settings, then Environment Variables.', 'Change SHOTSTACK_API_KEY to the key you copied, save, and click Redeploy.', 'Open the link below and click "Resume now".'],
      url: autopilot(i.id),
      urlLabel: 'Open this problem',
      paste,
    }
  }
  if (i.id === 'system:guides-failing') {
    return {
      id: i.id,
      title: i.title,
      why: 'The site tried to write a guide page (a place, hotel, resort or ship) and it did not work. After two tries it stops trying that one, so it does not waste money.',
      steps: ['Open the Content Autopilot page with the link below.', 'Read the grey line. It says which guide failed and why.', 'If it says the AI key is missing or wrong, open Vercel, then your project, then Settings, then Environment Variables, and check ANTHROPIC_API_KEY. Redeploy after changing it.', 'Click "Dismiss" so the site tries those guides again.', 'If the same guide fails again, copy the message below and paste it to Claude.'],
      url: autopilot(i.id),
      urlLabel: 'Open this problem',
      paste,
    }
  }
  if (i.id === 'system:page-copy-failing') {
    return {
      id: i.id,
      title: i.title,
      why: 'The site tried to write the intro text for a Compare or Best time to visit page and it did not work. After two tries it stops trying that page, so it does not waste money.',
      steps: ['Open the Content Autopilot page with the link below.', 'Read the grey line. It says which page failed and why.', 'If it says the AI key is missing or wrong, open Vercel, then your project, then Settings, then Environment Variables, and check ANTHROPIC_API_KEY. Redeploy after changing it.', 'Click "Dismiss" so the site tries those pages again.', 'If the same page fails again, copy the message below and paste it to Claude.'],
      url: autopilot(i.id),
      urlLabel: 'Open this problem',
      paste,
    }
  }
  if (i.id === 'system:page-copy-stale') {
    return {
      id: i.id,
      title: i.title,
      why: 'A Compare or Best time to visit page has written text that mentions a trip you no longer list. The site hides that text for now, so visitors never see the old trip.',
      steps: ['Open the Content Autopilot page with the link below.', 'Read the grey line. It lists the page addresses.', 'In the page copy card, find each of those addresses and click "Delete" on its row.', 'Click "Write one now" so a new intro is written from the trips you list today.', 'If you have turned the trip back on, you can skip this: the problem clears itself within a day.'],
      url: autopilot(i.id),
      urlLabel: 'Open this problem',
      paste,
    }
  }
  if (i.id === ORDER_WEBHOOK_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'GoHighLevel told the site about a paid order, but the site could not write it down. The site answered with an error on purpose, so GoHighLevel tries again by itself. Until it works, that sale is missing from your revenue numbers.',
      steps: [
        'Wait about an hour. GoHighLevel retries by itself, and a retry cannot count the same order twice.',
        'If this item is still here tomorrow, open Supabase, then the Table editor, then the orders table, and check that it opens without an error.',
        'Open Vercel, then your project, then Settings, then Environment Variables, and check SUPABASE_SERVICE_ROLE_KEY is there.',
        'Open GoHighLevel, find the workflow that calls the site, and look at its history for the failed calls. Press the retry button on each one.',
        'If it keeps failing, copy the message below and paste it to Claude.',
      ],
      url: 'https://app.gohighlevel.com',
      urlLabel: 'Open GoHighLevel',
      paste,
    }
  }
  if (i.id === PROMOTION_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'You pressed "Promote this package" and one part of it did not work: the search phrases, the blog ideas, the guide pages or the social post. The parts that did work are already queued. Nothing was posted by mistake.',
      steps: [
        'Open the Content Autopilot page with the link below.',
        'Read the grey line. It says which trip, and which part failed and why.',
        'If it says the AI key is missing or wrong, open Vercel, then your project, then Settings, then Environment Variables, and check ANTHROPIC_API_KEY. Redeploy after changing it.',
        'If it says a database update is missing, ask Claude for the contents of supabase/migrations/0039_promotions.sql, paste it into the Supabase SQL editor, and click Run.',
        'Open the trip in Packages and find the "Promote this package" card.',
        'If only the blog ideas failed, click "Retry the blog ideas" on that card. The other parts are already queued, so do NOT press "Promote this package" again (it is allowed once every 30 days).',
        'If nothing at all worked, the 30 days were not used up, so click "Promote this package" again.',
        'Come back and click "Dismiss" on this problem.',
      ],
      url: autopilot(i.id),
      urlLabel: 'Open this problem',
      paste,
    }
  }
  if (i.id === GUIDE_ORPHANS_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'These pages are live, but no other page on the site links to them. Google and visitors find pages by following links, so a page with no link in is hard to find and ranks worse.',
      steps: [
        'Open the Pages list with the link below. It is already filtered to the pages nothing links to.',
        'Click Edit on one page and look at the name in the "Sits under" box. A hotel or a port should sit under its country or city (the web address name, for example italy).',
        'Type the parent, click Save changes, and the parent page now links down to it.',
        'You can also write a blog post about the place. A post links to a page when the page name is in its title or tags.',
        'You do not need to fix them all today. This list refreshes by itself every few hours, and the item goes away when the list is empty.',
      ],
      url: adminLink('/admin/guides?filter=orphans'),
      urlLabel: 'Open the pages nothing links to',
      paste,
    }
  }
  if (i.id === SITE_CRAWL_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'Once a day the site visits a few of its own pages the way Google does, and checks the basics: does the page open, does it point to itself as the main copy, is it allowed in search, do its links work. These are the ones that failed. A page with one of these problems can drop out of Google or lose visitors.',
      steps: [
        'Open System Health with the link below and find the "Site health crawl" box.',
        'Read the first problem. It says which page, what is wrong, and what to do.',
        'Open that page in your browser. If it loads fine and looks right, the problem may have been a slow moment: it is checked again within a week and clears by itself.',
        'If a link in a blog post or guide points at a page that is gone, you do not need to do anything: the daily clean-up removes that link by itself (the words stay) and you can undo it on the Content edits page.',
        'For anything else, copy the message below and paste it to Claude.',
        'Click "Dismiss" here. This item only comes back if a NEW problem appears.',
      ],
      url: adminLink('/admin/system-health'),
      urlLabel: 'Open System Health',
      paste,
    }
  }
  if (i.id === PUBLISH_VERIFY_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'A few minutes after a page went live, the site opened it the way Google does (with no cookies) and one of the basics was wrong: it did not answer 200, it had no canonical link to itself, it did not have exactly one main heading, its structured data would not parse, or it was missing from the sitemap. Nothing was changed or removed. A page like this can be skipped by Google.',
      steps: [
        'Open the page address named below in a private (incognito) browser window. A private window sends no cookies, like Google.',
        'If the page shows an error, copy the message below and paste it to Claude with the address. This is the most important case.',
        'If the page looks fine, wait about an hour. A page can be missing from the sitemap until it is rebuilt, and a deploy in progress can give one bad answer. The site looks again by itself and this item goes away when the page passes.',
        'Do not delete or unpublish the page unless Claude says so. Nothing here does that automatically.',
      ],
      url: adminLink('/admin/system-health'),
      urlLabel: 'Open System Health',
      paste,
    }
  }
  if (i.id === INSPECT_PERMISSION_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'Once a day the site asks Google, for a few pages, "is this page in your search index, and if not, why?". Google refused to answer. Nothing is broken and nothing is blocked: the site just cannot tell you how many of its pages Google has taken in yet.',
      steps: [
        'Open Google Search Console and pick the travelfunbiz.ca property.',
        'Click Settings (the gear), then "Users and permissions".',
        'Click "Add user". Paste the service account email (it is the client_email inside GOOGLE_SERVICE_ACCOUNT_KEY in Vercel, it ends with iam.gserviceaccount.com). Choose "Full" or "Restricted" and click Add.',
        'Check that SEARCH_CONSOLE_SITE_URL in Vercel is the same property you just picked (it looks like sc-domain:travelfunbiz.ca for a domain property, or https://www.travelfunbiz.ca/ for a URL-prefix property).',
        'Nothing else to do: the next daily run asks again and this item goes away when Google answers.',
      ],
      url: 'https://search.google.com/search-console',
      urlLabel: 'Open Google Search Console',
      paste,
    }
  }
  if (i.id === NOT_INDEXED_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'Google was asked, one page at a time, whether each page is in its search index. These pages were published more than a week ago and Google says they are not indexed. The reason Google gave is shown for each one. Nothing is broken on your side by itself, but a page that is not indexed cannot bring in visitors.',
      steps: [
        'Read the reason Google gave for the first page in the box. "Discovered, currently not indexed" and "Crawled, currently not indexed" usually mean Google has not decided the page is worth keeping yet, which is common on a young site.',
        'If the reason says "blocked", "noindex" or "redirect", copy the message below and paste it to Claude with the page address. That one is a fault on our side.',
        'Otherwise do nothing for now. Add one link to the page from a popular page (a related blog post or its trip page) if you want to help it along, and check again in a week.',
        'You can look at any one page yourself: open Google Search Console, then URL inspection, and paste the address.',
      ],
      url: 'https://search.google.com/search-console',
      urlLabel: 'Open Google Search Console',
      paste,
    }
  }
  if (i.id.startsWith(NEWS_SOURCE_ISSUE_PREFIX)) {
    return {
      id: i.id,
      title: i.title,
      why: 'The site reads a few news feeds (official storm and travel warning notices, and some travel trade news) so it can write short news posts. This feed has failed three times in a row. Nothing is broken on your site and nothing wrong was posted. The site keeps trying every 30 minutes, and this warning goes away by itself after one good read.',
      steps: [
        'Click the link below. It opens the feed in your browser.',
        'If you see a page of text full of words like "item", "entry" or "title", the feed is fine. Wait one hour. The warning should clear by itself.',
        'If you see "Not found", an error, or a normal web page instead, the publisher probably moved the feed. Copy the message below and paste it to Claude, who will fix the address.',
        'If you do not want this feed any more, ask Claude to turn it off. To stop all travel news, open the Content Autopilot page, find the Travel news box, and set Mode to Off.',
      ],
      url: i.link?.href ?? adminLink('/admin/autopilot'),
      urlLabel: i.link ? 'Open the feed' : 'Open the Autopilot page',
      paste,
    }
  }
  if (i.id === AFFILIATE_PARTNER_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'Every guide page has room for a "Fun things to do" box with tour and activity links. It stays hidden until you add a partner, so right now it earns nothing. Nothing is broken.',
      steps: [
        'Sign up with a tours partner you like, using their affiliate or partner program. Their dashboard has a search link and your partner ID.',
        'Open the Affiliate Links page in the admin, then find the Partners box at the top.',
        'Type the partner name and your partner ID. Paste the search link from their dashboard, and put {query} where the place name goes and {partner_id} where your ID goes.',
        'Set Status to Active and click Create partner.',
        'Open any guide page on the site. The Fun things to do box now shows a button for that partner.',
      ],
      url: adminLink('/admin/affiliate-links'),
      urlLabel: 'Open Affiliate Links',
      paste: 'Please help me add my first affiliate partner on the Affiliate Links admin page. I will paste the search link from the partner dashboard.',
    }
  }
  if (i.id === NEWS_SETUP_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'Travel news needs one new table in Supabase to remember which news items it has read. Until it exists, the news step does nothing. This is a one-time step.',
      steps: ['Open Supabase and sign in.', 'Open your project, then click "SQL Editor" on the left.', 'Ask Claude for the contents of the file supabase/migrations/0047_news_items.sql, paste it in, and click Run.', 'Open the Content Autopilot page and look at the Travel news box. The yellow warning goes away.'],
      url: 'https://supabase.com/dashboard',
      urlLabel: 'Open Supabase',
      paste: 'Please give me the contents of supabase/migrations/0047_news_items.sql so I can run it in the Supabase SQL editor.',
    }
  }
  if (i.id === AI_SPEND_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'The site uses AI to write pages and posts, and each call costs a little money. In the last day it used more than the limit you set. Nothing was stopped. The number is a close guess, not the bill.',
      steps: ['Open the Anthropic console with the link below and click Usage. Look at the last day.', 'Open the Value page in the admin to see which job used the most.', 'If it looks wrong, set Autopilot to off for now and copy the message below to Claude.', 'If it looks fine, raise the limit: open Supabase, then the app_settings table, and set the row ai_daily_ceiling_usd to a bigger number, like 10.', 'This note goes away by itself when a day is back under the limit.'],
      url: 'https://console.anthropic.com/settings/usage',
      urlLabel: 'Open the Anthropic console',
      paste,
    }
  }
  if (i.id === HEAL_LOOP_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'The site fixes held drafts by itself, but it only does that when it can count how many AI calls it has used today. It could not read that count, so it stopped on purpose to be safe. Nothing bad happened, and nothing was published by mistake.',
      steps: [
        'Open Supabase and sign in, then open your project.',
        'Click "Table Editor" on the left, then the table called app_settings.',
        'Look for a row whose key is heal_loop_calls_per_day. If its value is not a whole number from 0 to 60, change it to 40 and click Save.',
        'Look for rows whose key starts with heal_loop_calls_used. Their value must be a whole number. If one is not, delete that row.',
        'If the table cannot be opened at all, the database is down or paused. Wait a few minutes and try again.',
        'Open the Content Autopilot page and click "Heal now" on the Self-healing card. The warning goes away when it can read the numbers.',
      ],
      url: autopilot(i.id),
      urlLabel: 'Open the Autopilot page',
      paste,
    }
  }
  if (i.id === HARD_WAITING_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'The site wrote these pages but its safety checks would not let them go live. The reason is something only a person should judge: a "we went there" claim, a price or a date, a link to another website, or a named person. The site did not change them.',
      steps: ['Open the Content Autopilot page with the link below.', 'Scroll to the guide pages card and the compare and best-time page copy card. Each draft shows, in red, why it was held back.', 'Open the draft with "Preview", fix or remove the part named in red, then click "Publish". Or click "Delete" if you do not want it.', 'Blog posts that were held back are on the Blog page in the admin, under Drafts.', 'You do not need to do anything for the pages the site fixed by itself. Those are listed under Content edits, each with an Undo button.'],
      url: autopilot(i.id),
      urlLabel: 'Open the Autopilot page',
      paste,
    }
  }
  if (i.id === 'system:step-heal-content' && /migration 0033/i.test(text)) {
    return {
      id: i.id,
      title: 'Self-healing needs one database update',
      why: 'The site can fix its own pages (reword a banned phrase, add a missing FAQ, mend a broken link) and keep a list of every change so you can undo it. That list needs one new table in Supabase. Until then it changes nothing on its own.',
      steps: ['Open Supabase and sign in.', 'Open your project, then click "SQL Editor" on the left.', 'Ask Claude for the contents of the file supabase/migrations/0033_content_edits.sql, paste it in, and click Run.', 'Open the Content Autopilot page and click "Heal now" on the Self-healing card.'],
      url: 'https://supabase.com/dashboard',
      urlLabel: 'Open Supabase',
      paste: 'Please give me the contents of supabase/migrations/0033_content_edits.sql so I can run it in the Supabase SQL editor.',
    }
  }
  if (i.id === CANNIBALISATION_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'For your information, nothing is broken. When two of your pages show up in Google for the same search words, they can share the clicks and neither wins. The page marked "stronger" is the one Google already prefers for that phrase.',
      steps: ['Open the Content Autopilot page with the link below and read each phrase and its two pages.', 'Pick the page you want to win. Usually it is the stronger one.', 'Open the other page. In its text, add a link to the stronger page, using the search words as the link words.', 'Change the weaker page so it is about something a little different (another city, another kind of trip, or another question).', 'You can ignore this if both pages are meant to be there. The list updates by itself every day.'],
      url: autopilot(i.id),
      urlLabel: 'Open the Autopilot page',
      paste,
    }
  }
  if (i.id === 'system:step-heal-content' && /click-rate test/i.test(text)) {
    return {
      id: i.id,
      title: 'The search title test had a problem',
      why: 'Once a day the site looks for pages that Google shows but few people click, tries a clearer search title, and puts the old one back by itself if it does not help. This time part of that did not work. Your pages are fine: every title change can be undone on the Content edits page.',
      steps: ['Open the Content Autopilot page with the link below and read the red line. It says which part failed.', 'If it says it could not read something, open Supabase, then the app_settings table, and look for rows that start with ctr_. Ask Claude before you delete any.', 'If it says a change could not be undone, open the Content edits page, find the page, and click Undo yourself.', 'The test tries again tomorrow. If the same line shows for three days, copy the message below and paste it to Claude.'],
      url: autopilot(i.id),
      urlLabel: 'Open the Autopilot page',
      paste,
    }
  }
  if (i.id === 'system:step-indexnow') {
    return {
      id: i.id,
      title: 'Bing could not be told about your newest pages',
      why: 'Once a day the site tells Bing (and a few smaller search engines) which pages are new or changed, so they show up sooner. Today that message did not go through. Your pages are fine and Google is not affected. The site tries again tomorrow.',
      steps: ['Open the Content Autopilot page with the link below and read the red line. It says what went wrong.', 'If it says "not readable" or "could not read", open Supabase, then the app_settings table, and check that the row named indexnow_ledger is empty or looks like {"/blog/example":"2026-10-01T10:00:00.000Z"}. Delete the row if you are unsure; it is rebuilt by itself.', 'If it says Bing did not take the pages, open Vercel, then your project, then Settings, then Environment Variables, and check that INDEXNOW_KEY is set. Then open travelfunbiz.ca/indexnow-key.txt in your browser: it must show that same key.', 'If it keeps failing for three days, copy the message below and paste it to Claude.'],
      url: autopilot(i.id),
      urlLabel: 'Open the Autopilot page',
      paste,
    }
  }
  if (i.id === 'system:keyword-engine') {
    const needsUpdate = /migration 0032/i.test(text)
    return {
      id: i.id,
      title: i.title,
      why: needsUpdate
        ? 'The keyword engine needs a small database update before it can save what it finds. Until then it spends nothing and the older weekly research keeps running.'
        : 'The weekly keyword engine (it finds which keywords to aim for and plans the next blog ideas) hit a problem.',
      steps: needsUpdate
        ? ['Open Supabase and sign in.', 'Open your project, then click "SQL Editor" on the left.', 'Ask Claude for the contents of the file supabase/migrations/0032_keyword_intel.sql, paste it in, and click Run.', 'Open the Keyword Research page and click "Run the engine now".']
        : ['Open the Keyword Research page with the link below.', 'Read the line under "Run the engine now". It says which part failed.', 'If it says a key is missing or wrong, open Vercel, then your project, then Settings, then Environment Variables, and check it. Redeploy after changing it.', 'Click "Run the engine now" again.', 'If it fails again, copy the message below and paste it to Claude.'],
      url: adminLink('/admin/keywords'),
      urlLabel: 'Open Keyword Research',
      paste,
    }
  }
  if (i.id === 'system:leads-not-forwarded') {
    return {
      id: i.id,
      title: i.title,
      why: 'Someone filled in a form, but the site could not put them in GoHighLevel yet. They are safe on the Leads page. The site keeps retrying by itself.',
      steps: ['Open the Leads page with the link below.', 'Find the people marked "failed".', 'Copy each one into GoHighLevel by hand so you can follow up today.', 'If many keep failing, copy the message below and paste it to Claude.'],
      url: adminLink('/admin/leads'),
      urlLabel: 'Open the Leads page',
      paste,
    }
  }
  if (i.id.startsWith('guide-caption:')) {
    return {
      id: i.id,
      title: i.title,
      why: 'This guide is about a named hotel, resort or ship. The site waits 24 hours before posting it, then checks the words it would post. The check found something it does not allow (a "best" style word, a number the guide does not back up, or a long dash), so the post is still waiting.',
      steps: ['Open the Distribution page with the link below.', 'Read the red words next to the guide. They say what the check did not like.', 'Open that guide in the admin, change the sentence named, and save. The site checks again by itself and posts it.', 'Or, if you are happy with the words as they are, click Approve on the Distribution page to post it now.'],
      url: adminLink('/admin/distribution'),
      urlLabel: 'Open Distribution',
      paste,
    }
  }
  if (/^(post|carousel|video):/.test(i.id)) {
    return {
      id: i.id,
      title: i.title,
      why: 'One of the posts, carousels or videos did not finish.',
      steps: ['Open the Content Autopilot page with the link below.', 'Find the red line for this item.', 'Click the "Retry" button on it. Retrying posts again, so only do it if the post is NOT already live.', 'If the same problem comes back, copy the message below and paste it to Claude.'],
      url: autopilot(i.id),
      urlLabel: 'Open this problem',
      paste,
    }
  }
  if (i.id.startsWith('system:cron') || i.id.startsWith('system:step')) {
    return {
      id: i.id,
      title: i.title,
      why: 'A job that runs by itself did not run right.',
      steps: ['Open the System Health page with the link below.', 'Look for the amber (orange) light.', 'If it is still orange after 15 minutes (the job runs every 15 minutes), copy the message below and paste it to Claude.'],
      url: adminLink('/admin/system-health'),
      urlLabel: 'Open System Health',
      paste,
    }
  }
  if (i.id.startsWith('package:thin:')) {
    return {
      id: i.id,
      title: i.title,
      why: 'A trip page with very little on it is hard to find on Google and gives visitors little reason to ask about the trip. This is not an error, just a nudge.',
      steps: [
        'Open the trip with the link below. The "Add details" box is at the top of the page.',
        'Take a screenshot of the Facebook post or event for this trip, or save the supplier PDF, or copy the supplier link.',
        'Drag the screenshot or PDF into the box (or paste the link or the words). Wait about a minute.',
        'Read the list it shows. Green "Applied automatically" lines are already on the page. Click "Replace" only on a line you want to change.',
        'If something looks wrong, click "Revert its changes" and nothing stays.',
      ],
      url: i.link ? adminLink(i.link.href) : adminLink('/admin/packages'),
      urlLabel: 'Open this trip',
    }
  }
  if (i.id.startsWith('package:recap:')) {
    return {
      id: i.id,
      title: i.title,
      why: 'These trips already happened. Do not take the pages down: Google already knows them, and a recap keeps them bringing visitors and sign-ups for the next trip like it. This is a daily nudge, not an error.',
      steps: [
        'Open the Recap Studio with the link below. It shows the trip name and a progress ring.',
        'Step 1: drop in photos from the trip. The Studio picks the best 12 for you, and you can change the order.',
        'Step 2: answer the five quick questions in a sentence or two each. It saves as you type.',
        'Step 3: add a traveller quote only if that person said yes, and tick the permission box. Or tap "Send a testimonial request link" and let them write it.',
        'Step 4: tap "Write the draft", read it next to your notes, fix any words, then tap "Publish". "Undo" is right there.',
        'No time? Make a link for a travel agent and text it to her. What she sends waits for your OK. Or tap "Snooze 7 days" and it comes back next week.',
      ],
      url: i.link ? adminLink(i.link.href) : adminLink('/admin/packages'),
      urlLabel: 'Open the Recap Studio',
    }
  }
  if (i.id.startsWith('recap-review:')) {
    return {
      id: i.id,
      title: i.title,
      why: 'Someone used a private recap link and sent you something. It is only waiting. Nothing is on the site until you approve it.',
      steps: [
        'Open the Recap Studio with the link below and find the box called "Waiting for you".',
        'Read each item. Photos show a small preview. Quotes show who said them.',
        'Tap Approve, Edit then Approve, or Reject. A quote can only be approved if the sender ticked the permission box.',
      ],
      url: i.link ? adminLink(i.link.href) : adminLink('/admin/packages'),
      urlLabel: 'Open the Recap Studio',
    }
  }
  if (i.id === 'recap-studio:migration') {
    return {
      id: i.id,
      title: i.title,
      why: 'The links for agents and travellers need two new tables in the database. Until they exist the links cannot be made.',
      steps: ['Open your Supabase project and go to the SQL editor.', 'Open the file supabase/migrations/0053_recap_studio.sql, copy all of it, paste it in the editor and press Run.', 'Come back here and refresh. This item goes away by itself.'],
      url: adminLink('/admin/system-health'),
      urlLabel: 'Open System Health',
    }
  }
  if (i.id.startsWith('agent-submission:')) {
    return {
      id: i.id,
      title: i.title,
      why: 'An agent used the private link you gave them and sent you a trip. It is only a draft. Nobody can see it on the site until you approve it.',
      steps: [
        'Open the draft with the link below. The top of the page says who sent it.',
        'Read each part. The AI filled in what the agent dropped and left blank what it could not find. Fix anything that is wrong in the form.',
        'Check the Still missing list. If the price or length of the trip is empty, type it in before you publish.',
        'Click "Approve and publish" to put it on the site, or "Send back to the agent" and write what to change. The agent can read your note on their page.',
      ],
      url: i.link ? adminLink(i.link.href) : adminLink('/admin/packages'),
      urlLabel: 'Open the draft',
    }
  }
  if (i.id.startsWith('source-watch:')) {
    return {
      id: i.id,
      title: i.title,
      why: 'Once a week the site reads the supplier page behind each trip. This one may say the trip is cancelled or on different dates. Nothing on your site was changed.',
      steps: [
        'Open the supplier page with the link below and read what it says.',
        'If the trip really is cancelled, open Packages, find the trip, and click Unpublish. If only the dates changed, fix them in the trip form.',
        'If the page is fine (the warning is wrong), open the Content Autopilot page and click Dismiss on this line.',
      ],
      url: i.link?.href ?? autopilot(i.id),
      urlLabel: i.link ? 'Open the supplier page' : 'Open this problem',
    }
  }
  if (i.area === 'setup') {
    return {
      id: i.id,
      title: i.title,
      why: 'Something is not set up yet, so a part of the site is switched off.',
      steps: ['Open the setup checklist with the link below.', 'Find the step that matches this problem.', 'Follow the steps there, and tick the box when it is done.'],
      url: CHECKLIST_URL,
      urlLabel: 'Open the setup checklist',
      paste,
    }
  }
  return {
    id: i.id,
    title: i.title,
    why: i.fix ?? 'Something needs a look.',
    steps: ['Open the Content Autopilot page with the link below.', 'Read the red box.', 'Copy the message below and paste it to Claude. Claude will look into it.'],
    url: autopilot(i.id),
    urlLabel: 'Open this problem',
    paste,
  }
}
