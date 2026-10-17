// Stored-column grounding text: a post's key takeaways and FAQ Q/A joined as plain bullet lines,
// built from stored columns only (no AI, no new data). Shared by distribution captions and reel
// scripts so numbers in them count as real facts when generated text is checked.

/** Joins key takeaways and FAQ Q/A text from stored columns. Anything that is not the expected
 * shape is skipped. Output is cut at a word boundary so it never exceeds maxChars. Returns ''
 * when there is nothing. Pure and never throws. */
export function buildGroundingText(keyTakeaways: unknown, faq: unknown, maxChars = 1200): string {
  const faqLines = Array.isArray(faq)
    ? (faq as Array<{ q?: unknown; a?: unknown } | null>).map((f) => `${typeof f?.q === 'string' ? f.q : ''} ${typeof f?.a === 'string' ? f.a : ''}`.trim()).filter(Boolean)
    : []
  const takeaways = Array.isArray(keyTakeaways) ? (keyTakeaways as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : []
  const text = [...takeaways.map((t) => `- ${t}`), ...faqLines.map((f) => `- ${f}`)].join('\n')
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  // Cut at a word boundary unless the next character already starts a new word.
  const atBoundary = /\s/.test(text.charAt(maxChars))
  const trimmed = atBoundary ? cut : cut.replace(/\s+\S*$/, '')
  // Never leave a dangling bullet marker at the end.
  return trimmed.replace(/\s+-$/, '').trimEnd()
}
