import { NextResponse } from 'next/server'
import { newsletterSubmissionSchema } from '@/lib/schemas/newsletter'
import { subscribeNewsletterToGoHighLevel } from '@/lib/gohighlevel'
import { isHoneypotFilled, allowRequest } from '@/lib/abuse-guard'

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

    const result = await subscribeNewsletterToGoHighLevel(parsed.data)
    if (result.ok) return NextResponse.json({ success: true })

    // Never tell a visitor they are subscribed when nothing was saved.
    console.error('[newsletter] not saved:', result.error)
    return NextResponse.json({ error: result.error }, { status: result.error.includes('not configured') ? 503 : 502 })
  } catch (error) {
    console.error('[newsletter] failed to subscribe', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
