import { NextResponse } from 'next/server'
import { isHoneypotFilled, allowRequest } from '@/lib/abuse-guard'
import { resolveProfileLink, submitSelfService } from '@/lib/agents-store'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

// PUBLIC route behind an agent's own profile link. The token is validated first (format, hash, expiry, revoked). The agent
// only ever sees their OWN profile text fields: never email, phone, notes, achievements or any amount. What they send waits as
// PENDING until an admin approves it; nothing here changes the live profile or publishes anything.
//   GET                      their current fields
//   POST {…fields}           JSON: bio, headline, specialties, certifications, years_experience, languages, video_urls, consents
//   POST multipart (file)    a profile photo (JPEG / PNG / WebP, 3 MB), returned as a URL to include in the next JSON save

const MAX_PHOTO = 3 * 1024 * 1024

function sniff(b: Buffer): { ext: string; type: string } | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' }
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' }
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', type: 'image/webp' }
  return null
}

export async function GET(request: Request, { params }: { params: { token: string } }) {
  if (!(await allowRequest(request, 'agent-profile-get', 30, 600))) return NextResponse.json({ error: 'Too many requests. Please wait a little.' }, { status: 429 })
  const r = await resolveProfileLink(params.token)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  // The drop-down of trips the agent can pick from: published packages only, name and slug.
  const { data: pk } = await getSupabaseAdmin().from('travel_packages').select('slug, name').eq('status', 'published').order('name', { ascending: true }).limit(300)
  return NextResponse.json({ agent: r.ctx.agent, packages: pk ?? [] })
}

export async function POST(request: Request, { params }: { params: { token: string } }) {
  if (!(await allowRequest(request, 'agent-profile-post', 12, 600))) return NextResponse.json({ error: 'Too many requests. Please wait a little.' }, { status: 429 })
  const r = await resolveProfileLink(params.token)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })

  if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a photo first.' }, { status: 400 })
    if (file.size > MAX_PHOTO) return NextResponse.json({ error: 'That photo is over 3 MB. Please choose a smaller one.' }, { status: 400 })
    const bytes = Buffer.from(await file.arrayBuffer())
    const kind = sniff(bytes)
    if (!kind) return NextResponse.json({ error: 'Please choose a JPEG, PNG or WebP photo.' }, { status: 400 })
    const storage = getSupabaseAdmin().storage.from('post-images')
    // An unguessable name under agents/pending/. It only becomes the profile photo if an admin approves the submission.
    const name = `agents/pending/${r.ctx.agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${kind.ext}`
    const up = await storage.upload(name, bytes, { contentType: kind.type })
    if (up.error) return NextResponse.json({ error: 'The photo could not be saved. Please try again.' }, { status: 500 })
    return NextResponse.json({ url: storage.getPublicUrl(name).data.publicUrl })
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (isHoneypotFilled(body)) return NextResponse.json({ ok: true })
  const s = await submitSelfService(r.ctx, body)
  return s.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: s.errors.join(' ') }, { status: 400 })
}
