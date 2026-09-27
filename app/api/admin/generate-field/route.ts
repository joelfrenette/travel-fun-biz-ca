import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'

export const maxDuration = 60

// The "AI" buttons next to fields in the admin package form. Until 2026-09-27 these were fixed
// string templates that invented inclusions ("Daily breakfast", "24/7 customer support") and
// generic blurbs regardless of the trip (roadmap use case f8611635). Now they ask the model,
// grounded in what the form already says, and refuse to run at all when no key is set rather
// than silently falling back to made-up text.
//
// Same rule as lib/package-extract.ts: any number in the generated text must already be in the
// form's own text, and the inclusion/exclusion lists may only contain what the form's text
// states. Otherwise the button returns an empty value and says why.

const FIELDS = ['keywords', 'short_description', 'full_description', 'highlights', 'price_includes', 'not_included', 'meta_title', 'meta_description'] as const
type Field = (typeof FIELDS)[number]

interface Ctx {
  name: string
  destination: string
  supplier: string
  duration: string
  price_display: string
  short_description: string
  full_description: string
  highlights: string
  price_includes: string
  not_included: string
  categories: string[]
}

function contextBlock(ctx: Ctx): string {
  const lines = [
    ['Package name', ctx.name],
    ['Destination', ctx.destination],
    ['Supplier / operator', ctx.supplier],
    ['Duration', ctx.duration],
    ['Price', ctx.price_display],
    ['Categories', ctx.categories.join(', ')],
    ['Short description', ctx.short_description],
    ['Full description', ctx.full_description],
    ['Highlights', ctx.highlights],
    ['Included', ctx.price_includes],
    ['Not included', ctx.not_included],
  ].filter(([, v]) => v && String(v).trim())
  return lines.map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n')
}

const GROUNDING = `You are writing one field of a travel package page for a Canadian travel agency (hosted group trips, cruises, singles getaways). Use ONLY the facts in the package details below. Do not add any number, date, price, hotel, meal, transfer, activity or inclusion that the details do not state. Never claim personal experience. If the details are too thin to write the field honestly, return an empty string. Return ONLY minified JSON: {"value": "..."}`

function fieldInstruction(field: Field): string {
  switch (field) {
    case 'keywords':
      return 'Write 6-10 SEO keyword phrases, comma-separated, built only from the places, trip type and features named in the details.'
    case 'short_description':
      return 'Write a 1-2 sentence card description (under 200 characters) in a warm, plain voice.'
    case 'full_description':
      return 'Write 2-4 short paragraphs of page copy (150-300 words) in a warm, practical voice. Plain text, no headings, no bullet lists, no call to action.'
    case 'highlights':
      return 'List 3-6 highlights, one per line, each a short phrase, each drawn from something the details actually say. Return them joined with \\n inside the JSON string.'
    case 'price_includes':
      return 'List what the price includes, one per line, ONLY items the details state are included. If the details do not say what is included, return an empty string. Return them joined with \\n inside the JSON string.'
    case 'not_included':
      return 'List what the price does not include, one per line, ONLY items the details state are excluded. If the details do not say, return an empty string. Return them joined with \\n inside the JSON string.'
    case 'meta_title':
      return 'Write an SEO title under 60 characters naming the destination and trip type.'
    case 'meta_description':
      return 'Write an SEO meta description under 155 characters.'
  }
}

function digitRuns(text: string): Set<string> {
  return new Set(text.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? [])
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAiConfigured()) return NextResponse.json({ error: 'AI writing is not configured: set ANTHROPIC_API_KEY. (These buttons no longer paste canned template text.)' }, { status: 503 })

  try {
    const body = await request.json()
    const field = body.field as Field
    if (!FIELDS.includes(field)) return NextResponse.json({ error: 'Unknown field' }, { status: 400 })

    const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join('\n') : '')
    const ctx: Ctx = {
      name: str(body.name),
      destination: str(body.destination),
      supplier: str(body.supplier),
      duration: str(body.duration),
      price_display: str(body.price_display),
      short_description: str(body.short_description),
      full_description: str(body.full_description),
      highlights: str(body.highlights),
      price_includes: str(body.price_includes),
      not_included: str(body.not_included),
      categories: Array.isArray(body.categories) ? body.categories.filter((c: unknown) => typeof c === 'string') : [],
    }
    const details = contextBlock(ctx)
    if (!ctx.name && !ctx.destination) return NextResponse.json({ error: 'Fill in at least the package name or destination first, so the AI has something real to write from.' }, { status: 400 })

    const prompt = `${GROUNDING}\n\nTask: ${fieldInstruction(field)}\n\nPACKAGE DETAILS:\n${details}`
    const r = await callAnthropic({ max_tokens: field === 'full_description' ? 4000 : 2000, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 50_000 })
    if (!r) return NextResponse.json({ error: 'The AI did not answer in time. Try again.' }, { status: 504 })
    if (!r.res.ok) {
      const t = await r.res.text().catch(() => '')
      console.error('[generate-field] anthropic error', r.res.status, t.slice(0, 300))
      return NextResponse.json({ error: `AI request failed (HTTP ${r.res.status}).` }, { status: 502 })
    }
    const parsed = parseModelJson<{ value?: unknown }>(anthropicText(await r.res.json()))
    let value = typeof parsed?.value === 'string' ? parsed.value.trim() : ''
    if (!value) return NextResponse.json({ error: 'The package details do not say enough to write this honestly. Add more detail (or type it in) and try again.' }, { status: 422 })

    // Grounding check: no number may appear that the form's own text doesn't contain.
    const known = digitRuns(details)
    const bad = [...digitRuns(value)].filter((n) => !known.has(n))
    if (bad.length) {
      return NextResponse.json({ error: `The AI draft mentioned ${bad.join(', ')}, which is not in the package details, so it was discarded. Add that fact to the form first if it's real.` }, { status: 422 })
    }
    if (field === 'keywords') value = value.split(/,|\n/).map((k) => k.trim()).filter(Boolean).join(', ')

    return NextResponse.json({ value, model: r.model })
  } catch (err) {
    console.error('[generate-field] error', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
