export interface NavLink {
  label: string
  href: string
  external?: boolean
  /** A grouped item: the header shows these in a drop-down (and as an indented list in the phone menu). */
  children?: NavLink[]
  /** Less important items: shown inline only on wide desktops, and under one "More" drop-down on narrower ones. */
  secondary?: boolean
}

/** Splits the top-level items into the ones always shown inline and the ones that go under "More" on narrower
 * desktops. Pure; order is kept; nothing is dropped. */
export function splitPrimaryNav(links: NavLink[]): { always: NavLink[]; more: NavLink[] } {
  return { always: links.filter((l) => !l.secondary), more: links.filter((l) => l.secondary) }
}

export const MORE_LABEL = 'More'

/** The index pages of the guide kinds (growth loop WP16). The header's "Cruises & Resorts" group and the footer's
 * "Explore" block both read this list, so a page is added in one place. An index page with nothing published says
 * so plainly and stays out of search until it has something to list (components/guide-index-page.tsx). */
export const cruiseAndResortLinks: NavLink[] = [
  { label: 'Cruise Lines', href: '/cruise-lines' },
  { label: 'Ships', href: '/ships' },
  { label: 'River Cruises', href: '/river-cruises' },
  { label: 'Yachts', href: '/yachts' },
  { label: 'Resorts', href: '/resorts' },
  { label: 'Hotels', href: '/hotels' },
]

export const destinationsLink: NavLink = { label: 'Destinations', href: '/destinations' }

export const primaryNavLinks: NavLink[] = [
  { label: 'All Trips', href: '/packages' },
  destinationsLink,
  { label: 'Cruises & Resorts', href: '/cruise-lines', children: cruiseAndResortLinks },
  { label: 'Blog', href: '/blog' },
  { label: 'Travel Agents', href: 'https://members.travelfunbiz.com', external: true, secondary: true },
  { label: 'In The News', href: 'https://travelfunbiz.com/in-the-news/', external: true, secondary: true },
  { label: 'About Us', href: 'https://travelfunbiz.com/about-us/', external: true, secondary: true },
  { label: 'Contact Us', href: '/#contact', secondary: true },
  { label: 'Booking', href: 'https://bookings.travelfunbiz.com/', external: true, secondary: true },
]

export const ctaLink: NavLink = { label: 'Get Started', href: '/#contact' }
