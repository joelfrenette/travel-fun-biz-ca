import { load } from 'cheerio'
import type { ScrapedPackage } from '@/types/scrape'

export function parseGeneric(html: string, sourceUrl: string): ScrapedPackage[] {
  const $ = load(html)
  const packages: ScrapedPackage[] = []

  const title = $('meta[property="og:title"], meta[name="title"]').attr('content')
    || $('title').first().text()
    || ''
  const description = $('meta[property="og:description"], meta[name="description"]').attr('content')
    || $('p').first().text()
    || ''
  const image = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src')

  packages.push({
    name: title.trim() || 'Untitled Package',
    description: description.trim() || undefined,
    imageUrl: image ? new URL(image, sourceUrl).href : undefined,
    sourceUrl,
  })

  return packages
}
