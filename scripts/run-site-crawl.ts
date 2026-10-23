// Read-only dry run of the site health crawl against a live site. It sends GET and HEAD requests only (as TravelFunBizHealthBot),
// prints what it found, and writes NOTHING: no database, no files, no page changes.
// Run: pnpm dlx tsx scripts/run-site-crawl.ts [https://www.travelfunbiz.ca] [--max=40]
import { crawlWindow, fetchSitemap, pathOf, realFetch, windowSize } from '../lib/site-crawl'

const siteUrl = (process.argv.find((a) => /^https?:\/\//.test(a)) ?? 'https://www.travelfunbiz.ca').replace(/\/$/, '')
const max = Number(process.argv.find((a) => a.startsWith('--max='))?.slice(6)) || 40

async function main() {
  const started = Date.now()
  const sm = await fetchSitemap(siteUrl, realFetch)
  if (sm.error) {
    console.log(`Sitemap problem: ${sm.error}`)
    process.exit(1)
  }
  const sorted = [...sm.urls].sort()
  const n = Math.min(max, Math.max(windowSize(sorted.length), 1))
  // A spread across the whole sorted list (not just the first pages) so every kind of page is looked at.
  const step = sorted.length / Math.min(n, sorted.length)
  const window = Array.from({ length: Math.min(n, sorted.length) }, (_v, i) => sorted[Math.floor(i * step)])
  console.log(`Sitemap: ${sorted.length} pages. Checking ${window.length} (read only, ${siteUrl}).`)
  const res = await crawlWindow({ siteUrl, sitemapUrls: sorted, window, fetch: realFetch, deadlineMs: Date.now() + 90_000 })
  const by: Record<string, number> = {}
  for (const f of res.findings) by[`${f.severity}:${f.kind}`] = (by[`${f.severity}:${f.kind}`] ?? 0) + 1
  console.log(`\nChecked ${res.checked.length} pages, ${res.linkChecks} links, ${res.skipped.length} skipped, in ${((Date.now() - started) / 1000).toFixed(1)}s.`)
  const slow = [...res.records].sort((a, b) => b.ms - a.ms).slice(0, 3).map((r) => `${pathOf(r.url)} ${r.ms}ms`)
  console.log(`Slowest: ${slow.join(', ')}`)
  console.log('\nBy kind:')
  for (const [k, v] of Object.entries(by).sort()) console.log(`  ${k}  x${v}`)
  console.log('\nFindings:')
  const rank = { error: 0, warning: 1, info: 2 }
  for (const f of [...res.findings].sort((a, b) => rank[a.severity] - rank[b.severity])) console.log(`  [${f.severity}] ${pathOf(f.url)}  ${f.kind}: ${f.message}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
