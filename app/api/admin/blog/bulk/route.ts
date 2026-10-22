import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getPostById, updatePost, deletePost } from '@/lib/posts'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { enrollIfDue } from '@/lib/distribution'
import { pingIndexNow } from '@/lib/indexnow'
import { revalidateBlog } from '@/lib/blog-revalidate'
import { parseBulkRequest, statusPatch, usesGenericEnrol } from '@/lib/blog-admin-filters'

export const maxDuration = 60

export interface BulkResult {
  id: string
  ok: boolean
  /** What happened, in plain words (also set for a skipped or failed id). */
  note: string
}

// One authorized call for a bulk Publish / Unpublish / Delete. Each id is handled on its own and gets its own result,
// so one failure never hides the others and nothing is deleted silently: the response lists every id.
// Unpublish only sets the post back to draft (the public blog and sitemap read status = published); nothing is removed.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = parseBulkRequest(await request.json().catch(() => null))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const admin = getSupabaseAdmin()
  const results: BulkResult[] = []
  const pingPaths: string[] = []
  const touched: string[] = []
  for (const id of parsed.ids) {
    try {
      const post = await getPostById(id)
      if (!post) {
        results.push({ id, ok: false, note: 'not found' })
        continue
      }
      if (parsed.action === 'delete') {
        await deletePost(id)
        touched.push(post.slug)
        results.push({ id, ok: true, note: `deleted "${post.title}"` })
      } else if (parsed.action === 'unpublish') {
        if (post.status === 'draft') {
          results.push({ id, ok: true, note: 'already a draft' })
          continue
        }
        await updatePost(id, statusPatch('unpublish', post, new Date().toISOString()))
        touched.push(post.slug)
        results.push({ id, ok: true, note: 'set to draft' })
      } else {
        if (post.status === 'published') {
          results.push({ id, ok: true, note: 'already published' })
          continue
        }
        const updated = await updatePost(id, statusPatch('publish', post, new Date().toISOString()))
        // Same follow-ups as the single-post save route; neither may fail the publish.
        if (usesGenericEnrol(updated)) await enrollIfDue(admin, updated.slug, updated.title).catch(() => undefined)
        touched.push(updated.slug)
        pingPaths.push(`/blog/${updated.slug}`)
        results.push({ id, ok: true, note: 'published' })
      }
    } catch (e) {
      results.push({ id, ok: false, note: e instanceof Error ? e.message : 'failed' })
    }
  }
  revalidateBlog(touched)
  if (pingPaths.length > 0) await Promise.resolve(pingIndexNow([...pingPaths, '/blog'])).catch(() => undefined)
  return NextResponse.json({ action: parsed.action, results, okCount: results.filter((r) => r.ok).length, failCount: results.filter((r) => !r.ok).length })
}
