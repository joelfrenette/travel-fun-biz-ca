// Offline check: destination page puts the guide block above the trip grid and uses the guide H1.
// File text only. Run: pnpm dlx tsx scripts/check-destination-page.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const dest = read('app/destinations/[slug]/page.tsx')
const guidePage = read('components/guide-page.tsx')
const guides = read('lib/guides.ts')

const h1Line = dest.split('\n').find((l) => l.includes('<h1')) ?? ''
expect('exactly one h1', (dest.match(/<h1/g) ?? []).length === 1)
expect('guide-case H1 uses guideKinds.destinations.guideLabel', /guide \? `\$\{destination\}: \$\{guideKinds\.destinations\.guideLabel\}`/.test(h1Line), h1Line)
expect('H1 does not hard-code "Travel Guide"', !h1Line.includes('Travel Guide'))
expect('no-guide H1 keeps the Trips string', /: `\$\{destination\} Trips`\}/.test(h1Line), h1Line)
expect('the Trips H1 is only in the no-guide branch', !/guide \? `\$\{destination\} Trips`/.test(h1Line) && !/page \? `\$\{destination\} Trips`/.test(h1Line))
expect('guideLabel for destinations is still "Travel Guide"', /destinations: \{[^}]*guideLabel: 'Travel Guide'/.test(guides))
expect('guide-page.tsx H1 uses the same label shape', guidePage.includes('{guide.name}: {info.guideLabel}</h1>'))

// The header call to action is now the GuideHeaderActions panel (components/guide-header-actions.tsx).
const iCompact = dest.indexOf('<GuideHeaderActions name={destination} packageName={upcoming[0]?.name}')
const iTake = dest.indexOf('<GuideTakeaways guide={guide} />')
const iArticle = dest.indexOf('<GuideArticle guide={guide} html=')
const iFaq = dest.indexOf('<GuideFaqList guide={guide} answers=')
const iFullCta = dest.indexOf('<GuideCta name={destination} packageName={upcoming[0]?.name} />')
const iGrid = dest.indexOf('More upcoming trips to {destination}')
expect('all anchors found', [iCompact, iTake, iArticle, iFaq, iFullCta, iGrid].every((i) => i > 0))
expect('compact GuideCta is above the guide block and the grid', iCompact < iTake && iCompact < iGrid)
expect('compact GuideCta is in the header, before the content container', iCompact < dest.indexOf('container mx-auto space-y-12'))
expect('takeaways, article and FAQ come before the Upcoming trips grid', iTake < iGrid && iArticle < iGrid && iFaq < iGrid)
expect('full guide CTA comes before the grid', iFullCta < iGrid)
expect('upcoming trips heading appears once', (dest.match(/upcoming trips to/gi) ?? []).length === 1)
// The nearest trip is the header card (lib/guide-header.ts), so the grid below lists only the rest.
expect('grid is gated on the rest of the trips', /\{restTrips\.length > 0 && \(\s*<section>\s*<h2[^>]*>More upcoming trips to/.test(dest))
expect('guide block is gated on guide so no-guide order is just the grid', /\{guide && \(\s*<div className="mx-auto max-w-3xl space-y-10">/.test(dest))
expect('grid comes before the child, property and recap sections', iGrid < dest.indexOf('inside-heading') && iGrid < dest.indexOf('property-guides-heading') && iGrid < dest.indexOf('Past trips to'))
expect('header still has the Send an enquiry path via GuideHeaderActions', read('components/guide-header-actions.tsx').includes('cta.enquiryHref'))

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll destination page checks passed')
