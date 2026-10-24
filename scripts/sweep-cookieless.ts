// Cookie-less sweep (hub WP1): fetch EVERY address in the live sitemap the way Googlebot does (GET, no cookies) and print the ones that do not
// answer 200. READ ONLY: it sends GET requests and prints; it never edits, deletes or unpublishes anything and writes nothing anywhere.
// Run it by hand after a deploy, especially after a change to caching, middleware or a page template (the 2026-10-24 trip-page 500 only
// happened for visitors with NO cookie, which is exactly what this checks).
//
//   pnpm dlx tsx scripts/sweep-cookieless.ts                         # the live site, every sitemap URL, 4 at a time
//   pnpm dlx tsx scripts/sweep-cookieless.ts --base https://www.travelfunbiz.ca --limit 50
//   pnpm dlx tsx scripts/sweep-cookieless.ts --compare-cookie         # also fetch each page with a language cookie (lang=fr) and flag a status that differs
//
// Options: --base <url>  --limit <n>  --concurrency <n> (default 4, max 8)  --timeout <seconds> (default 15)  --compare-cookie
// Exit code: 0 when every page answered 200 (and, with --compare-cookie, the same status both ways); 1 otherwise; 2 when the sitemap could not be read.
import { fetchFollow, fetchSitemap, normUrl, pool, realFetch, type FetchLike } from '../lib/site-crawl'
import { SITE_URL } from '../lib/site'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const base = (arg('base') ?? SITE_URL).replace(/\/$/, '')
const limit = Math.max(1, Number(arg('limit') ?? '0')) || Infinity
const concurrency = Math.min(8, Math.max(1, Number(arg('concurrency') ?? '4') || 4))
const timeoutMs = Math.max(2, Number(arg('timeout') ?? '15') || 15) * 1000
const compare = flag('compare-cookie')

/** The real fetch with one extra header added to every request (only used for the --compare-cookie second pass). */
const withCookie = (cookie: string): FetchLike => (url, init) => realFetch(url, { ...init, headers: { ...init.headers, cookie } })

async function main() {
  console.log(`Sweeping ${base} (GET only, no cookies${compare ? ', then again with lang=fr' : ''}).`)
  const sm = await fetchSitemap(base, realFetch)
  if (sm.error) {
    console.error(`Could not read the sitemap: ${sm.error}`)
    process.exit(2)
  }
  const urls = sm.urls.slice(0, limit)
  console.log(`${urls.length} address${urls.length === 1 ? '' : 'es'} to check${sm.urls.length > urls.length ? ` (of ${sm.urls.length})` : ''}.`)

  const rows = await pool(urls, concurrency, async (u) => {
    const plain = await fetchFollow(u, realFetch, { timeoutMs })
    const other = compare ? await fetchFollow(u, withCookie('lang=fr'), { timeoutMs }) : null
    return { u, plain, other }
  })

  let bad = 0
  let slow = 0
  for (const r of rows) {
    if (!r) continue
    const { u, plain, other } = r
    const problems: string[] = []
    if (plain.error) problems.push(`no answer (${plain.error})`)
    else if (plain.status !== 200) problems.push(`HTTP ${plain.status}${plain.hops ? ` after ${plain.hops} redirect${plain.hops === 1 ? '' : 's'} to ${plain.finalUrl}` : ''}`)
    else if (plain.hops > 0) problems.push(`redirects ${plain.hops}x to ${plain.finalUrl}`)
    if (other && !other.error && plain.status !== 0 && other.status !== plain.status) problems.push(`status differs with a cookie: ${plain.status} without, ${other.status} with lang=fr`)
    if (plain.ms > 3000) slow++
    if (problems.length) {
      bad++
      console.log(`${normUrl(u) ?? u}  ->  ${problems.join('; ')}`)
    }
  }
  const checked = rows.filter(Boolean).length
  console.log(`\nDone: ${checked} checked, ${bad} problem${bad === 1 ? '' : 's'}, ${slow} slower than 3 seconds.${checked < urls.length ? ` (${urls.length - checked} not reached)` : ''}`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
