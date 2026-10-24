// Offline check for the images loop: the image quality gate, the news cover card, the cover backfill plan, structured-data images,
// alt text, and the wiring (autoblog, news publish, OG route, admin counter, pages). No network, no database.
// Run: pnpm dlx tsx scripts/check-images-loop.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assessCover, coverAlt, coverKey, countWithoutGoodCover, heroAlt, inferDimensions, isGenericAlt, isOgCardUrl, isSvgUrl } from '../lib/image-quality'
import { buildNewsCard, newsCardKind, newsCoverAlt, newsCoverUrl, newsHeadlineOf } from '../lib/news-cover'
import { planBackfill, type BackfillRow } from '../lib/cover-backfill'
import { OG_PREFIXES, ogImageUrl, parseOgPath, structuredImages } from '../lib/og-path'
import { buildNewsPostRow } from '../lib/news-publish'
import { countPostsWithoutGoodCover } from '../lib/posts-page-summary'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const PEX = 'https://images.pexels.com/photos/1/a.jpeg'
const PEX2 = 'https://images.pexels.com/photos/2/b.jpeg'

// --- the quality gate ---
expect('a normal Pexels cover with a real alt is good', assessCover({ url: PEX, alt: 'Beach in Cancun at sunset' }).good)
expect('missing cover is bad', assessCover({ url: null }).problems.includes('missing') && assessCover({ url: '  ' }).problems.includes('missing'))
expect('an SVG default is bad (social sites cannot draw it)', assessCover({ url: '/assets/defaults/news.svg' }).problems.includes('svg') && assessCover({ url: 'https://x.test/a.svg?v=2' }).problems.includes('svg'))
expect('a default asset path is bad even when not svg', assessCover({ url: '/assets/defaults/blog.png' }).problems.includes('default_asset'))
expect('known tiny size is bad, 1200x630 is fine', assessCover({ url: PEX, width: 640, height: 480 }).problems.includes('tiny') && assessCover({ url: PEX, width: 1200, height: 630 }).good)
expect('a Pexels address asking for w=480 is tiny', assessCover({ url: `${PEX}?w=480` }).problems.includes('tiny') && inferDimensions(`${PEX}?w=1600`).width === 1600)
expect('wrong-subject alt is bad', assessCover({ url: PEX, alt: 'Laptop on a desk in an office' }).problems.includes('banned_subject'))
expect('a real place with an allowed phrase is not banned', assessCover({ url: PEX, alt: 'The old post office in Lisbon' }).good)
expect('a repeated picture is a duplicate, a rendered card never is', assessCover({ url: `${PEX}?w=1200`, alt: 'Cancun beach' }, { otherCovers: new Set([coverKey(PEX)]) }).problems.includes('duplicate') && assessCover({ url: 'https://www.travelfunbiz.ca/og/blog/x', alt: 'x y z' }, { otherCovers: new Set([coverKey('https://www.travelfunbiz.ca/og/blog/x')]) }).good)
expect('a broken address is bad', assessCover({ url: PEX, alt: 'Cancun beach' }, { broken: true }).problems.includes('broken'))
expect('alt needs fixing when blank, generic or a filename; the cover is still good', assessCover({ url: PEX, alt: '' }).needsAlt && assessCover({ url: PEX, alt: 'image' }).needsAlt && isGenericAlt('IMG_1234.jpg') && !isGenericAlt('Aerial view of Santorini caldera') && assessCover({ url: PEX, alt: 'image' }).good)
expect('og card urls and svg urls are told apart', isOgCardUrl('https://www.travelfunbiz.ca/og/news/news-x-abc123') && isOgCardUrl('/og/blog/x') && !isOgCardUrl(PEX) && isSvgUrl('/assets/defaults/guide.svg') && !isSvgUrl(PEX))

// --- the counter ---
const covers = [
  { url: PEX, alt: 'Cancun beach', date: '2026-01-01' },
  { url: `${PEX}?w=1400`, alt: 'Cancun beach again', date: '2026-02-01' }, // repeat of the first: bad
  { url: null, alt: null, date: '2026-03-01' }, // missing: bad
  { url: '/assets/defaults/blog.svg', alt: 'x', date: '2026-03-02' }, // default svg: bad
  { url: PEX2, alt: 'Lisbon trams', date: '2026-03-03' },
]
expect('counter counts missing, svg and repeated covers, once each (the earliest keeps the picture)', countWithoutGoodCover(covers) === 3, String(countWithoutGoodCover(covers)))
expect('counter ignores drafts and scheduled posts', countPostsWithoutGoodCover([
  { status: 'draft', publish_date: null, cover_image_url: null },
  { status: 'published', publish_date: '2099-01-01', cover_image_url: null },
  { status: 'published', publish_date: '2026-01-01', cover_image_url: PEX, alt_text: 'Cancun beach' },
  { status: 'published', publish_date: '2026-01-02', cover_image_url: null },
], '2026-10-22') === 1)

// --- alt text ---
expect('cover alt keeps a useful photo description and adds the place', coverAlt({ destination: 'Cancun', photoAlt: 'Aerial view of a turquoise sea' }) === 'Cancun: Aerial view of a turquoise sea')
expect('cover alt skips a banned photo description and uses place and topic', coverAlt({ destination: 'Cancun', keyword: 'family resorts', photoAlt: 'Laptop on a desk' }) === 'Cancun: family resorts')
expect('cover alt is never empty or "image"', coverAlt({ title: 'Best time for Greece' }) === 'Best time for Greece' && coverAlt({}) === 'Travel photo')
expect('hero alt names the place and the subject when the stored alt is generic or missing', heroAlt('image', 'Cancun') === 'Cancun: illustrative stock travel photo' && heroAlt(null, 'Cancun') === 'Cancun: illustrative stock travel photo' && heroAlt('Beach with palm trees', 'Cancun') === 'Cancun: Beach with palm trees' && heroAlt('Cancun hotel zone at dusk', 'Cancun') === 'Cancun hotel zone at dusk')

// --- the news card ---
const headline = 'Tropical Storm Rafael forms near Jamaica'
const card = buildNewsCard({ title: `News: ${headline}`, tags: ['travel-news', 'storm'], sourceName: 'the US National Hurricane Center' })
expect('news card: storm kind, headline without the News: prefix, source line', card.kind === 'storm' && card.title === headline && card.kindLabel === 'Storm update' && card.sourceLine === 'Source: US National Hurricane Center')
expect('news card kinds: advisory and plain news', newsCardKind(['travel-news', 'advisory']) === 'advisory' && newsCardKind(['travel-news', 'airline']) === 'news' && newsCardKind(null) === 'news' && buildNewsCard({ title: 'x y' }).sourceLine === 'A short brief for travellers')
expect('news cover url is the /og/news/<slug> card, alt is the headline', /^https?:\/\/[^/]+\/og\/news\/news-abc$/.test(newsCoverUrl('news-abc')) && newsCoverAlt(`News: ${headline}`) === headline && newsHeadlineOf('  news:  A  B ') === 'A B')
expect('og route accepts /og/news/<slug> and rejects a path with an extra segment', JSON.stringify(parseOgPath(['news', 'news-abc'])) === '{"prefix":"news","slug":"news-abc"}' && parseOgPath(['news', 'a', 'b']) === null && (OG_PREFIXES as readonly string[]).includes('news'))
const row = buildNewsPostRow(
  { item: { id: 'abcdef123', title: 't', url: 'https://www.nhc.noaa.gov/x', published_at: '2026-10-20T00:00:00Z', fetched_at: '2026-10-20T00:00:00Z', category: 'storm' }, facts: { sourceName: 'the US National Hurricane Center' }, brief: { headline, happened: 'A storm formed.', means: ['Check your flights.'] } as never, publish: true, calls: 1, now: new Date('2026-10-22T12:00:00Z') },
  '',
)
expect('a new news post row carries its news card as cover and the headline as alt', row.cover_image_url === newsCoverUrl(String(row.slug)) && row.alt_text === headline, JSON.stringify([row.cover_image_url, row.alt_text]))
expect('that news cover passes the quality gate', assessCover({ url: String(row.cover_image_url), alt: String(row.alt_text) }).good)

// --- structured data images ---
const si = structuredImages(PEX, 'blog', 'my-post')
expect('structured images: real cover first, then the 1200x630 card', si.length === 2 && si[0] === PEX && si[1] === ogImageUrl('blog', 'my-post'))
expect('structured images: no cover, an svg or a default gives only the card, never the stock beach photo', structuredImages(null, 'destinations', 'cancun').length === 1 && structuredImages('/assets/defaults/blog.svg', 'blog', 'x').length === 1 && structuredImages('', 'blog', 'x')[0].endsWith('/og/blog/x'))
expect('structured images: a site path is made absolute; the card itself is not listed twice', /^https?:\/\//.test(structuredImages('/uploads/a.jpg', 'blog', 'x')[0]) && structuredImages(ogImageUrl('blog', 'x'), 'blog', 'x').length === 1)

// --- the backfill plan ---
const rows: BackfillRow[] = [
  { table: 'posts', id: '1', slug: 'good-post', title: 'Good post', tags: [], date: '2026-01-01', cover: PEX, alt: 'Cancun beach at sunset' },
  { table: 'posts', id: '2', slug: 'good-no-alt', title: 'Lisbon in a weekend', tags: [], date: '2026-01-02', cover: PEX2, alt: null },
  { table: 'posts', id: '3', slug: 'no-cover', title: 'Cruise tips', tags: [], date: '2026-01-03', cover: null, alt: null },
  { table: 'posts', id: '4', slug: 'news-storm-abc123', title: 'News: Storm near Cuba', tags: ['travel-news', 'storm'], date: '2026-01-04', cover: null, alt: null },
  { table: 'posts', id: '5', slug: 'repeat', title: 'Repeat', tags: [], date: '2026-01-05', cover: `${PEX}?auto=compress`, alt: 'Cancun beach again' },
  { table: 'posts', id: '6', slug: 'broken', title: 'Broken', tags: [], date: '2026-01-06', cover: 'https://images.pexels.com/photos/9/gone.jpeg', alt: 'A lovely beach' },
  { table: 'posts', id: '7', slug: 'svg', title: 'Old svg cover post', tags: [], date: '2026-01-07', cover: '/assets/defaults/blog.svg', alt: 'x y' },
  { table: 'guides', id: 'g1', slug: 'cancun', guideKind: 'destinations', title: 'Cancun', date: '2026-01-01', cover: PEX2.replace('/2/', '/3/'), alt: null },
  { table: 'guides', id: 'g2', slug: 'tulum', guideKind: 'destinations', title: 'Tulum', date: '2026-01-02', cover: null, alt: null },
]
const plan = planBackfill(rows, { 'https://images.pexels.com/photos/9/gone.jpeg': { ok: false } })
const by = (slug: string) => plan.find((a) => a.slug === slug)
expect('plan: a good cover with a good alt is left completely alone', !by('good-post'))
expect('plan: a good cover with no alt only gets alt text (the cover is kept)', by('good-no-alt')?.source === 'alt-only' && by('good-no-alt')?.set.cover === undefined && !!by('good-no-alt')?.set.alt)
expect('plan: a post with no cover gets its branded card and alt', by('no-cover')?.source === 'branded-card' && by('no-cover')?.set.cover === ogImageUrl('blog', 'no-cover') && !!by('no-cover')?.set.alt)
expect('plan: a news post gets the teal news card, alt is the headline', by('news-storm-abc123')?.source === 'news-card' && by('news-storm-abc123')?.set.cover === newsCoverUrl('news-storm-abc123') && by('news-storm-abc123')?.set.alt === 'Storm near Cuba')
expect('plan: the later post with a repeated picture is replaced, the earlier is kept', by('repeat')?.source === 'branded-card' && !by('good-post'))
expect('plan: a broken cover is replaced', by('broken')?.source === 'branded-card' && /does not load/.test(by('broken')?.reasons.join(' ') ?? ''))
expect('plan: an svg default is replaced', by('svg')?.source === 'branded-card')
expect('plan: a guide with a good hero and no alt only gets alt; a guide with no hero is listed as needs-photo, never given a drawn card', by('cancun')?.source === 'alt-only' && by('cancun')?.set.alt === 'Cancun: illustrative stock travel photo' && by('tulum')?.source === 'needs-photo' && Object.keys(by('tulum')?.set ?? {}).length === 0)
expect('plan never touches a row it did not need to (8 changes of 9 rows)', plan.length === 8, String(plan.length))
const again = planBackfill(rows.map((r) => { const a = plan.find((p) => p.id === r.id && p.table === r.table); return a ? { ...r, cover: a.set.cover ?? r.cover, alt: a.set.alt ?? r.alt } : r }), { })
expect('plan is stable: applying it and planning again leaves only the guide that needs a photo', again.length === 1 && again[0].source === 'needs-photo', JSON.stringify(again.map((a) => [a.slug, a.source])))

// --- wiring (source checks) ---
const autoblog = read('lib/autoblog-run.ts')
expect('autoblog always asks for a cover with the destination and the card fallback, and saves cover and alt', /attachAutoblogCoverImage\(admin, imageSearchTerm, final\.slug, \{[^}]*destination:[^}]*cardFallback: true/.test(autoblog) && /cover_image_url: image\?\.cover_image_url \?\? null/.test(autoblog) && /alt_text: coverAltText/.test(autoblog) && /image\?\.alt_text \?\? null/.test(autoblog))
const blogImage = read('lib/blog-image.ts')
expect('blog image: destination goes into the search, alt comes from coverAlt, the last resort is the branded card', /findDestinationPhoto\(query\)/.test(blogImage) && /coverAlt\(/.test(blogImage) && /ogImageUrl\('blog'/.test(blogImage))
expect('news publish stores the card cover and alt', /cover_image_url: newsCoverUrl\(slug\)/.test(read('lib/news-publish.ts')))
const route = read('app/og/[...path]/route.tsx')
expect('og route draws a teal news theme with a source line', /theme === 'news'/.test(route) && /sourceLine/.test(route))
expect('og resolver draws news posts as the news card and ignores a card as a photo (no self fetch)', /isNewsPost\(post\)\) return newsContent/.test(read('lib/og-image.ts')) && /!isOgCardUrl\(v\)/.test(read('lib/og-image.ts')))
const blogAdmin = read('app/admin/blog/page.tsx')
expect('admin blog header shows Posts without a good cover', /Posts without a good cover/.test(blogAdmin) && /countPostsWithoutGoodCover/.test(blogAdmin) && /cells=\{cells\}/.test(blogAdmin))
const blogPage = read('app/blog/[slug]/page.tsx')
expect('blog page: hero is high priority with width and height; JSON-LD uses the cover plus the 1200x630 card', /fetchPriority="high"/.test(blogPage) && /width=\{1200\} height=\{675\}/.test(blogPage) && /structuredImages\(post\.cover_image_url, "blog", post\.slug\)/.test(blogPage) && !/image: \[image, DEFAULT_OG_IMAGE\]/.test(blogPage))
const guidePage = read('components/guide-page.tsx')
const destPage = read('app/destinations/[slug]/page.tsx')
expect('guide and destination pages: hero has descriptive alt, size, high priority; JSON-LD has the card', [guidePage, destPage].every((s) => /heroAlt\(guide\.hero_alt, guide\.name\)/.test(s) && /width=\{1200\}/.test(s) && /fetchPriority="high"/.test(s)) && /structuredImages\(guide\.hero_image_url/.test(guidePage) && /structuredImages\(guide\?\.hero_image_url, "destinations"/.test(destPage))
const script = read('scripts/backfill-covers.ts')
expect('backfill script is a dry run unless --yes, and never runs Pexels without --yes', /const apply = process\.argv\.includes\('--yes'\)/.test(script) && /--pexels writes the recent-photo history, so it needs --yes/.test(script))
expect('copy has no em dashes in the new files', ['lib/image-quality.ts', 'lib/news-cover.ts', 'lib/cover-backfill.ts', 'scripts/backfill-covers.ts', 'docs/factory/IMAGES-LOOP.md'].every((f) => { try { return !read(f).includes('—') } catch { return true } }))

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll image loop checks passed')
