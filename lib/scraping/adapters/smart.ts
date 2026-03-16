import { load, type CheerioAPI } from 'cheerio'
import type { ScrapedPackage } from '@/types/scrape'

/**
 * Smart Universal Scraper — works on any travel page by detecting repeating
 * content blocks that contain an image, a heading/title, and a link.
 *
 * Strategy:
 *  1. Find all CTA-style links (book now, more info, view details, etc.)
 *  2. Walk up from each CTA to find the smallest ancestor that also has an
 *     image and meaningful text — that's a package block.
 *  3. If no CTAs found, fall back to looking for repeated card-like elements.
 *  4. Extract structured data from each block.
 */
export function parseSmartUniversal(html: string, sourceUrl: string): ScrapedPackage[] {
  const $ = load(html)
  const packages: ScrapedPackage[] = []
  const seen = new Set<string>()

  console.log('[smart-scraper] Starting parse, HTML length:', html.length)

  // ── Strategy 1: CTA-anchor walk-up ────────────────────────────────
  const ctaSelectors = [
    'a:contains("More Info")', 'a:contains("MORE INFO")',
    'a:contains("Book Now")', 'a:contains("BOOK NOW")',
    'a:contains("Request Info")', 'a:contains("REQUEST INFO")',
    'a:contains("View Details")', 'a:contains("VIEW DETAILS")',
    'a:contains("Learn More")', 'a:contains("LEARN MORE")',
    'a:contains("Get Quote")', 'a:contains("GET QUOTE")',
    'a:contains("See Details")', 'a:contains("SEE DETAILS")',
  ]

  const ctaAnchors = $(ctaSelectors.join(', '))
  console.log('[smart-scraper] CTA anchors found:', ctaAnchors.length)

  ctaAnchors.each((_, anchor) => {
    const block = walkUpToBlock($, $(anchor))
    if (!block) return

    const pkg = extractPackage($, block, sourceUrl)
    if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
      seen.add(pkg.name.toLowerCase())
      packages.push(pkg)
    }
  })

  if (packages.length > 0) {
    console.log('[smart-scraper] CTA strategy found:', packages.length)
    return packages
  }

  // ── Strategy 2: Common card/container selectors ───────────────────
  console.log('[smart-scraper] CTA strategy found 0, trying card selectors...')

  const cardSelectors = [
    'article',
    '.card', '[class*="card"]',
    '[class*="package"]', '[class*="trip"]', '[class*="tour"]',
    '[class*="deal"]', '[class*="offer"]',
    '.product', '[class*="product"]',
    '.fusion-layout-column', '.fusion-builder-column',
    '.et_pb_column', '.wp-block-column',
  ]

  const cards = $(cardSelectors.join(', '))
  console.log('[smart-scraper] Card containers found:', cards.length)

  cards.each((_, el) => {
    const container = $(el)
    const textLen = container.text().replace(/\s+/g, ' ').trim().length
    if (textLen < 30 || textLen > 3000) return

    const hasImg = container.find('img').length > 0
    const hasLink = container.find('a[href]').length > 0
    if (!hasImg && !hasLink) return

    const pkg = extractPackage($, container, sourceUrl)
    if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
      seen.add(pkg.name.toLowerCase())
      packages.push(pkg)
    }
  })

  console.log('[smart-scraper] Total packages found:', packages.length)
  return packages
}

/**
 * Walk up from an element to find the nearest ancestor that looks like a
 * self-contained package block.
 */
function walkUpToBlock($: CheerioAPI, startEl: ReturnType<CheerioAPI>): ReturnType<CheerioAPI> | null {
  let el = startEl.parent()
  let depth = 0

  while (el.length > 0 && depth < 10) {
    const tag = (el.prop('tagName') || '').toLowerCase()
    if (['body', 'html', 'main', 'header', 'footer'].includes(tag)) break

    const hasImg = el.find('img').length > 0
    const textLen = el.text().replace(/\s+/g, ' ').trim().length

    if (hasImg && textLen > 30 && textLen < 3000) {
      // Check it doesn't contain multiple CTA links (would be a parent container)
      const ctaCount = el.find(
        'a:contains("MORE INFO"), a:contains("More Info"), ' +
        'a:contains("BOOK NOW"), a:contains("Book Now"), ' +
        'a:contains("REQUEST INFO"), a:contains("Request Info"), ' +
        'a:contains("VIEW DETAILS"), a:contains("View Details")'
      ).length
      if (ctaCount <= 1) return el
    }

    el = el.parent()
    depth++
  }

  // Fallback: direct parent
  const parent = startEl.parent()
  if (parent.text().replace(/\s+/g, ' ').trim().length > 20) return parent
  return null
}

/**
 * Extract package data from a DOM block.
 */
function extractPackage($: CheerioAPI, block: ReturnType<CheerioAPI>, sourceUrl: string): ScrapedPackage | null {
  const allText = block.text().replace(/\s+/g, ' ').trim()

  // ── Name ──────────────────────────────────────────────────────────
  let name = ''

  block.find('h1, h2, h3, h4, h5, h6').each((_, h) => {
    if (name) return
    const t = $(h).text().replace(/\s+/g, ' ').trim()
    if (t.length >= 5 && t.length <= 200) name = t
  })

  if (!name) {
    block.find('[class*="title"], [class*="heading"], [class*="name"]').each((_, el) => {
      if (name) return
      const t = $(el).text().replace(/\s+/g, ' ').trim()
      if (t.length >= 5 && t.length <= 200) name = t
    })
  }

  if (!name) {
    block.find('strong, b').each((_, el) => {
      if (name) return
      const t = $(el).text().replace(/\s+/g, ' ').trim()
      if (t.length >= 5 && t.length <= 200) name = t
    })
  }

  if (!name || name.length < 5) return null

  // ── Description ───────────────────────────────────────────────────
  let description = ''
  block.find('p').each((_, p) => {
    if (description) return
    const t = $(p).text().replace(/\s+/g, ' ').trim()
    if (t.length > 20 && t.length < 500) description = t
  })

  // ── Image ─────────────────────────────────────────────────────────
  let imageUrl: string | undefined
  block.find('img').each((_, img) => {
    if (imageUrl) return
    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src')
    if (src && !/spacer|pixel|blank/i.test(src)) {
      try { imageUrl = new URL(src, sourceUrl).href } catch { imageUrl = src }
    }
  })

  // ── Booking URL ───────────────────────────────────────────────────
  let bookingUrl: string | undefined
  block.find('a[href]').each((_, a) => {
    if (bookingUrl) return
    const text = $(a).text().toLowerCase()
    if (/more info|book now|request info|view details|learn more|get quote/i.test(text)) {
      const href = $(a).attr('href')
      if (href && href !== '#') {
        try { bookingUrl = new URL(href, sourceUrl).href } catch { bookingUrl = href }
      }
    }
  })

  if (!bookingUrl) {
    const firstLink = block.find('a[href]').first()
    const href = firstLink.attr('href')
    if (href && href !== '#' && !href.startsWith('javascript:')) {
      try { bookingUrl = new URL(href, sourceUrl).href } catch { bookingUrl = href }
    }
  }

  // ── Price ─────────────────────────────────────────────────────────
  let price: string | undefined
  const priceMatch = allText.match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/)
  if (priceMatch) price = priceMatch[0]

  // ── Duration ──────────────────────────────────────────────────────
  let duration: string | undefined
  const durMatch = allText.match(/\b(\d+)\s*(days?|nights?|weeks?)\b/i)
  if (durMatch) duration = `${durMatch[1]} ${durMatch[2]}`

  // ── Destination ───────────────────────────────────────────────────
  let destination: string | undefined
  const destMatch = name.match(/(?:to|in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i)
  if (destMatch) destination = destMatch[1]

  // ── Highlights ────────────────────────────────────────────────────
  const highlights: string[] = []
  block.find('li').each((_, li) => {
    const t = $(li).text().replace(/\s+/g, ' ').trim()
    if (t.length > 5 && t.length < 200 && highlights.length < 8) highlights.push(t)
  })

  // ── Supplier ──────────────────────────────────────────────────────
  let supplier = 'Unknown'
  try {
    const hostname = new URL(sourceUrl).hostname.replace('www.', '').split('.')[0]
    supplier = hostname.charAt(0).toUpperCase() + hostname.slice(1)
  } catch { /* ignore */ }

  return {
    name,
    description: description || undefined,
    destination,
    duration,
    price,
    imageUrl,
    bookingUrl,
    supplier,
    sourceUrl,
    highlights: highlights.length > 0 ? highlights : undefined,
  }
}
