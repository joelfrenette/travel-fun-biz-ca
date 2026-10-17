// Offline check: trip pages link to related guides (destination guide first), and render nothing when none match.
// Pure function plus file text only. No network, no database.
// Run: pnpm dlx tsx scripts/check-package-guides.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickGuidesForPackage, type GuideLink } from '../lib/guides'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

function g(id: string, kind: string, slug: string, parent: string | null, pkgs: string[] = []): GuideLink {
  return { id, kind, slug, name: slug, parent_slug: parent, summary: null, related_package_ids: pkgs } as unknown as GuideLink
}

const fixtures: GuideLink[] = [
  g('t1', 'activities', 'snorkel-tour', null, ['pkg-1']),
  g('u1', 'attractions', 'old-town', 'paris'),
  g('d1', 'destinations', 'paris', null),
  g('x1', 'destinations', 'rome', null),
]

const hit = pickGuidesForPackage({ id: 'pkg-1', destinationSlug: 'paris' }, fixtures)
expect('destination guide comes first', hit[0]?.id === 'd1', JSON.stringify(hit.map((h) => h.id)))
expect('trip-linked guide included', hit.some((h) => h.id === 't1'))
expect('guide under the destination included', hit.some((h) => h.id === 'u1'))
expect('unrelated destination excluded', !hit.some((h) => h.id === 'x1'))
expect('no duplicates', new Set(hit.map((h) => h.id)).size === hit.length)
expect('limit respected', pickGuidesForPackage({ id: 'pkg-1', destinationSlug: 'paris' }, fixtures, 2).length === 2)
expect('no match returns []', pickGuidesForPackage({ id: 'nope', destinationSlug: 'tokyo' }, fixtures).length === 0)
expect('null destination and no link returns []', pickGuidesForPackage({ id: 'nope', destinationSlug: null }, fixtures).length === 0)

const src = readFileSync(join(__dirname, '..', 'app', 'packages', '[slug]', 'page.tsx'), 'utf8')
expect('page imports listGuidesForPackage from lib/guides', /import \{[^}]*\blistGuidesForPackage\b[^}]*\} from "@\/lib\/guides"/.test(src))
expect('page calls listGuidesForPackage inside Promise.all', /Promise\.all\(\[[\s\S]*?listGuidesForPackage\(\{ id: pkg\.id, destination: pkg\.destination \}\)[\s\S]*?\]\)/.test(src))
expect('page has the "Guides for this trip" heading', src.includes('Guides for this trip'))
expect('block renders only when the list is non-empty', src.includes('tripGuides.length > 0 &&'))
expect('links use guidePath and guideKinds label', src.includes('guidePath(g.kind, g.slug)') && src.includes('guideKinds[g.kind].guideLabel'))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
