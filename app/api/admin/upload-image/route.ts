import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

const MAX_BYTES = 8 * 1024 * 1024 // 8MB
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }

// Generic admin image upload (blog cover images today; anything else that needs a real file
// picker later). Public bucket, admin-only write via the service role - never anonymous insert.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (!ALLOWED.has(file.type)) return NextResponse.json({ error: `Unsupported image type: ${file.type}` }, { status: 400 })
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Image is larger than 8MB' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${EXT[file.type]}`
    const storage = getSupabaseAdmin().storage.from('post-images')
    const { error } = await storage.upload(filename, buffer, { contentType: file.type })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const url = storage.getPublicUrl(filename).data.publicUrl
    return NextResponse.json({ url })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Upload failed' }, { status: 500 })
  }
}
