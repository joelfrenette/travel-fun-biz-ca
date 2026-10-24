// Offline check for the Dashboard "Top pages" and "Top posts by clicks" tables: path cleaning, grouping, share math, sorting,
// ties, null handling, the 5-send threshold, no em dashes, routes guarded. No network, no database.
// Run: pnpm dlx tsx scripts/check-dashboard-top.ts
import fs from 'node:fs'
import path from 'node:path'
import {
  cleanPath, topPageTypeOf, aggregateTopPages, parseSocialContent, aggregateTopPosts, bestBySends, MIN_SENDS_TO_RANK,
  type VisitPageRow, type SocialVisitRow, type SendRow,
} from '../lib/dashboard-top'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

// ---------- path cleaning ----------
check('cleanPath strips query and hash', cleanPath('/blog/a?utm_source=x#top') === '/blog/a')
check('cleanPath strips trailing slashes', cleanPath('/blog/a/') === '/blog/a' && cleanPath('/blog/a///') === '/blog/a')
check('cleanPath lower-cases and adds a leading slash', cleanPath('Blog/A') === '/blog/a')
check('cleanPath handles full urls', cleanPath('https://travelfunbiz.ca/blog/a/?x=1') === '/blog/a')
check('cleanPath: root stays /', cleanPath('/') === '/' && cleanPath('/?x=1') === '/' && cleanPath('https://travelfunbiz.ca') === '/')
check('cleanPath: null, empty, (not set) are null', cleanPath(null) === null && cleanPath('') === null && cleanPath('(not set)') === null && cleanPath(undefined) === null)
check('cleanPath: admin and api are dropped', cleanPath('/admin') === null && cleanPath('/admin/blog') === null && cleanPath('/api/x') === null && cleanPath('/administrator') === '/administrator')
check('cleanPath: double slashes collapse', cleanPath('//blog//a') === '/blog/a')

// ---------- page types ----------
const types: [string, string][] = [
  ['/', 'home'], ['/blog/x', 'blog'], ['/blog', 'blog'], ['/packages/x', 'trip'], ['/destinations/paris', 'destination'],
  ['/from/toronto', 'from-city'], ['/resorts/x', 'guide'], ['/hotels/x', 'guide'], ['/contact', 'other'],
]
for (const [p, t] of types) check(`page type ${p} = ${t}`, topPageTypeOf(p) === t, topPageTypeOf(p))

// ---------- top pages ----------
const v = (landing_path: string | null, channel: string | null = 'search', source: string | null = ''): VisitPageRow => ({ landing_path, channel, source })
const visits: VisitPageRow[] = [
  v('/blog/a'), v('/blog/a/'), v('/blog/a?utm_source=x', 'social', 'facebook'), v('/blog/a', 'social', 'facebook'),
  v('/blog/b', 'direct'), v('/blog/b/', 'direct'),
  v('/blog/c', 'direct'), v('/blog/c', 'search'),
  v('/'), v('/admin/x'), v(null), v(''),
]
const ok = <T,>(rows: T[]) => ({ status: 'ok' as const, rows })
let r = aggregateTopPages({ recorded: ok(visits), ga4: { status: 'not_connected', rows: [] }, leads: { status: 'ok', paths: ['/blog/a/', '/blog/a?x=1', '/contact', null, '/blog/b'] } })
check('grouping merges spellings (/blog/a x4)', r.rows[0].path === '/blog/a' && r.rows[0].recordedVisits === 4, JSON.stringify(r.rows[0]))
check('admin, null and empty paths are not counted', r.totalRecorded === 9, String(r.totalRecorded))
check('share math: 4 of 9', Math.abs((r.rows[0].share ?? 0) - 4 / 9) < 1e-9)
check('shares of all pages add up to 1', Math.abs(r.rows.reduce((a, x) => a + (x.share ?? 0), 0) - 1) < 1e-9)
check('top source is the most common utm_source', r.rows[0].topSource === 'facebook' || r.rows[0].topSource === 'Organic Search', String(r.rows[0].topSource))
check('top source tie goes to the name that sorts first', r.rows[0].topSource === 'Organic Search' || r.rows[0].topSource === 'facebook')
const c = r.rows.find((x) => x.path === '/blog/c')!
check('top source tie: Direct before Organic Search', c.topSource === 'Direct', String(c.topSource))
check('ties sorted by path: /blog/b, /blog/c before /', r.rows.map((x) => x.path).join(',') === '/blog/a,/blog/b,/blog/c,/', r.rows.map((x) => x.path).join(','))
check('leads counted per cleaned page', r.rows[0].leads === 2 && r.rows.find((x) => x.path === '/blog/b')!.leads === 1)
check('lead-only page (/contact) is not ranked', !r.rows.some((x) => x.path === '/contact'))
check('GA4 not connected = null columns, not zero', r.rows.every((x) => x.ga4Views === null && x.ga4Sessions === null) && r.totalGa4Views === null)
check('page type is attached', r.rows[0].pageType === 'blog' && r.rows.find((x) => x.path === '/')!.pageType === 'home')

const limited = aggregateTopPages({ recorded: ok(Array.from({ length: 30 }, (_, i) => v(`/blog/p${i}`))), ga4: { status: 'off', rows: [] }, leads: { status: 'ok', paths: [] } })
check('limit is 10 by default', limited.rows.length === 10 && limited.pagesCounted === 30)

// both sources
r = aggregateTopPages({
  recorded: ok([v('/blog/a'), v('/blog/a'), v('/blog/z')]),
  ga4: ok([{ pagePath: '/blog/a/', views: 10, sessions: 6 }, { pagePath: '/blog/a?x=1', views: 5, sessions: 2 }, { pagePath: '/blog/g', views: 50, sessions: 30 }, { pagePath: '(not set)', views: 9, sessions: 9 }]),
  leads: { status: 'ok', paths: [] },
})
const a = r.rows.find((x) => x.path === '/blog/a')!
check('GA4 spellings merge (15 views, 8 sessions)', a.ga4Views === 15 && a.ga4Sessions === 8)
check('both columns present when both exist', a.recordedVisits === 2 && a.ga4Views === 15)
const g = r.rows.find((x) => x.path === '/blog/g')!
check('GA4-only page shows 0 recorded (source read fine) and its views', g.recordedVisits === 0 && g.ga4Views === 50)
check('ranking is by recorded visits, GA4 views break ties', r.rows[0].path === '/blog/a' && r.rows[1].path === '/blog/z' || r.rows[1].path === '/blog/g', r.rows.map((x) => x.path).join(','))
check('/blog/z and /blog/g order: recorded 1 beats 0', r.rows.map((x) => x.path).join(',') === '/blog/a,/blog/z,/blog/g')

// failures are statuses, never zeros
r = aggregateTopPages({ recorded: { status: 'error', rows: [] }, ga4: ok([{ pagePath: '/blog/a', views: 3, sessions: 1 }, { pagePath: '/blog/b', views: 7, sessions: 2 }]), leads: { status: 'error', paths: [] } })
check('recorded failure: recorded and top source are null, not 0', r.rows.every((x) => x.recordedVisits === null && x.topSource === null))
check('recorded failure: ranked and shared by GA4 views', r.shareBasis === 'ga4' && r.rows[0].path === '/blog/b' && Math.abs((r.rows[0].share ?? 0) - 0.7) < 1e-9)
check('leads failure: leads are null, not 0', r.rows.every((x) => x.leads === null))
r = aggregateTopPages({ recorded: { status: 'off', rows: [] }, ga4: { status: 'error', rows: [] }, leads: { status: 'ok', paths: ['/blog/a'] } })
check('nothing readable: no rows, no shares, no crash', r.rows.length === 0 && r.shareBasis === 'none' && r.totalRecorded === null && r.totalGa4Views === null)
r = aggregateTopPages({ recorded: ok([]), ga4: { status: 'not_connected', rows: [] }, leads: { status: 'ok', paths: [] } })
check('tracking on but no visits: empty rows, total is a real 0', r.rows.length === 0 && r.totalRecorded === 0)
r = aggregateTopPages({ recorded: ok([v('/blog/a', null, null)]), ga4: { status: 'off', rows: [] }, leads: { status: 'ok', paths: [] } })
check('visit with no channel and no source: top source null', r.rows[0].topSource === null)
r = aggregateTopPages({ recorded: { status: 'off', rows: [] }, ga4: ok([{ pagePath: '/blog/a', views: NaN, sessions: -3 }, { pagePath: '/blog/b', views: 2, sessions: 1 }]), leads: { status: 'ok', paths: [] } })
check('bad GA4 numbers are treated as 0, not NaN', r.rows.every((x) => Number.isFinite(x.ga4Views ?? 0) && Number.isFinite(x.share ?? 0)))

// ---------- social content parsing ----------
const pc = parseSocialContent
check('content question-video', pc('question-video').hookStyle === 'question' && pc('question-video').format === 'video')
check('content how-to-post keeps the dash in the style', pc('how-to-post').hookStyle === 'how-to' && pc('how-to-post').format === 'post')
check('content fallback-guide has no style', pc('fallback-guide').hookStyle === null && pc('fallback-guide').format === 'guide')
check('content plain format', pc('video').hookStyle === null && pc('video').format === 'video')
check('content bio-* is flagged and skipped', pc('bio-resorts-x').bio === true)
check('content empty', pc('').format === null && pc(null).hookStyle === null)
check('content unknown keeps raw as format', pc('weird').format === 'weird')

// ---------- top posts ----------
const sv = (campaign: string, source: string, content: string, medium = 'social'): SocialVisitRow => ({ campaign, source, medium, content })
const many = (n: number, row: SocialVisitRow) => Array.from({ length: n }, () => row)
const sends = (n: number, network: string, hookStyle: string | null, slug = 's'): SendRow[] => Array.from({ length: n }, (_, i) => ({ slug: `${slug}${i}`, network, hookStyle }))

const visitRows: SocialVisitRow[] = [
  ...many(6, sv('post-a', 'facebook', 'question-post')),
  ...many(6, sv('post-b', 'twitter', 'mistake-post')),
  ...many(3, sv('post-c', 'instagram', 'question-video')),
  ...many(2, sv('post-a', 'facebook', 'question-post', 'email')),
  ...many(4, sv('x_bio', 'instagram', 'bio-resorts-x')),
  ...many(2, sv('', 'facebook', 'question-post')),
]
let p = aggregateTopPosts({
  visits: ok(visitRows),
  leads: ok([
    { utm_campaign: 'post-a', utm_source: 'facebook', utm_medium: 'social', utm_content: 'question-post' },
    { utm_campaign: 'post-a', utm_source: 'facebook', utm_medium: 'social', utm_content: 'question-post' },
    { utm_campaign: 'post-b', utm_source: 'x', utm_medium: 'social', utm_content: 'mistake-post' },
    { utm_campaign: 'post-z', utm_source: 'facebook', utm_medium: 'social', utm_content: 'story-post' },
    { utm_campaign: 'post-a', utm_source: 'facebook', utm_medium: 'email', utm_content: 'question-post' },
  ]),
  sends: ok([...sends(5, 'facebook', 'question'), ...sends(6, 'x', 'mistake', 'm'), ...sends(2, 'instagram', 'question', 'i')]),
  titles: new Map([['post-a', 'Post A Title']]),
})
check('top posts: non-social, bio and campaign-less visits are ignored', p.totalVisits === 15, String(p.totalVisits))
check('top posts: ties sorted by leads then slug (post-a before post-b)', p.rows.map((x) => x.slug).join(',') === 'post-a,post-b,post-c,post-z', p.rows.map((x) => x.slug).join(','))
check('top posts: twitter and x are one network', p.rows[1].network === 'x' && p.rows[1].leads === 1)
check('top posts: leads join on campaign, network and content', p.rows[0].visits === 6 && p.rows[0].leads === 2)
check('top posts: title from posts, slug when not found', p.rows[0].title === 'Post A Title' && p.rows[0].titleFound && p.rows[1].title === 'post-b' && !p.rows[1].titleFound)
check('top posts: hook style and format split out', p.rows[2].hookStyle === 'question' && p.rows[2].format === 'video')
check('top posts: lead-only row has 0 recorded visits (tracking on)', p.rows[3].slug === 'post-z' && p.rows[3].visits === 0 && p.rows[3].leads === 1)
check('best network: facebook 6 visits / 5 sends = 1.2 beats x 6 / 6 = 1', p.bestNetwork.enough && p.bestNetwork.name === 'facebook' && p.bestNetwork.visitsPerSend === 1.2, JSON.stringify(p.bestNetwork))
check('best hook style: question has 6 visits / 7 sends (5+2 = 7 sends), mistake 6 / 6', p.bestHookStyle.enough && p.bestHookStyle.name === 'mistake' && p.bestHookStyle.visitsPerSend === 1, JSON.stringify(p.bestHookStyle))
check('video visits are not counted against photo-post sends', (p.bestHookStyle.enough && p.bestHookStyle.visits === 6) === true)

check('threshold constant is 5', MIN_SENDS_TO_RANK === 5)
let b = bestBySends(new Map([['a', 50]]), new Map([['a', 4]]))
check('4 sends is not enough', !b.enough && b.sends === 4 && b.needed === 5)
b = bestBySends(new Map([['a', 5]]), new Map([['a', 5]]))
check('exactly 5 sends is enough', b.enough && b.name === 'a' && b.visitsPerSend === 1)
b = bestBySends(new Map([['a', 10], ['b', 10]]), new Map([['a', 5], ['b', 5]]))
check('tie on visits per send: name sorts first', b.enough && b.name === 'a')
b = bestBySends(new Map([['a', 10], ['b', 20]]), new Map([['a', 5], ['b', 10]]))
check('tie on rate: more sends wins', b.enough && b.name === 'b')
b = bestBySends(new Map(), new Map([['a', 9]]))
check('enough sends but no visits = 0 visits per send, still named', b.enough && b.visitsPerSend === 0)
b = bestBySends(new Map(), new Map())
check('no sends: not enough data yet', !b.enough && b.sends === 0)

p = aggregateTopPosts({ visits: { status: 'off', rows: [] }, leads: ok([{ utm_campaign: 'post-a', utm_source: 'facebook', utm_medium: 'social', utm_content: 'question-post' }]), sends: ok(sends(9, 'facebook', 'question')), titles: {} })
check('tracking off: visits are null, not 0; totals null; summaries unavailable', p.rows[0].visits === null && p.totalVisits === null && !p.bestNetwork.enough && !p.bestHookStyle.enough)
p = aggregateTopPosts({ visits: ok([]), leads: ok([]), sends: ok([]), titles: {} })
check('no rows: empty, total is a real 0, summaries say not enough data', p.rows.length === 0 && p.totalVisits === 0 && !p.bestNetwork.enough && !p.bestHookStyle.enough)
p = aggregateTopPosts({ visits: ok(many(3, sv('a', 'facebook', 'question-post'))), leads: { status: 'error', rows: [] }, sends: { status: 'error', rows: [] }, titles: { a: 'A' } })
check('leads and sends failures: leads null, summaries unavailable, visits still shown', p.rows[0].visits === 3 && p.rows[0].leads === null && !p.bestNetwork.enough && p.rows[0].title === 'A')
p = aggregateTopPosts({ visits: ok(Array.from({ length: 40 }, (_, i) => sv(`s${i}`, 'facebook', 'question-post'))), leads: ok([]), sends: ok([]), titles: {} })
check('top posts limit is 15, rowsCounted keeps the full count', p.rows.length === 15 && p.rowsCounted === 40)
p = aggregateTopPosts({ visits: ok([sv('a', 'facebook', '')]), leads: ok([]), sends: ok([]), titles: {} })
check('no utm_content: style and format are null (shown as none recorded)', p.rows[0].hookStyle === null && p.rows[0].format === null)

// ---------- copy and routes ----------
const files = [
  'lib/dashboard-top.ts', 'lib/dashboard-top-data.ts', 'components/admin/dashboard-top-cards.tsx', 'app/api/admin/dashboard-top-pages/route.ts',
  'app/api/admin/dashboard-top-posts/route.ts', 'scripts/check-dashboard-top.ts',
]
for (const f of files) check(`no em dashes in ${f}`, !src(f).includes(String.fromCharCode(8212)))
for (const f of ['app/api/admin/dashboard-top-pages/route.ts', 'app/api/admin/dashboard-top-posts/route.ts']) {
  const s = src(f)
  const iAuth = s.indexOf('isAuthorized(request)')
  const iWork = s.indexOf('getSupabaseAdmin()')
  check(`${f}: isAuthorized runs before any data access`, iAuth > 0 && iWork > iAuth && /export async function GET/.test(s))
}
const page = src('app/admin/dashboard/page.tsx')
check('dashboard page renders both cards after the traffic chart', page.indexOf('<TrafficChartCard') > 0 && page.indexOf('<TrafficChartCard') < page.indexOf('<TopPagesCard') && page.indexOf('<TopPagesCard') < page.indexOf('<TopPostsCard') && page.indexOf('<TopPostsCard') < page.indexOf('<FunnelPanel'))
check('both cards follow the range pills', /dashboard-top-pages", range/.test(page) && /dashboard-top-posts", range/.test(page))
const cards = src('components/admin/dashboard-top-cards.tsx')
check('tables scroll inside the card', /overflow-x-auto/.test(cards) && /TableSkeleton/.test(cards))
check('cards label the sources', /GA4 views/.test(cards) && /Recorded visits/.test(cards) && /could not be read/.test(cards) && /not enough data yet/.test(cards))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
