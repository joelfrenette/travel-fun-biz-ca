// 301s from the old WordPress travelfunbiz.com URL structure to this app's paths, so search
// rankings carry over when the new .com replica goes live. Only wired in on the US deployment
// (see next.config.js) — it never runs on travelfunbiz.ca.
//
// Built 2026-09-27 from the real live sitemaps (page-sitemap.xml + post-sitemap.xml, 84 URLs
// after de-duping the homepage). Only an exact match against a REAL current package destination
// (checked against lib/destinations.ts) gets a specific /destinations/[slug] target - everything
// else without a true equivalent on this codebase today lands on / (old "pages") or /blog (old
// "posts") rather than a guessed match. /privacy, /terms and /about don't exist as routes in this
// codebase yet either - building them is its own task (see the setup checklist, Part 6, on the
// legal wording that blocks it), but the redirect targets are ready for when they do.
// Nothing here touches the live .com site: it is data read by this repo's own next.config.js,
// and only takes effect on a deployment that sets NEXT_PUBLIC_SITE_ID=us.
import legacyRedirects from '@/data/legacy-com-redirects.json'

export interface LegacyRedirect {
  source: string
  destination: string
  permanent: boolean
}

export function getLegacyRedirects(): LegacyRedirect[] {
  return legacyRedirects as LegacyRedirect[]
}
