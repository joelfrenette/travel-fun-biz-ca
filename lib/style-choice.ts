// Pure helpers for the self-improving loop (WP3). No imports on purpose, so the offline check script
// (scripts/check-performance.ts) and lib/content-styles.ts can use them without pulling in Supabase.

/** A style needs this many posts before its numbers are trusted enough to steer the writer. */
export const MIN_POSTS_FOR_CONFIDENCE = 3
/** Once a style has enough posts, the writer picks the best one this often; the rest is rotation. */
export const EXPLOIT_SHARE = 0.7

export interface StyleScore {
  value: string
  posts: number
  clicks: number
  clicksPerPost: number
  leads: number
  leadsPerPost: number
  /** 'thin' = fewer than MIN_POSTS_FOR_CONFIDENCE posts, so the numbers are not yet meaningful. */
  sample: 'thin' | 'ok'
}

const KEY_LABEL: Record<string, string> = {
  content_style: 'Blog post style',
  cta_style: 'Call to action style',
  video_hook: 'Video hook',
  carousel_cta: 'Carousel call to action',
  carousel_hook: 'Carousel opening',
}

/** Plain-English name for a variant tag key (used by the Autopilot card and the daily brief). */
export function styleKeyLabel(key: string): string {
  if (KEY_LABEL[key]) return KEY_LABEL[key]
  const [kind, network] = key.split(':')
  if (kind === 'hook_style') return `Hook style, ${network}`
  if (kind === 'caption_style') return `Caption style, ${network}`
  return key
}

/** '/blog/some-slug' -> 'some-slug'. Anything else (a package, the home page, a nested path) -> null.
 * Tolerates a trailing slash, a query string or a hash. */
export function blogSlugFromPath(path: string): string | null {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '')
  const m = /^\/blog\/([^/]+)$/.exec(clean)
  return m ? m[1] : null
}

/** Picks the next style value. `recent` is ordered MOST RECENT FIRST (recent[0] is what the last post
 * used). With probability 0.7 it picks the best-scoring value that has 3 or more posts and is not the most
 * recent one (best = highest clicksPerPost, ties go to more posts, then to catalogue order). Otherwise, and
 * always when no value has 3 or more posts, it rotates: the least used value in `recent`, never the most
 * recent, ties broken by `rand`. Deterministic for a given `rand`. Values outside `catalogue` are ignored. */
export function chooseWeighted(
  scores: { value: string; clicksPerPost: number; posts: number }[],
  recent: string[],
  catalogue: readonly string[],
  rand: () => number = Math.random,
): string {
  if (!catalogue.length) throw new Error('chooseWeighted needs a non-empty catalogue')
  const last = recent[0]
  const order = (v: string) => catalogue.indexOf(v)

  const eligible = scores
    .filter((s) => s.posts >= MIN_POSTS_FOR_CONFIDENCE && order(s.value) >= 0 && s.value !== last)
    .sort((a, b) => b.clicksPerPost - a.clicksPerPost || b.posts - a.posts || order(a.value) - order(b.value))
  if (eligible.length && rand() < EXPLOIT_SHARE) return eligible[0].value

  const pool = catalogue.length > 1 ? catalogue.filter((v) => v !== last) : [...catalogue]
  const used = (v: string) => recent.filter((r) => r === v).length
  const fewest = Math.min(...pool.map(used))
  const least = pool.filter((v) => used(v) === fewest)
  return least[Math.min(least.length - 1, Math.floor(rand() * least.length))]
}
