import { officeInfo, socialPromos } from '@/content/footer'
import { SITE_NAME, absoluteUrl, site } from '@/lib/site'

/** One stable id for the business node. The home page declares it; the WebSite publisher and the guide pages point at it, so Google reads one entity, not three. */
export const ORG_ID = absoluteUrl('/') + '#organization'

const COUNTRY_NAMES: Record<string, string> = { CA: 'Canada', US: 'United States' }

/** The home page's WebSite node (hub WP6): name, address and publisher. No SearchAction, because the site has no search page. */
export function buildWebSiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: absoluteUrl('/'),
    publisher: { '@type': 'Organization', '@id': ORG_ID, name: SITE_NAME, url: absoluteUrl('/'), logo: { '@type': 'ImageObject', url: absoluteUrl('/logo.png') } },
  }
}

/** The home page's Organization / TravelAgency JSON-LD. One builder so the page and the admin NAP check read the same object. */
export function buildOrganizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'TravelAgency',
    '@id': ORG_ID,
    name: SITE_NAME,
    url: absoluteUrl('/'),
    logo: absoluteUrl('/logo.png'),
    ...(officeInfo.phone ? { telephone: officeInfo.phone } : {}),
    // Only facts already on the site: the one number every client and lead call goes to, and the country the site serves.
    // No hours, geo point, price range, rating or review count: none is stored, so none is claimed (see docs/local-seo-checklist.md).
    ...(officeInfo.phone ? { contactPoint: { '@type': 'ContactPoint', contactType: 'customer service', telephone: officeInfo.phone, areaServed: site.country } } : {}),
    areaServed: { '@type': 'Country', name: COUNTRY_NAMES[site.country] ?? site.country },
    address: {
      '@type': 'PostalAddress',
      ...(officeInfo.addressLines[0] ? { streetAddress: officeInfo.addressLines[0] } : {}),
      addressLocality: site.address.locality,
      addressRegion: site.address.region,
      ...(site.address.postalCode ? { postalCode: site.address.postalCode } : {}),
      addressCountry: site.country,
    },
    sameAs: socialPromos.map((s) => s.href),
  }
}
