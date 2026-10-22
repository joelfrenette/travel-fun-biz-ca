// Pure helpers shared by every "Posts: ..." admin page (Blog, News, and later Guides and Trips).
import { countWithoutGoodCover } from '@/lib/image-quality'

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

/** "Posts without a good cover" for the Posts: Blog header: published posts (not drafts, not scheduled) whose cover fails the image
 * quality gate (lib/image-quality.ts). A repeated picture counts only on the later post. `today` is a YYYY-MM-DD string. */
export function countPostsWithoutGoodCover(
  posts: { status: string; publish_date: string | null; created_at?: string | null; cover_image_url?: string | null; alt_text?: string | null }[],
  today: string,
): number {
  const live = posts.filter((p) => p.status === 'published' && !(p.publish_date && p.publish_date.slice(0, 10) > today))
  return countWithoutGoodCover(live.map((p) => ({ url: p.cover_image_url, alt: p.alt_text, date: p.publish_date ?? p.created_at ?? null })))
}

export const DISTRIBUTION_MODE_TEXT: Record<'off' | 'prepare' | 'auto', string> = {
  off: 'Off: nothing is queued for social',
  prepare: 'Prepare: queued posts wait for your approval',
  auto: 'Auto: posts go out to social on their own',
}
