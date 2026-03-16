import { NextResponse } from 'next/server'
import { STATIC_PATHS } from './_shared'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://example.com'

function sitemapXml() {
  const urls = STATIC_PATHS.map((path: string) => {
    const loc = `${SITE_URL}/fr${path === '/' ? '/' : path}`
    return `
  <url>
    <loc>${loc}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
  </url>`
  })

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}
</urlset>`
}

export async function GET() {
  const xml = sitemapXml()
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=0, s-maxage=3600'
    }
  })
}
