import { ExternalLink } from "lucide-react"
import type { TripExtra } from "@/lib/trip-extras"
import { DEFAULT_DISCLOSURE } from "@/lib/affiliate-partners"
import { translate } from "@/lib/i18n"
import type { Language } from "@/lib/preferences"

// "Plan the extras for your trip". Server component, no handlers. Shown on upcoming trip pages only (the page passes an
// empty list for a past trip). Each card is a stored title, the merchant and, when an admin wrote one, the link's note.
// Nothing about coverage, price, medical benefits or what is included is ever written here. Every outbound anchor goes
// through /go and is rel="sponsored nofollow noopener" in a new tab. It renders nothing without a qualifying link.

const OUTBOUND_REL = "sponsored nofollow noopener"

export function TripExtras({ extras, language }: { extras: TripExtra[]; language: Language }) {
  if (extras.length === 0) return null
  const t = (text: string) => translate(language, text)
  const view = (merchant: string) => t("View on {partner}").split("{partner}").join(merchant)

  return (
    <section className="container mx-auto px-4 pb-12" aria-labelledby="trip-extras-heading" data-trip-extras>
      <h2 id="trip-extras-heading" className="mb-2 text-2xl font-bold text-foreground">{t("Plan the extras for your trip")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t("Travellers often add these. Booking through our links costs you nothing extra.")}</p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {extras.map((x) => (
          <li key={x.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{x.merchant}</span>
            <h3 className="font-semibold text-foreground">{x.title}</h3>
            {x.note && <p className="text-sm text-muted-foreground">{x.note}</p>}
            <a
              href={x.href}
              target="_blank"
              rel={OUTBOUND_REL}
              className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {view(x.merchant)}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground" data-affiliate-disclosure>{t(DEFAULT_DISCLOSURE)}</p>
    </section>
  )
}
