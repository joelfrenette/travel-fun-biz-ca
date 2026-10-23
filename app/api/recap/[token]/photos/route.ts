import { NextResponse } from 'next/server'
import { isHoneypotFilled } from '@/lib/abuse-guard'
import { allowSubmit, recapGate } from '@/lib/recap-gate'
import { createShareUpload, notifyRecapSubmission, registerSharePhoto } from '@/lib/recap-store'
import { getPackageById } from '@/lib/packages'
import { PHOTOS_MAX, validatePhotoClaim } from '@/lib/recap-studio'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// PUBLIC route behind an AGENT recap link: photos go straight from the phone to the private bucket (a request here is limited to
// about 4.5 MB, and phone photos are bigger), so it is two steps.
//   POST {action:'upload-url', name, size}   checks the claim (type by name, 12 MB, 20 in all) and returns a one-time upload link
//   POST {action:'register', path, name}     checks the stored file by its real bytes, strips GPS and other metadata when sharp can read
//                                            it, and records it as a PENDING photo. A file that fails is deleted.
export async function POST(request: Request, { params }: { params: { token: string } }) {
  const g = await recapGate(request, params.token)
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status })
  if (g.share.kind !== 'agent') return NextResponse.json({ error: 'This link is for a short quote only.' }, { status: 403 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  if (isHoneypotFilled(body)) return NextResponse.json({ ok: true })
  if (!(await allowSubmit(params.token))) return NextResponse.json({ error: 'That is a lot of photos in a short time. Please wait a little and try again.' }, { status: 429 })

  if (body.action === 'upload-url') {
    const { count } = await g.admin.from('recap_submissions').select('id', { count: 'exact', head: true }).eq('share_id', g.share.id).eq('kind', 'photo')
    const v = validatePhotoClaim({ name: body.name, size: body.size }, count ?? 0)
    if (!v.ok) return NextResponse.json({ error: v.errors[0] }, { status: 400 })
    const r = await createShareUpload(g.admin, g.share.package_id)
    return r.ok ? NextResponse.json(r.value) : NextResponse.json({ error: r.error }, { status: r.status })
  }
  if (body.action === 'register' && typeof body.path === 'string') {
    const r = await registerSharePhoto(g.admin, g.share, body.path, typeof body.name === 'string' ? body.name : '')
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    const pkg = await getPackageById(g.share.package_id)
    if (pkg) await notifyRecapSubmission(g.admin, g.share.id, pkg.id, pkg.name, { answers: 0, quotes: 0, photos: 1 }).catch(() => null)
    return NextResponse.json({ ok: true, max: PHOTOS_MAX })
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
