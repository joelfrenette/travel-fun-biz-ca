import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isPexelsConfigured } from '@/lib/pexels'
import { attachAutoblogCoverImage } from '@/lib/blog-image'

// Manual counterpart to autoblog's automatic Pexels cover image (lib/blog-image.ts) - the admin
// editor's "Search Pexels" button, for a post autoblog didn't write or where the auto-picked
// photo (if any) isn't the one wanted.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isPexelsConfigured()) return NextResponse.json({ error: 'PEXELS_API_KEY is not set.' }, { status: 400 })
  try {
    const body = await request.json().catch(() => ({}))
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const slug = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : 'post'
    if (!query) return NextResponse.json({ error: 'query is required' }, { status: 400 })

    const result = await attachAutoblogCoverImage(getSupabaseAdmin(), query, slug)
    if (!result) return NextResponse.json({ error: `No Pexels photo found for "${query}".` }, { status: 404 })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
