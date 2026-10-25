import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { checkMigrationDrift } from '@/lib/migration-drift-check'
import { reportLines } from '@/lib/migration-drift'

export const dynamic = 'force-dynamic'

// GET  read only: which repo migrations have no applied row in supabase_migrations.schema_migrations. Never applies anything.
//      { read: false } when the applied list could not be read (never a false "clean").
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const report = await checkMigrationDrift(getSupabaseAdmin())
    if (!report) return NextResponse.json({ read: false, message: 'The applied migration list could not be read.' })
    return NextResponse.json({ read: true, ...report, lines: reportLines(report) })
  } catch {
    return NextResponse.json({ read: false, message: 'The applied migration list could not be read.' })
  }
}
