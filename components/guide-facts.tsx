import Link from "next/link"
import { buildKeyFacts, pickRoute, tripBullets, tripLengthBars, type FactsInput } from "@/lib/guide-facts"

// The facts block of a guide page (growth loop WP16): a key-facts table, the trips as bullets, a route diagram and a
// trip-length chart. Every piece is built in lib/guide-facts.ts from stored data and is left out entirely when its
// data is missing, so a page with no trips shows only the table rows it can back.

export function GuideFacts({ input }: { input: FactsInput }) {
  const rows = buildKeyFacts(input)
  const bullets = tripBullets(input.trips)
  const route = pickRoute(input.trips)
  const bars = tripLengthBars(input.trips)
  const widest = bars ? Math.max(...bars.map((b) => b.days)) : 0

  return (
    <div className="space-y-8">
      {rows.length > 1 && (
        <section aria-labelledby="key-facts-heading">
          <h2 id="key-facts-heading" className="mb-3 text-xl font-bold text-foreground">Key facts</h2>
          <div className="overflow-hidden rounded-xl border bg-card">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row" className="w-2/5 bg-muted/30 p-3 text-left font-medium text-muted-foreground">{r.label}</th>
                    <td className="p-3 text-foreground">{r.href ? <Link href={r.href} className="font-medium hover:underline">{r.value}</Link> : r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {bullets.length > 0 && (
        <section aria-labelledby="trip-bullets-heading">
          <h2 id="trip-bullets-heading" className="mb-3 text-xl font-bold text-foreground">Trips on our site</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
            {bullets.map((b) => (
              <li key={b.href}><Link href={b.href} className="hover:underline">{b.text}</Link></li>
            ))}
          </ul>
        </section>
      )}

      {route && (
        <section aria-labelledby="route-heading">
          <h2 id="route-heading" className="mb-1 text-xl font-bold text-foreground">A sample route</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            The stops listed on our <Link href={`/packages/${route.tripSlug}`} className="font-medium text-foreground hover:underline">{route.tripName}</Link> trip, in order. Check that trip page for the current plan.
          </p>
          <ol className="relative ml-3 space-y-3 border-l-2 border-primary/40 pl-6">
            {route.stops.map((s, i) => (
              <li key={`${i}-${s.title}`} className="relative text-sm text-foreground">
                <span aria-hidden="true" className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-primary bg-background" />
                {s.day !== null && <span className="mr-2 text-xs font-semibold uppercase text-muted-foreground">Day {s.day}</span>}
                {s.title}
              </li>
            ))}
          </ol>
        </section>
      )}

      {bars && (
        <section aria-labelledby="length-heading">
          <h2 id="length-heading" className="mb-3 text-xl font-bold text-foreground">How long the trips are</h2>
          <ul className="space-y-2" role="list">
            {bars.map((b) => (
              <li key={b.slug} className="text-sm">
                <div className="mb-0.5 flex justify-between gap-3 text-foreground">
                  <Link href={`/packages/${b.slug}`} className="truncate hover:underline">{b.name}</Link>
                  <span className="shrink-0 text-muted-foreground">{b.days} {b.days === 1 ? "day" : "days"}</span>
                </div>
                <div className="h-2.5 rounded-full bg-muted" aria-hidden="true">
                  <div className="h-2.5 rounded-full bg-primary" style={{ width: `${Math.max(6, Math.round((b.days / widest) * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
