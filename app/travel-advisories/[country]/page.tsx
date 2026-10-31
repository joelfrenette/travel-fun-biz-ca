import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { buildBreadcrumbJsonLd, jsonLdHtml } from "@/lib/jsonld"
import { getVisitorPreferences } from "@/lib/preferences"
import { getPublishedGuidePaths, guidePath } from "@/lib/guides"
import { ADVISORY_INDEX_PATH, buildAdvisoryJsonLd } from "@/lib/country-advisory"
import { loadAdvisoryPage } from "@/lib/country-advisory-public"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

export const revalidate = 300

type Props = { params: { country: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const view = await loadAdvisoryPage(params.country)
  // Mode not on, unknown country or draft row: not a page, and kept out of search.
  if (!view) return { title: `Travel advisory not found | ${SITE_NAME}`, robots: { index: false } }
  const url = absoluteUrl(view.path)
  return {
    title: view.title,
    description: view.description,
    alternates: { canonical: url },
    // A page with no current advisory data is not indexed.
    robots: view.indexable ? undefined : { index: false, follow: true },
    openGraph: { title: view.title, description: view.description, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: SITE_NAME }] },
    twitter: { card: "summary_large_image", title: view.title, description: view.description, images: [DEFAULT_OG_IMAGE] },
  }
}

const q = (s: string) => `"${s}"`

export default async function CountryAdvisoryPage({ params }: Props) {
  const view = await loadAdvisoryPage(params.country)
  if (!view) notFound()
  const { language, currency } = getVisitorPreferences()
  // A guide is linked only when a published destination guide really exists for this country.
  const guides = await getPublishedGuidePaths().catch(() => [])
  const guideSlug = view.guideSlug ?? view.slug
  const guide = guides.find((g) => g.kind === "destinations" && g.slug === guideSlug)

  const page = buildAdvisoryJsonLd(view, absoluteUrl)
  const crumbs = buildBreadcrumbJsonLd([
    { name: "Home", url: absoluteUrl("/") },
    { name: "Travel advisories", url: absoluteUrl(ADVISORY_INDEX_PATH) },
    { name: view.name, url: absoluteUrl(view.path) },
  ])

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        {view.hasData && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(page) }} />}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(crumbs) }} />
        <div className="border-b bg-muted/30">
          <div className="container mx-auto max-w-3xl px-4 py-10">
            <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">Home</Link> <span aria-hidden="true">/</span>{" "}
              <Link href={ADVISORY_INDEX_PATH} className="hover:underline">Travel advisories</Link> <span aria-hidden="true">/</span> <span>{view.name}</span>
            </nav>
            <h1 className="mt-3 text-balance text-3xl font-bold text-foreground sm:text-4xl">{view.h1}</h1>
            <p className="mt-3 text-pretty text-muted-foreground">
              This page shows what the governments of Canada and the UK currently say about travel to {view.name}, in their own words, with a link to each official page. We do not rate or rewrite their advice.
            </p>
          </div>
        </div>

        <div className="container mx-auto max-w-3xl space-y-10 px-4 py-10">
          {!view.hasData && (
            <p className="rounded-xl border bg-card p-4 text-muted-foreground">We do not have a current advisory for {view.name} on file yet. Please check the official government websites before you travel.</p>
          )}

          {view.canada && (
            <section aria-labelledby="canada-h" className="rounded-xl border bg-card p-5">
              <h2 id="canada-h" className="text-xl font-bold text-foreground">Government of Canada</h2>
              {view.canada.level && (
                <p className="mt-3 text-foreground">The Government of Canada says: <strong>{q(view.canada.level)}</strong></p>
              )}
              {view.canada.quote && <p className="mt-2 text-muted-foreground">From the same advisory: {q(view.canada.quote)}</p>}
              <dl className="mt-3 space-y-1 text-sm text-muted-foreground">
                {view.canada.publishedLabel && <div>Source published {view.canada.publishedLabel}</div>}
                {view.canada.checkedLabel && <div>Last checked {view.canada.checkedLabel}</div>}
              </dl>
              {view.canada.staleNote && <p role="status" className="mt-3 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{view.canada.staleNote}</p>}
              {view.canada.sourceUrl && (
                <p className="mt-3"><a href={view.canada.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Read the official Government of Canada advisory for {view.name}</a></p>
              )}
            </section>
          )}

          {view.uk && (
            <section aria-labelledby="uk-h" className="rounded-xl border bg-card p-5">
              <h2 id="uk-h" className="text-xl font-bold text-foreground">UK Foreign, Commonwealth and Development Office</h2>
              {view.uk.updateLine && <p className="mt-3 text-foreground">The UK FCDO&apos;s latest update line says: {q(view.uk.updateLine)}</p>}
              <dl className="mt-3 space-y-1 text-sm text-muted-foreground">
                {view.uk.publishedLabel && <div>Source published {view.uk.publishedLabel}</div>}
              </dl>
              {view.uk.sourceUrl && (
                <p className="mt-3"><a href={view.uk.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Read the official UK travel advice for {view.name}</a></p>
              )}
            </section>
          )}

          {view.log.length > 0 && (
            <section aria-labelledby="log-h">
              <h2 id="log-h" className="text-xl font-bold text-foreground">Update log</h2>
              <ul className="mt-3 space-y-3">
                {view.log.map((e, i) => (
                  <li key={i} className="rounded-lg border bg-card p-4 text-sm">
                    {e.dateLabel && <p className="font-semibold text-foreground">{e.dateLabel}</p>}
                    <p className="text-foreground">{e.text}</p>
                    {e.quote && <p className="mt-1 text-muted-foreground">{e.source} wording: {q(e.quote)}</p>}
                    {e.sourceUrl && <p className="mt-1"><a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Official source</a></p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="more-h">
            <h2 id="more-h" className="text-xl font-bold text-foreground">More</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
              {guide && <li><Link href={guidePath(guide.kind, guide.slug)} className="font-medium text-primary hover:underline">Our {view.name} destination guide</Link></li>}
              <li><Link href={ADVISORY_INDEX_PATH} className="font-medium text-primary hover:underline">All travel advisories</Link></li>
              <li><Link href="/packages" className="font-medium text-primary hover:underline">Browse our group trips</Link></li>
            </ul>
            <p className="mt-4 text-sm text-muted-foreground">Government advice can change at any time. This page is not travel advice from {SITE_NAME}. Always read the official page before you book or travel.</p>
          </section>
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
