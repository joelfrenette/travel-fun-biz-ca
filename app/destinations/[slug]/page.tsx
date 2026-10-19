import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { MapPin, Calendar } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { PackageCard } from "@/components/package-card"
import { GuideHeaderFeature } from "@/components/guide-header-feature"
import { GuideHeaderActions } from "@/components/guide-header-actions"
import { pickHeaderFeature, type HeaderPastTrip } from "@/lib/guide-header"
import type { TravelPackage } from "@/types/travel"
import { guideJsonLd, guideMetadata } from "@/components/guide-page"
import { GuideTakeaways, GuideArticle, GuideFaqList, RelatedGuidesSection, BlogStoriesSection, linkedGuidePage } from "@/components/guide-parts"
import { AffiliateAutoDisclosure, AffiliateParts } from "@/components/affiliate-text"
import { destinationBlurbFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"
import { loadAffiliateRules } from "@/lib/affiliate-rules"
import { getDestinationPage } from "@/lib/destinations"
import { getBestTimeToVisitPage } from "@/lib/best-time-to-visit"
import { getPublicBlurb } from "@/lib/destination-blurbs"
import { getPublishedGuide, listPropertyGuidesForDestination, listPublishedGuideLinks, guideTrail, childGroups, getTripFactsByIds, listPostsForGuide, pickRelatedGuides, relatedGuideCards, oneLineSummary, guideKinds, guidePath } from "@/lib/guides"
import { scopeOf } from "@/lib/guide-scope"
import { GuideCta } from "@/components/guide-cta"
import { GuideThingsToDo } from "@/components/guide-things-to-do"
import { loadThingsToDo } from "@/lib/things-to-do"
import { GuideFacts } from "@/components/guide-facts"
import { heroSrcSet, HERO_SIZES } from "@/lib/guide-images"
import type { FactsInput } from "@/lib/guide-facts"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange, formatDate } from "@/lib/site"
import { ogImageEntry } from "@/lib/og-path"
import { jsonLdHtml } from "@/lib/jsonld"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // A published guide for this destination supplies the title, description and social text (growth loop
  // WP4). Without one the page is exactly what it was: a trip listing.
  const [page, guide] = await Promise.all([getDestinationPage(params.slug), getPublishedGuide("destinations", params.slug)])
  if (guide) return guideMetadata("destinations", params.slug)
  if (!page) return { title: `Destination not found | ${SITE_NAME}`, robots: { index: false } }

  const title = `${page.destination} Trips | ${SITE_NAME}`
  const description = `Upcoming group trips, cruises and singles getaways to ${page.destination}, plus real recaps from past trips there.`
  const url = absoluteUrl(`/destinations/${params.slug}`)
  const image = ogImageEntry("destinations", params.slug, page.destination)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  }
}

export default async function DestinationPage({ params }: Props) {
  // "Fun things to do": curated cards and partner search buttons; empty (nothing rendered) when there are none.
  // Word links (WP22) are read in the same batch and fail open (no rules).
  const [page, guide, things, affiliateRules] = await Promise.all([getDestinationPage(params.slug), getPublishedGuide("destinations", params.slug), loadThingsToDo("destinations", params.slug), loadAffiliateRules()])
  // A destination with a guide but no published trip yet still has a page (the guide). With neither, it is not found.
  if (!page && !guide) notFound()
  const destination = page?.destination ?? guide!.name
  const upcoming = page?.upcoming ?? []
  const recaps = page?.recaps ?? []
  // What the header's right-hand card shows (lib/guide-header.ts): the nearest upcoming trip, else the latest past
  // trip, else the guide's photo with quick facts from its stored takeaways, else nothing (one column).
  const feature = pickHeaderFeature<TravelPackage, HeaderPastTrip>(
    guide,
    upcoming.map((item) => ({ item, from: page?.upcomingFrom[item.id] ?? null })),
    recaps,
  )
  const restTrips = feature.rest
  const heroInHeader = feature.kind === "facts" && !!feature.image

  const { language, currency } = getVisitorPreferences()
  // Word links (WP23): with a guide, its summary, quick facts, takeaways, article and FAQ answers share one limit (3 per
  // phrase, 6 per page, in reading order); without one, the intro blurb is the page text that is linked.
  const linked = guide ? linkedGuidePage(guide, affiliateRules, "destinations", feature.kind === "facts" ? "right" : "left") : null
  const usdToTargetRate = await getUsdToRate(currency)
  const pageUrl = absoluteUrl(`/destinations/${params.slug}`)
  const blurb = await getPublicBlurb(params.slug)  // Reuses the same grounding check best-time-to-visit's own page already applies (a real dated
  // published package must exist) rather than re-deriving it from page.upcoming, whose
  // TravelPackage items don't carry available_from/available_to at all.
  const blurbSet = destinationBlurbFieldSet(guide ? null : blurb?.blurb)
  const blurbLinked = linkPageFields(blurbSet.fields, guide ? [] : affiliateRules, "destinations")
  const bestTimeToVisit = await getBestTimeToVisitPage(params.slug)
  // Every published hotel and resort guide under this destination (published rows only; empty means no section).
  const propertyGuides = await listPropertyGuidesForDestination(params.slug)
  // The cities, ports and other pages that sit under this one (WP16), and the trail of parents above it. Hotels and
  // resorts are already listed in their own section, so they are left out of the groups.
  const allGuides = guide ? await listPublishedGuideLinks() : []
  const trail = guide ? guideTrail(guide, allGuides) : []
  const tripFacts = guide ? await getTripFactsByIds(guide.related_package_ids) : []
  // Same internal links as every other guide page: up to 6 related guides and up to 3 blog posts about this place.
  const relatedGuides = guide ? pickRelatedGuides(guide, allGuides, 6) : []
  const stories = guide ? await listPostsForGuide(guide, 3) : []
  const parentStep = trail.length > 1 ? trail[trail.length - 2] : null
  const factsInput: FactsInput = {
    kindLabel: guideKinds.destinations.label,
    scope: guide ? scopeOf(guide) : null,
    parent: guide && guide.parent_slug && parentStep && parentStep.path !== guideKinds.destinations.urlPrefix ? { name: parentStep.name, path: parentStep.path } : null,
    trips: tripFacts,
    bestTime: bestTimeToVisit ? { destination: bestTimeToVisit.destination, path: `/best-time-to-visit/${params.slug}` } : null,
    childCount: guide ? childGroups(guide, allGuides).reduce((n, g) => n + g.items.length, 0) : 0,
  }
  const childBlocks = guide ? childGroups(guide, allGuides).map((g) => ({ ...g, items: g.items.filter((x) => x.kind !== "hotels" && x.kind !== "resorts") })).filter((g) => g.items.length > 0) : []

  // A CollectionPage listing the real upcoming trips and past-trip recaps for this destination -
  // the audit script (scripts/audit-live-seo.mjs) flagged every destination page as having no
  // structured data at all. Every item here is a real published/past package, nothing invented.
  // When a guide exists, its TouristDestination, FAQPage and BreadcrumbList are added alongside.
  const allItems = [...upcoming, ...recaps]
  const jsonLd: object[] = []
  if (page) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${destination} Trips | ${SITE_NAME}`,
      description: `Upcoming group trips, cruises and singles getaways to ${destination}, plus real recaps from past trips there.`,
      url: pageUrl,
      // With a guide, the guide is the one primary entity of this URL: the trip list points at it.
      ...(guide ? { about: { "@id": pageUrl }, isPartOf: { "@id": pageUrl } } : {}),
      ...(allItems.length > 0
        ? {
            mainEntity: {
              "@type": "ItemList",
              itemListElement: allItems.map((pkg, i) => ({
                "@type": "ListItem",
                position: i + 1,
                url: absoluteUrl(`/packages/${pkg.slug}`),
                name: pkg.name,
              })),
            },
          }
        : {}),
    })
  }
  if (guide) jsonLd.push(...guideJsonLd(guide, trail))

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
        <div className="border-b bg-muted/30">
          <div className={`container mx-auto px-4 py-10 ${feature.kind !== "none" ? "grid items-stretch gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]" : ""}`}>
            <div className="flex min-w-0 flex-col">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="h-4 w-4" />Destination</p>
            <h1 className="mt-1 text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">{guide ? `${destination}: ${guideKinds.destinations.guideLabel}` : `${destination} Trips`}</h1>
            {guide && formatDate(guide.updated_at) && (
              <p className="mt-2 text-sm text-muted-foreground"><time dateTime={guide.updated_at}>Updated {formatDate(guide.updated_at)}</time></p>
            )}
            {guide ? (
              <>
                <p className="mt-3 max-w-3xl text-pretty text-foreground">{linked ? <AffiliateParts parts={linked.summary} /> : guide.summary}</p>
              </>
            ) : (
              blurb && <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">{blurbSet.blurb ? <AffiliateParts parts={blurbLinked.parts(blurbSet.blurb)} /> : blurb.blurb}</p>
            )}
            <GuideHeaderActions name={destination} packageName={upcoming[0]?.name} guide={guide} feature={feature} language={language} factParts={linked?.facts} />
            </div>
            <GuideHeaderFeature feature={feature} language={language} currency={currency} usdToTargetRate={usdToTargetRate} factParts={linked?.facts} />
          </div>
        </div>

        <div className="container mx-auto space-y-12 px-4 py-10">
          {guide && (
            <div className="mx-auto max-w-3xl space-y-10">
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
              <GuideTakeaways guide={guide} parts={linked?.takeaways} />
              <GuideFacts input={factsInput} />
              <GuideArticle guide={guide} html={linked?.bodyHtml} />
              <GuideFaqList guide={guide} answers={linked?.answers} />
              <AffiliateAutoDisclosure count={linked?.count ?? 0} language={language} />
              <GuideThingsToDo things={things} name={destination} language={language} />
              <GuideCta name={destination} packageName={upcoming[0]?.name} />
              <RelatedGuidesSection guides={relatedGuideCards(relatedGuides)} />
              <BlogStoriesSection stories={stories} />
            </div>
          )}

          {/* The guide block above comes first so the answer content is the top of the page; the trip grid follows.
              With no guide the grid is the first block, exactly as before. */}
          {/* The nearest trip is the header card, so this section only lists the REST: with one trip it is not rendered
              at all (no duplicate). Cards are centred and wrap, so a lone or odd one out is never stuck on the left. */}
          {restTrips.length > 0 && (
            <section>
              <h2 className="mb-4 text-center text-xl font-bold uppercase text-foreground">More upcoming trips to {destination}</h2>
              <div className="grid justify-center gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),22rem))]">
                {restTrips.map((pkg) => (
                  <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
                ))}
              </div>
            </section>
          )}

          {/* A destination without a guide gets the block here, after its trips (with a guide it sits in the guide block above). */}
          {!guide && (
            <div className="mx-auto max-w-3xl">
              <GuideThingsToDo things={things} name={destination} language={language} />
            </div>
          )}

          {/* One disclosure line per page, only when the intro blurb really got an automatic link (a page with a guide shows it after the FAQ). */}
          {!guide && <AffiliateAutoDisclosure count={blurbLinked.count} language={language} />}

          {childBlocks.length > 0 && (
            <section aria-labelledby="inside-heading">
              <h2 id="inside-heading" className="mb-4 text-xl font-bold uppercase text-foreground">More guides under {destination}</h2>
              <div className="space-y-4">
                {childBlocks.map((group) => (
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

          {propertyGuides.length > 0 && (
            <section aria-labelledby="property-guides-heading">
              <h2 id="property-guides-heading" className="mb-4 text-xl font-bold uppercase text-foreground">Hotel and resort guides for {destination}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {propertyGuides.map((g) => (
                  <li key={g.id}>
                    <Link href={guidePath(g.kind, g.slug)} className="block h-full rounded-lg border bg-card p-4 transition-shadow hover:shadow-md">
                      <span className="text-xs uppercase text-muted-foreground">{guideKinds[g.kind].label}</span>
                      <span className="mt-0.5 block font-semibold text-foreground">{g.name}</span>
                      <span className="mt-1 block text-sm text-muted-foreground">{oneLineSummary(g.summary)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* The best-time-to-visit page already links back here ("See all {destination}
              trips") - this completes the reciprocal link. bestTimeToVisit is only non-null when
              a real dated published package exists (upcoming OR past - seasonal timing is still
              meaningful either way), so this never points at a 404. Rendered independently of the
              upcoming/past split above, not nested inside it - a destination whose only dated
              package has since passed (and so sits in "Past trips" instead) still has real
              best-time-to-visit data worth linking to. */}
          {bestTimeToVisit && (
            <p className="text-sm text-muted-foreground">
              <Link href={`/best-time-to-visit/${params.slug}`} className="font-medium text-foreground hover:underline">
                See the best time to visit {destination}
              </Link>
            </p>
          )}

          {recaps.length > 0 && (
            <section>
              <h2 className="mb-4 text-xl font-bold uppercase text-foreground">Past trips to {destination}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {recaps.map((pkg) => (
                  <Link key={pkg.id} href={`/packages/${pkg.slug}`} className="group flex items-center gap-4 rounded-xl border bg-card p-4 transition-shadow hover:shadow-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pkg.image_url || DEFAULT_OG_IMAGE} alt={pkg.name} className="h-16 w-24 shrink-0 rounded object-cover" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground group-hover:underline">{pkg.name}</p>
                      {formatDateRange(pkg.available_from, pkg.available_to) && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Calendar className="h-3 w-3" />{formatDateRange(pkg.available_from, pkg.available_to)}</p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
