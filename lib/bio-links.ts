import { socialLink, slugifyUtm, type SocialSurface } from '@/lib/utm'
import { absoluteUrl } from '@/lib/site'

// The "link in bio" landing page (/links): one short address to say out loud or put in a profile, listing the newest
// guides, trips and posts. Every link carries UTM tags (source = the network the visitor came from, campaign =
// "<network>_bio", content = "bio-<kind>-<slug>") so a lead can be credited to the exact bio link. Pure functions here;
// app/links/page.tsx does the reads and the markup.

export const BIO_SOURCES = ['instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'threads', 'x', 'pinterest', 'bluesky'] as const
export type BioSource = (typeof BIO_SOURCES)[number]

/** The network named in `?src=` when it is one we know, else Instagram (the default bio link). Never echoes arbitrary text into a URL. */
export function bioSource(raw: string | string[] | null | undefined): BioSource {
  const v = (Array.isArray(raw) ? raw[0] : raw ?? '').trim().toLowerCase()
  return (BIO_SOURCES as readonly string[]).includes(v) ? (v as BioSource) : 'instagram'
}

export interface BioLink {
  kind: 'guide' | 'trip' | 'post'
  title: string
  href: string
}

export interface BioInput {
  guides: Array<{ path: string; slug: string; name: string }>
  trips: Array<{ slug?: string; name: string }>
  posts: Array<{ slug: string; title: string }>
}

const surfaceOf: Record<BioLink['kind'], SocialSurface> = { guide: 'guide', trip: 'trip', post: 'post' }

/** One tagged link to a page on this site. */
export function bioHref(path: string, source: BioSource, kind: BioLink['kind'], slug: string): string {
  return socialLink(absoluteUrl(path), source, `${source}_bio`, 'bio', `${surfaceOf[kind]}-${slugifyUtm(slug)}`)
}

/** Newest first within each kind, at most `limit` per kind, every link tagged. Items with no slug or no title are left out. */
export function buildBioLinks(input: BioInput, source: BioSource, limit = 6): Record<BioLink['kind'], BioLink[]> {
  const take = <T,>(rows: T[]) => rows.slice(0, limit)
  return {
    guide: take(input.guides.filter((g) => g.slug && g.name)).map((g) => ({ kind: 'guide' as const, title: g.name, href: bioHref(g.path, source, 'guide', g.slug) })),
    trip: take(input.trips.filter((t) => t.slug && t.name)).map((t) => ({ kind: 'trip' as const, title: t.name, href: bioHref(`/packages/${t.slug}`, source, 'trip', t.slug as string) })),
    post: take(input.posts.filter((p) => p.slug && p.title)).map((p) => ({ kind: 'post' as const, title: p.title, href: bioHref(`/blog/${p.slug}`, source, 'post', p.slug) })),
  }
}
