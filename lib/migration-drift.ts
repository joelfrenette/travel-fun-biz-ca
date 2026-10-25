// Migration drift, pure part. No database, no network, no file reads: lists go in, a report comes out, so
// scripts/check-migration-drift.ts tests every rule offline. IO lives in scripts/migration-drift.ts (the CLI, reads the folder) and
// lib/migration-drift-check.ts (the admin check, reads supabase_migrations.schema_migrations). Nothing here ever applies anything.
//
// A repo migration is a file named NNNN_slug.sql (four digit number). An applied migration is a row of
// supabase_migrations.schema_migrations ({version, name}). Migrations pasted by hand into the SQL editor leave no row there, so
// "unapplied" means "no row proves it", which is the safe direction (the stage goes amber, never a false green).

export interface RepoMigration {
  /** Four digits, e.g. "0057". */
  number: string
  slug: string
  file: string
}

export interface AppliedMigration {
  /** The stored version: "0057" for CLI-style rows, a timestamp like "20261024120000" for dashboard or MCP rows. */
  version: string
  /** The stored name, e.g. "agents_office_role" (may be empty). */
  name: string
}

export interface DriftReport {
  repoCount: number
  appliedCount: number
  /** Repo migrations no applied row matches, in number order. */
  unapplied: RepoMigration[]
  /** Unapplied migrations numbered BELOW a migration that is applied: they would run out of order. */
  outOfOrder: RepoMigration[]
  /** Numbers that more than one repo file uses. */
  duplicateNumbers: string[]
  /** Applied rows no repo file matches (e.g. applied from another branch). */
  unknownApplied: AppliedMigration[]
  /** File names that do not look like NNNN_slug.sql. */
  badFiles: string[]
  /** True when no applied row was given at all (history missing or empty): every migration then shows unapplied. */
  historyEmpty: boolean
  /** True when nothing needs a person. */
  clean: boolean
}

const FILE_RE = /^(\d{4})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/

/** Parses a folder listing. Non-.sql names (a README, .gitkeep) are ignored; a .sql name without the NNNN_ pattern is reported. */
export function parseMigrationFiles(names: readonly string[]): { migrations: RepoMigration[]; badFiles: string[] } {
  const migrations: RepoMigration[] = []
  const badFiles: string[] = []
  for (const file of names) {
    if (!file.toLowerCase().endsWith('.sql')) continue
    const m = FILE_RE.exec(file)
    if (!m) {
      badFiles.push(file)
      continue
    }
    migrations.push({ number: m[1], slug: m[2], file })
  }
  migrations.sort((a, b) => a.number.localeCompare(b.number) || a.file.localeCompare(b.file))
  return { migrations, badFiles }
}

/** Keeps only well formed rows. Anything else is dropped (never guessed). */
export function parseApplied(rows: unknown): AppliedMigration[] {
  if (!Array.isArray(rows)) return []
  const out: AppliedMigration[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const v = (r as Record<string, unknown>).version
    const n = (r as Record<string, unknown>).name
    if (typeof v !== 'string' && typeof v !== 'number') continue
    out.push({ version: String(v), name: typeof n === 'string' ? n : '' })
  }
  return out
}

/** True when an applied row stands for this repo migration: same number as the version, or the same slug as the name
 * (dashboard and MCP applies store a timestamp version but keep the name). */
export function matches(m: RepoMigration, a: AppliedMigration): boolean {
  if (a.version === m.number) return true
  if (a.version.startsWith(`${m.number}_`)) return true
  const name = a.name.replace(/\.sql$/i, '')
  return name !== '' && (name === m.slug || name === `${m.number}_${m.slug}`)
}

export function compareMigrations(repo: readonly RepoMigration[], applied: readonly AppliedMigration[], badFiles: readonly string[] = []): DriftReport {
  const unapplied = repo.filter((m) => !applied.some((a) => matches(m, a)))
  const appliedNumbers = repo.filter((m) => !unapplied.includes(m)).map((m) => m.number)
  const highestApplied = appliedNumbers.reduce((hi, n) => (n > hi ? n : hi), '')
  const outOfOrder = unapplied.filter((m) => highestApplied !== '' && m.number < highestApplied)

  const seen = new Map<string, number>()
  for (const m of repo) seen.set(m.number, (seen.get(m.number) ?? 0) + 1)
  const duplicateNumbers = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort()

  const unknownApplied = applied.filter((a) => !repo.some((m) => matches(m, a)))
  const historyEmpty = applied.length === 0
  return {
    repoCount: repo.length,
    appliedCount: applied.length,
    unapplied,
    outOfOrder,
    duplicateNumbers,
    unknownApplied,
    badFiles: [...badFiles],
    historyEmpty,
    clean: unapplied.length === 0 && duplicateNumbers.length === 0 && badFiles.length === 0 && !historyEmpty,
  }
}

/** What the System check stage reads. null on the CheckFacts side means "could not be read" (never a green). */
export interface MigrationFact {
  repoCount: number
  /** Unapplied migration numbers, in order, e.g. ["0058", "0059"]. */
  unapplied: string[]
  outOfOrder: string[]
  duplicateNumbers: string[]
  historyEmpty: boolean
}

export function toFact(r: DriftReport): MigrationFact {
  return {
    repoCount: r.repoCount,
    unapplied: r.unapplied.map((m) => m.number),
    outOfOrder: r.outOfOrder.map((m) => m.number),
    duplicateNumbers: r.duplicateNumbers,
    historyEmpty: r.historyEmpty,
  }
}

/** Plain text lines for the CLI and the CI job summary. */
export function reportLines(r: DriftReport): string[] {
  const lines = [`Repo migrations: ${r.repoCount}. Applied rows: ${r.appliedCount}.`]
  if (r.historyEmpty) lines.push('No applied history was found, so nothing can be proven applied.')
  if (r.unapplied.length) lines.push(`Not applied (${r.unapplied.length}): ${r.unapplied.map((m) => m.file).join(', ')}`)
  if (r.outOfOrder.length) lines.push(`Out of order (lower number than an applied one): ${r.outOfOrder.map((m) => m.number).join(', ')}`)
  if (r.duplicateNumbers.length) lines.push(`Duplicate numbers: ${r.duplicateNumbers.join(', ')}`)
  if (r.badFiles.length) lines.push(`Badly named files: ${r.badFiles.join(', ')}`)
  if (r.unknownApplied.length) lines.push(`Applied but not in the repo: ${r.unknownApplied.map((a) => a.name || a.version).join(', ')}`)
  if (r.clean) lines.push('Clean: every repo migration has an applied row.')
  return lines
}
