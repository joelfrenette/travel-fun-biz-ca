// Fails when lib/migrations-manifest.ts and supabase/migrations/ disagree, so the System check never compares the database with a
// stale list. Also fails on duplicate numbers, badly named files and gaps in the numbering. Run: pnpm dlx tsx scripts/check-migration-manifest.ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS_MANIFEST } from '../lib/migrations-manifest'
import { compareMigrations, parseMigrationFiles } from '../lib/migration-drift'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
}

const folder = readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter((f) => f.toLowerCase().endsWith('.sql')).sort()
const manifest = [...MIGRATIONS_MANIFEST].sort()
const missing = folder.filter((f) => !manifest.includes(f))
const extra = manifest.filter((f) => !folder.includes(f))

expect('every migration file is in lib/migrations-manifest.ts', missing.length === 0, `add to the list: ${missing.join(', ')}`)
expect('the manifest lists no file that is not in the folder', extra.length === 0, `remove from the list: ${extra.join(', ')}`)
expect('the manifest is in order', MIGRATIONS_MANIFEST.every((f, i) => i === 0 || MIGRATIONS_MANIFEST[i - 1] < f))

const { migrations, badFiles } = parseMigrationFiles(folder)
const self = compareMigrations(migrations, migrations.map((m) => ({ version: m.number, name: m.slug })), badFiles)
expect('no badly named migration file', badFiles.length === 0, badFiles.join(', '))
expect('no duplicate migration number', self.duplicateNumbers.length === 0, self.duplicateNumbers.join(', '))
const nums = migrations.map((m) => Number(m.number))
const gaps = nums.filter((n, i) => i > 0 && n !== nums[i - 1] + 1 && n !== nums[i - 1])
expect('the numbering has no gaps', gaps.length === 0, `gap before: ${gaps.join(', ')}`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
