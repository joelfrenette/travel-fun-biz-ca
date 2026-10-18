import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { KEYWORDS_MIGRATION_MESSAGE, isMissingKeywordsTable, normalizeKeywordInput, KEYWORD_COLUMNS } from '@/lib/affiliate-rules'
import { refreshAfterChange } from '@/lib/affiliate-refresh'

// WP22: turn one phrase ON or OFF, change it, or delete it. The whole site is refreshed after every change.

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const admin = getSupabaseAdmin()
    const cur = await admin.from('affiliate_keywords').select(KEYWORD_COLUMNS).eq('id', params.id).maybeSingle()
    if (cur.error) {
      if (isMissingKeywordsTable(cur.error.message)) return NextResponse.json({ error: KEYWORDS_MIGRATION_MESSAGE }, { status: 409 })
      throw new Error(cur.error.message)
    }
    if (!cur.data) return NextResponse.json({ error: 'That phrase no longer exists.' }, { status: 404 })
    const current = cur.data as unknown as { phrase: string; link_id: string; scope: string; max_per_page: number; status: string }

    const patch: Record<string, unknown> = {}
    if ('status' in body) {
      if (body.status !== 'on' && body.status !== 'off') return NextResponse.json({ error: 'Status must be on or off.' }, { status: 400 })
      patch.status = body.status
    }
    if ('phrase' in body || 'scope' in body || 'max_per_page' in body || 'link_id' in body) {
      const parsed = normalizeKeywordInput({ phrase: current.phrase, link_id: current.link_id, scope: current.scope, max_per_page: current.max_per_page, ...body })
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
      Object.assign(patch, parsed.value)
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

    const { data, error } = await admin.from('affiliate_keywords').update(patch).eq('id', params.id).select(KEYWORD_COLUMNS).single()
    if (error) {
      if (isMissingKeywordsTable(error.message)) return NextResponse.json({ error: KEYWORDS_MIGRATION_MESSAGE }, { status: 409 })
      if (/duplicate key|unique/i.test(error.message)) return NextResponse.json({ error: 'That phrase is already linked to this link.' }, { status: 409 })
      throw new Error(error.message)
    }
    const refreshed = await refreshAfterChange(admin)
    return NextResponse.json({ keyword: data, refreshed })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const { error } = await admin.from('affiliate_keywords').delete().eq('id', params.id)
    if (error) {
      if (isMissingKeywordsTable(error.message)) return NextResponse.json({ error: KEYWORDS_MIGRATION_MESSAGE }, { status: 409 })
      throw new Error(error.message)
    }
    const refreshed = await refreshAfterChange(admin)
    return NextResponse.json({ ok: true, refreshed })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
