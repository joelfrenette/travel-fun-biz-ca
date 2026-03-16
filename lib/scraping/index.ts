import type { ScrapedPackage, ScrapeResult } from '@/types/scrape'
import { parseTravelFunBiz } from './adapters/travelfunbiz'
import { parseGeneric } from './adapters/generic'
import { parseSmartUniversal } from './adapters/smart'

const adapterMap: Record<string, (html: string, url: string) => ScrapedPackage[]> = {
  'travelfunbiz.com': parseTravelFunBiz,
}

export function getAdapterForUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return adapterMap[hostname]
  } catch (error) {
    return undefined
  }
}

export function parsePackagesFromHtml(url: string, html: string): ScrapeResult {
  // Always try smart universal parser first as fallback
  const adapter = getAdapterForUrl(url) || parseSmartUniversal
  const parser = adapter || parseSmartUniversal
  const packages = parser(html, url)

  console.log('[scraping] Adapter used:', adapter === parseSmartUniversal ? 'smart-universal' : new URL(url).hostname.replace(/^www\./, ''))
  console.log('[scraping] Packages found:', packages.length)

  return {
    packages,
    adapter: adapter === parseSmartUniversal ? 'smart-universal' : new URL(url).hostname.replace(/^www\./, ''),
    htmlLength: html.length,
  }
}