import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getAutoblogPostsPerWeek, setAutoblogPostsPerWeek } from '@/lib/autoblog-cadence'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ postsPerWeek: await getAutoblogPostsPerWeek(getSupabaseAdmin()) })
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const { error } = await setAutoblogPostsPerWeek(getSupabaseAdmin(), Number(body.postsPerWeek))
  if (error) return NextResponse.json({ error }, { status: 400 })
  return NextResponse.json({ postsPerWeek: Number(body.postsPerWeek) })
}
