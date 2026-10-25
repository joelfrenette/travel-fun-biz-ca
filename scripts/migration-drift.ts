// Migration drift CLI. Compares supabase/migrations/*.sql with the migrations the live database says it has applied.
// READ ONLY: it lists, it never applies. The comparison rules are the pure core in lib/migration-drift.ts.
//
//   pnpm dlx tsx scripts/migration-drift.ts                      folder checks only (duplicates, bad names), no network
//   pnpm dlx tsx scripts/migration-drift.ts --applied rows.json  compare with a saved list: [{"version":"0057","name":"x"}, ...]
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... pnpm dlx tsx scripts/migration-drift.ts
//                                                                 also asks the Supabase Management API (one SELECT) for the applied rows
//
// Exit code: 1 only for a repo problem (duplicate number, badly named file). Unapplied migrations are reported but exit 0, because
// this tool is a window, not a gate. If GITHUB_STEP_SUMMARY is set, a markdown summary is appended to it (CI job summary).

import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareMigrations, parseApplied, parseMigrationFiles, reportLines, type AppliedMigration } from '../lib/migration-drift'

const DIR = join(process.cwd(), 'supabase', 'migrations')

async function fetchApplied(token: string, ref: string): Promise<AppliedMigration[] | null> {
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'select version, name from supabase_migrations.schema_migrations order by version' }),
    })
    if (!res.ok) return null
    const rows = (await res.json()) as unknown
    return Array.isArray(rows) ? parseApplied(rows) : null
  } catch {
    return null
  }
}

async function main() {
  const { migrations, badFiles } = parseMigrationFiles(readdirSync(DIR))
  const argv = process.argv.slice(2)
  const fileIdx = argv.indexOf('--applied')
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const ref = process.env.SUPABASE_PROJECT_REF

  let applied: AppliedMigration[] | null = null
  let source = 'none'
  if (fileIdx >= 0 && argv[fileIdx + 1]) {
    applied = parseApplied(JSON.parse(readFileSync(argv[fileIdx + 1], 'utf8')))
    source = argv[fileIdx + 1]
  } else if (token && ref) {
    applied = await fetchApplied(token, ref)
    source = applied ? 'Supabase Management API (read only)' : 'Supabase Management API (could not be read)'
  }

  const out: string[] = ['## Migration drift', '']
  let code = 0
  if (!applied) {
    const why = token && ref ? 'The applied list could not be read, so unapplied migrations are unknown.' : 'Skipped the live comparison: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are not both set.'
    const folderOnly = compareMigrations(migrations, migrations.map((m) => ({ version: m.number, name: m.slug })), badFiles)
    out.push(`${migrations.length} repo migrations, latest ${migrations.at(-1)?.number ?? 'none'}. ${why}`)
    if (folderOnly.duplicateNumbers.length) out.push(`- Duplicate numbers: ${folderOnly.duplicateNumbers.join(', ')}`)
    if (folderOnly.badFiles.length) out.push(`- Badly named files: ${folderOnly.badFiles.join(', ')}`)
    if (folderOnly.duplicateNumbers.length || folderOnly.badFiles.length) code = 1
  } else {
    const report = compareMigrations(migrations, applied, badFiles)
    out.push(`Source of the applied list: ${source}`, '', ...reportLines(report).map((l) => `- ${l}`))
    if (report.unapplied.length) out.push('', `To apply: open the System check page and apply migration ${report.unapplied[0].number} (nothing is applied automatically).`)
    if (report.duplicateNumbers.length || report.badFiles.length) code = 1
  }
  const text = out.join('\n')
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
  process.exit(code)
}

main()
