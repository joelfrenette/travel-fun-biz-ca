// Ported from Nomad Escape Plan's content-dedupe.ts (Factory Phase 2: blog/autoblog), trimmed to
// the generic token-overlap near-duplicate detector - the piece every content path needs per
// PARITY-SPEC's owner rule ("every content path dedupes"). Not a full-text similarity engine:
// title-only overlap is what the composer and the topic queue both actually need.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter((w) => w.length > 2))
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / Math.min(a.size, b.size)
}

/** Titles at or above this token overlap are treated as the same idea. Matches Nomad's threshold. */
export const DEDUPE_THRESHOLD = 0.75

export interface DedupeCandidate {
  title: string
}

/** The first existing item whose title is a near-duplicate of `title`, or null. */
export function findDuplicate<T extends DedupeCandidate>(title: string, existing: T[]): T | null {
  const target = tokens(title)
  for (const item of existing) {
    if (overlap(target, tokens(item.title)) >= DEDUPE_THRESHOLD) return item
  }
  return null
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
