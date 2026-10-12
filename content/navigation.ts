export interface NavLink {
  label: string
  href: string
  external?: boolean
  /** A grouped item: the header shows these in a drop-down (and as an indented list in the phone menu). */
  children?: NavLink[]
}

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
  { label: 'Travel Agents', href: 'https://members.travelfunbiz.com', external: true },
  { label: 'In The News', href: 'https://travelfunbiz.com/in-the-news/', external: true },
  { label: 'About Us', href: 'https://travelfunbiz.com/about-us/', external: true },
  { label: 'Contact Us', href: '/#contact' },
  { label: 'Booking', href: 'https://bookings.travelfunbiz.com/', external: true },
]

export const ctaLink: NavLink = { label: 'Get Started', href: '/#contact' }
