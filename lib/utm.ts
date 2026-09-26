// Ported verbatim from Nomad Escape Plan (Factory Phase 1: foundation) — genuinely site-generic,
// nothing here needs adapting. No caller wires this in yet; Phase 8 (tracking foundation) and
// the distribution/email phases are what actually call utmLink().
/**
 * UTM TAGS ON OUTBOUND LINKS — one place that knows how to add them.
 *
 * A link we post (a social caption, an email, a checkout hand-off) carries
 * utm_source / utm_medium / utm_campaign so the visit it produces is credited
 * to the right channel when it lands, and so a lead/order records where the
 * visitor came from.
 *
 * Rules:
 *   - only absolute http(s) links are tagged; a relative path ("/packages/x") or a
 *     placeholder ("[LINK]", "{{contact.x}}") is returned untouched
 *   - tags already on the link win, unless the caller asks to overwrite — a
 *     link someone tagged by hand keeps its tags
 *   - values are slugged (lowercase, a-z 0-9 . _ - :) so "Blog Post!" and
 *     "blog-post" don't count as two campaigns
 *   - an empty value is skipped rather than written as "utm_x="
 */
export interface UtmTags {
  source: string
  medium: string
  campaign: string
  content?: string
  term?: string
}

/** Lowercase, anything outside a-z 0-9 . _ - : becomes "-", runs collapsed, ends trimmed, 100 chars max. */
export function slugifyUtm(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

const PLACEHOLDER = /\[[A-Z_]+\]|\{\{|%7B%7B/i

export function utmLink(url: string, tags: UtmTags, opts: { overwrite?: boolean } = {}): string {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || PLACEHOLDER.test(url)) return url
  try {
    const u = new URL(url)
    const pairs: [string, string | undefined][] = [
      ['utm_source', tags.source],
      ['utm_medium', tags.medium],
      ['utm_campaign', tags.campaign],
      ['utm_content', tags.content],
      ['utm_term', tags.term],
    ]
    for (const [key, raw] of pairs) {
      const value = slugifyUtm(raw)
      if (!value) continue
      if (!opts.overwrite && u.searchParams.has(key)) continue
      u.searchParams.set(key, value)
    }
    return u.toString()
  } catch {
    return url
  }
}
