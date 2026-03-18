export interface NavLink {
  label: string
  href: string
  external?: boolean
}

export const primaryNavLinks: NavLink[] = [
  { label: 'Travel Agents', href: 'https://members.travelfunbiz.com', external: true },
  { label: 'In The News', href: 'https://travelfunbiz.com/in-the-news/', external: true },
  { label: 'About Us', href: 'https://travelfunbiz.com/about-us/', external: true },
  { label: 'Contact Us', href: '/#contact' },
  { label: 'Booking', href: 'https://bookings.travelfunbiz.com/', external: true },
]

export const ctaLink: NavLink = { label: 'Get Started', href: '/#contact' }
