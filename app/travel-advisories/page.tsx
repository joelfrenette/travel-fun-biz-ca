import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { buildBreadcrumbJsonLd, jsonLdHtml } from "@/lib/jsonld"
import { getVisitorPreferences } from "@/lib/preferences"
import { ADVISORY_INDEX_PATH } from "@/lib/country-advisory"
import { loadAdvisoryIndex } from "@/lib/country-advisory-public"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

export const revalidate = 300

const title = "Canada and UK travel advisories by country"
const description = "Current government travel advisories by country, in the governments' own words, with the date and a link to each official page."

export async function generateMetadata(): Promise<Metadata> {
  const rows = await loadAdvisoryIndex()
  if (rows === null) return { title: `Travel advisories not found | ${SITE_NAME}`, robots: { index: false } }
  const url = absoluteUrl(ADVISORY_INDEX_PATH)
  return {
    title,
    description,
    alternates: { canonical: url },
    // An index with nothing on it is thin: not indexed until there is at least one country.
    robots: rows.length > 0 ? undefined : { index: false, follow: true },
    openGraph: { title, description, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: SITE_NAME }] },
    twitter: { card: "summary_large_image", title, description, images: [DEFAULT_OG_IMAGE] },
  }
}

export default async function TravelAdvisoriesIndex() {
  const rows = await loadAdvisoryIndex()
  if (rows === null) notFound()
  const { language, currency } = getVisitorPreferences()
  const crumbs = buildBreadcrumbJsonLd([{ name: "Home", url: absoluteUrl("/") }, { name: "Travel advisories", url: absoluteUrl(ADVISORY_INDEX_PATH) }])
  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(crumbs) }} />
        <div className="border-b bg-muted/30">
          <div className="container mx-auto max-w-3xl px-4 py-10">
            <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">Home</Link> <span aria-hidden="true">/</span> <span>Travel advisories</span>
            </nav>
            <h1 className="mt-3 text-balance text-3xl font-bold text-foreground sm:text-4xl">Travel advisories by country</h1>
            <p className="mt-3 text-pretty text-muted-foreground">{description} Only countries whose advisory has changed since we started tracking are listed, so this list grows over time.</p>
          </div>
        </div>
        <div className="container mx-auto max-w-3xl px-4 py-10">
          {rows.length === 0 ? (
            <p className="text-muted-foreground">No country advisories are on file yet. Please check the official government websites before you travel.</p>
          ) : (
            <ul className="divide-y rounded-xl border bg-card">
              {rows.map((r) => (
                <li key={r.slug} className="p-4">
                  <Link href={r.path} className="font-semibold text-primary hover:underline">{r.title}</Link>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {r.level ? `The Government of Canada says: "${r.level}".` : "See the page for the UK update line."}
                    {r.updatedLabel ? ` Updated ${r.updatedLabel}.` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-6 text-sm text-muted-foreground">Government advice can change at any time. This list is not travel advice from {SITE_NAME}. Always read the official page before you book or travel.</p>
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
