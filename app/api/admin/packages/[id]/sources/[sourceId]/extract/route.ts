import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { ingestSourceForPackage } from '@/lib/package-ingest'

export const maxDuration = 300

// POST: read one source and fill what can be filled. This is the only place the AI runs for a source, and only
// when an admin presses the button. The work itself (the claim, the one extraction call, the copy and FAQ calls, the
// supplier photos, the illustrative cover, the money rule) lives in lib/package-ingest.ts so the agent submission
// pages run exactly the same thing.
export async function POST(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const result = await ingestSourceForPackage(getSupabaseAdmin(), params.id, params.sourceId)
  return NextResponse.json(result.body, { status: result.status })
}
