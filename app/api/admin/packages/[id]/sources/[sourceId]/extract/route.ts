import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { ingestSourceForPackage } from '@/lib/package-ingest'
import { getSource, RECAP_LOG_NAME } from '@/lib/package-sources'

export const maxDuration = 300

// POST: read one source and fill what can be filled. This is the only place the AI runs for a source, and only
// when an admin presses the button. The work itself (the claim, the one extraction call, the copy and FAQ calls, the
// supplier photos, the illustrative cover, the money rule) lives in lib/package-ingest.ts so the agent submission
// pages run exactly the same thing.
export async function POST(request: Request, { params }: { params: { id: string; sourceId: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = getSupabaseAdmin()
  const source = await getSource(admin, params.id, params.sourceId)
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 })
  // A trip photo (WP14) is for the gallery, never read by the model; the recap change log is not a source either.
  if (source.kind === 'photo') return NextResponse.json({ error: 'A trip photo is not read by the AI.' }, { status: 400 })
  if (source.file_name === RECAP_LOG_NAME) return NextResponse.json({ error: 'That row is the recap change log, not a source to read.' }, { status: 400 })
  const result = await ingestSourceForPackage(admin, params.id, params.sourceId)
  return NextResponse.json(result.body, { status: result.status })
}
