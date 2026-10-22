import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { updatePost, deletePost, getPostById } from '@/lib/posts'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { enrollIfDue } from '@/lib/distribution'
import { pingIndexNow } from '@/lib/indexnow'
import { revalidateBlog } from '@/lib/blog-revalidate'
import { usesGenericEnrol } from '@/lib/blog-admin-filters'

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const before = await getPostById(params.id).catch(() => null)
    const post = await updatePost(params.id, body)
    revalidateBlog([post.slug, ...(before && before.slug !== post.slug ? [before.slug] : [])])
    if (post.status === 'published') {
      if (usesGenericEnrol(post)) await enrollIfDue(getSupabaseAdmin(), post.slug, post.title)
      // Tell Bing the page is new or changed. Never blocks or fails the save above.
      await pingIndexNow([`/blog/${post.slug}`, '/blog'])
    }
    return NextResponse.json({ post })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    return NextResponse.json({ error: message }, { status: /already exists|duplicate/i.test(message) ? 409 : 400 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const before = await getPostById(params.id).catch(() => null)
    await deletePost(params.id)
    revalidateBlog(before ? [before.slug] : [])
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 400 })
  }
}
