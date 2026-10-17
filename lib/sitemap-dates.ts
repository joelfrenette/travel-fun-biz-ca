// Pure date helpers for app/sitemap.ts. A sitemap lastmod is only honest when it comes from a stored
// timestamp; a made-up "now" on every request teaches crawlers to ignore the field.

/** Valid ISO date string or a Date to a Date, else undefined (null, empty, unparseable). */
export function lastModOrUndefined(value: string | Date | null | undefined): Date | undefined {
  if (value == null || value === '') return undefined
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** The newest valid date among the values, or undefined when none is valid. */
export function maxIso(values: Array<string | Date | null | undefined>): Date | undefined {
  let best: Date | undefined
  for (const v of values) {
    const d = lastModOrUndefined(v)
    if (d && (!best || d.getTime() > best.getTime())) best = d
  }
  return best
}

/** Spread into a sitemap entry: adds lastModified only when a date exists. */
export function lastModField(d: Date | undefined): { lastModified?: Date } {
  return d ? { lastModified: d } : {}
}
