import { ExternalLink } from "lucide-react"
import { disclosureTexts, type ThingsToDo } from "@/lib/things-to-do"
import { DEFAULT_DISCLOSURE } from "@/lib/affiliate-partners"
import { translate } from "@/lib/i18n"
import type { Language } from "@/lib/preferences"

// "Fun things to do in <place>" (WP21). Server component, no handlers. Content, in order: curated cards an admin
// pinned to this page (photo, title, partner badge, the admin's note, a button), one automatic search button per
// active partner that has a search link, and the commission wording. It shows nothing at all when there are no
// active partners and no curated cards. It never invents a tour, a price, a rating, an availability or a review,
// and it adds no structured data (no products, no aggregate ratings). Every outbound anchor is
// rel="sponsored nofollow noopener" and opens in a new tab; they all go through /go, which is noindex.

const OUTBOUND_REL = "sponsored nofollow noopener"

// The page loads the data with loadThingsToDo(kind, slug) (server only, in its existing Promise.all) and passes it in.
export function GuideThingsToDo({ things, name, language }: { things: ThingsToDo; name: string; language: Language }) {
  if (things.cards.length === 0 && things.searches.length === 0) return null
  const t = (text: string) => translate(language, text)
  const fill = (text: string, values: Record<string, string>) => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), t(text))
  const notes = disclosureTexts(things)

  return (
    <section id="things-to-do" aria-labelledby="things-to-do-heading" data-things-to-do>
      <h2 id="things-to-do-heading" className="mb-3 text-xl font-bold text-foreground">{fill("Fun things to do in {name}", { name })}</h2>

      {things.cards.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {things.cards.map((c) => (
            <li key={c.id} className="flex flex-col overflow-hidden rounded-xl border bg-card">
              {c.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.imageUrl} alt={c.title} loading="lazy" referrerPolicy="no-referrer" className="aspect-[16/9] w-full object-cover" />
              )}
              <div className="flex flex-1 flex-col gap-2 p-4">
                {c.partnerName && <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{c.partnerName}</span>}
                <h3 className="font-semibold text-foreground">{c.title}</h3>
                {c.note && <p className="text-sm text-muted-foreground">{c.note}</p>}
                <a
                  href={c.href}
                  target="_blank"
                  rel={OUTBOUND_REL}
                  className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  {c.partnerName ? fill("View on {partner}", { partner: c.partnerName }) : t("View details")}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {things.searches.length > 0 && (
        <ul className={`flex flex-col gap-2 ${things.cards.length > 0 ? "mt-4" : ""}`}>
          {things.searches.map((s) => (
            <li key={s.partnerSlug}>
              <a
                href={s.href}
                target="_blank"
                rel={OUTBOUND_REL}
                className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
              >
                {s.logoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-5 w-auto max-w-[5rem] object-contain" />
                )}
                <span>{fill("Find {name} tours and activities on {partner}", { name, partner: s.partnerName })}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-1 text-xs text-muted-foreground" data-affiliate-disclosure>
        {notes.map((n) => (
          <p key={n}>{n === DEFAULT_DISCLOSURE ? t(DEFAULT_DISCLOSURE) : n}</p>
        ))}
      </div>
    </section>
  )
}
