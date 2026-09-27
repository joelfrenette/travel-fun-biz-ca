import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { extractPackageDraft, fetchSourceText, draftToFormData, MAX_SOURCE_CHARS } from '@/lib/package-extract'

export const maxDuration = 150

// POST { text?: string, url?: string } -> a grounded DRAFT package (never saved here; the admin
// reviews it in the form and the normal create path stores it as status=draft). Admin-triggered
// only: this costs a real AI call each time.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: { text?: unknown; url?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined
  let text = typeof body.text === 'string' ? body.text : ''
  if (text.length > MAX_SOURCE_CHARS * 2) return NextResponse.json({ error: `Source is too long (limit ${MAX_SOURCE_CHARS.toLocaleString()} characters).` }, { status: 413 })

  let fetched = false
  if (!text.trim() && url) {
    const r = await fetchSourceText(url)
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: r.error.status })
    text = r.text
    fetched = true
  }
  if (!text.trim()) return NextResponse.json({ error: 'Paste some source material or give a link.' }, { status: 400 })

  const { draft, error } = await extractPackageDraft(text, url)
  if (error) return NextResponse.json({ error: error.message }, { status: error.status })

  return NextResponse.json({
    draft,
    formData: draftToFormData(draft),
    source: { chars: text.length, fetched, url: url ?? null },
  })
}
