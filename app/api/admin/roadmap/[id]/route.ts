import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { updateUseCase, deleteUseCase } from '@/lib/roadmap'
import type { RoadmapUseCase } from '@/types/roadmap'

const STATUSES = ['backlog', 'in_progress', 'done']
const PRIORITIES = ['P1', 'P2', 'P3']

function buildPatch(body: unknown): { patch: Partial<RoadmapUseCase>; error?: string } {
  if (!body || typeof body !== 'object') return { patch: {}, error: 'Body must be a JSON object' }
  const b = body as Record<string, unknown>
  const patch: Partial<RoadmapUseCase> = {}

  if ('status' in b) {
    if (!STATUSES.includes(String(b.status))) return { patch, error: `status must be one of ${STATUSES.join(', ')}` }
    patch.status = b.status as RoadmapUseCase['status']
  }
  if ('priority' in b) {
    if (!PRIORITIES.includes(String(b.priority))) return { patch, error: `priority must be one of ${PRIORITIES.join(', ')}` }
    patch.priority = b.priority as RoadmapUseCase['priority']
  }
  if ('title' in b) {
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (title.length < 3 || title.length > 1000) return { patch, error: 'title must be between 3 and 1000 characters' }
    patch.title = title
  }
  if ('note' in b) patch.note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null
  if ('epic_id' in b) patch.epic_id = typeof b.epic_id === 'string' && b.epic_id ? b.epic_id : null
  if ('feature_id' in b) patch.feature_id = typeof b.feature_id === 'string' && b.feature_id ? b.feature_id : null

  return { patch }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { patch, error } = buildPatch(await request.json().catch(() => null))
    if (error) return NextResponse.json({ error }, { status: 400 })
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
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
