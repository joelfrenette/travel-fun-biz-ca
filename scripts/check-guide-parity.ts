// Offline check: destination pages match guide pages (related guides, blog stories, compact CTA), show a visible
// "Updated" date, and the Article JSON-LD carries datePublished and a full organization. File text plus pure helpers only.
// Run: pnpm dlx tsx scripts/check-guide-parity.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatDate } from '../lib/site'
import { relatedGuideCards, type GuideLink } from '../lib/guides'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const parts = read('components/guide-parts.tsx')
const guidePage = read('components/guide-page.tsx')
const dest = read('app/destinations/[slug]/page.tsx')

expect('guide-parts exports RelatedGuidesSection', /export function RelatedGuidesSection\b/.test(parts))
expect('guide-parts exports BlogStoriesSection', /export function BlogStoriesSection\b/.test(parts))
expect('guide-parts has no data-layer import (stays client safe)', !/from ["']@\/lib\/guides["']|supabase/.test(parts))

for (const [label, src] of [['guide-page', guidePage], ['destination page', dest]] as const) {
  expect(`${label} renders RelatedGuidesSection`, /<RelatedGuidesSection\b/.test(src))
  expect(`${label} renders BlogStoriesSection`, /<BlogStoriesSection\b/.test(src))
  expect(`${label} imports both from guide-parts`, /import \{[^}]*RelatedGuidesSection[^}]*BlogStoriesSection[^}]*\} from "@\/components\/guide-parts"/.test(src))
  expect(`${label} has a <time element`, /<time\b/.test(src))
  expect(`${label} prints Updated with formatDate`, /Updated \{formatDate\(/.test(src))
  expect(`${label} has no em dash`, !src.includes('—'))
}
expect('guide-page no longer defines the sections inline', !/id="related-guides-heading"|id="stories-heading"/.test(guidePage))
expect('destination page calls listPostsForGuide(guide, 3)', /listPostsForGuide\(guide, 3\)/.test(dest))
expect('destination page calls pickRelatedGuides(guide, allGuides, 6)', /pickRelatedGuides\(guide, allGuides, 6\)/.test(dest))
expect('destination page renders the header call-to-action panel', /<GuideHeaderActions name=\{destination\}/.test(dest))
expect('guide page renders the header call-to-action panel', /<GuideHeaderActions name=\{guide\.name\}/.test(guidePage))
expect('destination time uses updated_at', /dateTime=\{guide\.updated_at\}/.test(dest))
expect('guide-page time uses updated_at', /dateTime=\{guide\.updated_at\}/.test(guidePage))

expect('JSON-LD has datePublished from created_at', /datePublished: guide\.created_at/.test(guidePage))
expect('JSON-LD organization has url', /const organization = \{[^\n]*url: absoluteUrl\("\/"\)/.test(guidePage))
expect('JSON-LD organization has logo', /const organization = \{[^\n]*logo:/.test(guidePage))
expect('author and publisher share the organization', /author: organization,\s*publisher: organization/.test(guidePage))
expect('destination WebPage has dateModified (via the shared dates)', /"@type": "WebPage",[\s\S]*?\.\.\.dates,[\s\S]*?mainEntity: \{ "@type": info\.schemaType/.test(guidePage) && /\.\.\.\(guide\.updated_at \? \{ dateModified: guide\.updated_at \} : \{\}\)/.test(guidePage))
expect('no new Date() used as a modified date', !/dateModified:\s*new Date\(/.test(guidePage) && !/dateModified:\s*new Date\(/.test(dest))
expect('guide-page has no new Date() at all', !/new Date\(\)/.test(guidePage))

// Pure helpers
expect('formatDate formats an ISO date', formatDate('2026-09-03T10:00:00Z') === 'September 3, 2026', String(formatDate('2026-09-03T10:00:00Z')))
expect('formatDate empty gives null', formatDate('') === null && formatDate(null) === null && formatDate(undefined) === null)
expect('formatDate garbage gives null', formatDate('not a date') === null)
const cards = relatedGuideCards([{ id: 'a', kind: 'hotels', slug: 'ritz', name: 'Ritz', parent_slug: null, summary: 'A hotel. More text.', related_package_ids: [] } as unknown as GuideLink])
expect('relatedGuideCards maps href, label and one-line summary', cards[0]?.href.endsWith('/ritz') && cards[0].name === 'Ritz' && cards[0].summary === 'A hotel.' && cards[0].label.length > 0, JSON.stringify(cards))

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
