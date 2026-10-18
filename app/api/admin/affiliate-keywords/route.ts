import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { MAX_RULES } from '@/lib/affiliate-linker'
import { KEYWORDS_MIGRATION_MESSAGE, isMissingKeywordsTable, normalizeKeywordInput, KEYWORD_COLUMNS, type KeywordRow } from '@/lib/affiliate-rules'
import { loadStoredReport } from '@/lib/affiliate-usage'
import { refreshAfterChange } from '@/lib/affiliate-refresh'

// WP22: the word-link rules. GET lists them (with the stored usage report); POST adds one.
// Every handler checks isAuthorized first. Writes answer 409 "Run migration 0050 first" while the table is missing.

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const res = await admin.from('affiliate_keywords').select(KEYWORD_COLUMNS).order('created_at').limit(1000)
    if (res.error) {
      if (isMissingKeywordsTable(res.error.message)) return NextResponse.json({ keywords: [], report: null, migrated: false })
      throw new Error(res.error.message)
    }
    return NextResponse.json({ keywords: res.data ?? [], report: await loadStoredReport(admin), migrated: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const parsed = normalizeKeywordInput(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const admin = getSupabaseAdmin()
    const existing = await admin.from('affiliate_keywords').select('id, phrase, link_id').limit(1000)
    if (existing.error) {
      if (isMissingKeywordsTable(existing.error.message)) return NextResponse.json({ error: KEYWORDS_MIGRATION_MESSAGE }, { status: 409 })
      throw new Error(existing.error.message)
    }
    const rows = (existing.data ?? []) as { id: string; phrase: string; link_id: string }[]
    if (rows.length >= MAX_RULES) return NextResponse.json({ error: `You can have at most ${MAX_RULES} linked phrases. Delete one first.` }, { status: 400 })
    const lower = parsed.value.phrase.toLowerCase()
    if (rows.some((r) => r.link_id === parsed.value.link_id && r.phrase.toLowerCase() === lower)) {
      return NextResponse.json({ error: 'That phrase is already linked to this link.' }, { status: 409 })
    }

    const link = await admin.from('affiliate_links').select('id').eq('id', parsed.value.link_id).maybeSingle()
    if (link.error) throw new Error(link.error.message)
    if (!link.data) return NextResponse.json({ error: 'That link no longer exists. Pick another one.' }, { status: 400 })

    const { data, error } = await admin.from('affiliate_keywords').insert({ ...parsed.value, status: 'on' }).select(KEYWORD_COLUMNS).single()
    if (error) {
      if (isMissingKeywordsTable(error.message)) return NextResponse.json({ error: KEYWORDS_MIGRATION_MESSAGE }, { status: 409 })
      if (/duplicate key|unique/i.test(error.message)) return NextResponse.json({ error: 'That phrase is already linked to this link.' }, { status: 409 })
      throw new Error(error.message)
    }
    const refreshed = await refreshAfterChange(admin)
    return NextResponse.json({ keyword: data as KeywordRow, refreshed }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
