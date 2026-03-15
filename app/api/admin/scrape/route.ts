import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { parsePackagesFromHtml } from '@/lib/scraping'

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')

  const email = validateToken(token || '')
  if (!email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!SCRAPINGBEE_API_KEY) {
    return NextResponse.json({ error: 'Scraping API not configured. Add SCRAPINGBEE_API_KEY.' }, { status: 500 })
  }

  try {
    const { url } = await request.json()

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 })
    }

    const scrapingBeeUrl = new URL('https://app.scrapingbee.com/api/v1/')
    scrapingBeeUrl.searchParams.set('api_key', SCRAPINGBEE_API_KEY)
    scrapingBeeUrl.searchParams.set('url', url)
    scrapingBeeUrl.searchParams.set('render_js', 'true')
    scrapingBeeUrl.searchParams.set('premium_proxy', 'true')

    const response = await fetch(scrapingBeeUrl.toString(), { method: 'GET' })

    if (!response.ok) {
      const body = await response.text()
      console.error('[scrape] ScrapingBee error:', response.status, body)
      return NextResponse.json({ error: 'Failed to scrape URL' }, { status: 500 })
    }

    const html = await response.text()
    const result = parsePackagesFromHtml(url, html)

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('[scrape] Error:', error)
    return NextResponse.json({ error: 'Scraping failed' }, { status: 500 })
  }
}