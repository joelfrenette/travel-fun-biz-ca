import { SITE_URL } from '@/lib/site'
import { buildImageSitemapXml } from '@/lib/image-sitemap'
import { loadImageSitemapPages } from '@/lib/image-sitemap-data'

// /sitemap-images.xml (hub WP8): the pictures of blog posts, guides and trips. Listed in robots.txt next to /sitemap.xml.
// Joel submits it once in Search Console and Bing. Revalidated hourly, like the main sitemap.
export const revalidate = 3600

export async function GET() {
  const xml = buildImageSitemapXml(await loadImageSitemapPages(), SITE_URL)
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } })
}
