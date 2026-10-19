import { NextResponse } from 'next/server'
import { newsletterSubmissionSchema } from '@/lib/schemas/newsletter'
import { subscribeNewsletterToGoHighLevel } from '@/lib/gohighlevel'
import { isHoneypotFilled, allowRequest } from '@/lib/abuse-guard'
import { resolveLeadResponse } from '@/lib/lead-response'
import { saveLeadFirst, markLeadSent } from '@/lib/leads'

export async function POST(request: Request) {
  try {
    const json = await request.json()

    // A filled honeypot means a bot, not a person - a quiet "ok" and nothing else happens, same
    // as this project's own abuse-guard.ts doc comment describes. Real visitors never see this
    // field, so this never affects a genuine submission.
    if (isHoneypotFilled(json)) return NextResponse.json({ success: true })

    const parsed = newsletterSubmissionSchema.safeParse(json)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid data', issues: parsed.error.flatten() }, { status: 400 })
    }

    // A light per-IP throttle. Fails open (lib/abuse-guard.ts) - a spam guard must never be the
    // thing that takes the newsletter form down.
    if (!(await allowRequest(request, 'newsletter', 5, 600))) {
      return NextResponse.json({ error: 'Too many submissions - please try again shortly' }, { status: 429 })
    }

    // Backed up in the leads table first (package says it is a signup), so a GoHighLevel failure
    // cannot lose the subscriber.
    const backupId = await saveLeadFirst({
      name: parsed.data.fullName,
      email: parsed.data.email,
      phone: parsed.data.phone,
      package: 'Newsletter signup',
      // The consent record: the box was ticked on the form (the row's created_at is when).
      message: `Deal interests: ${parsed.data.deals.join(', ')}\nConsent to emails and texts: yes (checkbox ticked on the signup form)`,
      attribution: parsed.data.attribution,
    })
    const result = await subscribeNewsletterToGoHighLevel(parsed.data)
    if (backupId) await markLeadSent(backupId, result)
    // Saved in our own table counts as success even if GoHighLevel failed (the row stays unforwarded
    // and lib/heal.ts retries it). Never tell a visitor they are subscribed when nothing was saved.
    const outcome = resolveLeadResponse({ saved: !!backupId, ghlOk: result.ok, ghlError: result.ok ? undefined : result.error })
    if (outcome.success) {
      if (outcome.retryLater) console.error('[newsletter] saved, GoHighLevel send failed (will be retried):', result.ok ? '' : result.error)
      return NextResponse.json({ success: true }, { status: outcome.status })
    }
    console.error('[newsletter] not saved:', result.ok ? '' : result.error)
    return NextResponse.json({ error: result.ok ? 'Internal server error' : result.error }, { status: outcome.status })
  } catch (error) {
    console.error('[newsletter] failed to subscribe', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
