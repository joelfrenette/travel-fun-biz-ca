import { getPublishedPosts } from '@/lib/posts'
import { SITE_NAME, SITE_URL } from '@/lib/site'
import { buildRssXml, FEED_HEADERS, FEED_LIMIT } from '@/lib/rss'

// /feed.xml: the latest 20 published blog posts as RSS 2.0 (hub WP7). /blog/rss.xml serves the same feed for every post; both
// use lib/rss.ts. Revalidated hourly.
export const revalidate = 3600

export async function GET() {
  const posts = await getPublishedPosts()
  return new Response(buildRssXml({ siteName: SITE_NAME, siteUrl: SITE_URL, feedPath: '/feed.xml', posts, limit: FEED_LIMIT }), { headers: FEED_HEADERS })
}
