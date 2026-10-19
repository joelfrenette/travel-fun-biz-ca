// Offline check: only compare and best-time pages with published copy are listed and indexed.
// Run: pnpm dlx tsx scripts/check-page-copy-index.ts
import { buildCopyPathSet, shouldListPath, copyRobots, filterByCopy } from '../lib/page-copy-index'

let failures = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}

const cmp = (s: string) => `/compare/${s}`
const bt = (s: string) => `/best-time-to-visit/${s}`
const comparePairs = ['a-vs-b', 'a-vs-c', 'b-vs-c', 'c-vs-d', 'd-vs-e', 'e-vs-f'].map((pairSlug) => ({ pairSlug }))
const bestTimes = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug) => ({ slug }))
const staticUrls = ['/', '/packages', '/who-we-are', '/blog', '/destinations']

// Mirrors the order in app/sitemap.ts: static pages, then best-time, then compare.
function sitemapList(copy: Set<string> | null): string[] {
  return [
    ...staticUrls,
    ...filterByCopy(bestTimes, (d) => bt(d.slug), copy).map((d) => bt(d.slug)),
    ...filterByCopy(comparePairs, (c) => cmp(c.pairSlug), copy).map((c) => cmp(c.pairSlug)),
  ]
}

const rows = [
  { path: cmp('a-vs-b') }, { path: cmp('b-vs-c') }, { path: cmp('c-vs-d') }, { path: cmp('e-vs-f') },
  { path: bt('a') }, { path: bt('c') }, { path: bt('d') }, { path: bt('f') },
]
const set = buildCopyPathSet(rows)
check('set has 8 paths', set?.size === 8, set && [...set])

const list = sitemapList(set)
const listedCmp = list.filter((u) => u.startsWith('/compare/'))
const listedBt = list.filter((u) => u.startsWith('/best-time-to-visit/'))
check('only the 4 compare paths with copy are listed', JSON.stringify(listedCmp) === JSON.stringify(['a-vs-b', 'b-vs-c', 'c-vs-d', 'e-vs-f'].map(cmp)), listedCmp)
check('only the 4 best-time paths with copy are listed', JSON.stringify(listedBt) === JSON.stringify(['a', 'c', 'd', 'f'].map(bt)), listedBt)
check('every static page remains', staticUrls.every((u) => list.includes(u)), list)

const allList = sitemapList(null)
check('null set (read error) lists everything', allList.length === staticUrls.length + 12, allList.length)
check('empty rows give null set (fail open)', buildCopyPathSet([]) === null)
check('null/undefined rows give null set (fail open)', buildCopyPathSet(null) === null && buildCopyPathSet(undefined) === null)
check('empty-set read lists everything', sitemapList(buildCopyPathSet([])).length === allList.length)
check('rows without a string path are ignored', buildCopyPathSet([{ path: 5 }, { path: '' }, {}, { path: cmp('x') }])?.size === 1)

check('shouldListPath true for a path in the set', shouldListPath(cmp('a-vs-b'), set))
check('shouldListPath false for a path not in the set', !shouldListPath(cmp('a-vs-c'), set))
check('shouldListPath true when set is null', shouldListPath(cmp('anything'), null))

const noIdx = copyRobots(false)
check('no copy gives noindex, follow', noIdx?.index === false && noIdx?.follow === true, noIdx)
check('copy present gives default index (no robots override)', copyRobots(true) === undefined)
check('metadata decision follows the set', copyRobots(set!.has(cmp('a-vs-c')))?.index === false && copyRobots(set!.has(cmp('a-vs-b'))) === undefined)

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
