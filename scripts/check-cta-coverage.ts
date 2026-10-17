// Offline check: best-time, compare and guide index pages end with the shared GuideCta, with no typed phone number.
// File text only. Run: pnpm dlx tsx scripts/check-cta-coverage.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const files: Record<string, string> = {
  'app/best-time-to-visit/[destination]/page.tsx': 'PageCopyFaq copy',
  'app/compare/[pair]/page.tsx': 'PageCopyFaq copy',
  'components/guide-index-page.tsx': 'it.summary &&',
}

for (const [path, mainMarker] of Object.entries(files)) {
  const src = read(path)
  expect(`${path} imports GuideCta`, /import \{ GuideCta \} from "@\/components\/guide-cta"/.test(src))
  const iCta = src.indexOf('<GuideCta')
  expect(`${path} renders <GuideCta`, iCta >= 0)
  expect(`${path} renders GuideCta once`, (src.match(/<GuideCta/g) ?? []).length === 1)
  expect(`${path} GuideCta comes after the main content`, iCta > src.indexOf(mainMarker), mainMarker)
  expect(`${path} has no literal phone number`, !/\(\d{3}\)\s?\d{3}[-\s]\d{4}/.test(src) && !/\d{3}[-.]\d{3}[-.]\d{4}/.test(src))
  expect(`${path} has no 833 string`, !src.includes('833'))
  expect(`${path} does not use site.phone itself`, !src.includes('site.phone'))
}

const idx = read('components/guide-index-page.tsx')
expect('guide index GuideCta uses info.plural', /<GuideCta name=\{info\.plural\.toLowerCase\(\)\}/.test(idx))
const bt = read('app/best-time-to-visit/[destination]/page.tsx')
expect('best-time GuideCta uses destination and first package name', /<GuideCta name=\{page\.destination\} packageName=\{page\.packages\[0\]\?\.name\}/.test(bt))
const cmp = read('app/compare/[pair]/page.tsx')
expect('compare GuideCta names both destinations', /<GuideCta name=\{`\$\{page\.a\.destination\} vs \$\{page\.b\.destination\}`\}/.test(cmp))
expect('compare GuideCta uses a listed package name when present', /packageName=\{page\.a\.packages\[0\]\?\.name \?\? page\.b\.packages\[0\]\?\.name\}/.test(cmp))

const cta = read('components/guide-cta.tsx')
expect('GuideCta reads the phone from site.phone and hides it when empty', cta.includes('site.phone') && cta.includes('{phone && ('))

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll CTA coverage checks passed')
