import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readJsonObject } from '@/lib/admin-body'
import { previewKeyword } from '@/lib/affiliate-keyword-actions'

// WP22: "Preview" for the Link a word tool. Read only: runs the finder over the published content and reports where
// the phrase would be linked. Nothing is saved, and no AI or outside service is called.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await previewKeyword(getSupabaseAdmin(), await readJsonObject(request))
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
