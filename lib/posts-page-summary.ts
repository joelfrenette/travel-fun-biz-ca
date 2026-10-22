// Pure helpers shared by every "Posts: ..." admin page (Blog, News, and later Guides and Trips).

export interface StatusCounts {
  total: number
  published: number
  scheduled: number
  draft: number
}

/** Counts by status for the header strip. A published post with a future date counts as scheduled, not published,
 * because the public site does not show it yet. `today` is a YYYY-MM-DD string. */
export function countPostStatuses(posts: { status: string; publish_date: string | null }[], today: string): StatusCounts {
  const out: StatusCounts = { total: posts.length, published: 0, scheduled: 0, draft: 0 }
  for (const p of posts) {
    if (p.status !== 'published') out.draft++
    else if (p.publish_date && p.publish_date.slice(0, 10) > today) out.scheduled++
    else out.published++
  }
  return out
}

/** The label/value pairs the header strip prints, in a fixed order. */
export function statusCountCells(c: StatusCounts): { label: string; value: number }[] {
  return [
    { label: 'Total', value: c.total },
    { label: 'Published', value: c.published },
    { label: 'Scheduled', value: c.scheduled },
    { label: 'Drafts', value: c.draft },
  ]
}

export const DISTRIBUTION_MODE_TEXT: Record<'off' | 'prepare' | 'auto', string> = {
  off: 'Off: nothing is queued for social',
  prepare: 'Prepare: queued posts wait for your approval',
  auto: 'Auto: posts go out to social on their own',
}
