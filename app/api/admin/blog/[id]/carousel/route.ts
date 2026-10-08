import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPostById } from '@/lib/posts'
import { generateAndSaveCarousel, carouselKey } from '@/lib/carousel'
import { getSetting } from '@/lib/app-settings'
import { isAiConfigured } from '@/lib/ai-verify'

export const maxDuration = 60

export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const post = await getPostById(params.id)
  if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })
  const raw = await getSetting(getSupabaseAdmin(), carouselKey(post.slug))
  const slides = raw ? JSON.parse(raw) : null
  return NextResponse.json({ slides, slug: post.slug })
}

/** Generates (or regenerates) a carousel for this post and saves it. Does not post anything -
 * that's a separate, explicit admin action (/api/admin/distribution carousel posting is not
 * built here; the admin posts the generated image URLs manually for v1, same "a person still has
 * to press post on the carousel specifically" rule the spec itself calls for). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAiConfigured()) return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set.' }, { status: 503 })
  try {
    const post = await getPostById(params.id)
    if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    const slides = await generateAndSaveCarousel(getSupabaseAdmin(), post)
    if (!slides) return NextResponse.json({ error: 'Could not generate a grounded carousel - the draft may have mentioned a number not in the post. Try again.' }, { status: 502 })
    return NextResponse.json({ slides, slug: post.slug })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
