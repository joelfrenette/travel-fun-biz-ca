import type { Metadata } from "next"
import Link from "next/link"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Badge } from "@/components/ui/badge"
import { getPublishedPosts } from "@/lib/posts"
import { getVisitorPreferences } from "@/lib/preferences"
import { excerptFromMarkdown } from "@/lib/markdown"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

export const revalidate = 300

export const metadata: Metadata = {
  title: `Travel Stories & Trip Recaps | ${SITE_NAME}`,
  description: "Trip recaps, travel tips and destination guides from real group departures.",
  alternates: { canonical: absoluteUrl("/blog") },
}

export default async function BlogIndexPage() {
  const [posts, { language, currency }] = await Promise.all([getPublishedPosts(), Promise.resolve(getVisitorPreferences())])

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <section className="container mx-auto px-4 py-16">
          <div className="mb-10 text-center">
            <h1 className="text-balance text-4xl font-bold text-foreground">Travel Stories &amp; Trip Recaps</h1>
            <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">Real departures, real tips, and what actually happens on our group trips.</p>
          </div>

          {posts.length === 0 ? (
            <p className="text-center text-muted-foreground">Nothing published yet. Check back soon.</p>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {posts.map((post) => (
                <Link key={post.id} href={`/blog/${post.slug}`} className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg">
                  <div className="aspect-[16/9] overflow-hidden bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={post.cover_image_url || DEFAULT_OG_IMAGE} alt={post.title} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-5">
                    {post.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {post.tags.slice(0, 2).map((t) => <Badge key={t} variant="secondary" className="text-[10px] uppercase">{t}</Badge>)}
                      </div>
                    )}
                    <h2 className="text-lg font-bold leading-snug text-foreground group-hover:underline">{post.title}</h2>
                    <p className="text-sm text-muted-foreground">{excerptFromMarkdown(post.body, 120)}</p>
                    {post.publish_date && (
                      <p className="mt-auto pt-2 text-xs text-muted-foreground">{new Date(post.publish_date).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}</p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
      <Footer language={language} />
    </div>
  )
}
