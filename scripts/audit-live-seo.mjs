#!/usr/bin/env node
// Live SEO audit (roadmap use case 26427941, ported from Nomad factory-v9 item 26). Read-only:
// it never writes to the site or the database, only prints a report. Run it by hand after
// shipping an SEO-relevant change, not on a schedule — it makes real requests to the live site.
//
// Usage:
//   node scripts/audit-live-seo.mjs                       # audits https://travelfunbiz.ca
//   node scripts/audit-live-seo.mjs https://staging.example.com
//   node scripts/audit-live-seo.mjs --json report.json     # also writes a machine-readable report
//
// Checks, per page in the sitemap:
//   - <title> present, and within a length Google won't truncate/pad (10-65 chars)
//   - meta description present, within 50-160 chars
//   - a self-referencing canonical <link> (flags a missing one; a canonical pointing elsewhere is
//     reported as informational, not an error, since a recap page intentionally does that)
//   - at least one valid application/ld+json block that actually parses as JSON
//   - every <img> has a non-empty alt attribute
//   - every same-origin link on the page resolves (not a 404/5xx), checked once per unique URL
//     across the whole crawl so a shared header/footer link is only fetched once
//
// Exit code is 1 if any page has a finding, 0 if the site is clean, so this can gate a CI step
// later without any change here.

import * as cheerio from 'cheerio'

const args = process.argv.slice(2)
const jsonFlagIndex = args.indexOf('--json')
const jsonOutPath = jsonFlagIndex !== -1 ? args[jsonFlagIndex + 1] : null
const positional = args.filter((a, i) => a !== '--json' && i !== jsonFlagIndex + 1)
const baseUrl = (positional[0] || 'https://travelfunbiz.ca').replace(/\/$/, '')

const TITLE_MIN = 10
const TITLE_MAX = 65
const DESC_MIN = 50
const DESC_MAX = 160
const LINK_CHECK_CONCURRENCY = 8
const PAGE_FETCH_CONCURRENCY = 4
const TIMEOUT_MS = 20_000

/** @param {string} url */
async function fetchText(url, method = 'GET') {
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': 'TravelFunBiz-SEO-Audit/1 (+https://travelfunbiz.ca)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = method === 'GET' ? await res.text() : ''
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: '', error: err instanceof Error ? err.message : String(err) }
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function getSitemapUrls() {
  const res = await fetchText(`${baseUrl}/sitemap.xml`)
  if (!res.ok) {
    throw new Error(`Could not fetch ${baseUrl}/sitemap.xml (HTTP ${res.status}${res.error ? `, ${res.error}` : ''})`)
  }
  const $ = cheerio.load(res.body, { xmlMode: true })
  const urls = []
  $('url > loc').each((_, el) => urls.push($(el).text().trim()))
  if (urls.length === 0) throw new Error('Sitemap parsed but contained no <url><loc> entries.')
  return urls
}

/** @param {string} pageUrl @param {string} html */
function auditPage(pageUrl, html) {
  const findings = []
  const $ = cheerio.load(html)

  const title = $('head > title').first().text().trim()
  if (!title) findings.push({ check: 'title', message: 'Missing <title>.' })
  else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    findings.push({ check: 'title', message: `Title is ${title.length} chars ("${title}") — outside ${TITLE_MIN}-${TITLE_MAX}.` })
  }

  const desc = $('head meta[name="description"]').attr('content')?.trim()
  if (!desc) findings.push({ check: 'meta-description', message: 'Missing meta description.' })
  else if (desc.length < DESC_MIN || desc.length > DESC_MAX) {
    findings.push({ check: 'meta-description', message: `Meta description is ${desc.length} chars — outside ${DESC_MIN}-${DESC_MAX}.` })
  }

  const canonical = $('head link[rel="canonical"]').attr('href')?.trim()
  if (!canonical) findings.push({ check: 'canonical', message: 'No canonical <link> tag.' })
  else {
    let canonAbs
    try { canonAbs = new URL(canonical, pageUrl).toString() } catch { canonAbs = canonical }
    if (canonAbs.replace(/\/$/, '') !== pageUrl.replace(/\/$/, '')) {
      findings.push({ check: 'canonical', message: `Canonical points elsewhere (${canonAbs}) — fine if deliberate (e.g. a recap page), worth a glance otherwise.`, info: true })
    }
  }

  const ldBlocks = $('script[type="application/ld+json"]')
  if (ldBlocks.length === 0) {
    findings.push({ check: 'json-ld', message: 'No JSON-LD structured data on the page.' })
  } else {
    ldBlocks.each((_, el) => {
      const raw = $(el).contents().text()
      try {
        JSON.parse(raw)
      } catch (err) {
        findings.push({ check: 'json-ld', message: `A JSON-LD block does not parse: ${err instanceof Error ? err.message : err}` })
      }
    })
  }

  const missingAlt = []
  $('img').each((_, el) => {
    const alt = $(el).attr('alt')
    if (alt === undefined || alt.trim() === '') {
      const src = $(el).attr('src') || $(el).attr('data-src') || '(no src)'
      missingAlt.push(src)
    }
  })
  if (missingAlt.length > 0) {
    findings.push({ check: 'alt-text', message: `${missingAlt.length} image(s) missing alt text: ${missingAlt.slice(0, 5).join(', ')}${missingAlt.length > 5 ? ', …' : ''}` })
  }

  const links = new Set()
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return
    try {
      const abs = new URL(href, pageUrl)
      if (abs.origin === new URL(baseUrl).origin) links.add(abs.toString())
    } catch { /* ignore unparsable hrefs */ }
  })

  return { findings, links: [...links] }
}

async function main() {
  console.log(`Auditing ${baseUrl} ...\n`)
  const pageUrls = await getSitemapUrls()
  console.log(`Sitemap lists ${pageUrls.length} page(s).\n`)

  const pageResults = await mapWithConcurrency(pageUrls, PAGE_FETCH_CONCURRENCY, async (url) => {
    const res = await fetchText(url)
    if (!res.ok) return { url, html: null, findings: [{ check: 'fetch', message: `HTTP ${res.status}${res.error ? ` (${res.error})` : ''}` }], links: [] }
    return { url, html: res.body, ...auditPage(url, res.body) }
  })

  const allLinks = new Set()
  for (const r of pageResults) for (const l of r.links) allLinks.add(l)
  const linkList = [...allLinks]
  console.log(`Checking ${linkList.length} unique internal link(s) for broken destinations...\n`)
  const linkStatuses = await mapWithConcurrency(linkList, LINK_CHECK_CONCURRENCY, async (url) => {
    const res = await fetchText(url, 'HEAD')
    // Some routes don't support HEAD; fall back to GET before calling it broken.
    if (!res.ok && res.status === 0) return { url, ok: false, status: 0 }
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      const getRes = await fetchText(url, 'GET')
      return { url, ok: getRes.ok, status: getRes.status }
    }
    return { url, ok: res.ok, status: res.status }
  })
  const brokenLinks = new Map(linkStatuses.filter((l) => !l.ok).map((l) => [l.url, l.status]))

  let totalFindings = 0
  let totalInfo = 0
  const report = []
  for (const r of pageResults) {
    const brokenOnPage = []
    if (r.html) {
      const $ = cheerio.load(r.html)
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href')
        if (!href) return
        try {
          const abs = new URL(href, r.url).toString()
          if (brokenLinks.has(abs)) brokenOnPage.push(`${abs} (HTTP ${brokenLinks.get(abs)})`)
        } catch { /* ignore */ }
      })
    }
    const findings = [...r.findings, ...brokenOnPage.map((l) => ({ check: 'broken-link', message: `Links to ${l}` }))]
    const errors = findings.filter((f) => !f.info)
    const infos = findings.filter((f) => f.info)
    totalFindings += errors.length
    totalInfo += infos.length
    if (findings.length > 0) {
      console.log(`${r.url}`)
      for (const f of findings) console.log(`  ${f.info ? '(info)' : '[!]'} ${f.check}: ${f.message}`)
      console.log('')
    }
    report.push({ url: r.url, findings })
  }

  console.log('─'.repeat(60))
  console.log(`${pageUrls.length} pages, ${totalFindings} finding(s), ${totalInfo} informational note(s), ${brokenLinks.size} broken link(s) site-wide.`)

  if (jsonOutPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(jsonOutPath, JSON.stringify({ baseUrl, generatedAt: new Date().toISOString(), pageCount: pageUrls.length, findingCount: totalFindings, brokenLinkCount: brokenLinks.size, pages: report }, null, 2))
    console.log(`Wrote ${jsonOutPath}`)
  }

  process.exit(totalFindings > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Audit failed:', err instanceof Error ? err.message : err)
  process.exit(2)
})
