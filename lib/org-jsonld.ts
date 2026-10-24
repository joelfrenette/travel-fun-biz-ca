import { officeInfo, socialPromos } from '@/content/footer'
import { SITE_NAME, absoluteUrl, site } from '@/lib/site'

/** The home page's WebSite node (hub WP6): name, address and publisher. No SearchAction, because the site has no search page. */
export function buildWebSiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: absoluteUrl('/'),
    publisher: { '@type': 'Organization', name: SITE_NAME, url: absoluteUrl('/'), logo: { '@type': 'ImageObject', url: absoluteUrl('/logo.png') } },
  }
}

/** The home page's Organization / TravelAgency JSON-LD. One builder so the page and the admin NAP check read the same object. */
export function buildOrganizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'TravelAgency',
    name: SITE_NAME,
    url: absoluteUrl('/'),
    logo: absoluteUrl('/logo.png'),
    ...(officeInfo.phone ? { telephone: officeInfo.phone } : {}),
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
