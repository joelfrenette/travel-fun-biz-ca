import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { Calendar, Clock } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Badge } from "@/components/ui/badge"
import { getPublishedPostBySlug } from "@/lib/posts"
import { getRelatedPackages } from "@/lib/packages"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { renderMarkdown, readingTimeMinutes, excerptFromMarkdown } from "@/lib/markdown"
import { SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"
import { ogImageEntry } from "@/lib/og-path"
import { jsonLdHtml } from "@/lib/jsonld"
import { styleById } from "@/lib/content-styles"
import { PackageCard } from "@/components/package-card"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await getPublishedPostBySlug(params.slug)
  if (!post) return { title: `Post not found | ${SITE_NAME}`, robots: { index: false } }

  const title = post.meta_title || `${post.title} | ${SITE_NAME}`
  const description = post.meta_description || excerptFromMarkdown(post.body, 160)
  const image = ogImageEntry("blog", post.slug, post.alt_text || post.title)
  const url = absoluteUrl(`/blog/${post.slug}`)
  // Share text written for social (curiosity-led, short) wins when the post has it.
  const ogTitle = post.og_title || title
  const ogDescription = post.og_description || description

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title: ogTitle, description: ogDescription, url, type: "article", locale: SITE_LOCALE, siteName: SITE_NAME, images: [image] },
    twitter: { card: "summary_large_image", title: ogTitle, description: ogDescription, images: [image.url] },
  }
}

export default async function BlogPostPage({ params }: Props) {
  const post = await getPublishedPostBySlug(params.slug)
  if (!post) notFound()

  const { language, currency } = getVisitorPreferences()
  const pageUrl = absoluteUrl(`/blog/${post.slug}`)
  const image = post.cover_image_url || DEFAULT_OG_IMAGE
  // The "**Quick answer:**" paragraph the composer writes gets a class so the Article's speakable
  // markup can point at it. Posts without one are left exactly as rendered.
  const renderedBody = renderMarkdown(post.body)
  const hasQuickAnswer = /<p><strong>Quick answer:/.test(renderedBody)
  const bodyHtml = hasQuickAnswer ? renderedBody.replace(/<p>(<strong>Quick answer:)/, '<p class="quick-answer">$1') : renderedBody
  const faq = (Array.isArray(post.faq) ? post.faq : []).filter((f) => f && typeof f.q === "string" && typeof f.a === "string" && f.q && f.a)
  const takeaways = (Array.isArray(post.key_takeaways) ? post.key_takeaways : []).filter((t) => typeof t === "string" && t)
  const keywords = [post.primary_keyword, ...(post.secondary_keywords ?? [])].filter((k): k is string => !!k)
  const section = styleById(post.content_style)?.label
  const wordCount = post.body.trim().split(/\s+/).filter(Boolean).length
  const [relatedPackages, usdToTargetRate] = await Promise.all([
    getRelatedPackages(post.related_package_id),
    getUsdToRate(currency),
  ])

  const speakableSelectors = [hasQuickAnswer ? ".quick-answer" : null, takeaways.length > 0 ? "#key-takeaways" : null].filter((s): s is string => !!s)

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
    wordCount,
    inLanguage: SITE_LOCALE.replace("_", "-"),
    ...(keywords.length > 0 ? { keywords: keywords.join(", ") } : {}),
    ...(section ? { articleSection: section } : {}),
    ...(speakableSelectors.length > 0 ? { speakable: { "@type": "SpeakableSpecification", cssSelector: speakableSelectors } } : {}),
  }

  const faqJsonLd = faq.length > 0
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      }
    : null

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: "Blog", item: absoluteUrl("/blog") },
      { "@type": "ListItem", position: 3, name: post.title, item: pageUrl },
    ],
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
        {faqJsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(faqJsonLd) }} />}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(breadcrumbJsonLd) }} />

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
            <img src={post.cover_image_url} alt={post.alt_text || post.title} className="mb-8 aspect-[16/9] w-full rounded-xl object-cover" />
          )}

          {takeaways.length > 0 && (
            <aside id="key-takeaways" className="mb-8 rounded-xl border bg-muted/30 p-5">
              <h2 className="mb-2 text-lg font-semibold text-foreground">Key takeaways</h2>
              <ul className="list-disc space-y-1 pl-5 text-foreground">
                {takeaways.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </aside>
          )}

          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />

          {faq.length > 0 && (
            <section className="mt-10" aria-labelledby="faq-heading">
              <h2 id="faq-heading" className="mb-4 text-2xl font-bold text-foreground">Frequently asked questions</h2>
              <div className="divide-y rounded-xl border">
                {faq.map((f, i) => (
                  <details key={i} className="group p-4">
                    <summary className="cursor-pointer font-medium text-foreground">{f.q}</summary>
                    <p className="mt-2 text-muted-foreground">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>
          )}

          {relatedPackages.length > 0 ? (
            <div className="mt-12">
              <p className="mb-4 text-lg font-semibold text-foreground">Ready for your own trip?</p>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {relatedPackages.map((pkg) => (
                  <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-12 rounded-xl border bg-muted/30 p-6 text-center">
              <p className="text-lg font-semibold text-foreground">Ready for your own trip?</p>
              <Link href="/#contact" className="mt-3 inline-block rounded-md bg-primary px-6 py-3 text-sm font-bold uppercase text-primary-foreground">Ask us about your trip</Link>
            </div>
          )}
        </article>
      </main>
      <Footer language={language} />
    </div>
  )
}
