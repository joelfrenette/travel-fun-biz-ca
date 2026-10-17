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

/** The Needs attention item for live guide pages that no other page links to (WP16). Same reason as above. */
export const GUIDE_ORPHANS_ISSUE_ID = 'system:guide-orphans'

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
  if (i.id === HEAL_LOOP_ISSUE_ID) {
    return {
      id: i.id,
      title: i.title,
      why: 'The site fixes held drafts by itself, but it only does that when it can count how many AI calls it has used today. It could not read that count, so it stopped on purpose to be safe. Nothing bad happened, and nothing was published by mistake.',
      steps: [
        'Open Supabase and sign in, then open your project.',
        'Click "Table Editor" on the left, then the table called app_settings.',
        'Look for a row whose key is heal_loop_calls_per_day. If its value is not a whole number from 0 to 60, change it to 20 and click Save.',
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
      why: 'This trip already happened. Do not take the page down: Google already knows it, and a recap keeps it bringing visitors and sign-ups for the next trip like it. This is a nudge, not an error.',
      steps: [
        'Open the trip with the link below. The "Convert to Past Trip" card is near the top.',
        'Drop in photos from the trip (they stay private until you click "Add to gallery" on the ones you want).',
        'Type 3 to 8 short journal notes: a date and a line about what happened.',
        'Click "Write the recap". If it passes the safety checks it goes live right away, and you can click "Edit" to change the words or "Undo recap" to take it back.',
        'Pick the next trip to point visitors to, then you are done.',
      ],
      url: i.link ? adminLink(i.link.href) : adminLink('/admin/packages'),
      urlLabel: 'Open Convert to Past Trip',
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
