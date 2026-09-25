import type { Metadata } from "next"
import { Suspense } from "react"
import { notFound } from "next/navigation"
import { Calendar, Clock, MapPin, Star } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ContactForm } from "@/components/contact-form"
import { BookNowButton } from "@/components/book-now-button"
import { StickyCta } from "@/components/sticky-cta"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getPackages, getPublishedPackageBySlug, type DbPackage } from "@/lib/packages"
import { getVisitorPreferences } from "@/lib/preferences"
import { getUsdToRate } from "@/lib/fx"
import { formatPrice } from "@/lib/currency"
import { translate } from "@/lib/i18n"
import { SITE_NAME, SITE_LOCALE, DEFAULT_OG_IMAGE, absoluteUrl, formatDateRange } from "@/lib/site"

export const revalidate = 300

type Props = { params: { slug: string } }

function splitLines(value: string | null | undefined): string[] {
  return (value || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function faqsOf(pkg: DbPackage): { question: string; answer: string }[] {
  if (!Array.isArray(pkg.ai_faqs)) return []
  return pkg.ai_faqs.filter((f: any) => f && typeof f.question === "string" && typeof f.answer === "string" && f.question.trim() && f.answer.trim())
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const pkg = await getPublishedPackageBySlug(params.slug)
  if (!pkg) return { title: `Package not found | ${SITE_NAME}`, robots: { index: false } }

  const dates = formatDateRange(pkg.available_from, pkg.available_to)
  const title = pkg.meta_title || `${pkg.name} | ${pkg.destination}${dates ? ` | ${dates}` : ""} | ${SITE_NAME}`
  const description = pkg.meta_description || pkg.short_description || `${pkg.name}: ${pkg.duration} in ${pkg.destination}. Request info and join the fun with ${SITE_NAME}.`
  const image = pkg.og_image_url || pkg.image_url || DEFAULT_OG_IMAGE
  const url = absoluteUrl(`/packages/${pkg.slug}`)

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", locale: SITE_LOCALE, siteName: SITE_NAME, images: [{ url: image, alt: pkg.name }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  }
}

export default async function PackagePage({ params }: Props) {
  const pkg = await getPublishedPackageBySlug(params.slug)
  if (!pkg) notFound()

  const { language, currency } = getVisitorPreferences()
  const [allPackages, usdToTargetRate] = await Promise.all([getPackages(), getUsdToRate(currency)])

  const dates = formatDateRange(pkg.available_from, pkg.available_to)
  const priceDisplay = pkg.price_value ? formatPrice(pkg.price_value, currency, usdToTargetRate) : pkg.price_display
  const highlights = pkg.highlights?.length ? pkg.highlights : []
  const included = splitLines(pkg.price_includes)
  const notIncluded = splitLines(pkg.not_included)
  const faqs = faqsOf(pkg)
  const description = pkg.full_description || pkg.short_description || ""
  const pageUrl = absoluteUrl(`/packages/${pkg.slug}`)
  const image = pkg.image_url || DEFAULT_OG_IMAGE

  const jsonLd: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "TouristTrip",
      name: pkg.name,
      description: pkg.short_description || description,
      url: pageUrl,
      image,
      touristType: pkg.category,
      itinerary: { "@type": "Place", name: pkg.destination },
      ...(pkg.available_from ? { startDate: pkg.available_from } : {}),
      ...(pkg.available_to ? { endDate: pkg.available_to } : {}),
      provider: { "@type": "TravelAgency", name: SITE_NAME, url: absoluteUrl("/") },
      ...(pkg.price_value
        ? { offers: { "@type": "Offer", price: pkg.price_value, priceCurrency: "USD", url: pageUrl, availability: "https://schema.org/InStock" } }
        : {}),
    },
  ]
  if (faqs.length > 0) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
    })
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1 pb-20 lg:pb-0">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

        {/* Hero */}
        <section className="relative">
          <div className="relative h-[46vh] min-h-[320px] w-full overflow-hidden bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt={pkg.name} className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          </div>
          <div className="container mx-auto px-4">
            <div className="-mt-24 relative z-10 max-w-4xl rounded-xl border bg-card p-6 shadow-lg sm:p-8">
              <Badge className="mb-3 bg-primary text-primary-foreground font-bold uppercase">{translate(language, pkg.category)}</Badge>
              <h1 className="text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">{pkg.name}</h1>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5"><MapPin className="h-4 w-4" />{pkg.destination}</span>
                {dates && <span className="flex items-center gap-1.5"><Calendar className="h-4 w-4" />{dates}</span>}
                <span className="flex items-center gap-1.5"><Clock className="h-4 w-4" />{pkg.duration}</span>
                {pkg.rating && <span className="flex items-center gap-1.5"><Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />{pkg.rating}/5</span>}
              </div>
              <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">{pkg.price_value ? translate(language, "From") : translate(language, "Price")}</p>
                  <p className={pkg.price_value ? "text-3xl font-bold text-foreground" : "text-xl font-semibold text-foreground"}>
                    {priceDisplay}
                    {pkg.price_value && <span className="ml-2 text-sm font-normal text-muted-foreground">{currency.toUpperCase()} {translate(language, "per person")}</span>}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="lg" className="bg-primary font-bold uppercase text-primary-foreground hover:bg-primary/90">
                    <a href="#enquire">{translate(language, "Request Info")}</a>
                  </Button>
                  {pkg.booking_url && (
                    <BookNowButton href={pkg.booking_url} label={pkg.call_to_action || translate(language, "Book Now")} packageName={pkg.name} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Details */}
        <section className="container mx-auto grid gap-10 px-4 py-12 lg:grid-cols-[1fr_340px]">
          <div className="space-y-10">
            {description && (
              <div>
                <h2 className="mb-3 text-2xl font-bold">{translate(language, "About this trip")}</h2>
                <div className="space-y-4 text-pretty leading-relaxed text-muted-foreground">
                  {description.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
                </div>
              </div>
            )}
            {highlights.length > 0 && (
              <div>
                <h2 className="mb-3 text-2xl font-bold">{translate(language, "Highlights")}</h2>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {highlights.map((h) => <li key={h} className="flex gap-2 text-muted-foreground"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />{h}</li>)}
                </ul>
              </div>
            )}
            {(included.length > 0 || notIncluded.length > 0) && (
              <div className="grid gap-8 sm:grid-cols-2">
                {included.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-xl font-bold">{translate(language, "What's included")}</h2>
                    <ul className="space-y-1.5 text-muted-foreground">{included.map((i) => <li key={i}>✓ {i}</li>)}</ul>
                  </div>
                )}
                {notIncluded.length > 0 && (
                  <div>
                    <h2 className="mb-3 text-xl font-bold">{translate(language, "Not included")}</h2>
                    <ul className="space-y-1.5 text-muted-foreground">{notIncluded.map((i) => <li key={i}>– {i}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
            {faqs.length > 0 && (
              <div>
                <h2 className="mb-3 text-2xl font-bold">{translate(language, "Frequently asked questions")}</h2>
                <div className="divide-y rounded-lg border">
                  {faqs.map((f) => (
                    <details key={f.question} className="group p-4">
                      <summary className="cursor-pointer list-none font-medium">{f.question}</summary>
                      <p className="mt-2 text-muted-foreground">{f.answer}</p>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
            <div className="rounded-xl border bg-card p-5">
              <p className="text-sm font-semibold">{translate(language, "Ready to go?")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{translate(language, "Tell us you're interested and a real travel advisor will call or email you with the details.")}</p>
              <Button asChild className="mt-4 w-full bg-primary font-bold uppercase text-primary-foreground hover:bg-primary/90">
                <a href="#enquire">{translate(language, "Request Info")}</a>
              </Button>
              {pkg.supplier && <p className="mt-4 text-xs text-muted-foreground">{translate(language, "Operated by")} {pkg.supplier}</p>}
            </div>
          </aside>
        </section>

        {/* Lead form */}
        <section id="enquire" className="bg-muted/30 py-16">
          <div className="container mx-auto px-4">
            <div className="mb-8 text-center">
              <h2 className="text-balance text-3xl font-bold text-foreground">{translate(language, "Request info about")} {pkg.name}</h2>
              <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">{translate(language, "No obligation. We reply within one business day.")}</p>
            </div>
            <Suspense fallback={null}>
              <ContactForm preselectedPackage={pkg.name} packageOptions={Array.from(new Set([pkg.name, ...allPackages.map((p) => p.name)]))} language={language} />
            </Suspense>
          </div>
        </section>
      </main>
      <StickyCta packageName={pkg.name} requestLabel={translate(language, "Request Info")} bookingUrl={pkg.booking_url} bookLabel={pkg.call_to_action || translate(language, "Book Now")} />
      <Footer language={language} />
    </div>
  )
}
