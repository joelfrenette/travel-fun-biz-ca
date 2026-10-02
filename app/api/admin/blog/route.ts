import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { listPostsAdmin, createPost } from '@/lib/posts'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { enrollIfDue } from '@/lib/distribution'
import { pingIndexNow } from '@/lib/indexnow'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ posts: await listPostsAdmin() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const post = await createPost(body)
    if (post.status === 'published') {
      await enrollIfDue(getSupabaseAdmin(), post.slug, post.title)
      // Tell Bing a new public blog page appeared. Never blocks or fails the save above.
      await pingIndexNow([`/blog/${post.slug}`, '/blog', '/'])
    }
    return NextResponse.json({ post })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    return NextResponse.json({ error: message }, { status: /already exists|duplicate/i.test(message) ? 409 : 400 })
  }
}
