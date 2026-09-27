import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { saveBlurb, deleteBlurb } from '@/lib/destination-blurbs'

type Props = { params: { slug: string } }

// PUT { destination, blurb } - save or hand-edit a blurb. Always marked source=manual: this is
// the admin typing or editing text directly, as opposed to /generate below.
export async function PUT(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const destination = typeof body.destination === 'string' ? body.destination.trim() : ''
  const blurb = typeof body.blurb === 'string' ? body.blurb : ''
  if (!destination) return NextResponse.json({ error: 'Missing destination' }, { status: 400 })
  const result = await saveBlurb(params.slug, destination, blurb, 'manual')
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request, { params }: Props) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const result = await deleteBlurb(params.slug)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ ok: true })
}
