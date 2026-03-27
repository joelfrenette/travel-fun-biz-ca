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

  // ── Collect ALL images on the page for fallback matching ──────────
  const allPageImages: { src: string; alt: string; el: ReturnType<CheerioAPI> }[] = []
  $('img').each((_, img) => {
    const el = $(img)
    const src = extractImgSrc($, el, sourceUrl)
    if (src) {
      allPageImages.push({ src, alt: (el.attr('alt') || '').toLowerCase(), el })
    }
  })
  console.log('[travelfunbiz] Total page images found:', allPageImages.length)

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

    const pkg = extractFromBlock($, block, sourceUrl, allPageImages)
    if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
      // Skip non-package items (e.g. "HOW TO BECOME A TRAVEL AGENT")
      if (/become a travel agent|webinar|training/i.test(pkg.name)) return
      seen.add(pkg.name.toLowerCase())
      packages.push(pkg)
      console.log('[travelfunbiz] ✓ Package:', pkg.name, '| Image:', pkg.imageUrl ? 'YES' : 'NO')
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

      const pkg = extractFromBlock($, block, sourceUrl, allPageImages)
      if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
        if (/become a travel agent|webinar|training/i.test(pkg.name)) return
        seen.add(pkg.name.toLowerCase())
        packages.push(pkg)
        console.log('[travelfunbiz] ✓ Package (heading):', pkg.name, '| Image:', pkg.imageUrl ? 'YES' : 'NO')
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
        const pkg = extractFromBlock($, row, sourceUrl, allPageImages)
        if (pkg && pkg.name && !seen.has(pkg.name.toLowerCase())) {
          if (/become a travel agent|webinar|training/i.test(pkg.name)) return
          seen.add(pkg.name.toLowerCase())
          packages.push(pkg)
          console.log('[travelfunbiz] ✓ Package (table):', pkg.name, '| Image:', pkg.imageUrl ? 'YES' : 'NO')
        }
      }
    })
  }

  // Log summary
  const withImages = packages.filter(p => p.imageUrl).length
  const withoutImages = packages.filter(p => !p.imageUrl).length
  console.log('[travelfunbiz] Total packages found:', packages.length, `(${withImages} with images, ${withoutImages} without)`)

  return packages
}

/**
 * Extract image src from an <img> element, checking all common attributes.
 */
function extractImgSrc($: CheerioAPI, el: ReturnType<CheerioAPI>, baseUrl: string): string | undefined {
  const src =
    el.attr('src') ||
    el.attr('data-src') ||
    el.attr('data-lazy-src') ||
    el.attr('data-lazy') ||
    el.attr('data-original') ||
    el.attr('data-full-url') ||
    el.attr('data-img-url') ||
    (el.attr('srcset') || '').split(',')[0]?.trim().split(' ')[0] ||
    (el.attr('data-srcset') || '').split(',')[0]?.trim().split(' ')[0] ||
    ''

  if (!src || /spacer|pixel|blank|logo|icon|avatar|data:image/i.test(src)) {
    return undefined
  }

  // Skip tiny tracking pixels (1x1, 2x2, etc.)
  const width = parseInt(el.attr('width') || '0', 10)
  const height = parseInt(el.attr('height') || '0', 10)
  if ((width > 0 && width < 10) || (height > 0 && height < 10)) {
    return undefined
  }

  try {
    return new URL(src, baseUrl).href
  } catch {
    return src
  }
}

/**
 * Walk up from an element to find the nearest ancestor that looks like a
 * self-contained package block (has image + text content).
 * 
 * IMPORTANT: We use a wider search — up to 12 levels — and accept blocks
 * even without images (we'll find images via sibling/proximity search later).
 */
function findPackageBlock($: CheerioAPI, startEl: ReturnType<CheerioAPI>): ReturnType<CheerioAPI> | null {
  let el = startEl.parent()
  let depth = 0
  const maxDepth = 12

  while (el.length > 0 && depth < maxDepth) {
    const textLen = el.text().replace(/\s+/g, ' ').trim().length

    // A good block has reasonable text and isn't the whole page
    if (textLen > 30 && textLen < 3000) {
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
function extractFromBlock(
  $: CheerioAPI,
  block: ReturnType<CheerioAPI>,
  sourceUrl: string,
  allPageImages: { src: string; alt: string; el: ReturnType<CheerioAPI> }[]
): ScrapedPackage | null {
  const allText = block.text().replace(/\s+/g, ' ').trim()

  // ── Name ──────────────────────────────────────────────────────────
  let name = ''

  // Try headings first
  const headings = block.find('h1, h2, h3, h4, h5, h6')
  if (headings.length > 0) {
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
    if (t.length > 15 && !/^(more info|request info|book now|free webinar)$/i.test(t)) {
      descParts.push(t)
    }
  })

  description = descParts.join(' ').trim()

  if (!description) {
    let remaining = allText
      .replace(name, '')
      .replace(/MORE INFO|REQUEST INFO|BOOK NOW|FREE WEBINAR/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (remaining.length > 15) {
      description = remaining.substring(0, 500)
    }
  }

  // ── Image (multi-strategy) ────────────────────────────────────────
  let imageUrl: string | undefined

  // Strategy A: Look for images directly inside the block
  const imgs = block.find('img')
  console.log(`[travelfunbiz] [${name.substring(0, 30)}] Images in block: ${imgs.length}`)
  
  imgs.each((_, img) => {
    if (imageUrl) return
    const el = $(img)
    const src = extractImgSrc($, el, sourceUrl)
    if (src) {
      imageUrl = src
      console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found image in block: ${src.substring(0, 80)}`)
    }
  })

  // Strategy B: Look at the parent container (one level up from block)
  if (!imageUrl) {
    const parent = block.parent()
    if (parent.length > 0) {
      parent.find('img').each((_, img) => {
        if (imageUrl) return
        const el = $(img)
        const src = extractImgSrc($, el, sourceUrl)
        if (src) {
          imageUrl = src
          console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found image in parent: ${src.substring(0, 80)}`)
        }
      })
    }
  }

  // Strategy C: Look at previous siblings (image often comes before the text block)
  if (!imageUrl) {
    let sibling = block.prev()
    let siblingDepth = 0
    while (sibling.length > 0 && siblingDepth < 5) {
      sibling.find('img').each((_, img) => {
        if (imageUrl) return
        const el = $(img)
        const src = extractImgSrc($, el, sourceUrl)
        if (src) {
          imageUrl = src
          console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found image in prev sibling: ${src.substring(0, 80)}`)
        }
      })
      // Also check if the sibling itself is an img
      if (!imageUrl && sibling.is('img')) {
        const src = extractImgSrc($, sibling, sourceUrl)
        if (src) {
          imageUrl = src
          console.log(`[travelfunbiz] [${name.substring(0, 30)}] Sibling IS an image: ${src.substring(0, 80)}`)
        }
      }
      if (imageUrl) break
      sibling = sibling.prev()
      siblingDepth++
    }
  }

  // Strategy D: Look at next siblings
  if (!imageUrl) {
    let sibling = block.next()
    let siblingDepth = 0
    while (sibling.length > 0 && siblingDepth < 3) {
      sibling.find('img').each((_, img) => {
        if (imageUrl) return
        const el = $(img)
        const src = extractImgSrc($, el, sourceUrl)
        if (src) {
          imageUrl = src
          console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found image in next sibling: ${src.substring(0, 80)}`)
        }
      })
      if (imageUrl) break
      sibling = sibling.next()
      siblingDepth++
    }
  }

  // Strategy E: Check for background-image in style attributes
  if (!imageUrl) {
    block.find('[style]').each((_, el) => {
      if (imageUrl) return
      const style = $(el).attr('style') || ''
      const bgMatch = style.match(/background-image\s*:\s*url\(['"]?([^'")\s]+)['"]?\)/i)
      if (bgMatch && bgMatch[1]) {
        try {
          imageUrl = new URL(bgMatch[1], sourceUrl).href
          console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found background-image: ${imageUrl.substring(0, 80)}`)
        } catch {
          imageUrl = bgMatch[1]
        }
      }
    })
    // Also check parent for background images
    if (!imageUrl) {
      block.parent().find('[style]').each((_, el) => {
        if (imageUrl) return
        const style = $(el).attr('style') || ''
        const bgMatch = style.match(/background-image\s*:\s*url\(['"]?([^'")\s]+)['"]?\)/i)
        if (bgMatch && bgMatch[1]) {
          try {
            imageUrl = new URL(bgMatch[1], sourceUrl).href
            console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found bg-image in parent: ${imageUrl.substring(0, 80)}`)
          } catch {
            imageUrl = bgMatch[1]
          }
        }
      })
    }
  }

  // Strategy F: Fuzzy match — find a page image whose alt text matches the package name
  if (!imageUrl) {
    const nameLower = name.toLowerCase()
    const nameWords = nameLower.split(/\s+/).filter(w => w.length > 3)

    for (const pageImg of allPageImages) {
      // Check if alt text contains significant words from the package name
      const matchCount = nameWords.filter(w => pageImg.alt.includes(w)).length
      if (matchCount >= 2 || (nameWords.length <= 2 && matchCount >= 1)) {
        imageUrl = pageImg.src
        console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found image by alt-text match: ${imageUrl.substring(0, 80)}`)
        break
      }
    }
  }

  // Strategy G: Look for <a> wrapping an image near the block (linked images)
  if (!imageUrl) {
    block.find('a img, a[href] img').each((_, img) => {
      if (imageUrl) return
      const el = $(img)
      const src = extractImgSrc($, el, sourceUrl)
      if (src) {
        imageUrl = src
        console.log(`[travelfunbiz] [${name.substring(0, 30)}] Found linked image: ${src.substring(0, 80)}`)
      }
    })
  }

  if (!imageUrl) {
    console.log(`[travelfunbiz] [${name.substring(0, 30)}] ⚠ NO IMAGE FOUND after all strategies`)
  }

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

  // Pattern 1: "April 3 – 11, 2026" (same month)
  const sameMonthMatch = allText.match(
    /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2})\s*[–\-—]\s*(\d{1,2}),?\s*(\d{4})\b/i
  )
  if (sameMonthMatch) {
    const month = sameMonthMatch[1].match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)/i)?.[0] || ''
    startDate = `${sameMonthMatch[1]}, ${sameMonthMatch[3]}`
    endDate = `${month} ${sameMonthMatch[2]}, ${sameMonthMatch[3]}`
  }

  // Pattern 2: "April 25 – May 9, 2026" (different months)
  if (!startDate) {
    const diffMonthMatch = allText.match(
      /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2})\s*[–\-—]\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}),?\s*(\d{4})\b/i
    )
    if (diffMonthMatch) {
      startDate = `${diffMonthMatch[1]}, ${diffMonthMatch[3]}`
      endDate = `${diffMonthMatch[2]}, ${diffMonthMatch[3]}`
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
    }
  }

  // Pattern 5: ISO dates "2026-04-03"
  if (!startDate) {
    const isoMatch = allText.match(/(\d{4}-\d{2}-\d{2})/g)
    if (isoMatch && isoMatch.length >= 1) {
      startDate = isoMatch[0]
      if (isoMatch.length >= 2) endDate = isoMatch[1]
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
