import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { generatePackageFaqsDetailed } from '@/lib/package-faqs'

export const maxDuration = 60

// The prompt, the grounding and the quality gate live in lib/package-faqs.ts (growth loop WP12), shared with the
// automatic path that writes FAQs once a trip description lands. History: found 2026-10-03, this route was a
// hardcoded generator that invented specific business-policy claims (a refund rule, a deposit, a group size) with
// no grounding. The lib version answers only from the fields sent here and drops any answer that states a number
// the form does not contain, a refund/deposit/visa style topic the form never mentions, or a claim about the agency.

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await request.json()
    const r = await generatePackageFaqsDetailed({
      name: body.name,
      destination: body.destination,
      duration: body.duration,
      short_description: body.short_description,
      full_description: body.full_description,
      highlights: body.highlights,
      price_includes: body.price_includes,
      not_included: body.not_included,
      itinerary: body.itinerary,
      min_people: body.min_people,
      max_people: body.max_people,
    })
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status ?? 500 })
    return NextResponse.json({
      faqs: r.faqs,
      model: r.model,
      ...(r.discarded > 0 ? { notice: `${r.discarded} AI-drafted answer${r.discarded === 1 ? '' : 's'} did not pass the quality check (a number, claim or topic not in the package details) and ${r.discarded === 1 ? 'was' : 'were'} discarded.` } : {}),
    })
  } catch (err) {
    console.error('[generate-faqs] error', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
