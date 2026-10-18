import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PackageCard } from "@/components/package-card"
import { GuideHeaderFeature } from "@/components/guide-header-feature"
import { GuideHeaderActions } from "@/components/guide-header-actions"
import { pickHeaderFeature, type HeaderPastTrip } from "@/lib/guide-header"
import { isPastTrip } from "@/lib/past-trip"
import { dbPackageToTravelPackage } from "@/lib/packages"
import type { TravelPackage } from "@/types/travel"
import { getPublishedGuide, listPublishedGuideLinks, listPostsForGuide, pickRelatedGuides, guideTrail, childGroups, relatedGuideCards, getPublishedTripRowsByIds, getTripFactsByIds, guideKinds, guidePath, type PublicGuide, type GuideKind, type TrailStep } from "@/lib/guides"
import { SCOPE_LABEL, scopeOf } from "@/lib/guide-scope"
import { GuideCta } from "@/components/guide-cta"
import { GuideFacts } from "@/components/guide-facts"
import { heroSrcSet, HERO_SIZES } from "@/lib/guide-images"
import type { FactsInput } from "@/lib/guide-facts"
import { getDestinationSlugs } from "@/lib/destinations"
import { getBestTimeToVisitPage } from "@/lib/best-time-to-visit"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { GuideTakeaways, GuideArticle, GuideFaqList, RelatedGuidesSection, BlogStoriesSection } from "@/components/guide-parts"
import { jsonLdHtml } from "@/lib/jsonld"
import { SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, absoluteUrl, formatDate } from "@/lib/site"
import { ogImageEntry } from "@/lib/og-path"

// ONE shared page for every guide kind (destinations, hotels, resorts, cruise lines, ships, river cruises,
// yachts). The route files under app/<kind>/[slug]/page.tsx are thin wrappers around GuidePage and
// guideMetadata, so a fix here applies to every kind at once. app/destinations/[slug]/page.tsx also reuses the
// pieces in components/guide-parts.tsx and guideJsonLd when a destination has a guide.

const cleanText = (s: string) => s.replace(/\s+/g, " ").trim()

/** Structured data for one guide: its main entity (type per kind), the FAQ and the breadcrumb. Only the
 * fields we really have go in: no address, rating or price. */
export { GuideTakeaways, GuideArticle, GuideFaqList }

export function guideJsonLd(guide: PublicGuide, trail?: TrailStep[]): object[] {
  const info = guideKinds[guide.kind]
  const url = absoluteUrl(guidePath(guide.kind, guide.slug))
  const description = guide.meta_description || cleanText(guide.summary)
  const image = guide.hero_image_url || DEFAULT_OG_IMAGE
  // A destination page IS the destination. A page about a named hotel, resort, ship or line is an article ABOUT
  // it: it must not claim to be the business itself (that would read as the business's own listing).
  // One organization object for author and publisher. Dates come only from stored columns and are left out when empty.
  const organization = { "@type": "Organization", name: SITE_NAME, url: absoluteUrl("/"), logo: { "@type": "ImageObject", url: absoluteUrl("/logo.png") } }
  const dates = {
    ...(guide.created_at ? { datePublished: guide.created_at } : {}),
    ...(guide.updated_at ? { dateModified: guide.updated_at } : {}),
  }
  const inLanguage = SITE_LOCALE.replace("_", "-")
  const isPartOf = { "@type": "WebSite", url: absoluteUrl("/") }
  // Speakable: only selectors whose content is really on the page (the takeaways aside and the FAQ section).
  const speakableSelectors = [
    ...(guide.key_takeaways.length > 0 ? ["#key-takeaways"] : []),
    ...(guide.faq.length > 0 ? ["#guide-faq"] : []),
  ]
  const speakable = speakableSelectors.length > 0 ? { speakable: { "@type": "SpeakableSpecification", cssSelector: speakableSelectors } } : {}
  const main: object =
    guide.kind === "destinations"
      ? {
          "@context": "https://schema.org",
          "@type": "WebPage",
          "@id": url,
          url,
          name: guide.name,
          ...(description ? { description } : {}),
          ...dates,
          publisher: organization,
          inLanguage,
          isPartOf,
          ...speakable,
          mainEntity: { "@type": info.schemaType, name: guide.name, ...(description ? { description } : {}), image, url },
        }
      : {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: guide.meta_title || `${guide.name}: ${info.guideLabel}`,
          description,
          url,
          image,
          ...dates,
          inLanguage,
          isPartOf,
          ...speakable,
          author: organization,
          publisher: organization,
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
        ...(trail && trail.length > 0
          ? trail.map((step, i) => ({ "@type": "ListItem", position: i + 2, name: step.name, item: absoluteUrl(step.path) }))
          : [
              { "@type": "ListItem", position: 2, name: info.plural, item: absoluteUrl(info.urlPrefix) },
              { "@type": "ListItem", position: 3, name: guide.name, item: url },
            ]),
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
  // The rendered share image (lib/og-image.ts) draws the hero photo, title and site name at 1200x630.
  const image = ogImageEntry(kind, slug, guide.hero_alt || guide.name)
  const url = absoluteUrl(guidePath(kind, slug))
  return {
    title,
    description,
    alternates: { canonical: url },
    keywords: [guide.primary_keyword, ...guide.secondary_keywords].filter((k): k is string => !!k),
    openGraph: { title: ogTitle, description: ogDescription, url, type: "article", locale: SITE_LOCALE, siteName: SITE_NAME, images: [image] },
    twitter: { card: "summary_large_image", title: ogTitle, description: ogDescription, images: [image.url] },
  }
}

export async function GuidePage({ kind, slug }: { kind: GuideKind; slug: string }) {
  const guide = await getPublishedGuide(kind, slug)
  if (!guide) notFound()

  const info = guideKinds[kind]
  const { language, currency } = getVisitorPreferences()
  const bestTimeSlug = kind === "destinations" ? slug : guide.parent_slug
  const [usdToTargetRate, tripRows, allGuides, destinations, bestTime, stories, tripFacts] = await Promise.all([
    getUsdToRate(currency),
    getPublishedTripRowsByIds(guide.related_package_ids),
    // Every published guide as a link row: related guides, the parent chain and the pages under this one all come from it.
    listPublishedGuideLinks(),
    guide.parent_slug ? getDestinationSlugs() : Promise.resolve([]),
    // Only for a destination guide or a guide whose parent is a destination: the best-time page exists only when a real dated package does.
    bestTimeSlug ? getBestTimeToVisitPage(bestTimeSlug) : Promise.resolve(null),
    // Blog posts written for one of this page's trips, or whose title or tags name this page. Empty when none match.
    listPostsForGuide(guide, 3),
    // The stored facts of this page's published trips (dates, length, itinerary stops) for the facts block.
    getTripFactsByIds(guide.related_package_ids),
  ])
  // Upcoming versus past by the one shared rule (lib/past-trip.ts). The header card shows the nearest upcoming trip
  // (else the latest past one, else the photo and quick facts); the trips section lists only the REST, so a single
  // trip is never shown twice, and a past trip is never offered as bookable.
  const upcomingRows = tripRows.filter((r) => !isPastTrip(r))
  const pastRows = tripRows.filter((r) => isPastTrip(r))
  const feature = pickHeaderFeature<TravelPackage, HeaderPastTrip>(
    guide,
    upcomingRows.map((r) => ({ item: dbPackageToTravelPackage(r), from: r.available_from ?? null })),
    pastRows,
  )
  const packages: TravelPackage[] = feature.kind === "upcoming" ? [feature.trip, ...feature.rest] : []
  const heroInHeader = feature.kind === "facts" && !!feature.image
  const otherPast = pastRows.filter((r) => !!r.slug && !(feature.kind === "past" && feature.trip.id === r.id))
  const parentGuide = guide.parent_slug ? await getPublishedGuide("destinations", guide.parent_slug) : null
  const parentDestination = guide.parent_slug ? destinations.find((d) => d.slug === guide.parent_slug) : undefined
  const parentName = parentGuide?.name ?? parentDestination?.destination ?? null
  // Up to 6 other published guides: same parent first, then the same kind, then ones sharing a trip.
  const relatedGuides = pickRelatedGuides(guide, allGuides, 6)
  // Breadcrumb: the parents (a country, then a city, then a port), then this page. A parent with trips but no guide still gets a link.
  const trail = guideTrail(guide, allGuides, guide.parent_slug && parentName ? { slug: guide.parent_slug, name: parentName } : null)
  const children = childGroups(guide, allGuides)
  const scope = scopeOf(guide)
  const parentStep = trail.length > 1 ? trail[trail.length - 2] : null
  const factsInput: FactsInput = {
    kindLabel: info.label,
    scope,
    // The step above this page in the trail, unless that step is only the kind's index page (no parent was found).
    parent: parentStep && guide.parent_slug && parentStep.path !== info.urlPrefix ? { name: parentStep.name, path: parentStep.path } : null,
    trips: tripFacts,
    bestTime: bestTime && bestTimeSlug ? { destination: bestTime.destination, path: `/best-time-to-visit/${bestTimeSlug}` } : null,
    childCount: children.reduce((n, g) => n + g.items.length, 0),
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(guideJsonLd(guide, trail)) }} />

        <div className="border-b bg-muted/30">
          <div className={`container mx-auto max-w-4xl px-4 py-10 ${feature.kind !== "none" ? "grid items-stretch gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]" : ""}`}>
            <div className="flex min-w-0 flex-col">
            <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">Home</Link>
              <span className="mx-1.5">/</span>
              {trail.slice(0, -1).map((step) => (
                <span key={step.path}>
                  <Link href={step.path} className="hover:underline">{step.name}</Link>
                  <span className="mx-1.5">/</span>
                </span>
              ))}
              <span className="text-foreground">{guide.name}</span>
            </nav>
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{scope ? `${SCOPE_LABEL[scope]} guide` : `${info.label} guide`}</p>
            <h1 className="mt-1 text-balance text-3xl font-bold text-foreground sm:text-4xl">{guide.name}: {info.guideLabel}</h1>
            {formatDate(guide.updated_at) && (
              <p className="mt-2 text-sm text-muted-foreground"><time dateTime={guide.updated_at}>Updated {formatDate(guide.updated_at)}</time></p>
            )}
            <p className="mt-4 max-w-3xl text-pretty text-lg text-foreground">{guide.summary}</p>
            <GuideHeaderActions name={guide.name} packageName={packages[0]?.name} guide={guide} feature={feature} language={language} />
            </div>
            <GuideHeaderFeature feature={feature} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
          </div>
        </div>

        <article className="container mx-auto max-w-4xl space-y-10 px-4 py-10">
          {guide.hero_image_url && !heroInHeader && (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={guide.hero_image_url}
                srcSet={heroSrcSet(guide.hero_image_url) ?? undefined}
                sizes={heroSrcSet(guide.hero_image_url) ? HERO_SIZES.page : undefined}
                alt={guide.hero_alt || guide.name}
                className="aspect-[16/9] w-full rounded-xl object-cover"
              />
              <figcaption className="mt-1.5 text-xs text-muted-foreground">Illustrative stock photo.</figcaption>
            </figure>
          )}

          <GuideTakeaways guide={guide} />
          <GuideFacts input={factsInput} />
          <GuideArticle guide={guide} />
          <GuideFaqList guide={guide} />

          {children.length > 0 && (
            <section aria-labelledby="inside-heading">
              <h2 id="inside-heading" className="mb-3 text-xl font-bold text-foreground">More guides under {guide.name}</h2>
              <div className="space-y-4">
                {children.map((group) => (
                  <div key={group.label}>
                    <h3 className="mb-1.5 text-sm font-semibold uppercase text-muted-foreground">{group.label}</h3>
                    <ul className="flex flex-wrap gap-2">
                      {group.items.slice(0, 24).map((g) => (
                        <li key={g.id}><Link href={guidePath(g.kind, g.slug)} className="inline-block rounded-full border bg-card px-3 py-1 text-sm font-medium text-foreground hover:bg-muted">{g.name}</Link></li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}

          {feature.rest.length > 0 && (
            <section>
              <h2 className="mb-4 text-center text-xl font-bold text-foreground">More trips that go with this guide</h2>
              <div className="grid justify-center gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),22rem))]">
                {feature.rest.map((pkg) => (
                  <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
                ))}
              </div>
            </section>
          )}

          {otherPast.length > 0 && (
            <section>
              <h2 className="mb-3 text-xl font-bold text-foreground">Past trips</h2>
              <ul className="space-y-1 text-sm">
                {otherPast.map((r) => (
                  <li key={r.id}><Link href={`/packages/${r.slug}`} className="font-medium text-foreground hover:underline">{r.name}</Link></li>
                ))}
              </ul>
            </section>
          )}

          <GuideCta name={guide.name} packageName={packages[0]?.name} />

          <RelatedGuidesSection guides={relatedGuideCards(relatedGuides)} />
          <BlogStoriesSection stories={stories} />

          {(parentName || (bestTime && bestTimeSlug)) && (
            <nav aria-label="Related pages" className="space-y-2 text-sm">
              <h2 className="text-base font-bold text-foreground">Keep exploring</h2>
              <ul className="space-y-1">
                {parentName && guide.parent_slug && (
                  <li><Link href={`/destinations/${guide.parent_slug}`} className="font-medium text-foreground hover:underline">More about {parentName}</Link></li>
                )}
                {bestTime && bestTimeSlug && (
                  <li><Link href={`/best-time-to-visit/${bestTimeSlug}`} className="font-medium text-foreground hover:underline">When to visit {bestTime.destination}</Link></li>
                )}
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
