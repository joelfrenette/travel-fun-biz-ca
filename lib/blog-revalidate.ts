import { revalidatePath } from 'next/cache'

/** Drops the cached public pages for a post so a publish, unpublish, edit or delete shows up now instead of after the
 * 5 minute (blog) or 1 hour (sitemap, llms.txt) cache. Never throws: a cache miss must not fail the admin action. */
export function revalidateBlog(slugs: string[]): void {
  try {
    revalidatePath('/blog')
    for (const s of new Set(slugs)) if (s) revalidatePath(`/blog/${s}`)
    revalidatePath('/sitemap.xml')
    revalidatePath('/llms.txt')
  } catch (e) {
    console.error('[blog] revalidate failed:', e instanceof Error ? e.message : e)
  }
}
