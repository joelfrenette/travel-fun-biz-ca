import type { ReactNode } from "react"
import { Calendar, Check, X, Info, MapPin, Sparkles, Phone, CalendarClock } from "lucide-react"
import { PhoneLink } from "@/components/phone-link"
import { buildKeyFacts, inclusionBlocks, attributionLabels, type TripKit, type KitStop, type KitRowInput, type KitFact } from "@/lib/trip-kit-facts"

// The reusable body of the Trip Page Kit. Every block draws ONLY stored or sourced data and is left out when it has none.
// No price appears anywhere in this file: the only price on the page is the hero's agent-confirmed block.

export function KeyFactsStrip({ pkg, kit }: { pkg: KitRowInput; kit: TripKit | null }) {
  const facts = buildKeyFacts(pkg, kit)
  if (facts.length === 0) return null
  return (
    <section aria-label="Key facts" className="border-b bg-muted/30" data-testid="trip-kit-facts">
      <dl className="container mx-auto grid grid-cols-2 gap-px px-4 py-5 sm:grid-cols-3 lg:grid-cols-6">
        {facts.map((f) => (
          <div key={f.label} className="px-2 py-2">
            <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{f.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-foreground sm:text-base">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function StopCard({ stop, index, known }: { stop: KitStop; index: number; known: boolean }) {
  const meta = [stop.date, stop.arrive && `Arrive ${stop.arrive}`, stop.depart && `Depart ${stop.depart}`, stop.days].filter(Boolean) as string[]
  return (
    <li className="relative pl-12 sm:pl-16" data-testid="trip-kit-stop">
      {known && <span aria-hidden="true" className="absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground sm:h-11 sm:w-11">{index + 1}</span>}
      {!known && <span aria-hidden="true" className="absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary sm:h-11 sm:w-11"><MapPin className="h-5 w-5" /></span>}
      <article className={`overflow-hidden rounded-2xl border bg-card shadow-sm ${stop.photo ? "md:grid md:grid-cols-[2fr_3fr]" : ""}`}>
        {stop.photo && (
          <figure className="relative md:h-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={stop.photo.url.replace("dpr=2", "dpr=1")} alt={stop.photo.alt} loading="lazy" decoding="async" className="aspect-[16/9] w-full object-cover md:absolute md:inset-0 md:aspect-auto md:h-full" />
          </figure>
        )}
        <div className="p-4 sm:p-5">
          <h3 className="text-xl font-bold text-foreground">{stop.name}{stop.region ? <span className="font-normal text-muted-foreground">, {stop.region}</span> : null}</h3>
          {meta.length > 0 && <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground"><CalendarClock className="h-4 w-4" aria-hidden="true" />{meta.join(" · ")}</p>}
          {stop.things.length > 0 && (
            <>
              <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{stop.things.length > 1 ? "Fun things to do here" : "About this stop"}</p>
              <ul className="mt-2 space-y-2 text-sm text-muted-foreground sm:text-base">
                {stop.things.map((t) => (
                  <li key={t.text} className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />{t.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </article>
    </li>
  )
}

/** "Your route" when the route is stored, "Where you are headed" when the places are only named. */
export function RouteTimeline({ kit, cta }: { kit: TripKit; cta: ReactNode }) {
  if (kit.stops.length === 0) return null
  const known = kit.routeKnown
  const mid = Math.min(kit.stops.length, Math.ceil(kit.stops.length / 2))
  return (
    <section id="route" className="container mx-auto px-4 py-10 sm:py-14" aria-labelledby="route-heading" data-testid="trip-kit-route">
      <h2 id="route-heading" className="text-2xl font-bold sm:text-3xl">{known ? "Your route" : "Where you are headed"}</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        {known ? "The stops on this trip, in the order the trip lists them." : "The places this trip is built around. Ask your agent for the day by day plan."}
      </p>
      <ol className="relative mt-8 space-y-6 before:absolute before:bottom-0 before:left-[17px] before:top-2 before:w-px before:bg-border sm:before:left-[21px]">
        {kit.stops.map((s, i) => (
          <StopCard key={s.name} stop={s} index={i} known={known} />
        ))}
      </ol>
      {kit.otherStops.length > 0 && (
        <p className="mt-6 text-sm text-muted-foreground"><strong className="text-foreground">Also on the route:</strong> {kit.otherStops.join(", ")}.</p>
      )}
      {mid >= 0 && <div className="mt-10">{cta}</div>}
    </section>
  )
}

function FactList({ items, tone }: { items: KitFact[]; tone: "yes" | "no" }) {
  return (
    <ul className="space-y-2.5">
      {items.map((f) => (
        <li key={f.text} className="flex gap-2.5 text-muted-foreground">
          {tone === "yes" ? <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" /> : <X className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />}
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** What's included / not included. Flights are named only when a stored source says so; otherwise the page says to ask. */
export function InclusionBlock({ pkg, kit }: { pkg: Pick<KitRowInput, "price_includes" | "not_included">; kit: TripKit | null }) {
  const { included, notIncluded } = inclusionBlocks(pkg, kit)
  const flightsKnown = [...included, ...notIncluded].some((f) => /flight|air ?fare/i.test(f.text))
  return (
    <section className="container mx-auto px-4 py-10" aria-labelledby="included-heading" data-testid="trip-kit-included">
      <h2 id="included-heading" className="text-2xl font-bold sm:text-3xl">What is included</h2>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border bg-card p-5">
          <h3 className="mb-3 text-lg font-bold">Included</h3>
          {included.length > 0 ? <FactList items={included} tone="yes" /> : <p className="text-muted-foreground">Your agent will confirm exactly what is included for your dates.</p>}
        </div>
        <div className="rounded-2xl border bg-card p-5">
          <h3 className="mb-3 text-lg font-bold">Not included</h3>
          {notIncluded.length > 0 ? <FactList items={notIncluded} tone="no" /> : <p className="text-muted-foreground">Your agent will confirm what is not included.</p>}
        </div>
      </div>
      {!flightsKnown && <p className="mt-4 flex items-start gap-2 text-sm text-muted-foreground"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Wondering about flights? Ask your agent whether they are part of this trip.</p>}
    </section>
  )
}

const GTK_ASK = [
  { match: /deposit/i, label: "Deposit", fallback: "Ask your agent when the deposit is due." },
  { match: /final|balance/i, label: "Final payment", fallback: "Ask your agent when the final payment is due." },
  { match: /passport|visa/i, label: "Passports and visas", fallback: "Ask your agent what documents you need." },
  { match: /cancel|refund/i, label: "Cancellation", fallback: "Ask your agent about cancellation terms before you book." },
]

/** Good to know: stored/sourced notes first, then a plain "ask your agent" line for the four things everyone asks. */
export function GoodToKnow({ kit }: { kit: TripKit | null }) {
  const notes = kit?.goodToKnow ?? []
  const used = new Set<KitFact>()
  const rows = GTK_ASK.map((g) => {
    const hit = notes.find((n) => g.match.test(`${n.label} ${n.text}`))
    if (hit) used.add(hit)
    return { label: g.label, text: hit?.text ?? g.fallback, ask: !hit }
  })
  const extra = notes.filter((n) => !used.has(n))
  return (
    <section className="bg-muted/30" aria-labelledby="gtk-heading" data-testid="trip-kit-good-to-know">
      <div className="container mx-auto px-4 py-10 sm:py-14">
        <h2 id="gtk-heading" className="text-2xl font-bold sm:text-3xl">Good to know</h2>
        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          {[...rows, ...extra.map((n) => ({ label: n.label || "Note", text: n.text, ask: false }))].map((r) => (
            <div key={`${r.label}-${r.text}`} className="rounded-xl border bg-card p-4">
              <dt className="text-sm font-bold uppercase tracking-wide text-foreground">{r.label}</dt>
              <dd className={`mt-1 ${r.ask ? "text-muted-foreground italic" : "text-muted-foreground"}`}>{r.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

/** The conversation block: call or text first, then a callback request. Never names an agent. */
export function AgentCta({ id, phone, telHref, tripName, heading, method }: { id?: string; phone: string; telHref: string; tripName: string; heading: string; method: string }) {
  return (
    <div id={id} className="rounded-3xl bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-sm ring-1 ring-primary/20 sm:p-9" data-testid="trip-kit-cta">
      <h2 className="text-balance text-2xl font-bold sm:text-3xl">{heading}</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">A travel specialist will help you with dates, what is open, what is included and the best way to book {tripName}. No pressure, just a friendly conversation.</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {telHref && (
          <PhoneLink href={telHref} method={method} className="flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-bold text-primary-foreground shadow hover:bg-primary/90">
            <Phone className="h-5 w-5" aria-hidden="true" />
            Call or text us{phone ? `: ${phone}` : ""}
          </PhoneLink>
        )}
        <a href="#enquire" className="flex items-center justify-center gap-2 rounded-xl border-2 border-primary px-5 py-4 text-base font-bold text-primary hover:bg-primary/5">
          <Calendar className="h-5 w-5" aria-hidden="true" />
          Request a callback from a live agent
        </a>
      </div>
    </div>
  )
}

/** Small attribution line for the reference text and photos used. Required by the CC BY-SA licence. */
export function KitAttribution({ kit }: { kit: TripKit | null }) {
  const refs = attributionLabels(kit?.attributions ?? [])
  const photos = kit?.stops.some((s) => s.photo) ?? false
  if (refs.length === 0 && !photos) return null
  return (
    <p className="container mx-auto px-4 pb-8 text-xs text-muted-foreground" data-testid="trip-kit-attribution">
      {refs.length > 0 && (
        <>
          Source: {refs.map((r, i) => (
            <span key={r.url ?? r.label}>{i > 0 ? ", " : ""}<a href={r.url ?? "#"} target="_blank" rel="noopener noreferrer nofollow" className="underline">{r.label}</a></span>
          ))}{" "}
          (text under CC BY-SA 4.0).{" "}
        </>
      )}
      {photos && "Place photos from Pexels are illustrative pictures of the places, not of this trip."}
    </p>
  )
}

