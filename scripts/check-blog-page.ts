// Offline check: the blog post page has the call to action, freshness markup, BlogPosting schema and a sized cover image.
// Reads the file text only. No network.
// Run: pnpm dlx tsx scripts/check-blog-page.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'app', 'blog', '[slug]', 'page.tsx'), 'utf8')

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

expect('imports GuideCta from components/guide-cta', /import \{ GuideCta \} from "@\/components\/guide-cta"/.test(src))
// Conversion loop: the compact GuideCta was replaced by ContextCta (after the Quick answer) and a sticky bar.
expect('renders a full (non-compact) GuideCta', /<GuideCta (?![^>]*\bcompact\b)[^>]*\/>/.test(src))
expect('renders ContextCta after the quick answer and at the end', src.includes('blockId="after_quick_answer"') && src.includes('blockId="end_of_page"'))
expect('context CTA sits after key takeaways and before the second half of the body', (() => {
  const a = src.indexOf('id="key-takeaways"')
  const b = src.indexOf('blockId="after_quick_answer"')
  const c = src.indexOf('articleAfter &&')
  return a > -1 && b > a && c > b
})())
expect('blog posts get the sticky phone bar', src.includes('<StickyCta'))
expect('no bare "Ask us about your trip" button in the page', !src.includes('Ask us about your trip'))
expect('CTA name falls back to primary keyword', /linkedPackage\?\.destination[\s\S]{0,80}post\.primary_keyword/.test(src))
expect('package cards kept when packages exist', src.includes('<PackageCard') && src.includes('relatedPackages.length > 0'))
expect('uses <time dateTime>', src.includes('<time dateTime={post.publish_date}'))
expect('shows Updated only when edited more than a day later', src.includes('Updated <time dateTime={post.updated_at}') && src.includes('24 * 60 * 60 * 1000'))
expect('JSON-LD is BlogPosting, not Article', src.includes('"@type": "BlogPosting"') && !src.includes('"@type": "Article"'))
expect('author and publisher carry url absoluteUrl("/")', (src.match(/name: SITE_NAME, url: absoluteUrl\("\/"\)/g) || []).length >= 2)
expect('image is an array [cover, 1200x630 card], never the site-wide stock photo', src.includes('image: structuredImages(post.cover_image_url, "blog", post.slug)'))
expect('about Thing from primary_keyword', src.includes('about: { "@type": "Thing", name: post.primary_keyword }'))
expect('isPartOf Blog with /blog url', src.includes('isPartOf: { "@type": "Blog", url: absoluteUrl("/blog") }'))
expect('cover img fetchPriority="high"', src.includes('fetchPriority="high"'))
expect('cover img width={1200} height={675} decoding async', src.includes('width={1200}') && src.includes('height={675}') && src.includes('decoding="async"'))
expect('no literal phone number in the page', !/\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(src))
expect('no em dashes', !src.includes(String.fromCharCode(0x2014)))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
