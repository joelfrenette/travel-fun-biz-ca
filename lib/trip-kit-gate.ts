// Trip Page Kit quality gate (pure). The existing trip copy gate (copyBlockers in lib/package-enrich.ts) is reused, then the
// "best" policy is applied on top: OPINION words are allowed (stunning, best, famous, iconic, legendary, must-see, luxury),
// but anything that cannot be verified is blocked: awards, star ratings, rankings, guarantees, lowest or best price,
// discounts, fake urgency, and any money amount.

import { copyBlockers } from '@/lib/package-enrich'
import { averageSentenceWords } from '@/lib/seo-score'
import { isPriceText, fold } from '@/lib/trip-kit-facts'

/** Blocker labels from copyBlockers that the "best" policy lets through (opinion, not a checkable claim). */
const OPINION_LABELS = new Set(['best', 'reputation claim'])

const UNVERIFIABLE: [RegExp, string][] = [
  [/\bguarantee[sd]?\b|\bguaranteed\b/i, 'guarantee'],
  [/\blowest\b|\bcheapest\b|\bbest (?:price|rate|deal|value)\b|\bbeat any price\b|\bprice match/i, 'price promise'],
  [/\bsells? out\b|\blast chance\b|\bhurry\b|\bact now\b|\bonly a few (?:spots|spaces|cabins|rooms)\b|\bwhile (?:spots|spaces) last\b/i, 'fake urgency'],
  [/\b(?:rated|ranked|voted)\b/i, 'rating or ranking'],
  [/\bfree\b(?! time| day| days)/i, 'free offer'],
]

export interface GateContext {
  /** The only text a number or a name may come from. */
  grounding: string
  field: string
}

/** Reasons a piece of kit copy must not go live. Empty means clean. */
export function tripKitBlockers(text: string, ctx: GateContext): string[] {
  const base = copyBlockers(text, ctx).filter((b) => {
    const m = /^superlative or rating claim \((.+)\)$/.exec(b)
    return !(m && OPINION_LABELS.has(m[1]))
  })
  const out = [...base]
  if (isPriceText(text)) out.push('a price, deposit amount or discount (prices only show when an agent confirmed them)')
  for (const [p, label] of UNVERIFIABLE) if (p.test(text)) out.push(`unverifiable claim (${label})`)
  if (ctx.field === 'full_description' && averageSentenceWords(text) > 22) out.push('sentences are too long (aim for under 22 words on average)')
  // The first sentence should carry the trip name (SEO: keyword early); checked by the caller, which knows the name.
  return [...new Set(out)]
}

/** The lines that pass thingBlockers, in order, without repeats. */
export function tripKitThingsOk(lines: string[], referenceNames: string[], grounding: string): string[] {
  const out: string[] = []
  for (const l of lines) {
    const t = l.replace(/\s+/g, ' ').trim()
    if (thingBlockers(t, referenceNames, grounding).length === 0 && !out.some((x) => fold(x) === fold(t))) out.push(t)
  }
  return out
}

/** A "fun thing to do" line: short, no digits, names a thing from the reference page, passes the copy gate. */
export function thingBlockers(line: string, referenceNames: string[], grounding: string): string[] {
  const out: string[] = []
  const t = line.trim()
  if (t.length < 20 || t.length > 170) out.push('wrong length')
  if (/\d/.test(t)) out.push('digit in a things-to-do line')
  const f = fold(t)
  if (!referenceNames.some((n) => f.includes(fold(n)))) out.push('names nothing from the reference page')
  out.push(...tripKitBlockers(t, { grounding, field: 'thing' }).filter((b) => !/^too short|^too long/.test(b)))
  return out
}
