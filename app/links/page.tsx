import type { Metadata } from 'next'
import { listPublishedGuides, guidePath } from '@/lib/guides'
import { getPublishedPosts } from '@/lib/posts'
import { getPackagesForBrowse } from '@/lib/packages'
import { buildBioLinks, bioSource, type BioLink } from '@/lib/bio-links'
import { SITE_NAME } from '@/lib/site'

// The "link in bio" page for Instagram, TikTok and the other networks (the end card of every reel and the caption of every
// bio-network post say "link in bio"). Server rendered and light: the newest guides, trips and posts, each link UTM tagged
// (utm_source = ?src= or instagram, utm_campaign = <source>_bio). Not for search: noindex, so it never competes with the real pages.
export const metadata: Metadata = {
  title: `Links | ${SITE_NAME}`,
  description: `The newest guides, trips and posts from ${SITE_NAME}.`,
  robots: { index: false, follow: true },
  alternates: { canonical: '/links' },
}

export const revalidate = 600

const SECTIONS: Array<{ kind: BioLink['kind']; heading: string }> = [
  { kind: 'trip', heading: 'Trips you can join' },
  { kind: 'guide', heading: 'Newest guides' },
  { kind: 'post', heading: 'Latest posts' },
]

export default async function LinksPage({ searchParams }: { searchParams?: { src?: string | string[] } }) {
  const source = bioSource(searchParams?.src)
  const [guides, posts, trips] = await Promise.all([
    listPublishedGuides().catch(() => []),
    getPublishedPosts().catch(() => []),
    getPackagesForBrowse().catch(() => []),
  ])
  const links = buildBioLinks(
    {
      guides: guides.map((g) => ({ path: guidePath(g.kind, g.slug), slug: g.slug, name: g.name })),
      trips: trips.map((t) => ({ slug: t.slug, name: t.name })),
      posts: posts.map((p) => ({ slug: p.slug, title: p.title })),
    },
    source,
  )

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 px-4 py-10">
      <header className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{SITE_NAME}</p>
        <h1 className="mt-2 text-balance text-2xl font-bold">Plan your trip</h1>
        <p className="mt-2 text-pretty text-sm text-muted-foreground">Pick a guide, a trip or a post. Want help planning? Tell us where you want to go.</p>
        <a href="/#contact" className="mt-4 inline-block rounded-md bg-primary px-5 py-3 text-sm font-bold uppercase text-primary-foreground">
          Get in touch
        </a>
      </header>

      {SECTIONS.map(({ kind, heading }) =>
        links[kind].length === 0 ? null : (
          <section key={kind} aria-labelledby={`links-${kind}`}>
            <h2 id={`links-${kind}`} className="mb-3 text-sm font-bold uppercase tracking-wide text-muted-foreground">
              {heading}
            </h2>
            <ul className="space-y-3">
              {links[kind].map((l) => (
                <li key={l.href}>
                  <a href={l.href} className="block rounded-lg border bg-card px-4 py-3 text-center font-medium text-foreground transition-colors hover:bg-muted">
                    {l.title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </main>
  )
}
