import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY

export async function POST(request: Request) {
  // Auth check
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  console.log('[scrape] Auth header present:', !!authHeader)
  console.log('[scrape] Token length:', token?.length || 0)
  
  const email = validateToken(token || '')
  if (!email) {
    console.log('[scrape] Token validation failed')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  console.log('[scrape] Authenticated as:', email)

  if (!SCRAPINGBEE_API_KEY) {
    console.log('[scrape] SCRAPINGBEE_API_KEY not configured')
    return NextResponse.json({ error: 'Scraping API not configured. Add SCRAPINGBEE_API_KEY to environment variables.' }, { status: 500 })
  }

  try {
    const { url } = await request.json()

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 })
    }

    // Call ScrapingBee to fetch the page
    const scrapingBeeUrl = new URL('https://app.scrapingbee.com/api/v1/')
    scrapingBeeUrl.searchParams.set('api_key', SCRAPINGBEE_API_KEY)
    scrapingBeeUrl.searchParams.set('url', url)
    scrapingBeeUrl.searchParams.set('render_js', 'true')
    scrapingBeeUrl.searchParams.set('premium_proxy', 'true')
    
    console.log('[scrape] Fetching URL:', url)

    const response = await fetch(scrapingBeeUrl.toString(), {
      method: 'GET',
    })

    if (!response.ok) {
      console.error('[scrape] ScrapingBee error:', response.status, await response.text())
      return NextResponse.json({ error: 'Failed to scrape URL' }, { status: 500 })
    }

    const html = await response.text()

    // Extract package data from HTML using simple regex patterns
    // This is a basic extraction — can be enhanced with AI later
    const extractedData = extractPackageData(html, url)

    console.log('[scrape] Extracted data:', extractedData)

    return NextResponse.json({ 
      success: true, 
      data: extractedData,
      html_length: html.length 
    })

  } catch (error) {
    console.error('[scrape] Error:', error)
    return NextResponse.json({ error: 'Scraping failed' }, { status: 500 })
  }
}

function extractPackageData(html: string, sourceUrl: string): Record<string, any> {
  const data: Record<string, any> = {
    source_url: sourceUrl,
  }

  // Helper to extract text between tags
  function extractMeta(name: string): string | null {
    const patterns = [
      new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`, 'i'),
      new RegExp(`<meta[^>]*property=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${name}["']`, 'i'),
    ]
    for (const pattern of patterns) {
      const match = html.match(pattern)
      if (match) return match[1].trim()
    }
    return null
  }

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) {
    data.name = titleMatch[1].trim()
      .replace(/\s*\|.*$/, '') // Remove site name after |
      .replace(/\s*-\s*[^-]+$/, '') // Remove site name after -
      .trim()
  }

  // Extract meta description
  const metaDesc = extractMeta('description') || extractMeta('og:description')
  if (metaDesc) {
    data.short_description = metaDesc.substring(0, 300)
  }

  // Extract OG image
  const ogImage = extractMeta('og:image')
  if (ogImage) {
    data.image_url = ogImage.startsWith('http') ? ogImage : new URL(ogImage, sourceUrl).href
  }

  // Try to extract price (common patterns)
  const pricePatterns = [
    /(?:from|starting at|price[:\s]*)\s*\$?([\d,]+(?:\.\d{2})?)/i,
    /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per person|pp|\/person)?/i,
    /USD\s*([\d,]+(?:\.\d{2})?)/i,
    /CAD\s*([\d,]+(?:\.\d{2})?)/i,
  ]
  for (const pattern of pricePatterns) {
    const match = html.match(pattern)
    if (match) {
      const priceNum = parseFloat(match[1].replace(/,/g, ''))
      if (priceNum > 100 && priceNum < 50000) { // Reasonable travel package price range
        data.price_display = `From $${priceNum.toLocaleString()}`
        data.price_value = priceNum
        break
      }
    }
  }

  // Try to extract duration
  const durationPatterns = [
    /(\d+)\s*(?:days?|nights?)\s*[\/&,]\s*(\d+)\s*(?:days?|nights?)/i,
    /(\d+)\s*days?\s*(?:and|&)?\s*(\d+)\s*nights?/i,
    /(\d+)\s*nights?/i,
    /(\d+)\s*days?/i,
  ]
  for (const pattern of durationPatterns) {
    const match = html.match(pattern)
    if (match) {
      if (match[2]) {
        data.duration = `${match[1]} Days / ${match[2]} Nights`
        data.duration_days = parseInt(match[1])
      } else {
        const num = parseInt(match[1])
        if (num >= 2 && num <= 30) {
          data.duration = `${num} Days`
          data.duration_days = num
        }
      }
      break
    }
  }

  // Try to extract destination from URL or content
  const urlParts = sourceUrl.toLowerCase()
  const destinations = [
    'cancun', 'mexico', 'caribbean', 'jamaica', 'bahamas', 'aruba', 'cuba',
    'dominican', 'punta cana', 'riviera maya', 'costa rica', 'hawaii',
    'europe', 'italy', 'france', 'spain', 'greece', 'croatia',
    'thailand', 'bali', 'maldives', 'fiji', 'tahiti',
    'alaska', 'mediterranean', 'river cruise', 'ocean cruise'
  ]
  for (const dest of destinations) {
    if (urlParts.includes(dest.replace(' ', '')) || html.toLowerCase().includes(dest)) {
      data.destination = dest.charAt(0).toUpperCase() + dest.slice(1)
      break
    }
  }

  // Try to identify supplier from URL
  const supplierPatterns: Record<string, string> = {
    'sandals': 'Sandals Resorts',
    'beaches': 'Beaches Resorts',
    'royalcaribbean': 'Royal Caribbean',
    'carnival': 'Carnival Cruise Line',
    'norwegian': 'Norwegian Cruise Line',
    'princess': 'Princess Cruises',
    'viking': 'Viking Cruises',
    'celebrity': 'Celebrity Cruises',
    'holland': 'Holland America',
    'msc': 'MSC Cruises',
    'clubmed': 'Club Med',
    'funjet': 'Funjet Vacations',
    'apple': 'Apple Vacations',
    'costco': 'Costco Travel',
    'expedia': 'Expedia',
    'travelzoo': 'Travelzoo',
  }
  for (const [key, value] of Object.entries(supplierPatterns)) {
    if (urlParts.includes(key)) {
      data.supplier = value
      break
    }
  }

  // Extract any bullet points or highlights
  const listItemMatches = html.match(/<li[^>]*>([^<]{10,100})<\/li>/gi)
  if (listItemMatches && listItemMatches.length > 0) {
    const highlights = listItemMatches
      .slice(0, 8)
      .map(li => li.replace(/<[^>]+>/g, '').trim())
      .filter(text => text.length > 10 && text.length < 100)
    if (highlights.length > 0) {
      data.highlights = highlights
    }
  }

  // Set booking URL to source
  data.booking_url = sourceUrl

  // Default category based on content
  const categoryKeywords: Record<string, string[]> = {
    'Cruise': ['cruise', 'sailing', 'ship', 'cabin', 'deck'],
    'Beach & Resort': ['beach', 'resort', 'all-inclusive', 'pool', 'spa'],
    'Adventure': ['adventure', 'hiking', 'safari', 'expedition', 'trek'],
    'Cultural': ['cultural', 'history', 'museum', 'heritage', 'tour'],
    'Luxury': ['luxury', 'premium', 'exclusive', '5-star', 'five star'],
    'Family': ['family', 'kids', 'children', 'disney'],
    'Honeymoon': ['honeymoon', 'romantic', 'couples', 'wedding'],
  }
  const lowerHtml = html.toLowerCase()
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some(kw => lowerHtml.includes(kw))) {
      data.category = category
      break
    }
  }
  if (!data.category) {
    data.category = 'Adventure' // Default
  }

  return data
}