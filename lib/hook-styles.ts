import type { SupabaseClient } from '@supabase/supabase-js'

// Growth loop (WP2): the hook and call-to-action styles social content rotates through, plus the
// tiny deterministic rotation that keeps consecutive posts on one network from opening the same
// way. Pure data and pure functions, except readRecentVariantValues which only READS the
// content_variants log (written by tagVariant in lib/content-variants.ts).

/** First-line styles. Each prompt fragment tells the model what the opening line should do, and
 * never asks it to produce a number it was not given. */
export const HOOK_STYLES = ['question', 'number', 'contrarian', 'mistake', 'story', 'comparison', 'how-to'] as const
export type HookStyle = (typeof HOOK_STYLES)[number]

export const HOOK_STYLE_PROMPTS: Record<HookStyle, string> = {
  question: 'open with one direct question a curious traveller would genuinely ask about this topic',
  number: 'open with a number, but ONLY a number that appears in the post title, summary or takeaways given below; if none is given, open with a concrete detail from the post instead and do not invent a figure',
  contrarian: 'open by gently challenging a common assumption about this topic, without insulting anyone and without claiming an expert authority',
  mistake: 'open by naming one common planning mistake that this post helps the reader avoid',
  story: 'open with a short scene-setting line that puts the reader in the moment, written as general travel knowledge and never as "we went" or "I visited"',
  comparison: 'open with a this-versus-that contrast taken from the post (two options, two styles, two ways to do it)',
  'how-to': 'open with a plain how-to promise, for example how to get something done with less stress',
}

/** Call-to-action styles. The id strings are the values stored under the `cta_style` tag. The last
 * one is called guide-download in the shared brief but there is no file to download, so the wording
 * is always "read the full guide". */
export const CTA_STYLES = ['soft-question', 'direct-book', 'compare', 'quiz-style', 'guide-download'] as const
export type CtaStyle = (typeof CTA_STYLES)[number]

export const CTA_STYLE_PROMPTS: Record<CtaStyle, string> = {
  'soft-question': 'end with a gentle question that invites the reader to the post page, for example asking which option suits them',
  'direct-book': 'end with a plain invitation to ask us about planning this trip, no urgency and no promised reply time',
  compare: 'end by inviting the reader to compare the options on the post page',
  'quiz-style': 'end with a short either-or question that the post helps answer, then point to the post',
  'guide-download': 'end by inviting the reader to read the full guide on the post page (it is a web page, not a download, so never say download)',
}

/** Plain-text hashtag rules per network, from the growth-loop brief. Lives here so every caption
 * writer (blog captions, carousel captions) can show the same rule. */
export const HASHTAG_RULES: Record<string, string> = {
  instagram: '3 to 8 hashtags at the very end',
  tiktok: '1 to 3 hashtags',
  x: '1 to 2 hashtags',
  twitter: '1 to 2 hashtags',
  linkedin: '0 to 3 hashtags',
  pinterest: 'keyword-rich wording instead of many hashtags, 0 to 3 hashtags',
  bluesky: '0 to 2 hashtags',
  facebook: '0 to 2 hashtags',
  threads: '0 to 2 hashtags',
  youtube: '0 to 3 hashtags, no timestamps needed',
}

/** Picks the next style from `catalogue`, given `recent` values with the MOST RECENT FIRST.
 * Rules, in order: never the most recent one (unless it is the only choice); among the rest prefer
 * the one used least in the last 5; ties go to the one used longest ago across the whole `recent`
 * list (never used counts as longest ago, so callers should pass about 12 values, not 5, or the
 * last catalogue entries can starve); remaining ties go to catalogue order. No randomness, so it is repeatable and
 * testable. Values not in the catalogue are ignored. */
export function rotateStyle<T extends string>(recent: readonly string[], catalogue: readonly T[], offset = 0): T {
  if (catalogue.length === 0) throw new Error('rotateStyle needs a non-empty catalogue')
  const window = recent.slice(0, 5)
  const last = recent.find((v) => (catalogue as readonly string[]).includes(v))
  // `offset` (for example the network's position in the platform list) rotates the catalogue used
  // for the final tie-break only, so networks with empty history do not all open the same way.
  const shift = ((offset % catalogue.length) + catalogue.length) % catalogue.length
  const ordered = [...catalogue.slice(shift), ...catalogue.slice(0, shift)]
  const pool = catalogue.length > 1 ? ordered.filter((s) => s !== last) : [...ordered]
  let best = pool[0]
  let bestCount = Infinity
  let bestAge = -1
  for (const style of pool) {
    const count = window.filter((v) => v === style).length
    const idx = recent.indexOf(style) // whole history, so a style never used beats one used 6 posts ago
    const age = idx === -1 ? Infinity : idx
    if (count < bestCount || (count === bestCount && age > bestAge)) {
      best = style
      bestCount = count
      bestAge = age
    }
  }
  return best
}

/** Reads one tag for one post (for example `carousel_cta` for a slug), or null. Never throws. */
export async function readVariantTag(admin: SupabaseClient, slug: string, key: string): Promise<string | null> {
  try {
    const { data } = await admin.from('content_variants').select('variant_tags').eq('slug', slug).maybeSingle()
    const v = (data as { variant_tags?: Record<string, unknown> | null } | null)?.variant_tags?.[key]
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/** Reads the last `limit` values stored under tag `key` (for example `hook_style:instagram`) in
 * content_variants, newest first. Rows are ordered by updated_at; rows that never had the tag are
 * skipped (a post that did not go to that network), so a wider window of rows is read and then cut
 * to `limit` values. Never throws: an empty list just means "no history, start anywhere". */
export async function readRecentVariantValues(admin: SupabaseClient, key: string, limit = 5): Promise<string[]> {
  return valuesFromRows(await readRecentVariantRows(admin), key, limit)
}

export interface VariantRow {
  variant_tags: Record<string, unknown> | null
  updated_at?: string | null
}

/** Reads the most recent content_variants rows once, so a caller that needs many keys can filter in
 * memory (valuesFromRows) instead of querying per key. Never throws; [] means no history. */
export async function readRecentVariantRows(admin: SupabaseClient, rows = 80): Promise<VariantRow[]> {
  try {
    const { data, error } = await admin.from('content_variants').select('variant_tags, updated_at').order('updated_at', { ascending: false }).limit(rows)
    if (error || !data) return []
    return data as VariantRow[]
  } catch {
    return []
  }
}

/** Newest-first values stored under `key`. Rows are ordered by their `hook_style_at` stamp when the
 * row has one (so a later, unrelated tag write cannot reorder history), else by updated_at. */
export function valuesFromRows(rows: readonly VariantRow[], key: string, limit = 5): string[] {
  const stamp = (r: VariantRow) => {
    const at = r.variant_tags?.hook_style_at
    const t = Date.parse(typeof at === 'string' ? at : (r.updated_at ?? ''))
    return Number.isFinite(t) ? t : 0
  }
  const sorted = [...rows].sort((a, b) => stamp(b) - stamp(a))
  const out: string[] = []
  for (const row of sorted) {
    const v = row.variant_tags?.[key]
    if (typeof v === 'string' && v) out.push(v)
    if (out.length >= limit) break
  }
  return out
}

const NUMBER_WORDS: Record<string, string> = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  dozen: '12', hundred: '100', thousand: '1000',
}
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi')

/** Numbers in `text` (digits, and the spelled-out two..twelve, dozen, hundred, thousand) that do not
 * appear in `source` as a digit or a word. "one" is left alone on purpose (too common in plain
 * English). Links in `text` are ignored. */
export function ungroundedNumbers(text: string, source: string): string[] {
  // Only a comma-grouped number ("1,200") is joined; "Day 3 100 people" stays 3 and 100.
  const digits = (s: string) => (s.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => m.replace(/,/g, '')).match(/\d+/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ''))
  const words = (s: string) => (s.match(NUMBER_WORD_RE) ?? []).map((w) => w.toLowerCase())
  const known = new Set<string>([...digits(source), ...words(source).map((w) => NUMBER_WORDS[w])])
  // Links and #hashtags are ignored; a plain year from 2025 to 2030 is allowed.
  const body = text.replace(/https?:\/\/\S+/gi, ' ').replace(/#\S+/g, ' ')
  const stray = [...digits(body), ...words(body).map((w) => NUMBER_WORDS[w])].filter((n) => !known.has(n) && !(n.length === 4 && +n >= 2025 && +n <= 2030))
  return [...new Set(stray)]
}

/** Swaps the long dash characters and spaced double hyphens for a comma. No fact changes. */
export function repairDashes(text: string): string {
  const em = String.fromCharCode(8212)
  const en = String.fromCharCode(8211)
  return text
    .replace(new RegExp(`\\s*${em}\\s*`, 'g'), ', ')
    .replace(new RegExp(`\\s${en}\\s`, 'g'), ', ')
    .replace(/\s--\s/g, ', ')
}
