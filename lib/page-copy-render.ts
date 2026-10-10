import * as React from 'react'
import { getPublishedPageCopy, staleLinkedSlugs, type PublicPageCopy } from '@/lib/page-copy'

// What the compare and best-time routes call. Kept apart from lib/page-copy.ts because React's cache() does not
// exist outside a React server build (the offline script imports page-copy.ts under plain node).

// The installed @types/react predates cache(), but Next's React has it at runtime; fall back to no caching.
const cache = ((React as unknown as { cache?: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R }).cache ?? (<A extends unknown[], R>(fn: (...args: A) => R) => fn))

/** One fetch per request path: generateMetadata and the page both ask, only one query runs. */
const fetchCopy = cache((path: string) => getPublishedPageCopy(path))

/** The published copy for a page, or null when there is none OR when it links to a trip the page no longer lists
 * (then the page renders exactly as if no copy existed). `warn` is set by the page itself (not by generateMetadata)
 * so a stale row logs once per render. */
export async function getUsablePageCopy(path: string, currentPackageSlugs: string[], warn = false): Promise<PublicPageCopy | null> {
  const copy = await fetchCopy(path)
  if (!copy) return null
  const stale = staleLinkedSlugs(copy.linked_slugs, currentPackageSlugs)
  if (stale.length) {
    if (warn) console.warn(`[page-copy] ${path}: copy links to trip(s) no longer listed (${stale.join(', ')}); showing the page without it`)
    return null
  }
  return copy
}
