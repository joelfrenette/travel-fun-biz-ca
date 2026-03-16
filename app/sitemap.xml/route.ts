import { NextResponse } from 'next/server'

const SUPPORTED_LOCALES = ['en', 'fr', 'es']
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://example.com'
const STATIC_PATHS = ['/', '/about', '/contact', '/booking']

function sitemapXml() {
  const urls: string[] = []
  for (const locale of SUPPORTED_LOCALES) {
    for (const path of STATIC_PATHS) {
      const loc = `${SITE_URL}/${locale}${path === '/' ? '/' : path}`
      urls.push(`
  <url>
    <loc>${loc}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
  </url>
`)
    }
  }

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
