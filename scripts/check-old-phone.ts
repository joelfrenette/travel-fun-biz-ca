// Offline check: the old Canada office number must not appear in any public source file (Joel, 2026-10-12: every
// client, prospect and lead call goes to (833) 878-5386 via site.phone on BOTH profiles). No network.
// Run: pnpm dlx tsx scripts/check-old-phone.ts   (exit 1 on a failure)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { site } from '../lib/site'
import { translate } from '../lib/i18n'
import { SMS_CONSENT_KEY } from '../content/footer'

const OLD = /365\)?[\s.-]*800[\s.-]*6363|3658006363/
const SKIP_DIRS = new Set(['node_modules', '.next', '.claude', '.git', 'scripts'])
const EXT = /\.(ts|tsx|js|jsx|mjs|json|md|mdx|html|sql|txt|xml|svg|csv)$/i
const root = join(__dirname, '..')

const hits: string[] = []
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p)
    else if (EXT.test(name) && s.size < 2_000_000 && OLD.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1))
  }
}
walk(root)

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

expect('no source file still holds the old Canada office number', hits.length === 0, hits.join(', '))
expect('site.phone is the site-wide number', site.phone === '(833) 878-5386', site.phone)

// The footer consent sentence is a stable key with a {phone} placeholder, translated in fr and es, number substituted at render.
for (const lang of ['en', 'fr', 'es'] as const) {
  const rendered = translate(lang, SMS_CONSENT_KEY).replace('{phone}', site.phone)
  expect(`footer consent renders the new number in ${lang}`, rendered.includes('(833) 878-5386') && !rendered.includes('{phone}'), rendered)
  if (lang !== 'en') expect(`footer consent is translated in ${lang}`, translate(lang, SMS_CONSENT_KEY) !== SMS_CONSENT_KEY)
}
expect('price-on-request line is translated in fr and es', translate('fr', 'Call or text {phone} for pricing') !== 'Call or text {phone} for pricing' && translate('es', 'Contact us for pricing') !== 'Contact us for pricing')

console.log(failures ? `\n${failures} FAILED` : '\nOld phone number check passed')
process.exit(failures ? 1 : 0)
