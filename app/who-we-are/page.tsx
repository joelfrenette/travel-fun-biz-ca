import type { Metadata } from "next"
import Link from "next/link"
import { Heart, Users, ShieldCheck } from "lucide-react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Button } from "@/components/ui/button"
import { Breadcrumbs } from "@/components/breadcrumbs"
import { getVisitorPreferences } from "@/lib/preferences"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"
import { WHO_WE_ARE_SECTIONS } from "@/content/who-we-are"
import { loadAffiliateRules } from "@/lib/affiliate-rules"
import { whoWeAreFieldSet, linkPageFields } from "@/lib/affiliate-text-sources"
import { AffiliateParts, AffiliateAutoDisclosure } from "@/components/affiliate-text"

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

const SECTION_ICONS = { connection: Heart, who: Users, agency: ShieldCheck } as const

export default async function WhoWeArePage() {
  // `language` is forwarded to Header/Footer (whose nav/footer links are translated) but NOT used
  // for this page's own body copy below, unlike other top-level pages - deliberately English-only
  // for now rather than a silent gap. This is marketing/values copy where tone matters; translating
  // it accurately needs a real FR/ES pass, not a literal machine translation, so it's left as a
  // known scope gap rather than guessed at.
  const { language, currency } = getVisitorPreferences()
  // Word links (WP23): the copy lives in content/who-we-are.ts and is linked in reading order with one shared limit.
  // Fails open (no rules, no links). Headings are never linked.
  const affiliateRules = await loadAffiliateRules()
  const copy = whoWeAreFieldSet()
  const linked = linkPageFields(copy.fields, affiliateRules, "pages")

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <Breadcrumbs crumbs={[{ name: "Home", path: "/" }, { name: "Who We Are" }]} currentPath="/who-we-are" />
            <h1 className="text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">Who We Are</h1>
            <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">
              <AffiliateParts parts={linked.parts(copy.intro)} />
            </p>
          </div>
        </div>

        <div className="container mx-auto max-w-2xl space-y-8 px-4 py-10">
          {WHO_WE_ARE_SECTIONS.map((s, i) => {
            const Icon = SECTION_ICONS[s.id]
            return (
              <section key={s.id} className="space-y-3">
                <h2 className="flex items-center gap-2 text-xl font-bold uppercase text-foreground"><Icon className="h-5 w-5" aria-hidden="true" />{s.heading}</h2>
                <p className="text-muted-foreground">
                  <AffiliateParts parts={linked.parts(copy.sections[i])} />
                </p>
              </section>
            )
          })}

          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground"><AffiliateParts parts={linked.parts(copy.closing)} /></p>
            <Button asChild className="mt-4 font-bold uppercase">
              <Link href="/#contact">Get in touch</Link>
            </Button>
          </div>

          <AffiliateAutoDisclosure count={linked.count} language={language} />
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
