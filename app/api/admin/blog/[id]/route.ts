import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { updatePost, deletePost } from '@/lib/posts'

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const post = await updatePost(params.id, body)
    return NextResponse.json({ post })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    return NextResponse.json({ error: message }, { status: /already exists|duplicate/i.test(message) ? 409 : 400 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    await deletePost(params.id)
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 400 })
  }
}
