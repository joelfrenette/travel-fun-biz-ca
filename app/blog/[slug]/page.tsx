import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { Calendar, Clock } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Badge } from "@/components/ui/badge"
import { getPublishedPostBySlug } from "@/lib/posts"
import { getVisitorPreferences } from "@/lib/preferences"
import { renderMarkdown, readingTimeMinutes, excerptFromMarkdown } from "@/lib/markdown"
import { SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await getPublishedPostBySlug(params.slug)
  if (!post) return { title: `Post not found | ${SITE_NAME}`, robots: { index: false } }

  const title = post.meta_title || `${post.title} | ${SITE_NAME}`
  const description = post.meta_description || excerptFromMarkdown(post.body, 160)
  const image = post.cover_image_url || DEFAULT_OG_IMAGE
  const url = absoluteUrl(`/blog/${post.slug}`)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "article", locale: SITE_LOCALE, siteName: SITE_NAME, images: [{ url: image, alt: post.title }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  }
}

export default async function BlogPostPage({ params }: Props) {
  const post = await getPublishedPostBySlug(params.slug)
  if (!post) notFound()

  const { language, currency } = getVisitorPreferences()
  const pageUrl = absoluteUrl(`/blog/${post.slug}`)
  const image = post.cover_image_url || DEFAULT_OG_IMAGE
  const bodyHtml = renderMarkdown(post.body)

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.meta_description || excerptFromMarkdown(post.body, 160),
    image,
    url: pageUrl,
    ...(post.publish_date ? { datePublished: post.publish_date } : {}),
    dateModified: post.updated_at,
    author: { "@type": "Organization", name: SITE_NAME },
    publisher: { "@type": "Organization", name: SITE_NAME, logo: { "@type": "ImageObject", url: absoluteUrl("/logo.png") } },
    mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

        <article className="container mx-auto max-w-3xl px-4 py-12">
          <Link href="/blog" className="text-sm text-muted-foreground hover:underline">&larr; All stories</Link>

          <header className="mt-4 mb-8">
            {post.tags.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {post.tags.map((t) => <Badge key={t} variant="secondary" className="text-[10px] uppercase">{t}</Badge>)}
              </div>
            )}
            <h1 className="text-balance text-3xl font-bold text-foreground sm:text-4xl">{post.title}</h1>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
              {post.publish_date && (
                <span className="flex items-center gap-1.5"><Calendar className="h-4 w-4" />{new Date(post.publish_date).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}</span>
              )}
              <span className="flex items-center gap-1.5"><Clock className="h-4 w-4" />{readingTimeMinutes(post.body)} min read</span>
            </div>
          </header>

          {post.cover_image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.cover_image_url} alt={post.title} className="mb-8 aspect-[16/9] w-full rounded-xl object-cover" />
          )}

          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />

          <div className="mt-12 rounded-xl border bg-muted/30 p-6 text-center">
            <p className="text-lg font-semibold text-foreground">Ready for your own trip?</p>
            <Link href="/#contact" className="mt-3 inline-block rounded-md bg-primary px-6 py-3 text-sm font-bold uppercase text-primary-foreground">Browse Upcoming Trips</Link>
          </div>
        </article>
      </main>
      <Footer language={language} />
    </div>
  )
}
