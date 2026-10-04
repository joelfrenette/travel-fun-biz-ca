import type { Metadata } from "next"
import Link from "next/link"
import { Heart, Users, ShieldCheck } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Button } from "@/components/ui/button"
import { getVisitorPreferences } from "@/lib/preferences"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

// Added 2026-10-03 (roadmap_usecases 0181b4f4): a visitor landing on a "singles trip" package
// from an ad or search result may reasonably wonder if this is a dating service. This page exists
// to answer that plainly, before they bounce. Pure editorial/values copy - no claims about trip
// counts, traveler numbers, or anything else that would need grounding in real data; the voice
// matches the existing "bring your bestie, your sister, your mom, or come solo" framing already
// used in real package descriptions (see e.g. the Riviera Maya women's trip copy).
const title = `Who We Are | ${SITE_NAME}`
const description = "Our singles and group trips are about connection and fun, not a dating service. Here's what that actually means."
const url = absoluteUrl("/who-we-are")

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: url },
  openGraph: { title, description, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: SITE_NAME }] },
  twitter: { card: "summary_large_image", title, description, images: [DEFAULT_OG_IMAGE] },
}

export default function WhoWeArePage() {
  // `language` is forwarded to Header/Footer (whose nav/footer links are translated) but NOT used
  // for this page's own body copy below, unlike other top-level pages - deliberately English-only
  // for now rather than a silent gap. This is marketing/values copy where tone matters; translating
  // it accurately needs a real FR/ES pass, not a literal machine translation, so it's left as a
  // known scope gap rather than guessed at.
  const { language, currency } = getVisitorPreferences()

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <h1 className="text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">Who We Are</h1>
            <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">
              A straight answer to the question we get asked most about our singles and group trips: no, this isn&apos;t a dating service.
            </p>
          </div>
        </div>

        <div className="container mx-auto max-w-2xl space-y-8 px-4 py-10">
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-xl font-bold uppercase text-foreground"><Heart className="h-5 w-5" aria-hidden="true" />Connection, not matchmaking</h2>
            <p className="text-muted-foreground">
              Our singles and group trips exist for one reason: traveling is more fun with people around you. Some of our travelers come alone and leave with a group of new friends. Some bring their sister, their best friend, or their mom. Some are a couple joining a group departure. What they have in common isn&apos;t relationship status - it&apos;s wanting a trip where they&apos;re never doing things solo unless they want to be.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-xl font-bold uppercase text-foreground"><Users className="h-5 w-5" aria-hidden="true" />Who actually shows up</h2>
            <p className="text-muted-foreground">
              Every group is different, and we don&apos;t screen for dating intent or run a matching algorithm. You&apos;re not signing up to be paired with anyone. You&apos;re signing up for a real trip, with real logistics, run by a real travel advisor - the people on it are simply other travelers who booked the same departure.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-xl font-bold uppercase text-foreground"><ShieldCheck className="h-5 w-5" aria-hidden="true" />A real travel agency, not a platform</h2>
            <p className="text-muted-foreground">
              We&apos;re a licensed travel agency that plans and books the trip end to end - flights, hotels, excursions, the details that actually go wrong if nobody&apos;s handling them. That&apos;s the job. Anything social that happens on a trip is a side effect of good people ending up in the same place, not the product we&apos;re selling.
            </p>
          </section>

          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">Have a question before you book? Just ask - we&apos;d rather answer it now than have you wonder.</p>
            <Button asChild className="mt-4 font-bold uppercase">
              <Link href="/#contact">Get in touch</Link>
            </Button>
          </div>
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
