import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { listTopicQueue, suggestTopics, queueIdeas, setTopicStatus } from '@/lib/blog-topics'
import { getAutoblogMode } from '@/lib/autoblog-run'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [topics, mode] = await Promise.all([listTopicQueue(admin), getAutoblogMode()])
    return NextResponse.json({ topics, mode })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    if (body.action === 'suggest') {
      const count = Math.min(Math.max(Number(body.count) || 3, 1), 10)
      const ideas = await suggestTopics(admin, { count })
      const { queued } = await queueIdeas(admin, ideas, 'suggested')
      return NextResponse.json({ suggested: ideas.length, queued })
    }

    if (body.action === 'approve_all') {
      const rows = (await listTopicQueue(admin)).filter((r) => r.status === 'suggested')
      await Promise.all(rows.map((r) => setTopicStatus(admin, r.id, 'approved')))
      return NextResponse.json({ approved: rows.length })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
