import { load, type CheerioAPI } from 'cheerio'
import type { ScrapedPackage } from '@/types/scrape'

/**
 * Parser for travelfunbiz.com
 *
 * The page uses a simple repeating layout: each travel package is a visual
 * "card" containing an image, a bold heading, date/duration text, a short
 * description, and a CTA button ("MORE INFO" / "REQUEST INFO").
 *
 * Strategy:
 *  1. Find all CTA links (MORE INFO, REQUEST INFO, BOOK NOW, FREE WEBINAR).
 *  2. Walk up the DOM from each CTA to find the nearest ancestor that also
 *     contains an image and a heading — that ancestor is the package block.
 *  3. Extract structured data from each block.
 */
export function parseTravelFunBiz(html: string, sourceUrl: string): ScrapedPackage[] {
  const $ = load(html)
  const packages: ScrapedPackage[] = []
  const seen = new Set<string>() // deduplicate by name

  console.log('[travelfunbiz] Starting parse, HTML length:', html.length)

  // ── Strategy 1: CTA-anchor walk-up ────────────────────────────────
  const ctaAnchors = $(
    'a:contains("MORE INFO"), a:contains("More Info"), ' +
    'a:contains("REQUEST INFO"), a:contains("Request Info"), ' +
    'a:contains("BOOK NOW"), a:contains("Book Now"), ' +
    'a:contains("FREE WEBINAR"), a:contains("Free Webinar"), ' +
    'a:contains("VIEW DETAILS"), a:contains("View Details")'
  )

  console.log('[travelfunbiz] CTA anchors found:', ctaAnchors.length)

  ctaAnchors.each((_, anchor) => {
    const block = findPackageBlock($, $(anchor))
    if (!block) return

    const pkg = extractFromBlock($, block, sourceUrl)
    if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
      // Skip non-package items (e.g. "HOW TO BECOME A TRAVEL AGENT")
      if (/become a travel agent|webinar|training/i.test(pkg.name)) return
      seen.add(pkg.name.toLowerCase())
      packages.push(pkg)
      console.log('[travelfunbiz] ✓ Package:', pkg.name)
    }
  })

  // ── Strategy 2: Heading-based fallback ────────────────────────────
  // If strategy 1 found nothing, look for headings that look like trip names
  if (packages.length === 0) {
    console.log('[travelfunbiz] CTA strategy found 0, trying heading strategy...')

    $('h1, h2, h3, h4, h5, h6, strong, b').each((_, el) => {
      const heading = $(el)
      const text = heading.text().replace(/\s+/g, ' ').trim()

      // Must look like a trip name (>10 chars, not generic)
      if (text.length < 10 || text.length > 200) return
      if (/menu|nav|footer|header|copyright|cookie|privacy/i.test(text)) return

      const block = findPackageBlock($, heading)
      if (!block) return

      const pkg = extractFromBlock($, block, sourceUrl)
      if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
        if (/become a travel agent|webinar|training/i.test(pkg.name)) return
        seen.add(pkg.name.toLowerCase())
        packages.push(pkg)
        console.log('[travelfunbiz] ✓ Package (heading):', pkg.name)
      }
    })
  }

  // ── Strategy 3: Table-row based ───────────────────────────────────
  // Some older sites use <table> layouts
  if (packages.length === 0) {
    console.log('[travelfunbiz] Heading strategy found 0, trying table strategy...')

    $('tr, table').each((_, el) => {
      const row = $(el)
      const hasImg = row.find('img').length > 0
      const hasLink = row.find('a[href]').length > 0
      const textLen = row.text().replace(/\s+/g, ' ').trim().length

      if (hasImg && hasLink && textLen > 30 && textLen < 2000) {
        const pkg = extractFromBlock($, row, sourceUrl)
        if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
          if (/become a travel agent|webinar|training/i.test(pkg.name)) return
          seen.add(pkg.name.toLowerCase())
          packages.push(pkg)
          console.log('[travelfunbiz] ✓ Package (table):', pkg.name)
        }
      }
    })
  }

  console.log('[travelfunbiz] Total packages found:', packages.length)
  return packages
}

/**
 * Walk up from an element to find the nearest ancestor that looks like a
 * self-contained package block (has image + text content).
 */
function findPackageBlock($: CheerioAPI, startEl: ReturnType<CheerioAPI>): ReturnType<CheerioAPI> | null {
  let el = startEl.parent()
  let depth = 0
  const maxDepth = 10

  while (el.length > 0 && depth < maxDepth) {
    const hasImg = el.find('img').length > 0
    const textLen = el.text().replace(/\s+/g, ' ').trim().length

    // A good block has an image, reasonable text, and isn't the whole page
    if (hasImg && textLen > 30 && textLen < 3000) {
      // Make sure we're not at a page-level container (body, main, etc.)
      const tag = el.prop('tagName')?.toLowerCase() || ''
      if (['body', 'html', 'main', 'header', 'footer'].includes(tag)) break

      // Check that this block doesn't contain too many other CTA links
      // (which would mean it's a parent container of multiple packages)
      const ctaCount = el.find(
        'a:contains("MORE INFO"), a:contains("REQUEST INFO"), a:contains("BOOK NOW"), a:contains("FREE WEBINAR")'
      ).length
      if (ctaCount <= 1) {
        return el
      }
      // If it has multiple CTAs, it's a parent — keep going up but also
      // try the current level's children
    }

    el = el.parent()
    depth++
  }

  // Fallback: return the direct parent of the start element if it has some content
  const parent = startEl.parent()
  if (parent.text().replace(/\s+/g, ' ').trim().length > 20) {
    return parent
  }

  return null
}

/**
 * Extract package data from a DOM block.
 */
function extractFromBlock($: CheerioAPI, block: ReturnType<CheerioAPI>, sourceUrl: string): ScrapedPackage | null {
  const allText = block.text().replace(/\s+/g, ' ').trim()

  // ── Name ──────────────────────────────────────────────────────────
  let name = ''

  // Try headings first
  const headings = block.find('h1, h2, h3, h4, h5, h6')
  if (headings.length > 0) {
    // Pick the first heading that looks like a trip name
    headings.each((_, h) => {
      if (name) return
      const t = $(h).text().replace(/\s+/g, ' ').trim()
      if (t.length >= 8 && t.length <= 200) {
        name = t
      }
    })
  }

  // Fallback: bold/strong text
  if (!name) {
    block.find('strong, b').each((_, el) => {
      if (name) return
      const t = $(el).text().replace(/\s+/g, ' ').trim()
      if (t.length >= 8 && t.length <= 200) {
        name = t
      }
    })
  }

  // Fallback: first link text that's long enough
  if (!name) {
    block.find('a').each((_, el) => {
      if (name) return
      const t = $(el).text().replace(/\s+/g, ' ').trim()
      if (t.length >= 10 && t.length <= 200 && !/more info|request|book|webinar/i.test(t)) {
        name = t
      }
    })
  }

  if (!name || name.length < 5) return null

  // ── Description ───────────────────────────────────────────────────
  let description = ''
  const paragraphs = block.find('p')
  const descParts: string[] = []

  paragraphs.each((_, p) => {
    const t = $(p).text().replace(/\s+/g, ' ').trim()
    // Skip very short or CTA-like text
    if (t.length > 15 && !/^(more info|request info|book now|free webinar)$/i.test(t)) {
      descParts.push(t)
    }
  })

  description = descParts.join(' ').trim()

  // If no <p> tags, try extracting text that isn't the heading or CTA
  if (!description) {
    // Get all text nodes, remove the name and CTA text
    let remaining = allText
      .replace(name, '')
      .replace(/MORE INFO|REQUEST INFO|BOOK NOW|FREE WEBINAR/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (remaining.length > 15) {
      description = remaining.substring(0, 500)
    }
  }

  // ── Image ─────────────────────────────────────────────────────────
  let imageUrl: string | undefined
  const imgs = block.find('img')
  imgs.each((_, img) => {
    if (imageUrl) return
    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src')
    if (src && !/spacer|pixel|blank|logo|icon|avatar/i.test(src)) {
      try {
        imageUrl = new URL(src, sourceUrl).href
      } catch {
        imageUrl = src
      }
    }
  })

  // ── Booking URL ───────────────────────────────────────────────────
  let bookingUrl: string | undefined
  const links = block.find('a[href]')
  links.each((_, a) => {
    if (bookingUrl) return
    const linkText = $(a).text().replace(/\s+/g, ' ').trim().toLowerCase()
    if (/more info|request info|book now|view details|details|learn more/i.test(linkText)) {
      const href = $(a).attr('href')
      if (href && href !== '#') {
        try {
          bookingUrl = new URL(href, sourceUrl).href
        } catch {
          bookingUrl = href
        }
      }
    }
  })

  // Fallback: first non-anchor link
  if (!bookingUrl) {
    links.each((_, a) => {
      if (bookingUrl) return
      const href = $(a).attr('href')
      if (href && href !== '#' && !href.startsWith('javascript:')) {
        try {
          bookingUrl = new URL(href, sourceUrl).href
        } catch {
          bookingUrl = href
        }
      }
    })
  }

  // ── Duration / Dates ──────────────────────────────────────────────
  let duration: string | undefined
  let startDate: string | undefined
  let endDate: string | undefined

  // Try multiple date patterns

  // Pattern 1: "April 3 – 11, 2026" (same month)
  const sameMonthMatch = allText.match(
    /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2})\s*[–\-—]\s*(\d{1,2}),?\s*(\d{4})\b/i
  )
  if (sameMonthMatch) {
    const month = sameMonthMatch[1].match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)/i)?.[0] || ''
    startDate = `${sameMonthMatch[1]}, ${sameMonthMatch[3]}`
    endDate = `${month} ${sameMonthMatch[2]}, ${sameMonthMatch[3]}`
    console.log('[travelfunbiz] Parsed same-month date range:', startDate, '-', endDate)
  }

  // Pattern 2: "April 25 – May 9, 2026" (different months)
  if (!startDate) {
    const diffMonthMatch = allText.match(
      /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2})\s*[–\-—]\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}),?\s*(\d{4})\b/i
    )
    if (diffMonthMatch) {
      startDate = `${diffMonthMatch[1]}, ${diffMonthMatch[3]}`
      endDate = `${diffMonthMatch[2]}, ${diffMonthMatch[3]}`
      console.log('[travelfunbiz] Parsed diff-month date range:', startDate, '-', endDate)
    }
  }

  // Pattern 3: "March 13 - 21, 2025" with hyphen
  if (!startDate) {
    const hyphenMatch = allText.match(
      /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2}),?\s*(\d{4})\b/i
    )
    if (hyphenMatch) {
      startDate = `${hyphenMatch[1]} ${hyphenMatch[2]}, ${hyphenMatch[4]}`
      endDate = `${hyphenMatch[1]} ${hyphenMatch[3]}, ${hyphenMatch[4]}`
      console.log('[travelfunbiz] Parsed hyphen date range:', startDate, '-', endDate)
    }
  }

  // Pattern 4: "September 3 - 16, 2026" 
  if (!startDate) {
    const fullMonthMatch = allText.match(
      /\b(September|October|November|December|January|February|March|April|May|June|July|August)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2}),?\s*(\d{4})\b/i
    )
    if (fullMonthMatch) {
      startDate = `${fullMonthMatch[1]} ${fullMonthMatch[2]}, ${fullMonthMatch[4]}`
      endDate = `${fullMonthMatch[1]} ${fullMonthMatch[3]}, ${fullMonthMatch[4]}`
      console.log('[travelfunbiz] Parsed full month date range:', startDate, '-', endDate)
    }
  }

  // Pattern 5: ISO dates "2026-04-03"
  if (!startDate) {
    const isoMatch = allText.match(/(\d{4}-\d{2}-\d{2})/g)
    if (isoMatch && isoMatch.length >= 1) {
      startDate = isoMatch[0]
      if (isoMatch.length >= 2) endDate = isoMatch[1]
      console.log('[travelfunbiz] Parsed ISO dates:', startDate, endDate)
    }
  }

  // Convert text dates to ISO format for database storage
  function parseTextDate(textDate: string): string | undefined {
    if (!textDate) return undefined
    
    // Already ISO format
    if (/^\d{4}-\d{2}-\d{2}$/.test(textDate)) return textDate
    
    const months: Record<string, string> = {
      'jan': '01', 'january': '01',
      'feb': '02', 'february': '02',
      'mar': '03', 'march': '03',
      'apr': '04', 'april': '04',
      'may': '05',
      'jun': '06', 'june': '06',
      'jul': '07', 'july': '07',
      'aug': '08', 'august': '08',
      'sep': '09', 'september': '09',
      'oct': '10', 'october': '10',
      'nov': '11', 'november': '11',
      'dec': '12', 'december': '12',
    }
    
    // Parse "April 3, 2026" or "Apr 3, 2026"
    const match = textDate.match(/([a-z]+)\s+(\d{1,2}),?\s*(\d{4})/i)
    if (match) {
      const monthNum = months[match[1].toLowerCase()]
      if (monthNum) {
        const day = match[2].padStart(2, '0')
        return `${match[3]}-${monthNum}-${day}`
      }
    }
    
    return undefined
  }

  const parsedStartDate = parseTextDate(startDate || '')
  const parsedEndDate = parseTextDate(endDate || '')

  // Duration: "(7 Nights)" or "(9 Days)" or "(14 Nights Transatlantic)"
  const durationMatch = allText.match(/\((\d+)\s*(nights?|days?)[^)]*\)/i)
  if (durationMatch) {
    duration = durationMatch[0].replace(/[()]/g, '').trim()
  }

  // Also try "X Days" without parens
  if (!duration) {
    const daysMatch = allText.match(/\b(\d+)\s*(days?|nights?)\b/i)
    if (daysMatch) {
      duration = `${daysMatch[1]} ${daysMatch[2]}`
    }
  }

  // ── Destination ───────────────────────────────────────────────────
  let destination: string | undefined

  // Common destinations mentioned on this specific site
  const destinations = [
    'Switzerland', 'Japan', 'Barcelona', 'Spain', 'Aruba', 'Costa Rica',
    'Alaska', 'Danube', 'Italy', 'Sicily', 'Croatia', 'Budapest', 'Hungary',
    'Vienna', 'Austria', 'Germany', 'Regensburg', 'Passau', 'Tokyo', 'Kyoto',
    'Osaka', 'Crans Montana', 'Verbier', 'Monteverde', 'Ketchikan', 'Sitka',
    'Dubrovnik', 'Split', 'Hvar', 'Korcula', 'Taormina', 'Amalfi',
    'Palermo', 'Monreale', 'Sorrento', 'Positano', 'Pompeii',
    'New York', 'Funchal', 'Tangiers', 'Malaga', 'Palma De Mallorca',
    'Ponta Delgada', 'Seattle', 'Prince Rupert',
  ]

  for (const dest of destinations) {
    if (allText.toLowerCase().includes(dest.toLowerCase())) {
      destination = dest
      break
    }
  }

  // Try to extract from the name itself
  if (!destination) {
    const nameDestMatch = name.match(/(?:to|in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i)
    if (nameDestMatch) {
      destination = nameDestMatch[1]
    }
  }

  // ── Price ─────────────────────────────────────────────────────────
  let price: string | undefined
  const priceMatch = allText.match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/)
  if (priceMatch) {
    price = priceMatch[0]
  }

  // ── Highlights ────────────────────────────────────────────────────
  const highlights: string[] = []
  block.find('li').each((_, li) => {
    const t = $(li).text().replace(/\s+/g, ' ').trim()
    if (t.length > 5 && t.length < 200) {
      highlights.push(t)
    }
  })

  // Also extract "Highlights:" text if present
  const highlightsMatch = allText.match(/highlights?[:\s]+([^.]+)/i)
  if (highlightsMatch && highlights.length === 0) {
    const parts = highlightsMatch[1].split(/[–\-—,]/).map(s => s.trim()).filter(s => s.length > 3)
    highlights.push(...parts.slice(0, 8))
  }

  return {
    name,
    description: description || undefined,
    destination,
    startDate: parsedStartDate || startDate,
    endDate: parsedEndDate || endDate,
    duration,
    price,
    imageUrl,
    bookingUrl,
    supplier: 'TravelFunBiz',
    sourceUrl,
    highlights: highlights.length > 0 ? highlights : undefined,
  }
}