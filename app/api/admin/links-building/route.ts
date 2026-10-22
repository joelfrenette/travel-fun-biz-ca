import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/admin-body'
import { addEarned, applyTaskPatch, validateEarnedInput } from '@/lib/link-building'
import { buildLinksView, knownTaskIds, readEarned, readTaskState, writeEarned, writeTaskState } from '@/lib/links-building-data'

export const dynamic = 'force-dynamic'

// Link building workspace. Read-only except for the owner's own notes: task status and the "link earned" list.
// Nothing here sends a message, posts anywhere or calls an AI model.

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await buildLinksView(getSupabaseAdmin()))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// Body: { action: 'task', id, status?, note?, holds? } | { action: 'earned_add', page, source, date } | { action: 'earned_delete', id }
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: BAD_BODY_MESSAGE }, { status: 400 })
    const admin = getSupabaseAdmin()

    if (body.action === 'task') {
      const [state, known] = await Promise.all([readTaskState(admin), knownTaskIds(admin)])
      const result = applyTaskPatch(state, body.id, { status: body.status, note: body.note, holds: body.holds }, known, new Date().toISOString())
      if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
      const saved = await writeTaskState(admin, result.map)
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'earned_add') {
      const input = validateEarnedInput({ page: body.page, source: body.source, date: body.date })
      if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 })
      const added = addEarned(await readEarned(admin), input, `e-${randomUUID().slice(0, 8)}`)
      if ('error' in added) return NextResponse.json({ error: added.error }, { status: 400 })
      const saved = await writeEarned(admin, added.items)
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'earned_delete') {
      if (typeof body.id !== 'string') return NextResponse.json({ error: 'Unknown entry.' }, { status: 400 })
      const items = await readEarned(admin)
      const saved = await writeEarned(admin, items.filter((e) => e.id !== body.id))
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
