// Offline test of the migration drift core (lib/migration-drift.ts) and its System check stage. Fake lists, no network, no database.
// Run: pnpm dlx tsx scripts/check-migration-drift.ts
import {
  compareMigrations, matches, parseApplied, parseMigrationFiles, reportLines, toFact,
} from '../lib/migration-drift'
import { evaluateCheck, unreadFacts, STAGE_IDS, type CheckFacts } from '../lib/system-check'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
}

const files = ['0001_a.sql', '0002_b.sql', '0003_c.sql', '0004_d_e.sql', 'README.md', '.gitkeep']
const { migrations, badFiles } = parseMigrationFiles(files)
expect('parses NNNN_slug.sql and ignores non-sql files', migrations.map((m) => m.number).join(',') === '0001,0002,0003,0004' && badFiles.length === 0)
expect('a .sql file without the number pattern is reported', parseMigrationFiles(['foo.sql', '12_x.sql', '0001_ok.sql']).badFiles.join(',') === 'foo.sql,12_x.sql')

const all = (nums: string[]) => nums.map((n) => ({ version: n, name: '' }))
const clean = compareMigrations(migrations, all(['0001', '0002', '0003', '0004']))
expect('all applied is clean', clean.clean && clean.unapplied.length === 0 && clean.outOfOrder.length === 0)

const behind = compareMigrations(migrations, all(['0001', '0002']))
expect('missing newest are unapplied, in order, and not out of order', behind.unapplied.map((m) => m.number).join(',') === '0003,0004' && behind.outOfOrder.length === 0 && !behind.clean)

const hole = compareMigrations(migrations, all(['0001', '0003', '0004']))
expect('an unapplied migration below an applied one is out of order', hole.unapplied.map((m) => m.number).join(',') === '0002' && hole.outOfOrder.map((m) => m.number).join(',') === '0002')

const dup = compareMigrations(parseMigrationFiles(['0001_a.sql', '0002_b.sql', '0002_c.sql']).migrations, all(['0001', '0002']))
expect('a duplicate number is reported and is not clean', dup.duplicateNumbers.join(',') === '0002' && !dup.clean)

const extra = compareMigrations(migrations, [...all(['0001', '0002', '0003', '0004']), { version: '9999', name: 'mystery' }])
expect('an applied row with no repo file is listed as unknown, not an error', extra.unknownApplied.length === 1 && extra.clean)

const none = compareMigrations(migrations, [])
expect('an empty applied history is never clean (no false green)', none.historyEmpty && !none.clean && none.unapplied.length === 4)

expect('a timestamp version matches by name', matches(migrations[3], { version: '20261024120000', name: 'd_e' }) && matches(migrations[0], { version: '20260101', name: '0001_a' }) && !matches(migrations[0], { version: '20260101', name: 'zzz' }))
expect('a version does not match on a shared prefix of digits', !matches(migrations[0], { version: '00011', name: '' }))
expect('parseApplied drops junk and accepts numbers', parseApplied([{ version: '0001', name: 'a' }, null, 5, { version: 7 }, { name: 'x' }]).map((a) => a.version).join(',') === '0001,7' && parseApplied('nope').length === 0)

expect('the report lines name what is not applied', reportLines(behind).some((l) => l.includes('0003_c.sql')) && reportLines(clean).some((l) => l.startsWith('Clean')))

// ---- the System check stage -------------------------------------------------------------------------
const NOW = new Date('2026-10-24T15:00:00Z')
const stageOf = (migrations: CheckFacts['migrations']) => evaluateCheck({ ...unreadFacts(NOW), migrations }).stages.find((s) => s.id === 'migrations')!

expect('the check lists the migrations stage last', STAGE_IDS[STAGE_IDS.length - 1] === 'migrations')
const un = stageOf(null)
expect('migrations that could not be read are amber, say so, and never green', un.light === 'amber' && !un.read && /could not be read/.test(un.sentence) && un.number === null)
expect('migrations never asked about are also unread', stageOf(undefined).light === 'amber' && !stageOf(undefined).read)
const g = stageOf(toFact(clean))
expect('all applied is green and read', g.light === 'green' && g.read && g.needs === null && /4/.test(g.sentence))
const a = stageOf(toFact(behind))
expect('unapplied is amber with fix text "Apply migration NNNN" linking to the System check page', a.light === 'amber' && a.read && a.needs?.text === 'Apply migration 0003' && a.needs?.href === '/admin/system-check', JSON.stringify(a.needs))
expect('the amber sentence carries the real count', /2 database changes/.test(a.sentence), a.sentence)
const e = stageOf(toFact(none))
expect('an empty history is amber, not green', e.light === 'amber' && e.read && /no record/i.test(e.sentence), e.sentence)
const d = stageOf(toFact(dup))
expect('a duplicate number is amber', d.light === 'amber' && d.read)
expect('no stage sentence has a long dash', ![un, g, a, e, d].some((s) => /[—–]/.test(s.sentence)))

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
