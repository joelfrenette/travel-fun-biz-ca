// Offline check for "the AI topic suggester stays away from trips that already have a recent post".
// Covers: which packages count as covered (a post body that links /packages/<slug>), the idea filter (names a covered trip or its
// destination, the same test findGroundingPackage uses), and source assertions that suggestTopics reads the covered list, hands it to
// the prompt material and filters the ideas it gets back. No network, no database, no AI call.
// Run: pnpm dlx tsx --tsconfig tsconfig.json scripts/check-topic-covered.ts
import { readFileSync } from 'node:fs'

process.env.ANTHROPIC_API_KEY = ''

import { coveredPackages, mentionsCovered } from '../lib/blog-topics'

let failed = 0
function check(name: string, ok: boolean): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

const packages = [
  { slug: 'tahiti-cruise', name: 'Tahitian Tropical Escape', destination: 'Tahiti' },
  { slug: 'rhine-river', name: 'Rhine Christmas Markets', destination: 'Germany' },
  { slug: 'greek-isles', name: 'Greek Isles Getaway', destination: 'Greece' },
]
const posts = [
  { body: 'Book it: [Tahitian Tropical Escape](/packages/tahiti-cruise) today.' },
  { body: null },
  { body: 'A general packing list with no trip link.' },
]

const covered = coveredPackages(packages, posts)
check('a post that links the trip covers it', covered.length === 1 && covered[0].slug === 'tahiti-cruise')
check('a null body covers nothing', coveredPackages(packages, [{ body: null }]).length === 0)
check('no posts covers nothing', coveredPackages(packages, []).length === 0)
check('the slug test ignores case', coveredPackages(packages, [{ body: 'see /PACKAGES/Greek-Isles now' }]).map((p) => p.slug).join() === 'greek-isles')
check('a slug that only shares a prefix still matches by prefix like the wall does', coveredPackages([{ slug: 'rhine' }], [{ body: '/packages/rhine-river' }]).length === 1)

check('an idea naming a covered destination is rejected', mentionsCovered({ angle: 'Is Tahiti worth it in winter?', keyword: 'tahiti winter' }, covered))
check('an idea naming a covered trip is rejected', mentionsCovered({ angle: 'Inside the Tahitian Tropical Escape', keyword: 'cruise review' }, covered))
check('a general planning idea passes', !mentionsCovered({ angle: 'How to split costs on a group trip', keyword: 'group trip costs' }, covered))
check('an idea about an uncovered trip passes', !mentionsCovered({ angle: 'Why Greece in shoulder season', keyword: 'greece shoulder season' }, covered))
check('nothing covered rejects nothing', !mentionsCovered({ angle: 'Tahiti', keyword: 'tahiti' }, []))
check('blank destination and name never match', !mentionsCovered({ angle: 'anything', keyword: 'anything' }, [{ name: '', destination: null }]))

const src = readFileSync('lib/blog-topics.ts', 'utf8')
check('suggestTopics reads the covered trips', /const covered = await readCoveredPackages\(admin\)/.test(src))
check('the prompt material gets the covered list', /gatherTopicMaterial\(admin, covered\)/.test(src))
check('returned ideas are filtered with mentionsCovered', /!mentionsCovered\(i, covered\)/.test(src))
check('covered trips are left out of the sellable list', /!coveredSlugs\.has\(p\.slug\)/.test(src))
check('an unreadable lookup excludes nothing', /if \(pk\.error \|\| ps\.error\) return \[\]/.test(src))

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
