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
      steps: ['Open the System Health page with the link below.', 'Look for the amber (orange) light.', 'If it is still orange after 30 minutes, copy the message below and paste it to Claude.'],
      url: adminLink('/admin/system-health'),
      urlLabel: 'Open System Health',
      paste,
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
