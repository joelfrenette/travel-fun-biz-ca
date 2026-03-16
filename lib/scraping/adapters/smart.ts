import { load } from 'cheerio'
import type { ScrapedPackage } from '@/types/scrape'

/**
 * Smart Universal Scraper - Intelligently identifies travel packages on any page
 */
export function parseSmartUniversal(html: string, sourceUrl: string): ScrapedPackage[] {
  const $ = load(html)
  const packages: ScrapedPackage[] = []
  
  // Multiple strategies to find package containers
  const potentialContainers = findPackageContainers($)
  
  console.log('[smart-scraper] Found', potentialContainers.length, 'potential package containers')
  
  potentialContainers.each((idx, el) => {
    const container = $(el)
    const pkg = extractPackageData(container, sourceUrl, idx)
    
    // Only include if we have enough data
    if (isValidPackage(pkg)) {
      packages.push(pkg)
    }
  })
  
  console.log('[smart-scraper] Valid packages extracted:', packages.length)
  return packages
}

/**
 * Find potential package containers using multiple strategies
 */
function findPackageContainers($: cheerio.CheerioAPI): cheerio.Cheerio<cheerio.Element> {
  const candidates = $()
  
  // Strategy 1: Look for common grid/card layouts
  const commonCardSelectors = [
    '.fusion-layout-column',
    '.fusion-builder-column',
    '.et_pb_column',
    '.wp-block-column',
    'article',
    '[class*="package"]',
    '[class*="trip"]',
    '[class*="tour"]',
    '[class*="deal"]',
    '[class*="offer"]',
    '.card',
    '[class*="card"]',
    '.product',
    '[class*="product"]',
    '.item',
    '[class*="item"]',
  ]
  
  commonCardSelectors.forEach(selector => {
    candidates = candidates.add($(selector))
  })
  
  // Strategy 2: Look for elements with images + text + links
  $('*').each((_, el) => {
    const element = $(el)
    const hasImage = element.find('img').length > 0
    const hasLink = element.find('a[href]').length > 0
    const hasText = element.text().trim().length > 50
    
    if (hasImage && hasLink && hasText) {
      // Don't add parent elements (avoid duplicates)
      const isParent = element.parent().find(el).length > 0
      if (!isParent) {
        candidates = candidates.add(element)
      }
    }
  })
  
  // Filter to get the most specific containers
  return candidates.filter((_, el) => {
    const element = $(el)
    // Prefer containers that are relatively small (likely individual packages)
    const textLength = element.text().trim().length
    return textLength > 50 && textLength < 2000
  })
}

/**
 * Extract package data from a container
 */
function extractPackageData(container: cheerio.Cheerio<cheerio.Element>, sourceUrl: string, index: number): ScrapedPackage {
  const pkg: any = {
    name: '',
    description: '',
    imageUrl: '',
    bookingUrl: '',
    price: '',
    destination: '',
    duration: '',
    supplier: '',
    sourceUrl,
    highlights: [] as string[],
  }
  
  // Extract title (look for headings first)
  pkg.name = extractTitle(container)
  
  // Extract description (look for paragraph text)
  pkg.description = extractDescription(container)
  
  // Extract image
  pkg.imageUrl = extractImage(container, sourceUrl)
  
  // Extract price
  pkg.price = extractPrice(container)
  
  // Extract booking/link URL
  pkg.bookingUrl = extractBookingUrl(container, sourceUrl)
  
  // Extract date/duration
  pkg.duration = extractDateOrDuration(container)
  
  // Extract destination (city/country names)
  pkg.destination = extractDestination(container)
  
  // Extract highlights (list items, features)
  pkg.highlights = extractHighlights(container)
  
  // Extract supplier/brand
  pkg.supplier = extractSupplier(container, sourceUrl)
  
  return pkg
}

/**
 * Extract package title
 */
function extractTitle(container: cheerio.Cheerio<cheerio.Element>): string {
  // Try heading tags first
  const headings = container.find('h1, h2, h3, h4, h5, h6')
  if (headings.length > 0) {
    const firstHeading = headings.first()
    const text = firstHeading.text().trim()
    if (text.length > 5 && text.length < 200) {
      return text
    }
  }
  
  // Try elements with title/heading classes
  const titleElements = container.find('[class*="title"], [class*="heading"], [class*="name"]')
  if (titleElements.length > 0) {
    const text = titleElements.first().text().trim()
    if (text.length > 5 && text.length < 200) {
      return text
    }
  }
  
  // Try strong/bold text
  const boldText = container.find('strong, b')
  if (boldText.length > 0) {
    const text = boldText.first().text().trim()
    if (text.length > 5 && text.length < 200) {
      return text
    }
  }
  
  // Fallback: first significant text block
  const paragraphs = container.find('p')
  if (paragraphs.length > 0) {
    const text = paragraphs.first().text().trim()
    if (text.length > 10 && text.length < 100) {
      return text
    }
  }
  
  return `Package ${index}`
}

/**
 * Extract description
 */
function extractDescription(container: cheerio.Cheerio<cheerio.Element>): string {
  // Look for paragraph elements
  const paragraphs = container.find('p')
  if (paragraphs.length > 0) {
    // Skip the first paragraph if it looks like a title (short text)
    let startIndex = 0
    const firstParaText = paragraphs.first().text().trim()
    if (firstParaText.length < 50) {
      startIndex = 1
    }
    
    const desc = paragraphs.eq(startIndex).text().trim()
    if (desc.length > 20 && desc.length < 500) {
      return desc
    }
  }
  
  // Look for description/content classes
  const descElements = container.find('[class*="description"], [class*="content"], [class*="details"]')
  if (descElements.length > 0) {
    const text = descElements.first().text().trim()
    if (text.length > 20 && text.length < 500) {
      return text
    }
  }
  
  return ''
}

/**
 * Extract image URL
 */
function extractImage(container: cheerio.Cheerio<cheerio.Element>, sourceUrl: string): string | undefined {
  const img = container.find('img').first()
  if (img.length === 0) return undefined
  
  let src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src')
  
  if (!src) return undefined
  
  // Handle relative URLs
  if (src.startsWith('//')) {
    src = 'https:' + src
  } else if (src.startsWith('/')) {
    try {
      src = new URL(src, sourceUrl).href
    } catch {
      return undefined
    }
  } else if (!src.startsWith('http')) {
    try {
      src = new URL(src, sourceUrl).href
    } catch {
      return undefined
    }
  }
  
  return src
}

/**
 * Extract price
 */
function extractPrice(container: cheerio.Cheerio<cheerio.Element>): string | undefined {
  const text = container.text()
  
  // Look for price patterns: $123, $1,234, $1,234.56, $1,234 per person, From $123, Starting at $123
  const pricePatterns = [
    /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g, // $1,234.56
    /\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|CAD|EUR|GBP)/g, // 1,234.56 USD
    /\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*(?:dollars|eur|gbp)/gi, // 1,234.56 dollars
  ]
  
  for (const pattern of pricePatterns) {
    const matches = text.match(pattern)
    if (matches && matches.length > 0) {
      // Return the first match with context
      const match = matches[0]
      return match
    }
  }
  
  return undefined
}

/**
 * Extract booking/CTA URL
 */
function extractBookingUrl(container: cheerio.Cheerio<cheerio.Element>, sourceUrl: string): string | undefined {
  // Look for links with CTA text
  const ctaKeywords = ['book now', 'more info', 'request info', 'details', 'view', 'learn more', 'get quote']
  const links = container.find('a[href]')
  
  for (const link of links) {
    const linkText = $(link).text().toLowerCase()
    const linkClass = $(link).attr('class') || ''
    
    if (ctaKeywords.some(keyword => linkText.includes(keyword) || linkClass.toLowerCase().includes(keyword))) {
      const href = $(link).attr('href')
      if (href) {
        try {
          return new URL(href, sourceUrl).href
        } catch {
          return undefined
        }
      }
    }
  }
  
  // Fallback: first link
  const firstLink = links.first()
  if (firstLink.length > 0) {
    const href = firstLink.attr('href')
    if (href) {
      try {
        return new URL(href, sourceUrl).href
      } catch {
        return undefined
      }
    }
  }
  
  return undefined
}

/**
 * Extract date or duration
 */
function extractDateOrDuration(container: cheerio.Cheerio<cheerio<Element>): string | undefined {
  const text = container.text()
  
  // Look for date patterns: Jan 15, 2025; 2025-01-15; 15th January 2025
  const datePatterns = [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}\b/gi,
    /\d{4}-\d{2}-\d{2}/g,
    /\d{1,2}\/\d{1,2}\/\d{4}/g,
  ]
  
  for (const pattern of datePatterns) {
    const match = text.match(pattern)
    if (match) {
      return match[0]
    }
  }
  
  // Look for duration patterns: 7 days; 7 nights; 7 days 6 nights; 1 week
  const durationPatterns = [
    /\b\d+\s*days?\b/gi,
    /\b\d+\s*nights?\b/gi,
    /\b\d+\s*days?\s*\d+\s*nights?\b/gi,
    /\b\d+\s*week[s]?\b/gi,
  ]
  
  for (const pattern of durationPatterns) {
    const match = text.match(pattern)
    if (match) {
      return match[0]
    }
  }
  
  return undefined
}

/**
 * Extract destination (city/country names)
 */
function extractDestination(container: cheerio.Cheerio<cheerio<Element>): string | undefined {
  const text = container.text()
  
  // Common travel destination patterns
  // This is a simplified approach - could be enhanced with a geo-location API
  const destinationPatterns = [
    /\b(?:Paris|London|New York|Tokyo|Rome|Barcelona|Dubai|Sydney|Amsterdam|Berlin|Madrid|Toronto|Vancouver|Montreal|Miami|Los Angeles|San Francisco|Las Vegas|Chicago|Boston|Seattle|Denver|Atlanta|Dallas|Houston|Phoenix|San Diego|Orlando|Mexico City|Cancun|Punta Cana|Montego Bay|Nassau|St. Lucia|Aruba|Jamaica|Bahamas|Dominican Republic|Costa Rica|Panama|Colombia|Peru|Chile|Argentina|Brazil|Uruguay|Ecuador|Galapagos|Patagonia|Andes|Amazon|Machu Picchu|Cusco|Lima|Buenos Aires|Santiago|Rio de Janeiro|São Paulo|Bogotá|Caracas|Lima|Quito|San José|Panama City|Bridgetown|Port of Spain|Georgetown|Paramaribo|Cayenne|Fortaleza|Recife|Salvador|Brasília|Santiago|Montevideo|Asunción|La Paz|Sucre|Lima|Quito|Bogotá|Caracas|Georgetown|Paramaribo|Cayenne|Fortaleza|Recife|Salvador|Brasília|Rio|São Paulo|Buenos Aires|Montevideo|Santiago|Mendoza|Córdoba|Rosario|La Plata|Mar del Plata|Bariloche|Ushuaia|El Calafate|Iguazú|Salta|Jujuy|Tucumán|Mendoza|San Juan|Córdoba|Santa Fe|Entre Ríos|Corrientes|Misiones|Chaco|Formosa|La Pampa|Río Negro|Neuquén|Chubut|Santa Cruz|Tierra del Fuego|Antártida Argentina|Malvinas|Buenos Aires|Catamarca|Jujuy|Salta|Tucumán|Santiago del Estero|Chaco|Formosa|Misiones|Corrientes|Entre Ríos|Santa Fe|La Pampa|Río Negro|Neuquén|Chubut|Santa Cruz|Tierra del Fuego)\b/gi,
  ]
  
  for (const pattern of destinationPatterns) {
    const match = text.match(pattern)
    if (match) {
      return match[0]
    }
  }
  
  // Fallback: look for capitalized words that might be places
  const words = text.split(/\s+/)
  const capitalizedWords = words.filter(word => 
    /^[A-Z][a-z]+$/.test(word) && 
    word.length > 3 && 
    word.length < 20 &&
    !['And', 'The', 'With', 'From', 'This', 'Your', 'Book', 'Get'].includes(word)
  )
  
  if (capitalizedWords.length > 0 && capitalizedWords.length < 5) {
    return capitalizedWords.join(', ')
  }
  
  return undefined
}

/**
 * Extract highlights/features
 */
function extractHighlights(container: cheerio.Cheerio<cheerio<Element>): string[] {
  const highlights: string[] = []
  
  // Look for list items
  const listItems = container.find('li')
  listItems.each((_, li) => {
    const text = $(li).text().trim()
    if (text.length > 5 && text.length < 200 && !text.includes('Read more') && !text.includes('Learn more')) {
      highlights.push(text)
    }
  })
  
  // Look for feature indicators
  const featureElements = container.find('[class*="feature"], [class*="highlight"], [class*="include"]')
  featureElements.each((_, el) => {
    const text = $(el).text().trim()
    if (text.length > 5 && text.length < 200) {
      highlights.push(text)
    }
  })
  
  // Remove duplicates
  return [...new Set(highlights)].slice(0, 8)
}

/**
 * Extract supplier/brand name
 */
function extractSupplier(container: cheerio.Cheerio<cheerio<Element>, sourceUrl: string): string {
  // Try to extract from source URL
  try {
    const url = new URL(sourceUrl)
    const hostname = url.hostname.replace('www.', '').split('.')[0]
    // Capitalize first letter
    return hostname.charAt(0).toUpperCase() + hostname.slice(1)
  } catch {
    return 'Unknown'
  }
}

/**
 * Validate if extracted data represents a real package
 */
function isValidPackage(pkg: any): boolean {
  // Must have at least a name or description
  if (!pkg.name && !pkg.description) return false
  
  // Should have some content
  const hasContent = pkg.name || pkg.description || pkg.price || pkg.bookingUrl
  if (!hasContent) return false
  
  // Should have minimal text length
  const totalText = `${pkg.name} ${pkg.description} ${pkg.price}`.trim()
  if (totalText.length < 20) return false
  
  // Should have image OR booking URL (prefer both but allow either)
  if (!pkg.imageUrl && !pkg.bookingUrl) {
    // Only allow if we have good title and description
    if (!pkg.name || pkg.name.length < 10) return false
    if (!pkg.description || pkg.description.length < 30) return false
  }
  
  return true
}