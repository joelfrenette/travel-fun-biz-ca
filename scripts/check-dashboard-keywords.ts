// Offline check for the dashboard "Top keywords" table (lib/dashboard-keywords.ts and its card, route and page wiring).
// Run: pnpm dlx tsx scripts/check-dashboard-keywords.ts  (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOP_KEYWORDS_LIMIT, buildTopKeywords, type QueryPageRow, type QueryRow } from '../lib/dashboard-keywords'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const queries: QueryRow[] = [
  { query: 'alaska cruise tips', clicks: 5, impressions: 400, position: 8.34 },
  { query: 'Danube river cruise', clicks: 12, impressions: 900, position: 4.06 },
  { query: 'singles travel', clicks: 5, impressions: 900, position: 14 },
  { query: 'ghost query', clicks: 0, impressions: 0, position: 0 },
  { query: '   ', clicks: 9, impressions: 9, position: 1 },
  { query: 'no position', clicks: 1, impressions: 50, position: 0 },
]
const pairs: QueryPageRow[] = [
  { query: 'danube river cruise', path: '/blog/danube-small', clicks: 1, impressions: 50 },
  { query: 'danube river cruise', path: '/packages/danube', clicks: 11, impressions: 850 },
  { query: 'singles travel', path: '/blog/singles', clicks: 5, impressions: 900 },
]
const rows = buildTopKeywords({ queries, pairs, targets: [{ keyword: 'Danube River Cruise', target_path: '/packages/danube-2027' }, { keyword: 'x', target_path: null }] })

expect('sorted by clicks, then impressions, then name', rows.map((r) => r.query).join('|') === 'Danube river cruise|singles travel|alaska cruise tips|no position', rows.map((r) => r.query).join('|'))
expect('a search with no clicks and no impressions, and a blank search, are left out', !rows.some((r) => r.query === 'ghost query') && rows.every((r) => r.query.trim() !== ''))
expect('click rate is clicks over impressions', Math.abs(rows[0].ctr - 12 / 900) < 1e-9 && rows[0].impressions === 900 && rows[0].clicks === 12)
expect('position is rounded to one decimal, and missing is null (never a zero)', rows[0].position === 4.1 && rows.find((r) => r.query === 'alaska cruise tips')!.position === 8.3 && rows.find((r) => r.query === 'no position')!.position === null)
expect('the page Google shows is the one with the most impressions for that search, matched ignoring case', rows[0].page === '/packages/danube' && rows[1].page === '/blog/singles')
expect('a search with no page row has page null', rows.find((r) => r.query === 'alaska cruise tips')!.page === null)
expect('the target page comes from Keyword Research, matched ignoring case, and null when none was chosen', rows[0].target === '/packages/danube-2027' && rows[1].target === null)
const noPairs = buildTopKeywords({ queries, pairs: null, targets: null })
expect('when the page report and the targets could not be read, the keywords still show with null pages and targets', noPairs.length === 4 && noPairs.every((r) => r.page === null && r.target === null))
expect('it keeps only the top 15 by default', TOP_KEYWORDS_LIMIT === 15 && buildTopKeywords({ queries: Array.from({ length: 40 }, (_, i) => ({ query: `q${i}`, clicks: i, impressions: i + 1, position: 3 })), pairs: [], targets: [] }).length === 15)
expect('nothing in, nothing out (an honest empty list, not made-up rows)', buildTopKeywords({ queries: [], pairs: [], targets: [] }).length === 0)
expect('it does not mutate its input', queries[0].query === 'alaska cruise tips' && queries.length === 6)

// ---- wiring
const route = read('app/api/admin/dashboard-top-keywords/route.ts')
expect('the route checks isAuthorized first and takes the same range param as the other cards', /isAuthorized\(request\)\)\s*return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)/.test(route) && /searchParams\.get\('range'\)/.test(route) && /parseRange/.test(route))
const data = read('lib/dashboard-keywords-data.ts')
expect('it reads Search Console for the dashboard range window, caches, and says not connected instead of faking numbers', /gscWindow\(range\)/.test(data) && /CACHE_MS/.test(data) && /not_connected/.test(data) && /isSearchConsoleConfigured/.test(data) && !/callAnthropic|Math\.random/.test(data))
const cards = read('components/admin/dashboard-top-cards.tsx')
expect('the card has honest not-connected, error and empty states', /Google Search Console is not connected/.test(cards) && /Top keywords could not be read/.test(cards) && /did not show this site for any search/.test(cards))
const page = read('app/admin/dashboard/page.tsx')
expect('the dashboard loads it with the same range and draws it after Top posts', /dashboard-top-keywords/.test(page) && page.indexOf('<TopPostsCard') < page.indexOf('<TopKeywordsCard') && page.indexOf('<TopKeywordsCard') < page.indexOf('<FunnelPanel'))

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
