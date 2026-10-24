// Offline self-check for hub WP8: the image sitemap builder (absolute https only, caps, escaping, empty file, no junk images) and
// that the main sitemap and robots are wired as intended. No network, no database.
// Run: pnpm dlx tsx scripts/check-image-sitemap.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildImageSitemapXml, normalizeImageUrl, MAX_IMAGES_PER_PAGE, GOOGLE_MAX_IMAGES_PER_PAGE } from '../lib/image-sitemap'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const SITE = 'https://travelfunbiz.ca'

check('cap per page is below Google\'s 1000', MAX_IMAGES_PER_PAGE <= 10 && MAX_IMAGES_PER_PAGE < GOOGLE_MAX_IMAGES_PER_PAGE)
check('https address passes', normalizeImageUrl('https://images.pexels.com/photos/1/a.jpeg?w=800', SITE) === 'https://images.pexels.com/photos/1/a.jpeg?w=800')
check('root-relative path becomes absolute https', normalizeImageUrl('/images/a.jpg', SITE) === 'https://travelfunbiz.ca/images/a.jpg')
check('http address rejected', normalizeImageUrl('http://example.com/a.jpg', SITE) === null)
check('protocol-relative rejected', normalizeImageUrl('//example.com/a.jpg', SITE) === null)
check('javascript and data addresses rejected', normalizeImageUrl('javascript:alert(1)', SITE) === null && normalizeImageUrl('data:image/png;base64,AAAA', SITE) === null)
check('svg rejected', normalizeImageUrl('https://x.test/a.svg', SITE) === null)
check('site default asset rejected', normalizeImageUrl('/assets/defaults/blog.jpg', SITE) === null)
check('rendered share card rejected', normalizeImageUrl('https://travelfunbiz.ca/og/blog/some-post', SITE) === null)
check('credentials in the address rejected', normalizeImageUrl('https://user:pw@x.test/a.jpg', SITE) === null)
check('blank rejected', normalizeImageUrl('  ', SITE) === null && normalizeImageUrl(null, SITE) === null)

const xml = buildImageSitemapXml(
  [
    { path: '/blog/a-post', images: [{ url: 'https://cdn.test/a.jpg?x=1&y=2', title: 'Cover of "A & B"' }, { url: 'https://cdn.test/a.jpg?x=1&y=2', title: 'dupe' }, { url: 'http://cdn.test/insecure.jpg' }] },
    { path: '/packages/trip', images: [{ url: '/images/trip.jpg', title: 'The trip' }] },
    { path: '/guide-without-photo', images: [{ url: null }] },
    { path: 'no-leading-slash', images: [{ url: 'https://cdn.test/x.jpg' }] },
  ],
  SITE + '/',
)
check('namespaces declared', xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"') && xml.includes('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'))
check('page loc is absolute https', xml.includes('<loc>https://travelfunbiz.ca/blog/a-post</loc>') && !xml.includes('travelfunbiz.ca//'))
check('& in a URL and a title is escaped', xml.includes('a.jpg?x=1&amp;y=2') && xml.includes('Cover of &quot;A &amp; B&quot;'))
check('duplicate picture on a page listed once', (xml.match(/cdn\.test\/a\.jpg/g) ?? []).length === 1)
check('insecure picture dropped', !xml.includes('insecure.jpg'))
check('relative picture made absolute', xml.includes('<image:loc>https://travelfunbiz.ca/images/trip.jpg</image:loc>'))
check('page with no usable picture is left out', !xml.includes('guide-without-photo') && !xml.includes('no-leading-slash'))
check('every image:loc is https', [...xml.matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].every((m) => m[1].startsWith('https://')))
check('title element only where there is text', buildImageSitemapXml([{ path: '/a', images: [{ url: 'https://x.test/a.jpg' }] }], SITE).includes('<image:title>') === false)
const many = buildImageSitemapXml([{ path: '/many', images: Array.from({ length: 40 }, (_, i) => ({ url: `https://x.test/${i}.jpg` })) }], SITE)
check('at most the cap per page', (many.match(/<image:image>/g) ?? []).length === MAX_IMAGES_PER_PAGE)
const empty = buildImageSitemapXml([], SITE)
check('no pages gives a valid empty urlset', /<urlset [^>]*>\n<\/urlset>/.test(empty) && empty.startsWith('<?xml'))
const stack: string[] = []
let ok = true
for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z:]+)[^>]*?>/g)) {
  if (m[1]) { if (stack.pop() !== m[2]) { ok = false; break } } else stack.push(m[2])
}
check('tags are balanced', ok && stack.length === 0)

// ---- wiring ----
check('main sitemap.ts is not touched (still no image entries)', !/image:image|images:/.test(read('app/sitemap.ts')))
const robots = read('app/robots.ts')
check('robots.ts lists both sitemaps', /sitemap: \[absoluteUrl\('\/sitemap\.xml'\), absoluteUrl\('\/sitemap-images\.xml'\)\]/.test(robots))
check('route exists and is cached for an hour', /revalidate = 3600/.test(read('app/sitemap-images.xml/route.ts')) && /buildImageSitemapXml/.test(read('app/sitemap-images.xml/route.ts')))
const data = read('lib/image-sitemap-data.ts')
check('data layer reads published rows only through the public client', /status', 'published'/.test(data) && /getPublishedPosts/.test(data) && /getAllPublishedPackages/.test(data) && !/getSupabaseAdmin/.test(data))
check('data layer keeps safe (thin) guides out, like the main sitemap', /withoutThinPages/.test(data))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
