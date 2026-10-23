// Offline check: guide and destination schema (speakable, WebPage entity) and the enquiry CTA prefill.
// File text plus the pure href builder only. Run: pnpm dlx tsx scripts/check-guide-schema.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enquiryHref } from '../lib/guide-facts'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

const parts = read('components/guide-parts.tsx')
const page = read('components/guide-page.tsx')
const cta = read('components/guide-cta.tsx')
const dest = read('app/destinations/[slug]/page.tsx')

expect('key-takeaways id on the aside', /<aside id="key-takeaways"[^>]*aria-label="Key takeaways"/.test(parts))
expect('guide-faq id still on the FAQ section', parts.includes('id="guide-faq"'))

const ld = page.slice(page.indexOf('export function guideJsonLd'), page.indexOf('export async function guideMetadata'))
expect('guideJsonLd has SpeakableSpecification', ld.includes('SpeakableSpecification'))
expect('speakable selectors are conditional', ld.includes('"#key-takeaways"') && ld.includes('"#guide-faq"') && /key_takeaways\.length > 0/.test(ld) && /faq\.length > 0/.test(ld))
expect('guideJsonLd has inLanguage from SITE_LOCALE', ld.includes('inLanguage') && ld.includes('SITE_LOCALE'))
expect('guideJsonLd has isPartOf WebSite', /isPartOf = \{ "@type": "WebSite"/.test(ld))
const destStart = ld.indexOf('guide.kind === "destinations"')
const destBranch = ld.slice(destStart, ld.indexOf('"@type": "Article"', destStart))
expect('destinations branch emits WebPage', destBranch.includes('"@type": "WebPage"'))
expect('WebPage mainEntity is the schemaType (TouristDestination)', /mainEntity: \{ "@type": info\.schemaType/.test(destBranch))
expect('destination WebPage has publisher, dates and inLanguage', destBranch.includes('publisher: organization') && destBranch.includes('...dates') && destBranch.includes('inLanguage'))
const entity = destBranch.slice(destBranch.indexOf('mainEntity:'))
expect('no dateModified on the TouristDestination entity', !entity.includes('dateModified'))
expect('no bare TouristDestination with dateModified left', !/"@type": info\.schemaType, name: guide\.name, description, url, image, \.\.\.\(guide\.updated_at/.test(ld))
expect('non-destination guides keep the Article', ld.includes('"@type": "Article"'))

expect('destination CollectionPage points at the guide', /guide \? \{ about: \{ "@id": pageUrl \}, isPartOf: \{ "@id": pageUrl \} \}/.test(dest))
expect('destination passes upcoming[0] name to GuideCta (both)', (dest.match(/packageName=\{upcoming\[0\]\?\.name\}/g) ?? []).length === 2)
expect('guide page passes packages[0] name to GuideCta (header panel, context block, closing form)', (page.match(/packageName=\{packages\[0\]\?\.name\}/g) ?? []).length === 3)

expect('named package href', enquiryHref('Alaska Cruise') === '/?package=Alaska%20Cruise#contact', enquiryHref('Alaska Cruise'))
expect('ampersand is encoded', enquiryHref('Rock & Roll Cruise') === '/?package=Rock%20%26%20Roll%20Cruise#contact', enquiryHref('Rock & Roll Cruise'))
expect('fallback when no name', enquiryHref() === '/?package=Custom%20Package#contact' && enquiryHref(null) === enquiryHref('') && enquiryHref('   ') === enquiryHref(undefined))
expect('query comes before the hash', enquiryHref('X').indexOf('?') < enquiryHref('X').indexOf('#'))
expect('GuideCta uses the builder, no bare /#contact', cta.includes('enquiryHref(packageName)') && !cta.includes('"/#contact"') && !cta.includes('href="/#contact"'))
expect('GuideCta takes the packageName prop', /packageName\?: string \| null/.test(cta))
expect('no hard-coded phone in guide-cta', !/\d{3}[)\s.-]*\d{3}[\s.-]\d{4}/.test(cta) && cta.includes('site.phone'))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
