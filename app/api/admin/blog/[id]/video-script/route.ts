import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getPostById } from '@/lib/posts'
import { generateVideoScript, capScriptDuration, estimatedSpokenSeconds, detectHookFormula } from '@/lib/video-script'
import { isAiConfigured } from '@/lib/ai-verify'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { tagVariant } from '@/lib/content-variants'

export const maxDuration = 60

/** Manual, admin-triggered only - generates a short-form video script from a real post's own
 * title/meta_description (never invents a destination or claim the post doesn't make). Does not
 * render anything or cost anything beyond the one Anthropic call; see /video-render for the
 * (unverified, see lib/shotstack.ts) Shotstack submission step. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAiConfigured()) return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set.' }, { status: 503 })
  try {
    const post = await getPostById(params.id)
    if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    const script = await generateVideoScript(post.title, post.meta_description || '')
    if (!script) return NextResponse.json({ error: 'Could not generate a script - try again.' }, { status: 502 })
    const capped = capScriptDuration(script)
    await tagVariant(getSupabaseAdmin(), post.slug, { hookFormula: detectHookFormula(capped.hook) ?? 'fallback' })
    return NextResponse.json({ script: capped, estimatedSeconds: Math.round(estimatedSpokenSeconds(capped)) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
