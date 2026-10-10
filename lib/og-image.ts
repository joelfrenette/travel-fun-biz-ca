// Resolves a share-image path (growth loop WP6) to what the picture shows: a title, a kind label and
// an optional background photo. Public reads only (anon client, RLS lets published rows through), so a
// draft or unpublished page can never get a picture. No AI, no writes. The route that draws it is
// app/og/[...path]/route.tsx; the pure parsing and wrapping helpers are in lib/og-path.ts.
import { getPublishedPostBySlug } from '@/lib/posts'
import { getPublishedPackageBySlug } from '@/lib/packages'
import { getPublishedGuide, isGuideKind, guideKinds } from '@/lib/guides'
import { getDestinationPage } from '@/lib/destinations'
import { getComparePage } from '@/lib/compare-destinations'
import { getBestTimeToVisitPage } from '@/lib/best-time-to-visit'
import { SITE_NAME } from '@/lib/site'
import { cleanTitle, isAllowedPhotoUrl, parseOgPath, type OgTarget } from '@/lib/og-path'

export * from '@/lib/og-path'

export interface OgContent {
  title: string
  kindLabel: string
  /** An https URL on an allowed host, or null (the renderer then draws the brand background). */
  photoUrl: string | null
}

function firstPhoto(...urls: (string | null | undefined)[]): string | null {
  for (const u of urls) {
    const v = u?.trim()
    if (v && isAllowedPhotoUrl(v)) return v
  }
  return null
}

/** What to draw for a parsed target, or null when no published page exists for it. */
export async function resolveOgTarget(target: OgTarget): Promise<OgContent | null> {
  const { prefix, slug } = target

  if (prefix === 'blog') {
    const post = await getPublishedPostBySlug(slug)
    if (!post) return null
    return { title: cleanTitle(post.og_title || post.title, SITE_NAME), kindLabel: 'Blog', photoUrl: firstPhoto(post.cover_image_url) }
  }

  if (prefix === 'packages') {
    const pkg = await getPublishedPackageBySlug(slug)
    if (!pkg) return null
    return { title: cleanTitle(pkg.name, SITE_NAME), kindLabel: 'Trip', photoUrl: firstPhoto(pkg.og_image_url, pkg.image_url) }
  }

  if (prefix === 'compare') {
    const page = await getComparePage(slug)
    if (!page) return null
    const photo = firstPhoto(...page.a.packages.map((p) => p.image_url), ...page.b.packages.map((p) => p.image_url))
    return { title: `${page.a.destination} vs ${page.b.destination}`, kindLabel: 'Compare', photoUrl: photo }
  }

  if (prefix === 'best-time-to-visit') {
    const page = await getBestTimeToVisitPage(slug)
    if (!page) return null
    return { title: `Best time to visit ${page.destination}`, kindLabel: 'Best time', photoUrl: firstPhoto(...page.packages.map((p) => p.image_url)) }
  }

  if (isGuideKind(prefix)) {
    const guide = await getPublishedGuide(prefix, slug)
    if (guide) {
      return {
        title: cleanTitle(guide.og_title || guide.name, SITE_NAME),
        kindLabel: `${guideKinds[prefix].label} guide`,
        photoUrl: firstPhoto(guide.hero_image_url),
      }
    }
    // A destination page exists without a guide: it is the trip listing for that place.
    if (prefix === 'destinations') {
      const page = await getDestinationPage(slug)
      if (!page) return null
      return {
        title: `${page.destination} trips`,
        kindLabel: 'Destination',
        photoUrl: firstPhoto(...page.upcoming.map((p) => p.image), ...page.recaps.map((p) => p.image_url)),
      }
    }
    return null
  }

  return null
}

/** Segments from the URL -> content, or null for an invalid path or an unpublished page (both are a 404). */
export async function resolveOgPath(segments: readonly string[] | undefined | null): Promise<OgContent | null> {
  const target = parseOgPath(segments)
  if (!target) return null
  return resolveOgTarget(target)
}
