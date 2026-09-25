import { site } from '@/lib/site'

// Office identity lives in lib/site.ts (one profile per deployment); this only shapes it for the footer.
export const officeInfo = {
  addressLines: site.addressLines,
  phone: site.phone,
  disclaimers: site.phone
    ? [`By calling or texting ${site.phone}, you agree to receive text messages. If you no longer wish to receive text messages, you may opt out at any time by replying "STOP".`]
    : [],
  registrations: site.registrations,
}

export const legalLinks = [
  { label: 'Privacy Policy', href: `${site.legalBaseUrl}/privacy-policy/` },
  { label: 'Terms & Conditions', href: `${site.legalBaseUrl}/terms-conditions/` },
  { label: 'Earnings Disclaimer', href: `${site.legalBaseUrl}/earnings-disclaimer/` },
  { label: 'Affiliate Agreement', href: `${site.legalBaseUrl}/affiliate-agreement/` },
]

export const recognitionBadges = [
  {
    href: 'https://travelfunbiz.com/reviews/',
    src: 'https://travelfunbiz.com/wp-content/uploads/2024/01/300xReviews.jpg',
    alt: 'Google and Facebook Reviews',
  },
  {
    href: 'https://web.bocaratonchamber.com/TRAVEL-AGENCIES/TravelFunbiz-15987',
    src: 'https://travelfunbiz.com/wp-content/uploads/2024/01/300xChamber.png',
    alt: 'Boca Raton Chamber of Commerce',
  },
  {
    href: 'https://www.bbb.org/us/fl/boca-raton/profile/online-travel-agency/travelfun-llc-0633-90563333',
    src: 'https://travelfunbiz.com/wp-content/uploads/2018/10/300x100-bbb_a_rating_logo-2.png',
    alt: 'BBB A+ Rating',
  },
  {
    href: 'https://cruising.org/en/verify-a-travel-agency-member',
    src: 'https://travelfunbiz.com/wp-content/uploads/2024/01/CLIA-o-graph-e1705621125433-300x92.jpg',
    alt: 'CLIA - Cruise Lines International Association',
  },
  {
    href: 'https://www.asta.org/travelerServices/advisor-directory',
    src: 'https://travelfunbiz.com/wp-content/uploads/2024/01/asta-logo-1-e1705621308273-300x122.png',
    alt: 'ASTA - American Society of Travel Advisors',
  },
]

export const socialPromos = [
  {
    href: 'https://www.facebook.com/MostPartiesMostFun',
    src: 'https://travelfunbiz.com/wp-content/uploads/2019/12/best-singles-cruises-11.jpg',
    alt: 'Follow us on Facebook',
  },
  {
    href: 'https://www.instagram.com/solotravelexpert/',
    src: 'https://travelfunbiz.com/wp-content/uploads/2019/12/best-singles-cruises-12.jpg',
    alt: 'Follow us on Instagram',
  },
  {
    href: 'https://bit.ly/SubscribeSoloTravelTV',
    src: 'https://travelfunbiz.com/wp-content/uploads/2021/11/YouTube-Subscribe-300x139-1.jpg',
    alt: 'Subscribe on YouTube',
  },
  {
    href: 'https://www.tiktok.com/@travelfunjoel',
    src: 'https://travelfunbiz.com/wp-content/uploads/2022/01/600x282-tiktok.png',
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
