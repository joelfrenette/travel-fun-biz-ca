// Offline checks for the local SEO schema (lib/org-jsonld.ts) and its checklist (docs/local-seo-checklist.md).
// No network, no database. Run: corepack pnpm dlx tsx scripts/check-local-seo.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { site } from '../lib/site'
import { buildOrganizationJsonLd, buildWebSiteJsonLd, ORG_ID } from '../lib/org-jsonld'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

const org = buildOrganizationJsonLd() as Record<string, any>
expect('node is a TravelAgency with a stable @id', org['@type'] === 'TravelAgency' && org['@id'] === ORG_ID && ORG_ID.endsWith('#organization'))
expect('name, phone and address come from lib/site.ts', org.name === site.name && org.telephone === site.phone && org.address.addressLocality === site.address.locality && org.address.addressRegion === site.address.region && org.address.addressCountry === site.country)
expect('contactPoint uses the same phone', org.contactPoint?.telephone === site.phone && org.contactPoint?.areaServed === site.country)
expect('areaServed is the site country', org.areaServed?.['@type'] === 'Country' && org.areaServed?.name === (site.country === 'CA' ? 'Canada' : 'United States'))
const claims = ['aggregateRating', 'review', 'openingHours', 'openingHoursSpecification', 'geo', 'priceRange', 'hasMap']
expect('no invented hours, geo, price range, rating or reviews', claims.every((k) => !(k in org)), claims.filter((k) => k in org).join())
expect('the WebSite publisher points at the same entity', (buildWebSiteJsonLd().publisher as Record<string, unknown>)['@id'] === ORG_ID)
expect('guide pages point their organization at the same @id', /"@id": ORG_ID/.test(read('components/guide-page.tsx')))
expect('the home page still writes the business node', /buildOrganizationJsonLd/.test(read('app/page.tsx')))
expect('org-jsonld stays free of next/headers and cookies (cache routing)', !/next\/headers|cookies\(|headers\(/.test(read('lib/org-jsonld.ts')))

const doc = read('docs/local-seo-checklist.md')
expect('the checklist exists, names the NAP and has no em dash', doc.includes(site.phone) && doc.includes(site.addressLines[0]) && !doc.includes(String.fromCharCode(0x2014)))
expect('the checklist lists the facts Joel must supply', /Facts Joel must supply/i.test(doc))

if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
console.log('\nall local SEO checks passed')
