import { load, type CheerioAPI } from 'cheerio'
import type { ScrapedPackage } from '@/types/scrape'

/**
 * Parser for travelfunbiz.com (WordPress + Elementor).
 *
 * Every package on the page follows the same document order:
 *   <a><img></a>  ->  <h2>TITLE</h2>  ->  <p>dates / blurb</p>...  ->  <a>MORE INFO</a>
 *
 * Elementor wraps each of those in its own nested widget/column divs, so
 * DOM-ancestry tricks (walk up N parents, look at siblings) break unpredictably.
 * Document order does not: for each heading, the image is the nearest <img>
 * before it, and the text/CTA are whatever comes after it up to the next heading.
 */

const SKIP_HEADING = /become a travel agent|webinar|training|insurance|allianz|what our guests|must be fun/i
const CTA_TEXT = /more info|request info|book now|view details|learn more/i
const REJECT_IMAGE = /spacer|pixel|blank|logo|icon|avatar|emoji|^data:/i

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
// "Sep 3 – 16, 2026", "Dec 28, 2026 – Jan 4, 2027", "Jul 27, – Aug 3, 2027", "April 16 – 20 , 2027"
const DATE_RANGE = new RegExp(
  `\\b${MONTH}\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\s*,?\\s*[–\\-—]\\s*(?:${MONTH}\\.?\\s+)?(\\d{1,2})\\s*,?\\s*(\\d{4})\\b`,
  'i',
)
const DURATION = /\(?\b(\d{1,2})\s*[- ]?\s*(nights?|days?)\b\)?/i

const MONTH_NUM: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

// Countries plus the regions/cities this site actually sells. Order doesn't matter;
// the earliest mention in the text wins, and the title is checked before the blurb.
const DESTINATIONS = [
  'Amalfi Coast', 'Riviera Maya', 'Montego Bay', 'Bora Bora', 'Swiss Alps', 'Rhine River', 'Danube',
  'French Polynesia', 'Tahiti', 'Moorea', 'Cancun', 'Punta Cana', 'Los Cabos', 'Puerto Vallarta',
  'Sicily', 'Tuscany', 'Santorini', 'Mykonos', 'Bali', 'Phuket', 'Maui', 'Oahu', 'Hawaii', 'Alaska',
  'Caribbean', 'Mediterranean', 'Scandinavia', 'Patagonia', 'Galapagos', 'Machu Picchu', 'Serengeti',
  'Antigua', 'Aruba', 'Australia', 'Austria', 'Bahamas', 'Barbados', 'Belgium', 'Belize', 'Brazil',
  'Cambodia', 'Canada', 'Chile', 'China', 'Colombia', 'Costa Rica', 'Croatia', 'Cuba', 'Czech Republic',
  'Denmark', 'Dominican Republic', 'Ecuador', 'Egypt', 'England', 'Fiji', 'Finland', 'France', 'Germany',
  'Greece', 'Grenada', 'Guatemala', 'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Ireland',
  'Israel', 'Italy', 'Jamaica', 'Japan', 'Jordan', 'Kenya', 'Malaysia', 'Maldives', 'Malta', 'Mexico',
  'Monaco', 'Morocco', 'Nepal', 'Netherlands', 'New Zealand', 'Norway', 'Panama', 'Peru', 'Philippines',
  'Poland', 'Portugal', 'Scotland', 'Singapore', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka',
  'St. Lucia', 'Sweden', 'Switzerland', 'Tanzania', 'Thailand', 'Turkey', 'Turks and Caicos',
  'United Kingdom', 'Vietnam', 'Wales',
]

const CATEGORY_RULES: [RegExp, string][] = [
  [/cruise|yacht|sailing|aboard|celebrity|royal caribbean|norwegian|carnival|windstar|amawaterways|viking|msc\b|princess/i, 'Cruise'],
  [/all-inclusive|resort|beach/i, 'Beach & Resort'],
  [/safari/i, 'Safari'],
  [/wellness|spa\b|yoga|retreat/i, 'Wellness & Spa'],
  [/honeymoon/i, 'Honeymoon'],
  [/family/i, 'Family'],
  [/\bsingles?\b/i, 'Singles'],
  [/luxury/i, 'Luxury'],
  [/tour|featuring|explore|heritage|history/i, 'Cultural'],
]

export function parseTravelFunBiz(html: string, sourceUrl: string): ScrapedPackage[] {
  const $ = load(html)
  const nodes = $('h1, h2, h3, img, p, li, a').toArray()
  const packages: ScrapedPackage[] = []
  const seen = new Set<string>()

  // Any heading bounds a package's image/text search; only <h2> starts one (the site
  // uses h1 for section titles and h3 for sub-blurbs like the insurance promo).
  const isHeading = (i: number) => /^h[1-3]$/i.test(nodes[i].tagName)

  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].tagName !== 'h2') continue
    const name = clean($(nodes[i]).text())
    if (name.length < 8 || name.length > 200 || SKIP_HEADING.test(name)) continue
    if (seen.has(name.toLowerCase())) continue

    // Image: nearest usable <img> before this heading, but not past the previous heading.
    let imageUrl: string | undefined
    for (let j = i - 1; j >= 0 && !isHeading(j); j--) {
      if (nodes[j].tagName === 'img') {
        imageUrl = extractImgSrc($(nodes[j]), sourceUrl)
        if (imageUrl) break
      }
    }

    // Text + CTA: everything after this heading up to the next heading.
    const paragraphs: string[] = []
    let bookingUrl: string | undefined
    for (let j = i + 1; j < nodes.length && !isHeading(j); j++) {
      const el = $(nodes[j])
      const tag = nodes[j].tagName
      if (tag === 'p' || tag === 'li') {
        const t = clean(el.text())
        if (t.length > 3 && !CTA_TEXT.test(t)) paragraphs.push(t)
      } else if (tag === 'a' && !bookingUrl && CTA_TEXT.test(clean(el.text()))) {
        bookingUrl = absolutize(el.attr('href'), sourceUrl)
      }
    }
    // The page has a dozen unrelated headings (reviews, footer); a package must have a CTA.
    if (!bookingUrl) continue

    const blurb = paragraphs.join(' ')
    const dates = parseDateRange(blurb)
    const durationMatch = blurb.match(DURATION)
    const duration = durationMatch ? `${durationMatch[1]} ${durationMatch[2]}` : undefined
    const durationDays = durationMatch
      ? parseInt(durationMatch[1], 10) + (/night/i.test(durationMatch[2]) ? 1 : 0)
      : undefined

    // The blurb usually opens with a dates/duration line ("Sep 4 – 8, 2026 (4-nights) in Montego Bay"),
    // which the card already shows as fields. Strip those, and drop the line entirely when only a
    // short fragment like "in Montego Bay, Jamaica" remains and a real paragraph follows it.
    const stripped = paragraphs.map((p) =>
      clean(p.replace(dates?.raw || '', '').replace(durationMatch?.[0] || '', '').replace(/^[\s,.:;–\-—]+/, '')),
    )
    if (stripped.length > 1 && stripped[0].length < 60) stripped.shift()
    const description = stripped.filter(Boolean).join(' ')

    const price = parsePrice(blurb)

    seen.add(name.toLowerCase())
    packages.push({
      name,
      description: description || undefined,
      destination: findDestination(name, blurb),
      startDate: dates?.start,
      endDate: dates?.end,
      duration,
      durationDays,
      price: price?.display,
      priceValue: price?.value,
      category: CATEGORY_RULES.find(([re]) => re.test(`${name} ${blurb}`))?.[1],
      imageUrl,
      bookingUrl,
      supplier: 'TravelFunBiz',
      sourceUrl,
      highlights: undefined,
    })
  }

  console.log(`[travelfunbiz] ${packages.length} packages, ${packages.filter(p => p.imageUrl).length} with images`)
  return packages
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function absolutize(href: string | undefined, base: string): string | undefined {
  if (!href || href === '#' || href.startsWith('javascript:')) return undefined
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

/** Prefer lazy-load attributes over a placeholder src; reject logos, emoji, and tracking pixels. */
function extractImgSrc(el: ReturnType<CheerioAPI>, base: string): string | undefined {
  const candidates = [
    el.attr('data-src'),
    el.attr('data-lazy-src'),
    el.attr('data-original'),
    (el.attr('data-srcset') || '').split(',')[0]?.trim().split(' ')[0],
    el.attr('src'),
    (el.attr('srcset') || '').split(',')[0]?.trim().split(' ')[0],
  ]
  const src = candidates.find(c => c && !REJECT_IMAGE.test(c))
  if (!src) return undefined

  const width = parseInt(el.attr('width') || '0', 10)
  const height = parseInt(el.attr('height') || '0', 10)
  if ((width > 0 && width < 50) || (height > 0 && height < 50)) return undefined

  return absolutize(src, base)
}

function parseDateRange(text: string): { start: string; end: string; raw: string } | undefined {
  const m = text.match(DATE_RANGE)
  if (!m) return undefined
  const [raw, m1, d1, y1, m2, d2, y2] = m
  const toIso = (month: string, day: string, year: string) =>
    `${year}-${MONTH_NUM[month.slice(0, 3).toLowerCase()]}-${day.padStart(2, '0')}`
  return {
    raw,
    start: toIso(m1, d1, y1 || y2),
    end: toIso(m2 || m1, d2, y2),
  }
}

/** Only accept a real trip price; deposits ("Deposit is only $150pp") are not the price. */
function parsePrice(text: string): { display: string; value: number } | undefined {
  const re = /(from\s*)?\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{2})?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 30), m.index)
    if (/deposit/i.test(before)) continue
    const value = parseInt(m[2].replace(/,/g, ''), 10)
    return { display: `${m[1] ? 'From ' : ''}$${value.toLocaleString('en-US')}`, value }
  }
  return undefined
}

function findDestination(name: string, blurb: string): string | undefined {
  for (const text of [name, blurb]) {
    let best: { index: number; dest: string } | undefined
    for (const dest of DESTINATIONS) {
      const index = text.search(new RegExp(`\\b${dest.replace('.', '\\.')}\\b`, 'i'))
      if (index >= 0 && (!best || index < best.index)) best = { index, dest }
    }
    if (best) return best.dest
  }
  return undefined
}
