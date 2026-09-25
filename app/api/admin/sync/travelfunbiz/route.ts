import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getAllPackagesAdmin } from '@/lib/packages'
import { importPackage } from '@/lib/import-package'
import { parsePackagesFromHtml } from '@/lib/scraping'
import { scrapedToPackage } from '@/lib/scraping/to-package'
import { generateSlug } from '@/lib/utils'

const SOURCE_URL = 'https://travelfunbiz.com/'

export const maxDuration = 60

// One click: fetch the current travelfunbiz.com homepage directly (it is plain WordPress HTML,
// no JS rendering needed), import every trip not already here as a draft, report the rest.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  let html: string
  try {
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TravelFunBiz.ca sync; +https://travelfunbiz.ca)' },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return NextResponse.json({ error: `travelfunbiz.com responded ${res.status}` }, { status: 502 })
    html = await res.text()
  } catch (error) {
    return NextResponse.json({ error: `Could not fetch travelfunbiz.com: ${error instanceof Error ? error.message : 'unknown error'}` }, { status: 502 })
  } finally {
    clearTimeout(timeout)
  }

  const { packages: scraped, adapter } = parsePackagesFromHtml(SOURCE_URL, html)
  const existing = new Set((await getAllPackagesAdmin()).map((p) => p.slug))

  const created: string[] = []
  const skipped: string[] = []
  const failed: { name: string; error: string }[] = []

  for (const item of scraped) {
    if (existing.has(generateSlug(item.name))) {
      skipped.push(item.name)
      continue
    }
    const { pkg, error } = await importPackage(scrapedToPackage(item))
    if (error) failed.push({ name: item.name, error: error.message })
    else if (pkg) created.push(pkg.name)
  }

  return NextResponse.json({ adapter, found: scraped.length, created, skipped, failed })
}
