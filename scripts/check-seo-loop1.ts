// Offline check for the SEO loop 1 helpers: from-city pages, "from Canada" titles, hreflang, llms-full.txt. No network.
// Run: pnpm dlx tsx scripts/check-seo-loop1.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FROM_CITIES, INDEXABLE_FROM_SLUGS, fromCityBySlug, fromDescription, fromFaq, fromHeading, fromLlmsLinks, fromPath, fromTitle, isFromPageIndexable, upcomingTrips } from '../lib/from-cities'
import { insertFromCanada, tripHeading, tripTitle, wantsFromCanada } from '../lib/package-seo'
import { buildHreflang, hreflangAlternates, pageAlternates } from '../lib/site'
import { buildLlmsFull, safeParagraph, type FullGuideRow } from '../lib/llms-full'
import { buildLlmsTxt } from '../lib/llms-txt'

let failures = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
  if (!ok) failures++
}
const PRICEY = /[$€£]|\bCAD\b|\bUSD\b|\bfrom \d|\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/i
const DASH = /[–—]/

// 1. City config
const wanted = ['toronto', 'vancouver', 'calgary', 'montreal', 'ottawa', 'edmonton', 'winnipeg', 'halifax']
check('all eight cities are configured', wanted.every((s) => fromCityBySlug(s)), FROM_CITIES.map((c) => c.slug))
check('slugs are unique and url-safe', new Set(FROM_CITIES.map((c) => c.slug)).size === FROM_CITIES.length && FROM_CITIES.every((c) => /^[a-z-]+$/.test(c.slug)))
check('every city has a 3-letter airport code', FROM_CITIES.every((c) => /^Y[A-Z]{2}$/.test(c.airportCode)))
check('unknown city is null', fromCityBySlug('paris') === null)
const t = FROM_CITIES[0]
check('title names the city', fromTitle(t, 'TravelFunBiz.ca') === 'Group Tours and Cruises from Toronto | TravelFunBiz.ca')
check('H1 names the city', fromHeading(t) === 'Group tours and cruises from Toronto')
check('path is /from/<slug>', fromPath(t) === '/from/toronto')

// 2. Trips: upcoming only, dated first, never invented
const rows = [
  { name: 'Past', slug: 'past', available_from: '2020-01-01', available_to: '2020-01-10', recap_mode: null },
  { name: 'Later', slug: 'later', available_from: '2099-05-01', available_to: '2099-05-10', recap_mode: null },
  { name: 'Undated', slug: 'undated', available_from: null, available_to: null, recap_mode: null },
  { name: 'Sooner', slug: 'sooner', available_from: '2098-01-01', available_to: '2098-01-09', recap_mode: null },
]
const up = upcomingTrips(rows, '2026-10-22')
check('past trips are left out', !up.some((r) => r.slug === 'past'))
check('soonest first, undated last', up.map((r) => r.slug).join() === 'sooner,later,undated', up.map((r) => r.slug))
check('no trips means noindex', !isFromPageIndexable(0) && isFromPageIndexable(1))

// 3. Copy has no prices, dates or long dashes
const faq = fromFaq(t, up, '(833) 878-5386')
const copy = [fromTitle(t, 'X'), fromHeading(t), fromDescription(t, 3), fromDescription(t, 0), ...faq.flatMap((f) => [f.q, f.a])].join(' ')
check('city copy has no price words or currency', !/[$€£]|\bCAD\b|\bUSD\b/.test(copy), copy)
check('city copy has no long dashes', !DASH.test(copy))
check('faq answers send people to us for prices', faq.some((f) => /contact form/.test(f.a)))
check('faq is generic: no flight times or fares', !/\b(nonstop|direct flight|hours?|fare)\b/i.test(copy))
check('zero-trip faq still valid', fromFaq(t, [], '').length >= 2)
check('llms links are one per indexable city', fromLlmsLinks().length === INDEXABLE_FROM_SLUGS.length && fromLlmsLinks().every((l) => l.path.startsWith('/from/')))
check('only Toronto is indexable until cities get their own facts', INDEXABLE_FROM_SLUGS.join(',') === 'toronto' && !isFromPageIndexable(3, 'calgary') && isFromPageIndexable(3, 'toronto'))

// 4. "from Canada" titles
const anz = { name: 'Australia and New Zealand Tour', short_description: 'Sydney to Queenstown.', full_description: null, meta_title: null }
check('ANZ trip gets from Canada in H1', tripHeading(anz, false) === 'Australia and New Zealand Tour from Canada')
check('ANZ with & also matches', wantsFromCanada({ name: 'Australia & New Zealand Cruise' }))
check('past ANZ trip keeps its name', tripHeading(anz, true) === anz.name)
check('other trips are untouched', tripHeading({ name: 'Greek Islands Cruise' }, false) === 'Greek Islands Cruise')
check('already from Canada is left alone', tripHeading({ name: 'Australia and New Zealand from Canada' }, false) === 'Australia and New Zealand from Canada')
check('own data says another origin: skipped', !wantsFromCanada({ name: 'Australia and New Zealand Tour', short_description: 'Departs from the US with a host.' }))
check('trailing year stays last', insertFromCanada('Australia and New Zealand Cruise 2027') === 'Australia and New Zealand Cruise from Canada 2027')
check('title: name inside a meta title gets it', tripTitle(anz, 'Australia and New Zealand Tour | Sydney | TravelFunBiz.ca', false) === 'Australia and New Zealand Tour from Canada | Sydney | TravelFunBiz.ca')
check('title: meta title without the name is not rewritten', tripTitle(anz, 'Best Down Under Trip | TravelFunBiz.ca', false) === 'Best Down Under Trip | TravelFunBiz.ca')
check('title: no double from Canada', !/from Canada.*from Canada/i.test(tripTitle(anz, tripTitle(anz, 'Australia and New Zealand Tour', false), false)))

// 5. hreflang
const base = { origin: 'https://www.example.ca', here: 'en-CA', siblingOrigin: 'https://example.com', siblingLocale: 'en-US' }
const off = buildHreflang('/packages/x', { ...base, siblingEnabled: false })
check('hreflang self + x-default, no sibling when off', off['en-CA'] === 'https://www.example.ca/packages/x' && off['x-default'] === off['en-CA'] && !('en-US' in off), off)
const on = buildHreflang('packages/x', { ...base, siblingEnabled: true })
check('flag on: en-US points at the sibling, same path', on['en-US'] === 'https://example.com/packages/x', on)
check('flag on but no sibling url: nothing added', !('en-US' in buildHreflang('/', { ...base, siblingOrigin: null, siblingEnabled: true })))
const live = hreflangAlternates('/')
check('live config: en-CA and x-default, sibling off today', 'en-CA' in live && 'x-default' in live && !('en-US' in live), live)
check('pageAlternates gives canonical + languages', pageAlternates('/from/toronto').canonical.endsWith('/from/toronto') && 'x-default' in pageAlternates('/from/toronto').languages)

// 6. llms-full: no prices, no thin pages
const g = (o: Partial<FullGuideRow>): FullGuideRow => ({ kind: 'destinations', slug: 's', name: 'N', parent_slug: null, meta_description: null, summary: null, quality_notes: null, ...o })
const full = buildLlmsFull([
  g({ slug: 'italy', name: 'Italy', meta_description: 'Rome, Florence and Venice in one trip. Prices from $2,999 per person. Call 833-878-5386 to book.' }),
  g({ slug: 'thin', name: 'Thin Place', meta_description: 'A thin page.', quality_notes: 'safe-page: built only from stored facts and general planning text; a later enrichment can improve it' }),
  g({ kind: 'hotels', slug: 'h1', name: 'Hotel Roma', parent_slug: 'italy', meta_description: 'A hotel near the station — see www.example.com for more.' }),
])
check('llms-full lists a normal guide', full.includes('### Italy') && full.includes('/destinations/italy'))
check('llms-full skips thin safe-page guides', !full.includes('Thin Place'))
check('llms-full names the parent', full.includes('Part of: Italy'))
check('llms-full has no prices, phones or web addresses', !PRICEY.test(full) && !/https?:\/\/(?!www\.travelfunbiz)/.test(full) && !/example\.com/.test(full), full)
check('llms-full keeps the safe sentence', full.includes('Rome, Florence and Venice in one trip.'))
check('llms-full has no long dashes', !DASH.test(full))
check('safeParagraph of only unsafe text is empty', safeParagraph('Only $99 today.') === '')
check('llms.txt points at llms-full and lists city pages when given', (() => {
  const txt = buildLlmsTxt({ destinations: [], trips: [], guides: [], posts: [], fromCities: fromLlmsLinks() })
  return txt.includes('/llms-full.txt') && txt.includes('/from/toronto')
})())

// 7. Wiring
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
check('sitemap lists city pages', /fromCityPages/.test(read('app/sitemap.ts')))
check('footer links the city pages', /FROM_CITIES/.test(read('components/footer.tsx')))
check('home page links the city pages', /FROM_CITIES/.test(read('app/page.tsx')))
check('city page is noindex without trips', /isFromPageIndexable/.test(read('app/from/[city]/page.tsx')))
check('llms-full route exists and is cached', /revalidate = 3600/.test(read('app/llms-full.txt/route.ts')))
check('package page uses the from-Canada helpers', /tripHeading/.test(read('app/packages/[slug]/page.tsx')) && /tripTitle/.test(read('app/packages/[slug]/page.tsx')))

process.exit(failures === 0 ? 0 : 1)
