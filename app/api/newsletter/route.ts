import { NextResponse } from 'next/server'
import { newsletterSubmissionSchema } from '@/lib/schemas/newsletter'
import { subscribeNewsletterToGoHighLevel } from '@/lib/gohighlevel'

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = newsletterSubmissionSchema.safeParse(json)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid data', issues: parsed.error.flatten() }, { status: 400 })
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
