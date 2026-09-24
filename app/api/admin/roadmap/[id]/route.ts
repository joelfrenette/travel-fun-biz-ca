import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { updateUseCase, deleteUseCase } from '@/lib/roadmap'

const PATCHABLE = ['status', 'priority', 'epic_id', 'feature_id', 'title', 'note'] as const

function isAuthorized(request: Request): boolean {
  const token = request.headers.get('authorization')?.replace('Bearer ', '') || ''
  return !!validateToken(token)
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const patch: Record<string, unknown> = {}
    for (const key of PATCHABLE) if (key in body) patch[key] = body[key]
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    return NextResponse.json({ usecase: await updateUseCase(params.id, patch) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    await deleteUseCase(params.id)
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
