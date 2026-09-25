// 301s from the old WordPress travelfunbiz.com URL structure to this app's paths, so search
// rankings carry over when the new .com replica goes live. Only wired in on the US deployment
// (see next.config.js) — it never runs on travelfunbiz.ca.
//
// EMPTY BY DESIGN: this sandbox cannot reach the live travelfunbiz.com (egress-blocked), so the
// list below has not been built from the real sitemap yet. To fill it in, either:
//   1. Export the sitemap from travelfunbiz.com (Yoast SEO > XML Sitemaps, or /sitemap_index.xml)
//      and hand the URL list to Claude, or
//   2. Allow this environment to reach travelfunbiz.com and ask Claude to build the map.
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
