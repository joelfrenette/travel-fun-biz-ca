import Link from "next/link"
import { Quote as QuoteIcon } from "lucide-react"
import type { RecapBundle } from "@/lib/recap-studio"

// The Recap Studio's extras on a past trip's page: the "Quick answer" (first sentence of the recap), the key takeaways, the
// quotes travellers gave permission to show, and two internal links (the destination guide, the next trip). Rendered only from a
// published bundle (lib/recap-public.ts); quotes here are the same ones that go into the page's Review markup.
export function TripRecapExtras({ bundle, guide, nextTrip }: { bundle: RecapBundle; guide: { href: string; label: string } | null; nextTrip: { slug: string; name: string } | null }) {
  return (
    <div className="space-y-6" data-testid="trip-recap-extras">
      {bundle.quickAnswer && (
        <div className="rounded-lg border-l-4 border-primary bg-muted/40 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick answer</p>
          <p className="mt-1 text-pretty text-foreground">{bundle.quickAnswer}</p>
        </div>
      )}
      {bundle.takeaways.length > 0 && (
        <div>
          <h2 className="mb-3 text-xl font-bold">Key takeaways</h2>
          <ul className="space-y-2">
            {bundle.takeaways.map((t) => (
              <li key={t} className="flex gap-2 text-muted-foreground"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />{t}</li>
            ))}
          </ul>
        </div>
      )}
      {bundle.quotes.length > 0 && (
        <div>
          <h2 className="mb-3 text-xl font-bold">In their words</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {bundle.quotes.map((q) => (
              <figure key={`${q.name}:${q.text}`} className="rounded-lg border bg-card p-4">
                <QuoteIcon className="mb-2 h-4 w-4 text-primary" aria-hidden />
                <blockquote className="text-pretty text-foreground">{q.text}</blockquote>
                <figcaption className="mt-2 text-sm text-muted-foreground">{q.name}, shown with permission</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
      {(guide || nextTrip) && (
        <p className="text-sm text-muted-foreground">
          {guide && <>Planning a visit? Read the <Link href={guide.href} className="font-medium text-foreground underline">{guide.label}</Link>. </>}
          {nextTrip && <>Want to go? See <Link href={`/packages/${nextTrip.slug}`} className="font-medium text-foreground underline">{nextTrip.name}</Link>.</>}
        </p>
      )}
    </div>
  )
}
