import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { parsePackagesFromHtml } from '@/lib/scraping'

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')

  console.log('[scrape-api] Request received')
  console.log('[scrape-api] Token exists:', !!token)
  
  const email = validateToken(token || '')
  if (!email) {
    console.log('[scrape-api] Unauthorized - invalid token')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!SCRAPINGBEE_API_KEY) {
    console.log('[scrape-api] API key not configured')
    return NextResponse.json({ error: 'Scraping API not configured. Add SCRAPINGBEE_API_KEY.' }, { status: 500 })
  }

  try {
    const { url } = await request.json()

    console.log('[scrape-api] URL to scrape:', url)

    if (!url || typeof url !== 'string') {
      console.log('[scrape-api] Invalid URL')
      return NextResponse.json({ error: 'URL is required' }, { status: 400 })
    }

    const scrapingBeeUrl = new URL('https://app.scrapingbee.com/api/v1/')
    scrapingBeeUrl.searchParams.set('api_key', SCRAPINGBEE_API_KEY)
    scrapingBeeUrl.searchParams.set('url', url)
    scrapingBeeUrl.searchParams.set('render_js', 'true')
    scrapingBeeUrl.searchParams.set('premium_proxy', 'true')

    console.log('[scrape-api] Calling ScrapingBee...')

    const response = await fetch(scrapingBeeUrl.toString(), { method: 'GET' })

    console.log('[scrape-api] ScrapingBee response status:', response.status)

    if (!response.ok) {
      const body = await response.text()
      console.error('[scrape-api] ScrapingBee error:', response.status, body)
      return NextResponse.json({ error: `Failed to scrape URL: ${response.status} - ${body}` }, { status: 500 })
    }

    const html = await response.text()
    console.log('[scrape-api] HTML received, length:', html.length)
    
    const result = parsePackagesFromHtml(url, html)
    console.log('[scrape-api] Parsed packages:', result.packages.length)

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('[scrape-api] Error:', error)
    return NextResponse.json({ error: `Scraping failed: ${error instanceof Error ? error.message : 'Unknown error'}` }, { status: 500 })
  }
}