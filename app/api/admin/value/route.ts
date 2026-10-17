import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { buildValueReport, cleanInputsPatch } from '@/lib/value'
import { collectValueData } from '@/lib/value-data'

export const maxDuration = 60

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const data = await collectValueData(getSupabaseAdmin())
    return NextResponse.json({ report: buildValueReport(data), inputs: data.inputs })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

/** Save the manual inputs form. Only known keys are written; a blank value clears the input. */
export async function PUT(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const rows = cleanInputsPatch(await request.json().catch(() => null), new Date().toISOString().slice(0, 10))
    if (!rows.length) return NextResponse.json({ error: 'Nothing to save' }, { status: 400 })
    const { error } = await getSupabaseAdmin().from('value_inputs').upsert(rows, { onConflict: 'key' })
    if (error) throw new Error(/value_inputs/.test(error.message) ? 'Migration 0045 is not applied yet, so inputs cannot be saved.' : error.message)
    return NextResponse.json({ saved: rows.length })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
