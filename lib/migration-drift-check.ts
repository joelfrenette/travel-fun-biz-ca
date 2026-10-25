// The read-only migration check the System check uses. Compares the committed list (lib/migrations-manifest.ts) with the rows in
// supabase_migrations.schema_migrations, read through the service role. It only ever SELECTS; it never applies anything.
// Anything it cannot read (schema not exposed to the API, no rows table, network error) returns null, which the System check
// shows as "could not be read" (amber), never as green.

import type { SupabaseClient } from '@supabase/supabase-js'
import { compareMigrations, parseApplied, parseMigrationFiles, toFact, type DriftReport, type MigrationFact } from '@/lib/migration-drift'
import { MIGRATIONS_MANIFEST } from '@/lib/migrations-manifest'

/** Reads the applied rows. null = could not be read. An empty array means the table is readable but has no rows. */
export async function readAppliedMigrations(admin: SupabaseClient) {
  try {
    // The `supabase_migrations` schema is not exposed to the API on a default project; then this errors and we report "unread".
    const res = await admin.schema('supabase_migrations').from('schema_migrations').select('version,name')
    if (res.error || !Array.isArray(res.data)) return null
    return parseApplied(res.data)
  } catch {
    return null
  }
}

/** The full report, or null when the applied list could not be read. */
export async function checkMigrationDrift(admin: SupabaseClient): Promise<DriftReport | null> {
  const applied = await readAppliedMigrations(admin)
  if (!applied) return null
  const { migrations, badFiles } = parseMigrationFiles(MIGRATIONS_MANIFEST)
  return compareMigrations(migrations, applied, badFiles)
}

/** What the System check stage reads. null = could not be read. */
export async function readMigrationDrift(admin: SupabaseClient): Promise<MigrationFact | null> {
  const report = await checkMigrationDrift(admin)
  return report ? toFact(report) : null
}
