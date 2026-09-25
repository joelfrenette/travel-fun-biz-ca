import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { deleteKeyword, updateKeyword } from '@/lib/keywords'

function isAuthorized(request: Request): boolean {
  const token = request.headers.get('authorization')?.replace('Bearer ', '') || ''
  return !!validateToken(token)
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const patch: { target_path?: string | null; note?: string | null } = {}
    if ('target_path' in body) patch.target_path = typeof body.target_path === 'string' && body.target_path.trim() ? body.target_path.trim() : null
    if ('note' in body) patch.note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    return NextResponse.json({ keyword: await updateKeyword(params.id, patch) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    await deleteKeyword(params.id)
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
