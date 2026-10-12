import Link from "next/link"
import { guidePath, oneLineSummary, type GuideSummary } from "@/lib/guides"
import { heroSrcSet, HERO_SIZES } from "@/lib/guide-images"

// Home-page block (growth loop WP16): the destinations that have a published guide, those with trips first
// (the page passes listTopDestinationGuides). Drawn only from real published guide rows, so with none published it
// renders nothing at all.
export function TopDestinations({ items }: { items: GuideSummary[] }) {
  if (items.length === 0) return null
  return (
    <section aria-labelledby="top-destinations-heading" className="py-16">
      <div className="container mx-auto px-4">
        <div className="mb-8 text-center">
          <h2 id="top-destinations-heading" className="text-balance text-3xl font-bold text-foreground">Where our trips go</h2>
          <p className="mx-auto mt-3 max-w-2xl text-pretty text-muted-foreground">Plain-English guides to the places on our trips, with what to expect and how to visit with a group.</p>
        </div>
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((g) => (
            <li key={g.id}>
              <Link href={guidePath(g.kind, g.slug)} className="group flex h-full flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg">
                {g.hero_image_url && (
                  <div className="aspect-[16/9] overflow-hidden bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.hero_image_url} srcSet={heroSrcSet(g.hero_image_url) ?? undefined} sizes={HERO_SIZES.card} alt={g.hero_alt || g.name} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                  </div>
                )}
                <div className="flex flex-1 flex-col gap-1.5 p-5">
                  <h3 className="text-lg font-bold leading-snug text-foreground group-hover:underline">{g.name}</h3>
                  <p className="line-clamp-3 text-sm text-muted-foreground">{oneLineSummary(g.summary)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-center">
          <Link href="/destinations" className="text-sm font-semibold uppercase text-primary hover:underline">See all destinations</Link>
        </p>
      </div>
    </section>
  )
}
