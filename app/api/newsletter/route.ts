import { NextResponse } from 'next/server'
import { newsletterSubmissionSchema } from '@/lib/schemas/newsletter'
import { subscribeNewsletterToGoHighLevel } from '@/lib/gohighlevel'
import { isHoneypotFilled, allowRequest } from '@/lib/abuse-guard'
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
    if (result.ok) return NextResponse.json({ success: true })

    // Never tell a visitor they are subscribed when nothing was saved.
    console.error('[newsletter] not saved:', result.error)
    return NextResponse.json({ error: result.error }, { status: result.error.includes('not configured') ? 503 : 502 })
  } catch (error) {
    console.error('[newsletter] failed to subscribe', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
