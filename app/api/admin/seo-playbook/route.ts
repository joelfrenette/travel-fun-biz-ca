import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/admin-body'
import { PLAYBOOK } from '@/lib/seo-playbook'
import { addTip, applyTick, readCustom, readTicks, writeCustom, writeTicks } from '@/lib/seo-playbook-store'
import { loadView } from '@/lib/seo-playbook-view'

export const dynamic = 'force-dynamic'

// SEO and GEO Manager. GET is read-only. POST only saves the owner's own ticks, notes and pasted tips.
// Nothing here calls an AI model, sends a message or changes the live site.

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await loadView(getSupabaseAdmin()))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// Body: { action: 'tick', id, done?, note? } | { action: 'tip_add', title, category, sourceName, text, link?, impact? } | { action: 'tip_delete', id }
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await readJsonObject(request)
    if (!body) return NextResponse.json({ error: BAD_BODY_MESSAGE }, { status: 400 })
    const admin = getSupabaseAdmin()
    const nowIso = new Date().toISOString()

    if (body.action === 'tick') {
      const [ticks, custom] = await Promise.all([readTicks(admin), readCustom(admin)])
      const known = new Set<string>([...PLAYBOOK.map((p) => p.id), ...custom.map((c) => c.id)])
      const result = applyTick(ticks, body.id, { done: body.done, note: body.note }, known, nowIso)
      if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
      const saved = await writeTicks(admin, result.map)
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'tip_add') {
      const added = addTip(await readCustom(admin), { title: body.title, category: body.category, sourceName: body.sourceName, text: body.text, link: body.link, impact: body.impact }, `tip-${randomUUID().slice(0, 8)}`, nowIso)
      if ('error' in added) return NextResponse.json({ error: added.error }, { status: 400 })
      const saved = await writeCustom(admin, added.tips)
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'tip_delete') {
      if (typeof body.id !== 'string') return NextResponse.json({ error: 'Unknown tip.' }, { status: 400 })
      const tips = await readCustom(admin)
      if (!tips.some((t) => t.id === body.id)) return NextResponse.json({ error: 'Unknown tip.' }, { status: 400 })
      const saved = await writeCustom(admin, tips.filter((t) => t.id !== body.id))
      if (saved.error) return NextResponse.json({ error: saved.error }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
