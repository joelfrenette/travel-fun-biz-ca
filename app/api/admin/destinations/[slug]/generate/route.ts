import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { generateBlurb, saveBlurb } from '@/lib/destination-blurbs'

export const maxDuration = 60

// POST { destination } - AI-writes a general (non-numeric, no visa/date claims - see
// lib/destination-blurbs.ts's BLURB_PROMPT) blurb about the destination and saves it as
// source=ai. Never overwrites a manual edit without the admin explicitly clicking generate
// again - this route always runs on request, it doesn't run itself.
export async function POST(request: Request, { params }: { params: { slug: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const destination = typeof body.destination === 'string' ? body.destination.trim() : ''
  if (!destination) return NextResponse.json({ error: 'Missing destination' }, { status: 400 })

  const result = await generateBlurb(destination)
  if (result.error !== null) return NextResponse.json({ error: result.error }, { status: 502 })
  const blurb: string = result.blurb

  const saved = await saveBlurb(params.slug, destination, blurb, 'ai')
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 500 })
  return NextResponse.json({ blurb })
}
