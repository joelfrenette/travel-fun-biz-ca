// Offline self-check for hub WP7: the four security headers (and what is deliberately absent), the robots policy left alone,
// the RSS 2.0 builder (valid XML, absolute links, escaping, newest 20), the /feed.xml and /blog/rss.xml routes, the feed link
// in the root layout, and that the cache-mirror matcher does not touch the feed.
// Run: pnpm dlx tsx scripts/check-head-hygiene.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildRssXml, escapeXml, FEED_LIMIT, type RssPost } from '../lib/rss'
import { decideRoute, isMirroredPath } from '../lib/cache-routing'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ---- headers ----
const headers = JSON.parse(read('data/security-headers.json')) as { key: string; value: string }[]
const h = (k: string) => headers.find((x) => x.key === k)?.value
check('X-Content-Type-Options nosniff', h('X-Content-Type-Options') === 'nosniff')
check('Referrer-Policy strict-origin-when-cross-origin', h('Referrer-Policy') === 'strict-origin-when-cross-origin')
check('X-Frame-Options SAMEORIGIN', h('X-Frame-Options') === 'SAMEORIGIN')
check('Permissions-Policy denies camera, microphone, geolocation', h('Permissions-Policy') === 'camera=(), microphone=(), geolocation=()')
check('no HSTS and no CSP in our list', !headers.some((x) => /strict-transport|content-security/i.test(x.key)))
const cfg = read('next.config.mjs')
check('next.config.mjs serves the list on every path', /async headers\(\)/.test(cfg) && /source: '\/:path\*'/.test(cfg) && /security-headers\.json/.test(cfg))
check('next.config.mjs redirects untouched (apex redirect stays in Vercel)', /async redirects\(\)/.test(cfg))
// A page that really used the camera, microphone or location would break under the policy: scan the app source.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${name}`
    if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out)
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(rel)
  }
  return out
}
const users = [...walk('app'), ...walk('components'), ...walk('lib')].filter((f) => /getUserMedia|navigator\.geolocation|mediaDevices|\.getCurrentPosition|\.watchPosition/.test(read(f)))
check('no page uses camera, microphone or geolocation APIs', users.length === 0, users)

// ---- robots and apex left alone ----
const robots = read('app/robots.ts')
check('robots.ts keeps the allow-all policy (no AI-crawler lines added)', /userAgent: '\*', allow: '\/'/.test(robots) && !/GPTBot|ClaudeBot|PerplexityBot|Google-Extended|OAI-SearchBot/.test(robots))
check('robots.ts still lists /sitemap.xml', /sitemap\.xml/.test(robots))

// ---- rss ----
const mk = (i: number, extra: Partial<RssPost> = {}): RssPost => ({ slug: `post-${i}`, title: `Post ${i}`, publish_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), updated_at: '2026-01-01T00:00:00Z', meta_description: `About post ${i}`, body: '## H\ntext', ...extra })
const now = new Date('2026-10-24T00:00:00Z')
const posts = Array.from({ length: 30 }, (_, i) => mk(i))
const xml = buildRssXml({ siteName: 'Travel & Fun', siteUrl: 'https://travelfunbiz.ca/', feedPath: '/feed.xml', posts, limit: FEED_LIMIT, now })
const items = xml.match(/<item>/g) ?? []
check('feed: latest 20 only', items.length === 20 && FEED_LIMIT === 20, items.length)
check('feed: newest first', xml.indexOf('post-29') < xml.indexOf('post-28') && !xml.includes('/blog/post-9<'))
check('feed: RSS 2.0 with an XML declaration', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && /<rss version="2\.0"/.test(xml))
check('feed: every link is absolute https', [...xml.matchAll(/<link>([^<]*)<\/link>/g)].every((m) => /^https:\/\/travelfunbiz\.ca\//.test(m[1])))
check('feed: no double slash from a trailing-slash site url', !/https:\/\/travelfunbiz\.ca\/\/blog/.test(xml))
check('feed: guid is the permalink', /<guid isPermaLink="true">https:\/\/travelfunbiz\.ca\/blog\/post-29<\/guid>/.test(xml))
check('feed: atom self link points at /feed.xml', /<atom:link href="https:\/\/travelfunbiz\.ca\/feed\.xml" rel="self"/.test(xml))
check('feed: site name is escaped', xml.includes('<title>Travel &amp; Fun Blog</title>'))
const nasty = buildRssXml({ siteName: 'S', siteUrl: 'https://s.test', feedPath: '/feed.xml', posts: [mk(1, { title: 'A <b>"quoted"</b> & it\'s \u0001 odd', meta_description: 'x ]]> <script>' })], now })
check('feed: markup in a title or description is escaped', nasty.includes('A &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; &amp; it&apos;s  odd') && !nasty.includes('<script>') && !nasty.includes('\u0001'), nasty)
check('feed: description falls back to an excerpt', buildRssXml({ siteName: 'S', siteUrl: 'https://s.test', feedPath: '/feed.xml', posts: [mk(1, { meta_description: null, body: 'Plain words here.' })], now }).includes('<description>Plain words here.</description>'))
check('feed: a future-dated post is left out', !buildRssXml({ siteName: 'S', siteUrl: 'https://s.test', feedPath: '/feed.xml', posts: [mk(1, { publish_date: '2027-01-01T00:00:00Z' })], now }).includes('<item>'))
check('feed: a bad date is left out, not written as "Invalid Date"', !buildRssXml({ siteName: 'S', siteUrl: 'https://s.test', feedPath: '/feed.xml', posts: [mk(1, { publish_date: 'nope', updated_at: 'also nope' })], now }).includes('Invalid Date'))
check('feed: no posts gives a valid empty channel', /<channel>[\s\S]*<\/channel>/.test(buildRssXml({ siteName: 'S', siteUrl: 'https://s.test', feedPath: '/feed.xml', posts: [], now })))
check('feed: no limit lists every post', (buildRssXml({ siteName: 'S', siteUrl: 'https://s.test', feedPath: '/blog/rss.xml', posts, now }).match(/<item>/g) ?? []).length === 30)
check('escapeXml covers the five characters', escapeXml(`&<>"'`) === '&amp;&lt;&gt;&quot;&apos;')
// Structural well-formedness: every opened tag is closed in order.
const stack: string[] = []
let wellFormed = true
for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z:]+)[^>]*?(\/?)>/g)) {
  if (m[3]) continue
  if (m[1]) { if (stack.pop() !== m[2]) { wellFormed = false; break } } else stack.push(m[2])
}
check('feed: tags are balanced', wellFormed && stack.length === 0)

// ---- routes and layout ----
const feedRoute = read('app/feed.xml/route.ts')
check('/feed.xml route: uses the shared builder, 20 posts, revalidates hourly', /buildRssXml/.test(feedRoute) && /limit: FEED_LIMIT/.test(feedRoute) && /revalidate = 3600/.test(feedRoute))
check('/blog/rss.xml reuses the same builder (no second copy)', /buildRssXml/.test(read('app/blog/rss.xml/route.ts')) && !/escapeXml/.test(read('app/blog/rss.xml/route.ts')))
check('feed is cacheable for an hour', /max-age=3600/.test(read('lib/rss.ts')))
check('root layout links the feed', /<link rel="alternate" type="application\/rss\+xml"[^>]*href="\/feed\.xml"/.test(read('app/layout.tsx')))

// ---- cache mirror ----
check('mirror matcher does not mirror /feed.xml', !isMirroredPath('/feed.xml') && decideRoute({ enabled: true, method: 'GET', pathname: '/feed.xml', langCookie: undefined, currencyCookie: undefined, defaultCurrency: 'cad' }).action === 'pass')
check('mirror matcher does not mirror /sitemap-images.xml', !isMirroredPath('/sitemap-images.xml'))
check('middleware matcher does not include the feed', !/feed\.xml/.test(read('middleware.ts')))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
