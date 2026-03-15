import { load } from 'cheerio'
import type { ScrapedPackage } from '@/types/scrape'

/**
 * Parser for travelfunbiz.com landing page
 */
export function parseTravelFunBiz(html: string, sourceUrl: string): ScrapedPackage[] {
  const $ = load(html)
  const packages: ScrapedPackage[] = []

  const candidates = $(
    '.fusion-layout-column, .fusion-builder-column, .et_pb_column, [class*="package"], [class*="trip"]'
  )

  candidates.each((_, el) => {
    const column = $(el)

    const hasCta = column.find('a:contains("MORE INFO"), a:contains("REQUEST INFO"), a:contains("BOOK NOW")').length > 0
    const hasImage = column.find('img').length > 0
    const heading = column.find('h1, h2, h3, h4, .fusion-title-heading').first()

    if (!hasCta || !hasImage || heading.length === 0) {
      return
    }

    const title = heading.text().replace(/\s+/g, ' ').trim()
    if (!title || title.length < 4) return

    const description = column.find('p').first().text().replace(/\s+/g, ' ').trim()

    const imageSrc = column.find('img').first().attr('src') || column.find('img').first().attr('data-src')

    const cta = column.find('a:contains("MORE INFO"), a:contains("REQUEST INFO"), a:contains("BOOK NOW")').first()
    const bookingUrl = cta.attr('href')

    const dateLine = column
      .find('p, span')
      .filter((_, p) => /\d{4}/.test($(p).text()) || /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test($(p).text()))
      .first()
      .text()
      .trim()

    const priceLine = column
      .find('p, span, strong')
      .filter((_, p) => /\$\s?\d/.test($(p).text()) || /(from|starting)/i.test($(p).text()))
      .first()
      .text()
      .trim()

    const destinationLine = column
      .find('p, span')
      .filter((_, p) => /[A-Z]{2,}/.test($(p).text()) && $(p).text().includes(','))
      .first()
      .text()
      .trim()

    const pkg: ScrapedPackage = {
      name: title,
      description: description || undefined,
      imageUrl: imageSrc,
      bookingUrl: bookingUrl ? new URL(bookingUrl, sourceUrl).href : undefined,
      destination: destinationLine || undefined,
      duration: dateLine || undefined,
      price: priceLine || undefined,
      sourceUrl,
      supplier: 'TravelFunBiz',
    }

    packages.push(pkg)
  })

  return packages
}