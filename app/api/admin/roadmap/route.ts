import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getRoadmap, createUseCase } from '@/lib/roadmap'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await getRoadmap())
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (title.length < 3 || title.length > 1000) {
      return NextResponse.json({ error: 'Title must be between 3 and 1000 characters' }, { status: 400 })
    }
    const usecase = await createUseCase({
      title,
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
      epic_id: typeof body.epic_id === 'string' && body.epic_id ? body.epic_id : null,
      feature_id: typeof body.feature_id === 'string' && body.feature_id ? body.feature_id : null,
      priority: ['P1', 'P2', 'P3'].includes(body.priority) ? body.priority : 'P2',
      status: 'backlog',
      source: 'admin',
    })
    return NextResponse.json({ usecase }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
