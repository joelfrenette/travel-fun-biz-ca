import { load } from 'cheerio'
import type { ScrapedPackage } from '@/types/scrape'

/**
 * Enhanced Parser for travelfunbiz.com landing page
 * Uses smart detection combined with site-specific optimizations
 */
export function parseTravelFunBiz(html: string, sourceUrl: string): ScrapedPackage[] {
  const $ = load(html)
  const packages: ScrapedPackage[] = []

  console.log('[travelfunbiz] Parsing travelfunbiz.com...')

  // Look for Fusion Builder columns and card elements
  const candidates = $(
    '.fusion-layout-column, .fusion-builder-column, .et_pb_column, [class*="package"], [class*="trip"], [class*="tour"]'
  )

  console.log('[travelfunbiz] Found candidate containers:', candidates.length)

  candidates.each((idx, el) => {
    const column = $(el)
    const pkg: any = {
      name: '',
      description: '',
      imageUrl: '',
      bookingUrl: '',
      price: '',
      destination: '',
      duration: '',
      supplier: 'TravelFunBiz',
      sourceUrl,
      highlights: [] as string[],
    }

    // Extract title from multiple possible locations
    const heading = column.find('h1, h2, h3, h4, .fusion-title-heading, [class*="title"]').first()
    if (heading.length > 0) {
      pkg.name = heading.text().replace(/\s+/g, ' ').trim()
    }

    // Try alternative title locations
    if (!pkg.name || pkg.name.length < 4) {
      const boldText = column.find('strong, b').first()
      if (boldText.length > 0) {
        pkg.name = boldText.text().replace(/\s+/g, ' ').trim()
      }
    }

    // Extract description
    const paragraphs = column.find('p')
    paragraphs.each((_, p) => {
      const text = $(p).text().replace(/\s+/g, ' ').trim()
      if (text.length > 20 && text.length < 300 && !pkg.description) {
        pkg.description = text
      }
    })

    // Extract image
    const img = column.find('img').first()
    if (img.length > 0) {
      const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src')
      if (src) {
        try {
          pkg.imageUrl = new URL(src, sourceUrl).href
        } catch {
          pkg.imageUrl = src
        }
      }
    }

    // Extract CTA/booking URL
    const ctaLinks = column.find('a:contains("MORE INFO"), a:contains("REQUEST INFO"), a:contains("BOOK NOW"), a:contains("VIEW DETAILS"), a:contains("DETAILS")')
    if (ctaLinks.length > 0) {
      const href = ctaLinks.first().attr('href')
      if (href) {
        try {
          pkg.bookingUrl = new URL(href, sourceUrl).href
        } catch {
          pkg.bookingUrl = href
        }
      }
    }

    // Fallback: first link
    if (!pkg.bookingUrl) {
      const firstLink = column.find('a[href]').first()
      if (firstLink.length > 0) {
        const href = firstLink.attr('href')
        if (href) {
          try {
            pkg.bookingUrl = new URL(href, sourceUrl).href
          } catch {
            pkg.bookingUrl = href
          }
        }
      }
    }

    // Extract price with more patterns
    const allText = column.text()
    const pricePatterns = [
      /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g,
      /\$\s?\d+/g,
      /\d+\s*(?:USD|CAD|EUR|GBP|dollars)/gi,
    ]

    for (const pattern of pricePatterns) {
      const match = allText.match(pattern)
      if (match) {
        pkg.price = match[0]
        break
      }
    }

    // Extract date/duration
    const datePatterns = [
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}\b/gi,
      /\d{4}-\d{2}-\d{2}/g,
      /\d+\s*days?\s*\d*\s*nights?/gi,
      /\d+\s*nights?\s*\d*\s*days?/gi,
    ]

    for (const pattern of datePatterns) {
      const match = allText.match(pattern)
      if (match) {
        pkg.duration = match[0]
        break
      }
    }

    // Extract destination
    const destinationPatterns = [
      /\b(?:Paris|London|New York|Tokyo|Rome|Barcelona|Dubai|Sydney|Amsterdam|Berlin|Madrid|Toronto|Vancouver|Montreal|Miami|Los Angeles|San Francisco|Las Vegas|Chicago|Boston|Seattle|Denver|Atlanta|Dallas|Houston|Phoenix|San Diego|Orlando|Mexico City|Cancun|Punta Cana|Montego Bay|Nassau|St. Lucia|Aruba|Jamaica|Bahamas|Dominican Republic|Costa Rica|Panama|Colombia|Peru|Chile|Argentina|Brazil|Machu Picchu|Galapagos|Patagonia|Andes|Amazon)\b/gi,
    ]

    for (const pattern of destinationPatterns) {
      const match = allText.match(pattern)
      if (match) {
        pkg.destination = match[0]
        break
      }
    }

    // Extract highlights from list items
    const listItems = column.find('li')
    listItems.each((_, li) => {
      const text = $(li).text().replace(/\s+/g, ' ').trim()
      if (text.length > 5 && text.length < 150 && pkg.highlights.length < 8) {
        pkg.highlights.push(text)
      }
    })

    // Validate package quality
    const hasName = pkg.name && pkg.name.length >= 4
    const hasContent = pkg.name || pkg.description || pkg.price
    const hasMedia = pkg.imageUrl || pkg.bookingUrl

    if (hasName && hasContent && hasMedia) {
      console.log('[travelfunbiz] Valid package:', pkg.name.substring(0, 50))
      packages.push(pkg)
    } else {
      console.log('[travelfunbiz] Skipped container - missing requirements')
    }
  })

  console.log('[travelfunbiz] Total valid packages found:', packages.length)
  return packages
}