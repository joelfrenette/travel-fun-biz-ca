import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readGrowthDigest } from '@/lib/growth-digest-read'

export const maxDuration = 30

// "Growth this week": the same builder the daily brief email uses (lib/growth-digest.ts). Read only: no email, no AI call, no write.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const digest = await readGrowthDigest(getSupabaseAdmin())
    if (!digest) return NextResponse.json({ error: 'The digest could not be built' }, { status: 500 })
    return NextResponse.json(digest)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
