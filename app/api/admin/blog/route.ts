import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { listPostsAdmin, createPost } from '@/lib/posts'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { enrollIfDue } from '@/lib/distribution'
import { pingIndexNow } from '@/lib/indexnow'
import { loadPostMeta } from '@/lib/blog-admin-meta'
import { qualityBlockers } from '@/lib/blog-quality'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const posts = await listPostsAdmin()
    // Extra facts for the list's filters and Source column; a failure here never blocks the list.
    const { meta, problems } = await loadPostMeta(getSupabaseAdmin(), posts).catch((e) => ({ meta: {}, problems: [e instanceof Error ? e.message : 'could not load post details'] }))
    return NextResponse.json({ posts, meta, metaProblems: problems })
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
    // A hand-written post is not blocked (it is a person's call), but it skips the writer's prompt and gates, which is how posts with no
    // content style, keyword, Quick answer or contact link got live. The same gate is run here and its findings are returned as warnings;
    // the weekly refresh (lib/blog-reheal.ts) then picks the post up if it is still below the bar.
    let qualityWarnings: string[] = []
    try {
      qualityWarnings = qualityBlockers(
        { title: post.title, body: post.body, faq: post.faq ?? [], primary_keyword: post.primary_keyword ?? '', content_style: post.content_style ?? '', seo_title: post.meta_title ?? '', seo_description: post.meta_description ?? '', og_title: post.og_title ?? '', og_description: post.og_description ?? '', key_takeaways: post.key_takeaways ?? [] },
        { now: new Date(), groundingText: '' },
      )
    } catch {
      qualityWarnings = []
    }
    return NextResponse.json({ post, qualityWarnings })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    return NextResponse.json({ error: message }, { status: /already exists|duplicate/i.test(message) ? 409 : 400 })
  }
}
