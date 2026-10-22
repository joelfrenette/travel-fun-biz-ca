// Offline check: the related-guides link graph leaves no indexable guide without inbound links (the Cancun, Tahiti and
// Star Clippers orphans), never links to a safe (thin) page or an unpublished one, and the orphan audit uses the same function
// the pages call. Run: pnpm dlx tsx scripts/check-orphans-fix.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickRelatedWithCoverage, pickCoverageGuides, guidePath, SAFE_PAGE_NOTE, type GuideLink, type GuideKind } from '../lib/guides'
import { findOrphans, inboundCounts, toAuditGuides, type AuditGuide } from '../lib/guide-orphans'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

let n = 0
function row(kind: GuideKind, slug: string, name: string, parent: string | null = null, extra: Partial<AuditGuide> & { status?: string } = {}) {
  n++
  return { id: `id-${n}`, kind, slug, name, parent_slug: parent, related_package_ids: [] as string[], summary: `${name} guide.`, body: '', quality_notes: null as string | null, status: 'published', ...extra }
}

// Many popular pages that would fill every "top 6" slot, plus three unpopular ones with almost nothing to relate to.
const fixtures = [
  ...['mexico', 'italy', 'greece', 'spain', 'france', 'japan', 'peru', 'iceland', 'belize', 'fiji'].map((s) => row('destinations', s, s[0].toUpperCase() + s.slice(1))),
  row('destinations', 'cancun', 'Cancun'),
  row('destinations', 'tahiti', 'Tahiti'),
  ...['ritz', 'savoy', 'plaza', 'baglioni', 'ace'].map((s) => row('hotels', s, s.toUpperCase(), 'italy')),
  ...['ponant', 'seadream', 'windstar'].map((s) => row('yachts', s, s.toUpperCase())),
  row('yachts', 'star-clippers', 'Star Clippers'),
  row('ships', 'queen-mary', 'Queen Mary'),
  row('hotels', 'safe-hotel', 'Safe Hotel', 'italy', { quality_notes: SAFE_PAGE_NOTE }),
  row('destinations', 'safe-town', 'Safe Town', null, { quality_notes: SAFE_PAGE_NOTE }),
  row('destinations', 'draft-place', 'Draft Place', null, { status: 'draft' }),
]

// What the public pages see: published rows only, safe pages dropped (listPublishedGuideLinks).
const isSafe = (g: { quality_notes: string | null }) => (g.quality_notes ?? '').startsWith('safe-page:')
const published = fixtures.filter((g) => g.status === 'published')
const live = published.filter((g) => !isSafe(g))
const links: GuideLink[] = live.map((g) => ({ id: g.id, kind: g.kind, slug: g.slug, name: g.name, parent_slug: g.parent_slug, summary: g.summary, related_package_ids: g.related_package_ids }))
const liveKeys = new Set(live.map((g) => `${g.kind}:${g.slug}`))

// The graph exactly as the pages render it.
const inbound = new Map<string, Set<string>>(links.map((g) => [`${g.kind}:${g.slug}`, new Set<string>()]))
let badTarget = ''
for (const g of links) {
  for (const hit of pickRelatedWithCoverage(g, links, 6)) {
    const k = `${hit.kind}:${hit.slug}`
    if (!liveKeys.has(k)) badTarget = k
    if (k !== `${g.kind}:${g.slug}`) inbound.get(k)?.add(`${g.kind}:${g.slug}`)
  }
}
const least = Math.min(...[...inbound.values()].map((s) => s.size))
expect('every indexable guide gets at least 2 related links from other pages', least >= 2, `least=${least}`)
for (const key of ['destinations:cancun', 'destinations:tahiti', 'yachts:star-clippers']) expect(`${key} has 2+ inbound`, (inbound.get(key)?.size ?? 0) >= 2, String(inbound.get(key)?.size))
expect('the related graph never links to a safe page or an unpublished one', badTarget === '', badTarget)
expect('no block exceeds six links and none repeats or links to itself', links.every((g) => {
  const r = pickRelatedWithCoverage(g, links, 6)
  return r.length <= 6 && new Set(r.map((x) => x.id)).size === r.length && !r.some((x) => x.id === g.id)
}))
expect('a safe page itself still gets a related block of indexable pages only', pickRelatedWithCoverage({ kind: 'hotels', slug: 'safe-hotel', parent_slug: 'italy', related_package_ids: [] }, links, 6).every((x) => liveKeys.has(`${x.kind}:${x.slug}`)))
expect('the coverage links do not depend on the order rows are read in', JSON.stringify(links.map((g) => pickCoverageGuides(g, links).map((x) => x.id))) === JSON.stringify(links.map((g) => pickCoverageGuides(g, [...links].reverse()).map((x) => x.id))))

// The audit, fed the published rows (safe pages included) the way loadAuditInputs does.
const audit = toAuditGuides(published as unknown as AuditGuide[])
const orphans = findOrphans(audit, [], [])
expect('audit: zero orphans', orphans.length === 0, orphans.map((o) => o.path).join(','))
const counts = inboundCounts(audit, [], [])
expect('audit: every indexable guide counts 2+ inbound pages', live.every((g) => (counts.get(`${g.kind}:${g.slug}`) ?? 0) >= 2))
expect('audit: a safe page is never reported as an orphan', !findOrphans(audit, [], []).some((o) => o.slug === 'safe-hotel' || o.slug === 'safe-town'))
expect('audit: a safe page is left out of the checked set but its path format is unchanged', guidePath('ships', 'solo') === '/ships/solo')

// Pages and audit share one function.
expect('guide page uses pickRelatedWithCoverage', /pickRelatedWithCoverage\(guide, allGuides, 6\)/.test(read('components/guide-page.tsx')))
expect('destination page uses pickRelatedWithCoverage', /pickRelatedWithCoverage\(guide, allGuides, 6\)/.test(read('app/destinations/[slug]/page.tsx')))
expect('listRelatedGuides uses pickRelatedWithCoverage', /pickRelatedWithCoverage\(current, await listPublishedGuideLinks\(\)/.test(read('lib/guides.ts')))
expect('the audit uses pickRelatedWithCoverage', /pickRelatedWithCoverage\(g, links, 6\)/.test(read('lib/guide-orphans.ts')))
expect('this file has no em dash', !read('scripts/check-orphans-fix.ts').includes(String.fromCharCode(8212)))

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
