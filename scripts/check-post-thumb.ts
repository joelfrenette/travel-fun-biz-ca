// Offline check: default post thumbnails (lib/post-defaults.ts), the "Posts: ..." sidebar entries (lib/admin-nav.ts)
// and the shared Posts page pieces. Run: pnpm dlx tsx scripts/check-post-thumb.ts   (exit 1 on a failure)
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_THUMBS, THUMB_TYPES, defaultThumb, ownImage, publicPostImage, resolveThumb, thumbTypeFor, usableImageUrl } from '../lib/post-defaults'
import { countPostStatuses } from '../lib/posts-page-summary'
import { adminNavItems, adminTools } from '../lib/admin-nav'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// --- fallback selection per type ---
expect('four kinds, each with its own default', THUMB_TYPES.length === 4 && new Set(Object.values(DEFAULT_THUMBS)).size === 4)
expect('blog, news, guide, trip map to their own default', THUMB_TYPES.every((t) => defaultThumb(t) === DEFAULT_THUMBS[t]))
expect('a trip recap uses the trip default', thumbTypeFor('recap') === 'trip' && defaultThumb('recap') === DEFAULT_THUMBS.trip)
expect('an unknown or empty kind uses the blog default', defaultThumb('nonsense') === DEFAULT_THUMBS.blog && defaultThumb(null) === DEFAULT_THUMBS.blog && defaultThumb(undefined) === DEFAULT_THUMBS.blog)
expect('own cover wins', resolveThumb({ cover_image_url: 'https://images.pexels.com/a.jpg' }, 'news').src === 'https://images.pexels.com/a.jpg' && !resolveThumb({ cover_image_url: 'https://images.pexels.com/a.jpg' }, 'news').isDefault)
expect('order is cover, then hero, then image', ownImage({ cover_image_url: '', hero_image_url: 'https://x.test/h.jpg', image_url: 'https://x.test/i.jpg' }) === 'https://x.test/h.jpg' && ownImage({ image_url: 'https://x.test/i.jpg' }) === 'https://x.test/i.jpg')
expect('no image falls back to the type default', resolveThumb({ cover_image_url: null }, 'news').src === DEFAULT_THUMBS.news && resolveThumb({}, 'guide').isDefault && resolveThumb(null, 'trip').src === DEFAULT_THUMBS.trip)
expect('blank, bare-word and script addresses are ignored', usableImageUrl('  ') === null && usableImageUrl('photo.jpg') === null && usableImageUrl('javascript:alert(1)') === null && usableImageUrl('//evil.test/x.jpg') === null)
expect('site paths and https addresses are accepted', usableImageUrl('/uploads/a.png') === '/uploads/a.png' && usableImageUrl('https://a.test/b.jpg') === 'https://a.test/b.jpg')
expect('public site: a news post with a null cover gets the news default', publicPostImage({ slug: 'news-storm-update', tags: ['travel-news'], related_package_id: null, cover_image_url: null }) === DEFAULT_THUMBS.news)
expect('public site: a plain post with no cover gets the blog default, one with a cover keeps it', publicPostImage({ slug: 'a-post', tags: [], related_package_id: null, cover_image_url: null }) === DEFAULT_THUMBS.blog && publicPostImage({ slug: 'a-post', tags: [], related_package_id: null, cover_image_url: 'https://a.test/c.jpg' }) === 'https://a.test/c.jpg')

// --- defaults exist on disk, light, 4:3, brand colours ---
for (const t of THUMB_TYPES) {
  const rel = join('public', DEFAULT_THUMBS[t])
  const ok = existsSync(join(root, rel))
  expect(`${t} default exists on disk (${DEFAULT_THUMBS[t]})`, ok)
  if (!ok) continue
  const svg = read(rel)
  expect(`${t} default is a small SVG, 4:3, with the site strip`, statSync(join(root, rel)).size < 4096 && /viewBox="0 0 400 300"/.test(svg) && /TRAVELFUNBIZ\.CA/.test(svg))
  expect(`${t} default has no embedded images or scripts`, !/<image|<script|href=/i.test(svg))
}
expect('blog is the brand red', /#d81f26/i.test(read('public/assets/defaults/blog.svg')))
expect('news is teal', /#0f6b63/i.test(read('public/assets/defaults/news.svg')))
const accent = (t: string) => (read(`public/assets/defaults/${t}.svg`).match(/<rect x="50" y="52"[^>]*fill="(#[0-9a-f]{6})"/i) ?? [])[1]
expect('all four accents are different', new Set(THUMB_TYPES.map(accent)).size === 4, THUMB_TYPES.map(accent).join(','))

// --- header counts ---
const c = countPostStatuses([{ status: 'published', publish_date: '2026-01-01' }, { status: 'published', publish_date: '2099-01-01' }, { status: 'draft', publish_date: null }], '2026-10-22')
expect('counts: published, scheduled (future date), draft', c.total === 3 && c.published === 1 && c.scheduled === 1 && c.draft === 1)

// --- sidebar entries ---
const titles = adminNavItems.map((i) => i.title)
const posts = adminNavItems.filter((i) => i.title.startsWith('Posts: '))
expect('sidebar has Posts: Blog, News, Guides, Trips', ['Posts: Blog', 'Posts: News', 'Posts: Guides', 'Posts: Trips'].every((t) => titles.includes(t)))
expect('links go to the right screens', adminNavItems.find((i) => i.title === 'Posts: Blog')?.href === '/admin/blog' && adminNavItems.find((i) => i.title === 'Posts: News')?.href === '/admin/news' && adminNavItems.find((i) => i.title === 'Posts: Guides')?.href === '/admin/guides' && adminNavItems.find((i) => i.title === 'Posts: Trips')?.href === '/admin/packages')
expect('the auto-writer link is kept and points at the autoblog tab', adminNavItems.find((i) => i.title === 'Posts: Blog Auto-Writer')?.href === '/admin/blog?tab=autoblog')
expect('the Posts entries sit together, right after Post Distribution', (() => { const i = titles.indexOf('Post Distribution'); const n = posts.length; return i >= 0 && titles.slice(i + 1, i + 1 + n).every((t) => t.startsWith('Posts: ')) })(), titles.join(' | '))
expect('the tool list is alphabetical', adminTools.every((t, i, a) => i === 0 || a[i - 1].title.localeCompare(t.title) <= 0))
expect('old titles are gone', !['Blog', 'News (Feeds and Briefs)', 'Guide Pages', 'Travel Packages', 'Blog Auto-Writer'].some((t) => titles.includes(t)))
expect('no duplicate titles or links', new Set(titles).size === titles.length && (() => { const h = adminNavItems.map((i) => i.href).filter(Boolean); return new Set(h).size === h.length })())

// --- wiring ---
const list = read('components/admin/blog-posts-list.tsx')
expect('the shared list shows a thumbnail, takes lockedType and extraActions, and does not fork', /<PostThumb/.test(list) && /lockedType/.test(list) && /extraActions/.test(list))
expect('the news page uses the shared list, the shared header and the automation card', /lockedType="news"/.test(read('app/admin/news/page.tsx')) && /PostsPageHeader/.test(read('app/admin/news/page.tsx')) && /PostsAutomationCard type="news"/.test(read('app/admin/news/page.tsx')))
expect('the blog page uses the shared header and the automation card', /PostsPageHeader/.test(read('app/admin/blog/page.tsx')) && /PostsAutomationCard type="blog"/.test(read('app/admin/blog/page.tsx')))
expect('the news items table shows a thumbnail', /<PostThumb type="news"/.test(read('app/admin/news/page.tsx')))
expect('the public blog list and post page use the default image', /publicPostImage/.test(read('app/blog/page.tsx')) && /publicPostImage/.test(read('app/blog/[slug]/page.tsx')))
expect('the thumbnail falls back when the image fails to load', /onError/.test(read('components/admin/post-thumb.tsx')) && /loading="lazy"/.test(read('components/admin/post-thumb.tsx')))
// phase 2: the Guides and Trips pages use the same family
expect('the guides list shows a guide thumbnail (hero image, else the guide default)', /<PostThumb type="guide" src=\{r\.hero_image_url\}/.test(read('app/admin/guides/page.tsx')) && defaultThumb('guide') === DEFAULT_THUMBS.guide)
expect('the trips table shows a trip thumbnail (image_url, else the trip default)', /<PostThumb type="trip" src=\{pkg\.image_url\}/.test(read('app/admin/packages/page.tsx')) && resolveThumb({ image_url: null }, 'trip').src === DEFAULT_THUMBS.trip)
expect('a guide with a hero image keeps it, one without gets the guide default', resolveThumb({ hero_image_url: 'https://a.test/h.jpg' }, 'guide').src === 'https://a.test/h.jpg' && resolveThumb({ hero_image_url: '' }, 'guide').src === DEFAULT_THUMBS.guide)
expect('the guides and trips pages use the shared header and their automation card', /PostsPageHeader/.test(read('app/admin/guides/page.tsx')) && /GuidesAutomationCard/.test(read('app/admin/guides/page.tsx')) && /PostsPageHeader/.test(read('app/admin/packages/page.tsx')) && /TripsAutomationCard/.test(read('app/admin/packages/page.tsx')))
expect('the shared header can show custom cells', /cells\?:/.test(read('components/admin/posts-page-header.tsx')))
for (const f of ['app/api/admin/posts/automation/route.ts', 'app/api/admin/news/feeds/route.ts']) {
  expect(`${f} checks isAuthorized first in every handler`, (() => { const s = read(f); const handlers = (s.match(/export async function (GET|POST)/g) ?? []).length; return handlers > 0 && (s.match(/if \(!isAuthorized\(request\)\)/g) ?? []).length === handlers })())
}

// --- no em dashes in what this change adds ---
const EM = String.fromCharCode(0x2014)
const files = [
  'lib/post-defaults.ts', 'lib/posts-page-summary.ts', 'components/admin/post-thumb.tsx', 'components/admin/posts-page-header.tsx', 'components/admin/posts-automation-card.tsx',
  'app/api/admin/posts/automation/route.ts', 'components/admin/guides-automation-card.tsx', 'components/admin/trips-automation-card.tsx', 'lib/posts-menu-2.ts', 'scripts/check-post-thumb.ts', 'public/assets/defaults/blog.svg', 'public/assets/defaults/news.svg', 'public/assets/defaults/guide.svg', 'public/assets/defaults/trip.svg',
]
for (const f of files) expect(`no em dash in ${f}`, !read(f).includes(EM))
const navSrc = read('lib/admin-nav.ts')
expect('no em dash in admin-nav titles', !navSrc.split('\n').filter((l) => /title:/.test(l)).some((l) => l.includes(EM)))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
