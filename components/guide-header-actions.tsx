import Link from "next/link"
import { Phone, MessageSquare } from "lucide-react"
import { site } from "@/lib/site"
import { headerCta, leftQuickFacts, type HeaderFeature, type HeaderGuide } from "@/lib/guide-header"
import { translate } from "@/lib/i18n"
import type { Language } from "@/lib/preferences"

// The lower part of the LEFT column of a guide page header: up to four quick facts (stored key takeaways only, see
// lib/guide-header.ts) and a call-to-action panel pushed to the bottom (mt-auto) so the column fills the height of
// the trip card on the right. Server component, no handlers. The panel uses only claims already on the site
// (site.tagline); the number is site.phone. There is no trip alert form or newsletter anchor on guide pages, so the
// "Get trip alerts" button is left out on purpose.

export function GuideHeaderActions({
  name,
  packageName,
  guide,
  feature,
  language,
}: {
  name: string
  packageName?: string | null
  guide: HeaderGuide | null
  feature: HeaderFeature<unknown>
  language: Language
}) {
  const facts = leftQuickFacts(guide, feature)
  const cta = headerCta(name, packageName, site.phone)
  const title = translate(language, cta.titleTemplate).replace("{name}", cta.name)
  return (
    <div className="mt-6 flex flex-1 flex-col gap-5">
      {facts.length > 0 && (
        <aside aria-label={translate(language, "Quick facts")}>
          <h2 className="text-sm font-bold uppercase text-foreground">{translate(language, "Quick facts")}</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-foreground">
            {facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </aside>
      )}
      <section aria-labelledby="guide-header-cta" className="mt-auto rounded-xl border border-primary/30 bg-primary/10 p-5 sm:p-6">
        <h2 id="guide-header-cta" className="text-balance text-xl font-bold text-foreground sm:text-2xl">{title}</h2>
        <p className="mt-1 text-sm text-foreground/80">{site.tagline}</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {cta.phone && (
            cta.callHref ? (
              <a href={cta.callHref} className="inline-flex flex-col items-center justify-center rounded-md bg-primary px-5 py-3 text-center text-primary-foreground shadow-sm hover:opacity-90">
                <span className="inline-flex items-center gap-2 text-sm font-bold"><Phone className="h-4 w-4" aria-hidden="true" />{translate(language, "Call or text")} {cta.phone}</span>
                <span className="text-xs opacity-90">{translate(language, "our AI agent answers")}</span>
              </a>
            ) : (
              <span className="inline-flex flex-col items-center justify-center rounded-md bg-primary px-5 py-3 text-center text-primary-foreground">
                <span className="text-sm font-bold">{translate(language, "Call or text")} {cta.phone}</span>
                <span className="text-xs opacity-90">{translate(language, "our AI agent answers")}</span>
              </span>
            )
          )}
          <Link href={cta.enquiryHref} className="inline-flex items-center justify-center gap-2 rounded-md border border-primary bg-background px-5 py-3 text-sm font-bold text-foreground hover:bg-primary/10">
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            {translate(language, "Send an enquiry")}
          </Link>
        </div>
      </section>
    </div>
  )
}
