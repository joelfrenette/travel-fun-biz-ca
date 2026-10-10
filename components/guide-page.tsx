import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PackageCard } from "@/components/package-card"
import { getPublishedGuide, listPublishedGuides, getPublishedPackagesByIds, guideKinds, guidePath, type PublicGuide, type GuideKind } from "@/lib/guides"
import { getDestinationSlugs } from "@/lib/destinations"
import { getBestTimeToVisitPage } from "@/lib/best-time-to-visit"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { GuideTakeaways, GuideArticle, GuideFaqList } from "@/components/guide-parts"
import { jsonLdHtml } from "@/lib/jsonld"
import { SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

// ONE shared page for every guide kind (destinations, hotels, resorts, cruise lines, ships, river cruises,
// yachts). The route files under app/<kind>/[slug]/page.tsx are thin wrappers around GuidePage and
// guideMetadata, so a fix here applies to every kind at once. app/destinations/[slug]/page.tsx also reuses the
// pieces in components/guide-parts.tsx and guideJsonLd when a destination has a guide.

const cleanText = (s: string) => s.replace(/\s+/g, " ").trim()

/** Structured data for one guide: its main entity (type per kind), the FAQ and the breadcrumb. Only the
 * fields we really have go in: no address, rating or price. */
export { GuideTakeaways, GuideArticle, GuideFaqList }

export function guideJsonLd(guide: PublicGuide): object[] {
  const info = guideKinds[guide.kind]
  const url = absoluteUrl(guidePath(guide.kind, guide.slug))
  const description = guide.meta_description || cleanText(guide.summary)
  const image = guide.hero_image_url || DEFAULT_OG_IMAGE
  // A destination page IS the destination. A page about a named hotel, resort, ship or line is an article ABOUT
  // it: it must not claim to be the business itself (that would read as the business's own listing).
  const main: object =
    guide.kind === "destinations"
      ? { "@context": "https://schema.org", "@type": info.schemaType, name: guide.name, description, url, image }
      : {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: guide.meta_title || `${guide.name}: ${info.guideLabel}`,
          description,
          url,
          image,
          dateModified: guide.updated_at,
          author: { "@type": "Organization", name: SITE_NAME },
          publisher: { "@type": "Organization", name: SITE_NAME },
          mainEntityOfPage: { "@type": "WebPage", "@id": url },
          about: { "@type": info.schemaType, name: guide.name },
        }
  const out: object[] = [
    main,
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
        { "@type": "ListItem", position: 2, name: info.plural, item: absoluteUrl(info.urlPrefix) },
        { "@type": "ListItem", position: 3, name: guide.name, item: url },
      ],
    },
  ]
  if (guide.faq.length > 0) {
    out.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: guide.faq.map((f) => ({ "@type": "Question", name: cleanText(f.q), acceptedAnswer: { "@type": "Answer", text: cleanText(f.a) } })),
    })
  }
  return out
}

export async function guideMetadata(kind: GuideKind, slug: string): Promise<Metadata> {
  const guide = await getPublishedGuide(kind, slug)
  const info = guideKinds[kind]
  if (!guide) return { title: `${info.label} guide not found | ${SITE_NAME}`, robots: { index: false } }

  const title = guide.meta_title || `${guide.name}: ${info.guideLabel} | ${SITE_NAME}`
  const description = guide.meta_description || cleanText(guide.summary).slice(0, 155)
  const ogTitle = guide.og_title || title
  const ogDescription = guide.og_description || description
  const image = guide.hero_image_url || DEFAULT_OG_IMAGE
  const url = absoluteUrl(guidePath(kind, slug))
  return {
    title,
    description,
    alternates: { canonical: url },
    keywords: [guide.primary_keyword, ...guide.secondary_keywords].filter((k): k is string => !!k),
    openGraph: { title: ogTitle, description: ogDescription, url, type: "article", locale: SITE_LOCALE, siteName: SITE_NAME, images: [{ url: image, alt: guide.hero_alt || guide.name }] },
    twitter: { card: "summary_large_image", title: ogTitle, description: ogDescription, images: [image] },
  }
}

export async function GuidePage({ kind, slug }: { kind: GuideKind; slug: string }) {
  const guide = await getPublishedGuide(kind, slug)
  if (!guide) notFound()

  const info = guideKinds[kind]
  const { language, currency } = getVisitorPreferences()
  const bestTimeSlug = kind === "destinations" ? slug : guide.parent_slug
  const [usdToTargetRate, packages, sameKind, destinations, bestTime] = await Promise.all([
    getUsdToRate(currency),
    getPublishedPackagesByIds(guide.related_package_ids),
    listPublishedGuides(kind),
    guide.parent_slug ? getDestinationSlugs() : Promise.resolve([]),
    // Only for a destination guide or a guide whose parent is a destination: the best-time page exists only when a real dated package does.
    bestTimeSlug ? getBestTimeToVisitPage(bestTimeSlug) : Promise.resolve(null),
  ])
  const parentGuide = guide.parent_slug ? await getPublishedGuide("destinations", guide.parent_slug) : null
  const parentDestination = guide.parent_slug ? destinations.find((d) => d.slug === guide.parent_slug) : undefined
  const parentName = parentGuide?.name ?? parentDestination?.destination ?? null
  const siblings = sameKind.filter((g) => g.slug !== slug).slice(0, 6)

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(guideJsonLd(guide)) }} />

        <div className="border-b bg-muted/30">
          <div className="container mx-auto max-w-4xl px-4 py-10">
            <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">Home</Link>
              <span className="mx-1.5">/</span>
              <Link href={info.urlPrefix} className="hover:underline">{info.plural}</Link>
              <span className="mx-1.5">/</span>
              <span className="text-foreground">{guide.name}</span>
            </nav>
            <h1 className="mt-3 text-balance text-3xl font-bold text-foreground sm:text-4xl">{guide.name}: {info.guideLabel}</h1>
            <p className="mt-4 max-w-3xl text-pretty text-lg text-foreground">{guide.summary}</p>
          </div>
        </div>

        <article className="container mx-auto max-w-4xl space-y-10 px-4 py-10">
          {guide.hero_image_url && (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={guide.hero_image_url} alt={guide.hero_alt || guide.name} className="aspect-[16/9] w-full rounded-xl object-cover" />
              <figcaption className="mt-1.5 text-xs text-muted-foreground">Illustrative stock photo.</figcaption>
            </figure>
          )}

          <GuideTakeaways guide={guide} />
          <GuideArticle guide={guide} />
          <GuideFaqList guide={guide} />

          {packages.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-bold text-foreground">Trips that go with this guide</h2>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {packages.map((pkg) => (
                  <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
                ))}
              </div>
            </section>
          )}

          <section className="rounded-xl border bg-muted/30 p-6 text-center">
            <p className="text-lg font-semibold text-foreground">Thinking about {guide.name}?</p>
            <p className="mt-1 text-sm text-muted-foreground">Tell us who is travelling and roughly when, and our team will help you work out the right trip.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              <Link href="/#contact" className="inline-block rounded-md bg-primary px-6 py-3 text-sm font-bold uppercase text-primary-foreground">Ask us about your trip</Link>
              <Link href="/packages" className="inline-block rounded-md border px-6 py-3 text-sm font-bold uppercase text-foreground hover:bg-muted">See all trips</Link>
            </div>
          </section>

          {(parentName || (bestTime && bestTimeSlug) || siblings.length > 0) && (
            <nav aria-label="Related pages" className="space-y-2 text-sm">
              <h2 className="text-base font-bold text-foreground">Keep exploring</h2>
              <ul className="space-y-1">
                {parentName && guide.parent_slug && (
                  <li><Link href={`/destinations/${guide.parent_slug}`} className="font-medium text-foreground hover:underline">More about {parentName}</Link></li>
                )}
                {bestTime && bestTimeSlug && (
                  <li><Link href={`/best-time-to-visit/${bestTimeSlug}`} className="font-medium text-foreground hover:underline">When to visit {bestTime.destination}</Link></li>
                )}
                {siblings.map((g) => (
                  <li key={g.id}><Link href={guidePath(g.kind, g.slug)} className="font-medium text-foreground hover:underline">{g.name}: {info.guideLabel}</Link></li>
                ))}
                <li><Link href={info.urlPrefix} className="text-muted-foreground hover:underline">All {info.plural.toLowerCase()}</Link></li>
              </ul>
            </nav>
          )}
        </article>
      </main>
      <Footer language={language} />
    </div>
  )
}
