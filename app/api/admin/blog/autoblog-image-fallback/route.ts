import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getAutoblogAiImageFallback, setAutoblogAiImageFallback } from '@/lib/blog-image'
import { isImageAiConfigured } from '@/lib/image-ai-gen'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  return NextResponse.json({ on: await getAutoblogAiImageFallback(admin), configured: isImageAiConfigured() })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  if (typeof body.on !== 'boolean') return NextResponse.json({ error: 'on must be a boolean' }, { status: 400 })
  const admin = getSupabaseAdmin()
  if (body.on && !isImageAiConfigured()) {
    return NextResponse.json({ error: 'OPENAI_API_KEY is not set - add it in Vercel before turning this on.' }, { status: 400 })
  }
  const { error } = await setAutoblogAiImageFallback(admin, body.on)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ on: body.on })
}
