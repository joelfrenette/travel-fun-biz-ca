import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getSupabaseAdmin } from "@/lib/supabase-admin"
import { getPublishedPackageBySlug } from "@/lib/packages"
import { loadTripKit } from "@/lib/trip-kit-store"
import { todayYmd, isPastTrip } from "@/lib/past-trip"
import { priceOnRequestLine, SITE_NAME } from "@/lib/site"
import { ackFirstName } from "@/lib/lead-ack"
import { buildItinerary, isItineraryLeadMessage, itineraryEmailStatus, itinerarySecret, verifyItineraryToken } from "@/lib/itinerary-magnet"
import { getItineraryMagnetMode } from "@/lib/itinerary-magnet-store"
import { ItineraryPrintButton } from "@/components/itinerary-print-button"

// The private, printable itinerary a visitor gets after "Send me the itinerary and dates" (lib/itinerary-magnet.ts).
// Opened only with the signed token the request made (it names one lead and one trip). Not indexed, not cached, no referrer
// sent on outgoing links, and the only personal detail on it is the visitor's first name. Everything shown comes from fields
// already stored for the trip; a missing fact says "ask your agent". Off mode and any bad token give the normal not found page.
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: `Your trip itinerary | ${SITE_NAME}`,
  robots: { index: false, follow: false, nocache: true, noarchive: true, nosnippet: true },
  referrer: "no-referrer",
}

export default async function ItineraryPage({ params }: { params: { token: string } }) {
  if ((await getItineraryMagnetMode()) !== "on") notFound()
  const claim = verifyItineraryToken(params.token, itinerarySecret())
  if (!claim) notFound()

  // The lead the token names must exist and must be an itinerary request for THIS trip.
  let lead: { name?: string | null; message?: string | null } | null = null
  try {
    const { data } = await getSupabaseAdmin().from("leads").select("name, message").eq("id", claim.leadId).maybeSingle()
    lead = (data as { name?: string | null; message?: string | null } | null) ?? null
  } catch {
    lead = null
  }
  if (!lead || !isItineraryLeadMessage(lead.message, claim.slug)) notFound()

  const pkg = await getPublishedPackageBySlug(claim.slug)
  if (!pkg) notFound()

  const today = todayYmd()
  const { kit, price } = await loadTripKit(pkg.id)
  const view = buildItinerary({ trip: pkg, kit, price, today, phone: priceOnRequestLine().phone })
  const first = ackFirstName(lead.name)
  const emailed = itineraryEmailStatus(lead.message) === "Sent"
  const past = isPastTrip(pkg, today)

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-foreground print:max-w-none print:px-0 print:py-0">
      <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{SITE_NAME}</p>
      <h1 className="mt-1 text-balance text-3xl font-bold sm:text-4xl">{view.title}</h1>
      <p className="mt-2 text-muted-foreground">
        {first === "there" ? "Here is your itinerary." : `Hi ${first}, here is your itinerary.`} It shows only what we have confirmed.
        {emailed && <span className="print:hidden"> We also emailed you a link to this page.</span>}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3 print:hidden">
        <ItineraryPrintButton />
        <a href={`/packages/${pkg.slug}`} className="text-sm font-medium underline">Back to the trip page</a>
      </div>

      {past && <p className="mt-6 rounded-xl border bg-muted/40 p-4 text-sm">This trip has already run. Ask your agent about the next one.</p>}

      <section className="mt-8" aria-labelledby="it-facts">
        <h2 id="it-facts" className="text-xl font-bold">The basics</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border p-4"><dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Where</dt><dd className="mt-1 font-semibold">{view.destination}</dd></div>
          <div className="rounded-xl border p-4"><dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Length</dt><dd className="mt-1 font-semibold">{view.duration ?? "Your agent will confirm the length."}</dd></div>
          <div className="rounded-xl border p-4 sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Next confirmed dates</dt>
            <dd className="mt-1 font-semibold">
              {view.dates.length > 0 ? <ul className="space-y-1">{view.dates.map((d) => <li key={d}>{d}</li>)}</ul> : <span className="font-normal italic text-muted-foreground">{view.datesAsk}</span>}
            </dd>
          </div>
          <div className="rounded-xl border p-4 sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Price</dt>
            <dd className="mt-1">
              {view.price ? (
                <>
                  <span className="text-xl font-extrabold">{view.price.headline}</span>
                  <span className="block text-xs text-muted-foreground">{view.price.note}</span>
                </>
              ) : (
                <span className="italic text-muted-foreground">{view.priceAsk}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-8" aria-labelledby="it-days">
        <h2 id="it-days" className="text-xl font-bold">Day by day</h2>
        {view.days.length > 0 ? (
          <ol className="mt-3 space-y-3">
            {view.days.map((d, i) => (
              <li key={i} className="break-inside-avoid rounded-xl border p-4">
                <p className="font-semibold">{d.label ? `${d.label}: ` : ""}{d.title}</p>
                {d.text && <p className="mt-1 text-muted-foreground">{d.text}</p>}
              </li>
            ))}
          </ol>
        ) : (
          <>
            <p className="mt-3 text-muted-foreground">{view.noDayPlan}</p>
            {view.places && (
              <div className="mt-3 rounded-xl border p-4">
                <p className="font-semibold">{view.places.heading}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{view.places.names.map((n) => <li key={n}>{n}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </section>

      <section className="mt-8" aria-labelledby="it-included">
        <h2 id="it-included" className="text-xl font-bold">What is included</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="break-inside-avoid rounded-xl border p-4">
            <h3 className="mb-2 font-bold">Included</h3>
            {view.included.length > 0 ? <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{view.included.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="italic text-muted-foreground">{view.includedAsk}</p>}
          </div>
          <div className="break-inside-avoid rounded-xl border p-4">
            <h3 className="mb-2 font-bold">Not included</h3>
            {view.notIncluded.length > 0 ? <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{view.notIncluded.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="italic text-muted-foreground">{view.notIncludedAsk}</p>}
          </div>
        </div>
      </section>

      <section className="mt-8 rounded-xl border bg-muted/30 p-4" aria-labelledby="it-talk">
        <h2 id="it-talk" className="text-xl font-bold">Questions? Talk to an agent</h2>
        <p className="mt-1 text-muted-foreground">
          {view.phone ? <>Call or text <strong>{view.phone}</strong>. </> : null}
          A travel advisor will confirm anything not shown here, such as the final price, flights and payment dates.
        </p>
      </section>
    </main>
  )
}
