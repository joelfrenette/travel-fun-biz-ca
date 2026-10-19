import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { readJsonObject } from '@/lib/admin-body'
import { createKeyword, listKeywords } from '@/lib/affiliate-keyword-actions'

// WP22: the word-link rules. GET lists them (with the stored usage report); POST adds one. The logic is in
// lib/affiliate-keyword-actions.ts. Every handler checks isAuthorized first; writes answer 409 "Run migration 0050 first"
// while the table is missing.

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await listKeywords(getSupabaseAdmin())
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await createKeyword(getSupabaseAdmin(), await readJsonObject(request))
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
