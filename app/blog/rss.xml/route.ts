import { getPublishedPosts } from '@/lib/posts'
import { excerptFromMarkdown } from '@/lib/markdown'
import { SITE_NAME, SITE_URL, absoluteUrl } from '@/lib/site'

export const revalidate = 3600

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export async function GET() {
  const posts = await getPublishedPosts()
  const items = posts.map((post) => {
    const url = absoluteUrl(`/blog/${post.slug}`)
    const pubDate = post.publish_date ? new Date(post.publish_date).toUTCString() : new Date(post.updated_at).toUTCString()
    return `  <item>
    <title>${escapeXml(post.title)}</title>
    <link>${url}</link>
    <guid isPermaLink="true">${url}</guid>
    <pubDate>${pubDate}</pubDate>
    <description>${escapeXml(post.meta_description || excerptFromMarkdown(post.body, 300))}</description>
  </item>`
  }).join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${escapeXml(SITE_NAME)} Blog</title>
  <link>${SITE_URL}/blog</link>
  <description>Trip recaps, travel tips and destination guides from ${escapeXml(SITE_NAME)}.</description>
  <language>en</language>
${items}
</channel>
</rss>`

  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } })
}
