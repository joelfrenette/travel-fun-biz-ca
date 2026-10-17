import { site } from '@/lib/site'

/** The SMS consent sentence as a stable translation key. The phone number is NOT in the key: it is the {phone}
 * placeholder, substituted at render (components/footer.tsx), so the en/fr/es strings in lib/i18n.ts never drift when
 * the number changes. */
export const SMS_CONSENT_KEY = 'By calling or texting {phone}, you agree to receive text messages. If you no longer wish to receive text messages, you may opt out at any time by replying "STOP".'

// Office identity lives in lib/site.ts (one profile per deployment); this only shapes it for the footer.
export const officeInfo = {
  addressLines: site.addressLines,
  phone: site.phone,
  disclaimers: site.phone
    ? [SMS_CONSENT_KEY]
    : [],
  registrations: site.registrations,
}

export const aboutLinks = [
  { label: 'Who We Are', href: '/who-we-are' },
]

export const legalLinks = [
  { label: 'Privacy Policy', href: `${site.legalBaseUrl}/privacy-policy/` },
  { label: 'Terms & Conditions', href: `${site.legalBaseUrl}/terms-conditions/` },
  { label: 'Earnings Disclaimer', href: `${site.legalBaseUrl}/earnings-disclaimer/` },
  { label: 'Affiliate Agreement', href: `${site.legalBaseUrl}/affiliate-agreement/` },
]

// Pictures are copied into public/assets/footer so the footer does not depend on travelfunbiz.com.
// The original URL of each is kept in a comment above its entry as provenance.
export const recognitionBadges = [
  {
    href: 'https://travelfunbiz.com/reviews/',
    // https://travelfunbiz.com/wp-content/uploads/2024/01/300xReviews.jpg
    src: '/assets/footer/reviews.jpg',
    alt: 'Google and Facebook Reviews',
  },
  {
    href: 'https://web.bocaratonchamber.com/TRAVEL-AGENCIES/TravelFunbiz-15987',
    // https://travelfunbiz.com/wp-content/uploads/2024/01/300xChamber.png
    src: '/assets/footer/boca-chamber.png',
    alt: 'Boca Raton Chamber of Commerce',
  },
  {
    href: 'https://www.bbb.org/us/fl/boca-raton/profile/online-travel-agency/travelfun-llc-0633-90563333',
    // https://travelfunbiz.com/wp-content/uploads/2018/10/300x100-bbb_a_rating_logo-2.png
    src: '/assets/footer/bbb.png',
    alt: 'BBB A+ Rating',
  },
  {
    href: 'https://cruising.org/en/verify-a-travel-agency-member',
    // https://travelfunbiz.com/wp-content/uploads/2024/01/CLIA-o-graph-e1705621125433-300x92.jpg
    src: '/assets/footer/clia.jpg',
    alt: 'CLIA - Cruise Lines International Association',
  },
  {
    href: 'https://www.asta.org/travelerServices/advisor-directory',
    // https://travelfunbiz.com/wp-content/uploads/2024/01/asta-logo-1-e1705621308273-300x122.png
    src: '/assets/footer/asta.png',
    alt: 'ASTA - American Society of Travel Advisors',
  },
  {
    href: 'https://www.iata.org/',
    // https://travelfunbiz.com/wp-content/uploads/2025/10/logo-IATAN.png
    src: '/assets/footer/iata.png',
    alt: 'IATAN - International Airlines Travel Agent Network',
  },
]

export const socialPromos = [
  {
    href: 'https://www.facebook.com/MostPartiesMostFun',
    // https://travelfunbiz.com/wp-content/uploads/2019/12/best-singles-cruises-11.jpg
    src: '/assets/footer/facebook.jpg',
    alt: 'Follow us on Facebook',
  },
  {
    href: 'https://www.instagram.com/solotravelexpert/',
    // https://travelfunbiz.com/wp-content/uploads/2019/12/best-singles-cruises-12.jpg
    src: '/assets/footer/instagram.jpg',
    alt: 'Follow us on Instagram',
  },
  {
    href: 'https://bit.ly/SubscribeSoloTravelTV',
    // https://travelfunbiz.com/wp-content/uploads/2021/11/YouTube-Subscribe-300x139-1.jpg
    src: '/assets/footer/youtube.jpg',
    alt: 'Subscribe on YouTube',
  },
  {
    href: 'https://www.tiktok.com/@travelfunjoel',
    // https://travelfunbiz.com/wp-content/uploads/2022/01/600x282-tiktok.png
    src: '/assets/footer/tiktok.png',
    alt: 'Follow us on TikTok',
  },
]

export const newsletterDealOptions = [
  'All-Inclusive Resorts',
  'Cruises',
  'European Tours',
  'Adventure Travel',
  'Luxury Escapes',
]
