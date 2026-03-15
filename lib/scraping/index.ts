import type { ScrapedPackage, ScrapeResult } from '@/types/scrape'
import { parseTravelFunBiz } from './adapters/travelfunbiz'
import { parseGeneric } from './adapters/generic'

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
  const adapter = getAdapterForUrl(url)
  const parser = adapter || parseGeneric
  const packages = parser(html, url)

  return {
    packages,
    adapter: adapter ? new URL(url).hostname.replace(/^www\./, '') : 'generic',
    htmlLength: html.length,
  }
}
