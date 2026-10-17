// Offline check for honest sitemap lastModified. Run: pnpm dlx tsx scripts/check-sitemap-lastmod.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { maxIso, lastModOrUndefined, lastModField } from '../lib/sitemap-dates'

let failures = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}

const m = maxIso(['2026-01-05T00:00:00Z', '2026-03-09T12:00:00Z', '2026-02-01T00:00:00Z'])
check('max of several ISO dates', m?.toISOString() === '2026-03-09T12:00:00.000Z', m)
check('empty input is undefined', maxIso([]) === undefined)
const g = maxIso([null, undefined, '', 'not a date', '2026-04-01T00:00:00Z'])
check('null, empty and invalid are ignored', g?.toISOString() === '2026-04-01T00:00:00.000Z', g)
check('all invalid is undefined', maxIso([null, 'garbage']) === undefined)
check('lastModOrUndefined handles null and bad strings', lastModOrUndefined(null) === undefined && lastModOrUndefined('x') === undefined)
check('lastModOrUndefined parses a good date', lastModOrUndefined('2026-01-01T00:00:00Z') instanceof Date)
check('lastModField omits the key when no date', !('lastModified' in lastModField(undefined)))
check('lastModField sets the key when a date exists', lastModField(new Date(0)).lastModified instanceof Date)

const src = readFileSync(join(__dirname, '..', 'app', 'sitemap.ts'), 'utf8')
check("sitemap.ts has no 'lastModified: new Date()'", !/lastModified:\s*new Date\(\)/.test(src))
check('sitemap.ts has no bare new Date() at all', !/new Date\(\)/.test(src))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll sitemap lastmod checks passed')
