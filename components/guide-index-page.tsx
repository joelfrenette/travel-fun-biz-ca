import type { Metadata } from "next"
import Link from "next/link"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { listPublishedGuides, guideKinds, guidePath, type GuideKind, type GuideSummary } from "@/lib/guides"
import { getDestinationSlugs } from "@/lib/destinations"
import { getVisitorPreferences } from "@/lib/preferences"
import { jsonLdHtml } from "@/lib/jsonld"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

// ONE shared index page for every guide kind (the thin route files at app/<kind>/page.tsx call these).
// Destinations also lists every place with a published trip, even before its guide is written.

interface IndexItem {
  key: string
  href: string
  name: string
  summary: string | null
  image: string | null
  alt: string | null
}

async function loadItems(kind: GuideKind): Promise<IndexItem[]> {
  const guides = await listPublishedGuides(kind)
  const items: IndexItem[] = guides.map((g: GuideSummary) => ({ key: g.id, href: guidePath(g.kind, g.slug), name: g.name, summary: g.summary, image: g.hero_image_url, alt: g.hero_alt }))
  if (kind === "destinations") {
    const have = new Set(guides.map((g) => g.slug))
    for (const d of await getDestinationSlugs()) {
      if (!have.has(d.slug)) items.push({ key: `trip-${d.slug}`, href: `/destinations/${d.slug}`, name: d.destination, summary: `Upcoming and past trips to ${d.destination}.`, image: null, alt: null })
    }
  }
  return items
}

export async function guideIndexMetadata(kind: GuideKind): Promise<Metadata> {
  const info = guideKinds[kind]
  const items = await loadItems(kind)
  const title = kind === "destinations" ? `Destination Guides and Trips | ${SITE_NAME}` : `${info.plural}: Guides for Group Travellers | ${SITE_NAME}`
  const description =
    kind === "destinations"
      ? "Plain-English destination guides and every place our group trips, cruises and singles getaways go."
      : `Plain-English ${info.plural.toLowerCase()} guides for group travellers: who each one suits, what to expect and how to book it with a group.`
  const url = absoluteUrl(info.urlPrefix)
  return {
    title,
    description,
    alternates: { canonical: url },
    // An index with nothing on it is thin content: keep it out of search until there is something to list.
    robots: items.length === 0 ? { index: false, follow: true } : undefined,
    openGraph: { title, description, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: info.plural }] },
    twitter: { card: "summary_large_image", title, description, images: [DEFAULT_OG_IMAGE] },
  }
}

export async function GuideIndexPage({ kind }: { kind: GuideKind }) {
  const info = guideKinds[kind]
  const { language, currency } = getVisitorPreferences()
  const items = await loadItems(kind)
  const heading = kind === "destinations" ? "Destination Guides and Trips" : `${info.plural}: Guides`
  const intro =
    kind === "destinations"
      ? "Where our group trips, cruises and singles getaways go, with a plain-English guide to each place."
      : `Plain-English guides to ${info.plural.toLowerCase()} for group travellers: who each one suits, what to expect and how to book it with a group.`
  const url = absoluteUrl(info.urlPrefix)

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: heading,
      description: intro,
      url,
      mainEntity: { "@type": "ItemList", itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, url: absoluteUrl(it.href), name: it.name })) },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
        { "@type": "ListItem", position: 2, name: info.plural, item: url },
      ],
    },
  ]

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
        <section className="container mx-auto px-4 py-16">
          <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
            <Link href="/" className="hover:underline">Home</Link>
            <span className="mx-1.5">/</span>
            <span className="text-foreground">{info.plural}</span>
          </nav>
          <div className="mb-10 text-center">
            <h1 className="text-balance text-4xl font-bold text-foreground">{heading}</h1>
            <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">{intro}</p>
          </div>

          {items.length === 0 ? (
            <p className="text-center text-muted-foreground">
              Nothing published yet. Check back soon, or <Link href="/#contact" className="font-medium text-foreground hover:underline">tell us what you are looking for</Link>.
            </p>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((it) => (
                <Link key={it.key} href={it.href} className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg">
                  {it.image && (
                    <div className="aspect-[16/9] overflow-hidden bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={it.image} alt={it.alt || it.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                    </div>
                  )}
                  <div className="flex flex-1 flex-col gap-2 p-5">
                    <h2 className="text-lg font-bold leading-snug text-foreground group-hover:underline">{it.name}</h2>
                    {it.summary && <p className="line-clamp-4 text-sm text-muted-foreground">{it.summary}</p>}
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
