// Pure decisions for "only index compare and best-time pages that have written copy". No database import, so the
// offline check can run it under plain node. The one query lives in getPublishedPageCopyPaths (lib/page-copy.ts).

/** Builds the lookup of published copy paths from rows. Returns null when there is nothing usable to filter by
 * (read failed, no rows at all), which callers treat as "fail open": list and index everything as before. */
export function buildCopyPathSet(rows: { path?: unknown }[] | null | undefined): Set<string> | null {
  if (!Array.isArray(rows)) return null
  const set = new Set<string>()
  for (const r of rows) if (typeof r?.path === 'string' && r.path) set.add(r.path)
  return set.size > 0 ? set : null
}

/** True when the sitemap should list this compare or best-time path. A null set means fail open (list it). */
export function shouldListPath(path: string, copyPaths: Set<string> | null): boolean {
  if (!copyPaths) return true
  return copyPaths.has(path)
}

/** The robots value for a compare or best-time page: noindex (links still followed) when the page has no usable
 * copy, otherwise undefined so the default (index) applies. */
export function copyRobots(hasUsableCopy: boolean): { index: false; follow: true } | undefined {
  return hasUsableCopy ? undefined : { index: false, follow: true }
}

/** Keeps the items whose path is listable (see shouldListPath). Order is preserved. */
export function filterByCopy<T>(items: T[], pathOf: (item: T) => string, copyPaths: Set<string> | null): T[] {
  return items.filter((i) => shouldListPath(pathOf(i), copyPaths))
}
