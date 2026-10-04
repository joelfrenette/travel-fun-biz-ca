import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'

export const maxDuration = 60

// Found 2026-10-03: this was a hardcoded "Placeholder FAQ generator" that invented specific
// business-policy claims with zero grounding - most seriously, "cancellations made 30+ days
// before departure receive a full refund minus administrative fees" as "Our cancellation
// policy," a fabricated, specific financial term a real customer could reasonably act on and
// later dispute. Also invented a deposit requirement, a "typically small" group size, and
// generic "best time to visit" advice - none backed by any real field on this package. Rewritten
// to match this project's established grounded-AI pattern (lib/package-extract.ts,
// generate-field/route.ts): ask the model, but only let it answer from the real fields given,
// and never invent a number, policy, or specific claim the form doesn't already state.

const GROUNDING = `You are writing FAQ answers for one travel package page on a Canadian travel agency's site. Use ONLY the facts in the package details below. If the details do not state something (a cancellation policy, a deposit amount, a group size, a fitness requirement, a specific best-time-to-visit season), do not invent it - write a generic, honest answer that points the reader to contact the agency for that specific detail instead of making up a number or policy. Never state a specific refund percentage, deposit amount, or date window unless the details explicitly give you one. Return ONLY minified JSON of this exact shape: {"faqs":[{"question":"...","answer":"..."},...]}`

function contextBlock(ctx: Record<string, string>): string {
  return Object.entries(ctx)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}: ${v.trim()}`)
    .join('\n')
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAiConfigured()) return NextResponse.json({ error: 'AI writing is not configured: set ANTHROPIC_API_KEY. (This button no longer pastes canned template text with an invented cancellation policy.)' }, { status: 503 })

  try {
    const body = await request.json()
    const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join('\n') : v != null ? String(v) : '')
    const ctx: Record<string, string> = {
      'Package name': str(body.name),
      Destination: str(body.destination),
      Duration: str(body.duration),
      Price: str(body.price_display),
      'Short description': str(body.short_description),
      Highlights: str(body.highlights),
      Included: str(body.price_includes),
      'Not included': str(body.not_included),
      'Group size': (() => {
        // `|| ''`/`|| '?'` would treat a real, meaningful 0 (e.g. "no minimum group size") as
        // absent - group size is the one field here that can legitimately be zero.
        const hasMin = body.min_people !== '' && body.min_people != null
        const hasMax = body.max_people !== '' && body.max_people != null
        return hasMin || hasMax ? `${hasMin ? body.min_people : '?'}-${hasMax ? body.max_people : '?'} travelers` : ''
      })(),
    }
    const details = contextBlock(ctx)
    if (!body.name && !body.destination) return NextResponse.json({ error: 'Fill in at least the package name or destination first, so the FAQ has something real to answer about.' }, { status: 400 })

    const prompt = `${GROUNDING}\n\nWrite 6-8 FAQ questions and answers a real prospective traveler would ask about this specific package, grounded only in the details below (always including "what's included", "what's not included", and "how do I book" using the real details if given, plus whatever else the details support - skip a topic entirely rather than inventing an answer for it).\n\nPACKAGE DETAILS:\n${details}`

    const r = await callAnthropic({ max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 50_000 })
    if (!r) return NextResponse.json({ error: 'The AI did not answer in time. Try again.' }, { status: 504 })
    if (!r.res.ok) {
      const t = await r.res.text().catch(() => '')
      console.error('[generate-faqs] anthropic error', r.res.status, t.slice(0, 300))
      return NextResponse.json({ error: `AI request failed (HTTP ${r.res.status}).` }, { status: 502 })
    }
    const parsed = parseModelJson<{ faqs?: { question?: string; answer?: string }[] }>(anthropicText(await r.res.json()))
    const faqs = Array.isArray(parsed?.faqs)
      ? parsed!.faqs.filter((f): f is { question: string; answer: string } => typeof f?.question === 'string' && typeof f?.answer === 'string' && !!f.question.trim() && !!f.answer.trim())
      : []
    if (faqs.length === 0) return NextResponse.json({ error: 'The package details do not say enough to write honest FAQs yet. Add more detail and try again.' }, { status: 422 })

    // Grounding check: an answer may not state a number this form's own text doesn't contain -
    // the same rule generate-field/route.ts and package-extract.ts already enforce, so a model
    // slip can't reintroduce a specific invented refund percentage or deposit amount.
    const known = new Set((details.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? []))
    const safeFaqs = faqs.filter((f) => {
      const nums = f.answer.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? []
      return nums.every((n) => known.has(n))
    })
    if (safeFaqs.length === 0) return NextResponse.json({ error: 'The AI draft mentioned specific numbers not in the package details, so every answer was discarded. Add that detail to the form first if it is real, then try again.' }, { status: 422 })

    // Disclose a partial discard rather than silently returning fewer FAQs than asked for -
    // generate-field/route.ts fails loud on this same grounding check; a per-item filter needs the
    // same disclosure, or an admin has no way to know some answers were dropped for inventing a number.
    const discarded = faqs.length - safeFaqs.length
    return NextResponse.json({
      faqs: safeFaqs,
      model: r.model,
      ...(discarded > 0 ? { notice: `${discarded} of ${faqs.length} AI-drafted answers mentioned a number not in the package details and were discarded.` } : {}),
    })
  } catch (err) {
    console.error('[generate-faqs] error', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
