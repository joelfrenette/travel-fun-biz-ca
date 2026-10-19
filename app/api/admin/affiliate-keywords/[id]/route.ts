import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readJsonObject } from '@/lib/admin-body'
import { deleteKeyword, updateKeyword } from '@/lib/affiliate-keyword-actions'

// WP22: turn one phrase ON or OFF, change it, or delete it. The whole site is refreshed after every change.

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await updateKeyword(getSupabaseAdmin(), params.id, await readJsonObject(request))
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await deleteKeyword(getSupabaseAdmin(), params.id)
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
