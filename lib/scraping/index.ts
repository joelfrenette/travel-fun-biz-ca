import type { ScrapedPackage, ScrapeResult } from '@/types/scrape'
import { parseTravelFunBiz } from './adapters/travelfunbiz'
import { parseSmartUniversal } from './adapters/smart'

const adapterMap: Record<string, (html: string, url: string) => ScrapedPackage[]> = {
  'travelfunbiz.com': parseTravelFunBiz,
}

export function getAdapterForUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return adapterMap[hostname]
  } catch {
    return undefined
  }
}

export function parsePackagesFromHtml(url: string, html: string): ScrapeResult {
  const dedicatedAdapter = getAdapterForUrl(url)
  let adapterName = 'smart-universal'
  let packages: ScrapedPackage[] = []

  // Try dedicated adapter first
  if (dedicatedAdapter) {
    adapterName = new URL(url).hostname.replace(/^www\./, '')
    packages = dedicatedAdapter(html, url)
    console.log(`[scraping] Dedicated adapter "${adapterName}" found ${packages.length} packages`)
  }

  // Fall back to smart universal if dedicated adapter found nothing
  if (packages.length === 0) {
    console.log('[scraping] Falling back to smart-universal parser')
    adapterName = dedicatedAdapter ? `${adapterName}+smart-universal` : 'smart-universal'
    packages = parseSmartUniversal(html, url)
    console.log(`[scraping] Smart-universal found ${packages.length} packages`)
  }

  console.log('[scraping] Final adapter:', adapterName, '| Packages:', packages.length)

  return {
    packages,
    adapter: adapterName,
    htmlLength: html.length,
  }
}
