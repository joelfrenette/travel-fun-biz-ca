import { NextResponse } from 'next/server'
import { tripAlertSubmissionSchema } from '@/lib/schemas/trip-alert'
import { subscribeTripAlertToGoHighLevel } from '@/lib/gohighlevel'
import { isHoneypotFilled, allowRequest } from '@/lib/abuse-guard'
import { saveLeadFirst, markLeadSent } from '@/lib/leads'
import { getPublishedPackageBySlug } from '@/lib/packages'
import { effectiveAlertTag } from '@/lib/past-trip'

// Public: "tell me about the next one" on a past trip's page (WP14). Same path as the newsletter: honeypot, a light
// per-IP throttle, the lead saved to `leads` BEFORE GoHighLevel is called (so a GHL failure cannot lose it), then the
// contact upserted with the trip's alert tag. The leads table has no kind column, so the row's `package` reads
// "Trip alert: <tag>" and the debrief counts it apart from contact-form leads. Test people (lib/test-data.ts) are
// flagged is_test on the row and tagged test-data in GoHighLevel.
export async function POST(request: Request) {
  try {
    const json = await request.json()
    if (isHoneypotFilled(json)) return NextResponse.json({ success: true })

    const parsed = tripAlertSubmissionSchema.safeParse(json)
    if (!parsed.success) return NextResponse.json({ error: 'Invalid data', message: parsed.error.issues[0]?.message ?? 'Please check your email address and the box.' }, { status: 400 })

    if (!(await allowRequest(request, 'trip-alert', 5, 600))) {
      return NextResponse.json({ error: 'Too many submissions - please try again shortly' }, { status: 429 })
    }

    // The tag comes from the trip's own row, never from the request.
    const pkg = await getPublishedPackageBySlug(parsed.data.slug)
    if (!pkg) return NextResponse.json({ error: 'Trip not found' }, { status: 404 })
    const tag = effectiveAlertTag(pkg)

    const attribution = { ...parsed.data.attribution, page_path: parsed.data.attribution?.page_path || `/packages/${pkg.slug}` }
    const backupId = await saveLeadFirst({
      name: parsed.data.name || 'Trip alert subscriber',
      email: parsed.data.email,
      package: `Trip alert: ${tag}`,
      message: `Asked to hear about the next trip like: ${pkg.name} (/packages/${pkg.slug})\nConsent to emails: yes (checkbox ticked on the trip alert form)`,
      attribution,
    })
    const result = await subscribeTripAlertToGoHighLevel({ email: parsed.data.email, name: parsed.data.name, alertTag: tag, attribution })
    if (backupId) await markLeadSent(backupId, result)
    if (result.ok) return NextResponse.json({ success: true })

    // The detail stays in the server log; the visitor gets one fixed sentence (the sign-up is also saved in `leads`).
    console.error('[trip-alerts] not saved:', result.error)
    return NextResponse.json({ error: 'We could not save your sign-up just now. Please try again in a few minutes.' }, { status: result.error.includes('not configured') ? 503 : 502 })
  } catch (error) {
    console.error('[trip-alerts] failed', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
