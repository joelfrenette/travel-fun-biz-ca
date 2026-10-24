// Trip Page Kit quality gate (pure). The existing trip copy gate (copyBlockers in lib/package-enrich.ts) is reused, then the
// "best" policy is applied on top: OPINION words are allowed (stunning, best, famous, iconic, legendary, must-see, luxury),
// but anything that cannot be verified is blocked: awards, star ratings, rankings, guarantees, lowest or best price,
// discounts, fake urgency, and any money amount.

import { copyBlockers } from '@/lib/package-enrich'
import { SUPERLATIVE_PATTERNS } from '@/lib/guide-composer'
import { averageSentenceWords } from '@/lib/seo-score'
import { isPriceText, fold, isLocalLanguageName } from '@/lib/trip-kit-facts'

/** Blocker labels from copyBlockers that the "best" policy lets through (opinion, not a checkable claim). */
const OPINION_LABELS = new Set(['best', 'reputation claim'])
/** Labels that pass when the very same word is in the grounding text (the source itself says it). Awards, star ratings,
 * number one, top-rated, world-class and diamonds are never exempt. */
const STATED_OK = new Set(['size or age superlative', 'most popular or similar', 'first or only claim'])

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
  // "adults only resort" is an age rule, not a "only resort" claim.
  const checked = text.replace(/\badults?[- ]only\b/gi, 'adults')
  const g = fold(ctx.grounding)
  const base = copyBlockers(checked, ctx).filter((b) => {
    const m = /^superlative or rating claim \((.+)\)$/.exec(b)
    if (!m) return true
    if (OPINION_LABELS.has(m[1])) return false
    // A size, age, popularity or first/only word is allowed when the stored text or the cited reference page uses that same word.
    if (STATED_OK.has(m[1])) {
      const hits = SUPERLATIVE_PATTERNS.filter(([, label]) => label === m[1]).flatMap(([p]) => checked.match(new RegExp(p.source, 'gi')) ?? [])
      if (hits.length > 0 && hits.every((h) => g.includes(fold(h)))) return false
    }
    return true
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
  if (isLocalLanguageName(t)) out.push('a local-language name (only English titles from the reference page are used)')
  if (/\b(?:St|Sts|Ste|Mt|Dr|Fr|Mr|Mrs|Ms|Ft|Sv|sv)\.(?=[A-Za-z])/.test(t)) out.push('missing space after an abbreviation')
  const f = fold(t)
  if (!referenceNames.some((n) => f.includes(fold(n)))) out.push('names nothing from the reference page')
  out.push(...tripKitBlockers(t, { grounding, field: 'thing' }).filter((b) => !/^too short|^too long/.test(b)))
  return out
}
