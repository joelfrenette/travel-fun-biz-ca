import { getPublishedPosts } from '@/lib/posts'
import { SITE_NAME, SITE_URL } from '@/lib/site'
import { buildRssXml, FEED_HEADERS } from '@/lib/rss'

// The older feed address: every published post. /feed.xml (latest 20) is the one linked from the page head. Both use lib/rss.ts.
export const revalidate = 3600

export async function GET() {
  const posts = await getPublishedPosts()
  return new Response(buildRssXml({ siteName: SITE_NAME, siteUrl: SITE_URL, feedPath: '/blog/rss.xml', posts }), { headers: FEED_HEADERS })
}
