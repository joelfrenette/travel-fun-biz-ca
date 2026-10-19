import { articleHtml, renderMarkdown } from '@/lib/markdown'
import { quickFacts, MAX_LEFT_FACTS } from '@/lib/guide-header'
import { isPastTrip, hasRecap } from '@/lib/past-trip'
import { translate } from '@/lib/i18n'
import { splitPathLinks } from '@/lib/path-links'
import { HERO_DESCRIPTION, FEATURES_SUBTITLE, CONTACT_BLURB } from '@/content/home-copy'
import { featureItems } from '@/content/features'
import { WHO_WE_ARE_INTRO, WHO_WE_ARE_SECTIONS, WHO_WE_ARE_CLOSING } from '@/content/who-we-are'
import type { Language } from '@/lib/preferences'
import { compileRules, linkKeywords, linkTextParts, newLinkerState, type AffiliateRule, type LinkedItem, type PageContext, type Part } from '@/lib/affiliate-linker'

// WP23: THE list of every piece of public text the word linker looks at. Three things read this one file, so they cannot
// disagree about what "all the text on the site" means:
//   1. the public pages (they build their fields with the builders below and link them with linkPageFields),
//   2. the admin Preview ("where would this phrase link?"), and
//   3. the usage report and Rescan (lib/affiliate-usage.ts).
// A page lists its fields IN THE ORDER A VISITOR READS THEM. The links on a page are counted across all of its fields in
// that order (3 per phrase, 6 per page, one 50 ms time budget, one disclosure line), so the first places win.
//
// Text that is deliberately NOT linked is listed in EXCLUDED_TEXT with the reason. Pure: no database, no network, no React.

export type PageType = 'blog' | 'guide' | 'destination' | 'destination-trips' | 'trip' | 'best-time' | 'compare' | 'home' | 'who-we-are' | 'blog-index' | 'guide-index'

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  blog: 'Blog posts',
  guide: 'Guides',
  destination: 'Destination guides',
  'destination-trips': 'Destination pages without a guide',
  trip: 'Trip pages',
  'best-time': 'Best-time pages',
  compare: 'Compare pages',
  home: 'Home page',
  'who-we-are': 'Who we are page',
  'blog-index': 'Blog index',
  'guide-index': 'Guide index pages',
}

/** html: the field is HTML (already rendered from markdown where it is stored as markdown). text: plain text.
 * linkified: plain text that may hold [words](/path) links to pages of this site. */
export type FieldFormat = 'html' | 'text' | 'linkified'

export interface RendererRef {
  file: string
  /** links: the file builds the fields and calls linkPageFields. shows: the file only displays what it is given
   * (AffiliateParts, AffiliateLinkified or html from linkPageFields). */
  role: 'links' | 'shows'
}

export interface SourceField {
  /** Stable name, for example "trip.description". */
  key: string
  pageType: PageType
  /** Plain-English name of the place, for the admin ("description"). */
  label: string
  context: PageContext
  format: FieldFormat
  /** How it is stored: markdown, plain text, ... */
  stored: string
  /** Where it is read from. */
  loadedFrom: string
  renderers: RendererRef[]
  /** Always false for a linkable field: text inside an anchor or a heading is listed in EXCLUDED_TEXT instead. */
  insideAnchorOrHeading: false
}

const R = (file: string, role: RendererRef['role'] = 'links'): RendererRef => ({ file, role })
const BLOG_PAGE = 'app/blog/[slug]/page.tsx'
const GUIDE_PAGE = 'components/guide-page.tsx'
const GUIDE_PARTS = 'components/guide-parts.tsx'
const DEST_PAGE = 'app/destinations/[slug]/page.tsx'
const HEADER_ACTIONS = 'components/guide-header-actions.tsx'
const HEADER_FEATURE = 'components/guide-header-feature.tsx'
const TRIP_PAGE = 'app/packages/[slug]/page.tsx'
const TRIP_JOURNAL = 'components/trip-journal.tsx'
const BEST_TIME_PAGE = 'app/best-time-to-visit/[destination]/page.tsx'
const COMPARE_PAGE = 'app/compare/[pair]/page.tsx'
const PAGE_COPY = 'components/page-copy-parts.tsx'

function field(key: string, pageType: PageType, label: string, context: PageContext, format: FieldFormat, stored: string, loadedFrom: string, renderers: RendererRef[]): SourceField {
  return { key, pageType, label, context, format, stored, loadedFrom, renderers, insideAnchorOrHeading: false }
}

function guideFields(prefix: 'guide' | 'destination', pageType: PageType, context: PageContext, renderers: RendererRef[]): SourceField[] {
  const headerRenderers = [...renderers, R(HEADER_ACTIONS, 'shows'), R(HEADER_FEATURE, 'shows')]
  const from = 'guides'
  return [
    field(`${prefix}.summary`, pageType, 'summary under the title', context, 'text', 'plain text', `${from}.summary`, renderers),
    field(`${prefix}.quick-facts`, pageType, 'quick facts', context, 'text', 'plain text (first sentence of each key takeaway)', `${from}.key_takeaways`, headerRenderers),
    field(`${prefix}.takeaways`, pageType, 'key takeaways', context, 'text', 'plain text', `${from}.key_takeaways`, renderers),
    field(`${prefix}.body`, pageType, 'article', context, 'html', 'markdown', `${from}.body`, renderers),
    field(`${prefix}.faq`, pageType, 'FAQ answers', context, 'text', 'plain text', `${from}.faq[].a`, renderers),
  ]
}

const GUIDE_RENDERERS = [R(GUIDE_PAGE), R(GUIDE_PARTS, 'shows')]
const DEST_RENDERERS = [R(DEST_PAGE), R(GUIDE_PARTS, 'shows')]

/** Every linkable text field of the public site, grouped by page type, each group in reading order. */
export const SOURCE_FIELDS: SourceField[] = [
  field('blog.takeaways', 'blog', 'key takeaways', 'blog', 'text', 'plain text', 'posts.key_takeaways', [R(BLOG_PAGE)]),
  field('blog.body', 'blog', 'article', 'blog', 'html', 'markdown', 'posts.body', [R(BLOG_PAGE)]),
  field('blog.faq', 'blog', 'FAQ answers', 'blog', 'text', 'plain text', 'posts.faq[].a', [R(BLOG_PAGE)]),
  field('blog.more-stories', 'blog', 'excerpts under "More stories"', 'blog', 'text', 'plain text', 'posts.meta_description of the related posts', [R(BLOG_PAGE)]),

  ...guideFields('guide', 'guide', 'guides', GUIDE_RENDERERS),
  ...guideFields('destination', 'destination', 'destinations', DEST_RENDERERS),
  field('destination-trips.blurb', 'destination-trips', 'intro blurb', 'destinations', 'text', 'plain text', 'destination_blurbs.blurb', [R(DEST_PAGE)]),

  field('trip.recap', 'trip', 'recap ("How the trip went")', 'trips', 'text', 'plain text', 'travel_packages.recap_summary', [R(TRIP_PAGE)]),
  field('trip.recap-highlights', 'trip', 'recap highlights', 'trips', 'text', 'plain text', 'travel_packages.recap_highlights', [R(TRIP_PAGE)]),
  field('trip.journal', 'trip', 'trip journal entries', 'trips', 'text', 'plain text', 'travel_packages.journal_entries[].body', [R(TRIP_PAGE), R(TRIP_JOURNAL, 'shows')]),
  field('trip.description', 'trip', 'description (full, else short)', 'trips', 'linkified', 'plain text with [words](/path) links', 'travel_packages.full_description, else short_description', [R(TRIP_PAGE)]),
  field('trip.highlights', 'trip', 'highlights', 'trips', 'text', 'plain text', 'travel_packages.highlights', [R(TRIP_PAGE)]),
  field('trip.itinerary', 'trip', 'itinerary day text', 'trips', 'text', 'plain text', 'travel_packages.itinerary[].description', [R(TRIP_PAGE)]),
  field('trip.included', 'trip', 'what is included', 'trips', 'text', 'plain text', 'travel_packages.price_includes', [R(TRIP_PAGE)]),
  field('trip.not-included', 'trip', 'what is not included', 'trips', 'text', 'plain text', 'travel_packages.not_included', [R(TRIP_PAGE)]),
  field('trip.faq', 'trip', 'FAQ answers', 'trips', 'text', 'plain text', 'travel_packages.ai_faqs[].answer', [R(TRIP_PAGE)]),

  field('best-time.intro', 'best-time', 'intro', 'pages', 'html', 'markdown', 'page_copy.intro', [R(BEST_TIME_PAGE), R(PAGE_COPY, 'shows')]),
  field('best-time.takeaways', 'best-time', 'key takeaways', 'pages', 'text', 'plain text', 'page_copy.key_takeaways', [R(BEST_TIME_PAGE), R(PAGE_COPY, 'shows')]),
  field('best-time.faq', 'best-time', 'FAQ answers', 'pages', 'text', 'plain text', 'page_copy.faq[].a', [R(BEST_TIME_PAGE), R(PAGE_COPY, 'shows')]),
  field('compare.intro', 'compare', 'intro', 'pages', 'html', 'markdown', 'page_copy.intro', [R(COMPARE_PAGE), R(PAGE_COPY, 'shows')]),
  field('compare.takeaways', 'compare', 'key takeaways', 'pages', 'text', 'plain text', 'page_copy.key_takeaways', [R(COMPARE_PAGE), R(PAGE_COPY, 'shows')]),
  field('compare.faq', 'compare', 'FAQ answers', 'pages', 'text', 'plain text', 'page_copy.faq[].a', [R(COMPARE_PAGE), R(PAGE_COPY, 'shows')]),

  field('home.hero', 'home', 'sentence under the big title', 'pages', 'text', 'plain text (translated)', 'content/home-copy.ts', [R('app/page.tsx'), R('components/hero-section.tsx', 'shows')]),
  field('home.features-intro', 'home', '"Why choose us" paragraph', 'pages', 'text', 'plain text (translated)', 'content/home-copy.ts', [R('app/page.tsx'), R('components/features-section.tsx', 'shows')]),
  field('home.features', 'home', 'the four benefit blurbs', 'pages', 'text', 'plain text (translated)', 'content/features.ts', [R('app/page.tsx'), R('components/features-section.tsx', 'shows')]),
  field('home.contact', 'home', 'sentence above the contact form', 'pages', 'text', 'plain text (translated)', 'content/home-copy.ts', [R('app/page.tsx')]),

  field('who-we-are.intro', 'who-we-are', 'sentence under the title', 'pages', 'text', 'plain text', 'content/who-we-are.ts', [R('app/who-we-are/page.tsx')]),
  field('who-we-are.sections', 'who-we-are', 'the three sections', 'pages', 'text', 'plain text', 'content/who-we-are.ts', [R('app/who-we-are/page.tsx')]),
  field('who-we-are.closing', 'who-we-are', 'closing sentence', 'pages', 'text', 'plain text', 'content/who-we-are.ts', [R('app/who-we-are/page.tsx')]),

  field('blog-index.intro', 'blog-index', 'sentence under the title', 'pages', 'text', 'plain text', 'app/blog/page.tsx', [R('app/blog/page.tsx')]),
  field('guide-index.intro', 'guide-index', 'sentence under the title', 'pages', 'text', 'plain text', 'components/guide-index-page.tsx', [R('components/guide-index-page.tsx')]),
]

const FIELD_BY_KEY = new Map(SOURCE_FIELDS.map((f) => [f.key, f]))
export const sourceField = (key: string): SourceField | undefined => FIELD_BY_KEY.get(key)
export const pageLabelOfKey = (key: string): string => {
  const f = FIELD_BY_KEY.get(key)
  return f ? PAGE_TYPE_LABEL[f.pageType] : key
}
export const fieldLabelOfKey = (key: string): string => FIELD_BY_KEY.get(key)?.label ?? key

/** Every file that must call linkPageFields (role links) or show linked text (role shows). */
export function rendererFiles(): RendererRef[] {
  const seen = new Map<string, RendererRef>()
  for (const f of SOURCE_FIELDS) for (const r of f.renderers) if (!seen.has(r.file) || r.role === 'links') seen.set(r.file, r)
  return [...seen.values()]
}

/** "Where we look", for the admin tool panel: one entry per page type, with the places searched on it. */
export function whereWeLook(): { pageType: PageType; label: string; places: string[] }[] {
  const out: { pageType: PageType; label: string; places: string[] }[] = []
  for (const f of SOURCE_FIELDS) {
    let g = out.find((x) => x.pageType === f.pageType)
    if (!g) out.push((g = { pageType: f.pageType, label: PAGE_TYPE_LABEL[f.pageType], places: [] }))
    g.places.push(f.label)
  }
  return out
}

export const WHERE_WE_LOOK_TEXT = whereWeLook().map((g) => `${g.label} (${g.places.join(', ')})`).join('; ')

// ---------- text that is never linked ----------

export interface ExcludedText {
  where: string
  reason: string
  /** True when the text sits inside a heading or an anchor by design. */
  insideAnchorOrHeading: boolean
}

export const EXCLUDED_TEXT: ExcludedText[] = [
  { where: 'Headings (page titles and section titles, h1 to h6), FAQ questions, itinerary day titles, journal entry titles', reason: 'A link in a heading changes how the page is read by people and by search engines. Headings are titles, not running text.', insideAnchorOrHeading: true },
  { where: 'Cards that are wholly one link: blog index cards, guide index cards, related guide cards, trip cards on best-time and compare pages, past-trip cards, "More stories" titles, "Guides for this trip" lists', reason: 'A link inside a link is invalid HTML and breaks both.', insideAnchorOrHeading: true },
  { where: 'Any existing link in the written text, and the breadcrumb', reason: 'Already a link. The linker skips the whole link.', insideAnchorOrHeading: true },
  { where: 'Trip card teasers (components/package-card.tsx): name, two-line description, price', reason: 'A client component shown in up to five places, and a clipped teaser of the trip page description (which is linked). Linking it would spend the 6-link page limit on teasers.', insideAnchorOrHeading: false },
  { where: 'Prices, price on request lines, dates, durations, ratings, "Operated by", "This trip happened ..."', reason: 'Facts and generated lines, not writing. A link next to a price reads as a price change.', insideAnchorOrHeading: false },
  { where: 'Buttons and calls to action: Request Info, Book Now, the header call-to-action panel, "Ready to go?", the guide call to action', reason: 'Our own calls to action must stay clean.', insideAnchorOrHeading: false },
  { where: 'Forms: contact form, trip alert form (labels, hints, buttons)', reason: 'Form labels and fields are never linked.', insideAnchorOrHeading: false },
  { where: 'Header, footer, menus and navigation', reason: 'Site chrome, not page text.', insideAnchorOrHeading: false },
  { where: 'JSON-LD structured data, meta titles and descriptions, Open Graph and social text', reason: 'Not visible body text. Links there would be wrong or invisible.', insideAnchorOrHeading: false },
  { where: 'Image alt text and photo captions ("Illustrative stock photo.")', reason: 'Attributes and captions are never linked.', insideAnchorOrHeading: false },
  { where: 'The generated facts block on guide pages and the "Fun things to do" and trip extras cards', reason: 'Built from live data, and they carry their own links and disclosure.', insideAnchorOrHeading: false },
  { where: 'Customer reviews (home page and trip pages)', reason: 'Quotes from travellers. We do not put links into somebody else\'s words.', insideAnchorOrHeading: false },
  { where: 'One-line template sentences that only insert a destination name (best-time and compare headers, destination page footers)', reason: 'Not writing: a name dropped into a fixed sentence.', insideAnchorOrHeading: false },
  { where: 'Legal and account pages (privacy, terms, earnings disclaimer, affiliate agreement) and every admin page', reason: 'Legal text carries no affiliate links, and admin pages are not public.', insideAnchorOrHeading: false },
]

// ---------- fields of one page ----------

export interface TextField {
  /** Unique inside one page, for example "trip.highlights#2". */
  id: string
  /** The SOURCE_FIELDS key. */
  key: string
  format: FieldFormat
  value: string
}

const mk = (key: string, index: number | null, format: FieldFormat, value: string): TextField => ({ id: index === null ? key : `${key}#${index}`, key, format, value })
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// ---- guides and destination guides ----

export interface GuideLike {
  summary?: string | null
  key_takeaways?: string[] | null
  body?: string | null
  faq?: { q?: unknown; a?: unknown }[] | null
}

/** Where the quick facts are shown: 'left' under the title (up to four), 'right' in the photo card (up to five), or
 * 'none' (a trip card sits on the right and the left column has no facts, or there are no takeaways). */
export type FactsMode = 'left' | 'right' | 'none'

export interface GuideFieldSet {
  fields: TextField[]
  summary: TextField
  facts: TextField[]
  takeaways: TextField[]
  body: TextField
  /** One per guide.faq entry, in order. */
  faq: TextField[]
}

export function guideFieldSet(guide: GuideLike, kind: 'guide' | 'destination', factsMode: FactsMode = 'left'): GuideFieldSet {
  const takeaways = Array.isArray(guide.key_takeaways) ? guide.key_takeaways.map(str) : []
  const facts = factsMode === 'none' ? [] : factsMode === 'left' ? quickFacts(takeaways).slice(0, MAX_LEFT_FACTS) : quickFacts(takeaways)
  const summary = mk(`${kind}.summary`, null, 'text', str(guide.summary))
  const factFields = facts.map((f, i) => mk(`${kind}.quick-facts`, i, 'text', f))
  const takeFields = takeaways.map((t, i) => mk(`${kind}.takeaways`, i, 'text', t))
  const body = mk(`${kind}.body`, null, 'html', articleHtml(str(guide.body)))
  const faq = (Array.isArray(guide.faq) ? guide.faq : []).map((f, i) => mk(`${kind}.faq`, i, 'text', str(f?.a)))
  return { fields: [summary, ...factFields, ...takeFields, body, ...faq], summary, facts: factFields, takeaways: takeFields, body, faq }
}

/** A destination page without a guide shows only the blurb. */
export function destinationBlurbFieldSet(blurb: string | null | undefined): { fields: TextField[]; blurb: TextField | null } {
  const f = str(blurb).trim() ? mk('destination-trips.blurb', null, 'text', str(blurb)) : null
  return { fields: f ? [f] : [], blurb: f }
}

// ---- blog posts ----

export interface BlogLike {
  body?: string | null
  faq?: unknown
  key_takeaways?: unknown
}

/** The FAQ entries the blog page shows (both parts filled in). The page and the field list use this one filter. */
export function blogFaq(post: { faq?: unknown }): { q: string; a: string }[] {
  return (Array.isArray(post.faq) ? post.faq : []).filter((f): f is { q: string; a: string } => !!f && typeof f.q === 'string' && typeof f.a === 'string' && !!f.q && !!f.a)
}

/** The takeaways the blog page shows. */
export function blogTakeaways(post: { key_takeaways?: unknown }, isNews: boolean): string[] {
  return isNews ? [] : (Array.isArray(post.key_takeaways) ? post.key_takeaways : []).filter((t): t is string => typeof t === 'string' && !!t)
}

export interface BlogFieldSet {
  fields: TextField[]
  takeaways: TextField[]
  body: TextField
  faq: TextField[]
  /** One per related post, in order (an empty excerpt gives an empty field). */
  moreStories: TextField[]
}

/** `bodyHtml` is the rendered article when the page already has it (it adds a class to the quick answer); otherwise the
 * markdown is rendered here. `moreExcerpts` are the short descriptions shown under "More stories", in order. */
export function blogFieldSet(post: BlogLike, opts: { isNews?: boolean; bodyHtml?: string; moreExcerpts?: string[] } = {}): BlogFieldSet {
  const takeaways = blogTakeaways(post, !!opts.isNews).map((t, i) => mk('blog.takeaways', i, 'text', t))
  // The blog page renders its article with renderMarkdown (every link opens in a new tab).
  const body = mk('blog.body', null, 'html', opts.bodyHtml ?? renderMarkdown(str(post.body)))
  const faq = blogFaq(post).map((f, i) => mk('blog.faq', i, 'text', f.a))
  const moreStories = (opts.moreExcerpts ?? []).map((e, i) => mk('blog.more-stories', i, 'text', str(e)))
  return { fields: [...takeaways, body, ...faq, ...moreStories], takeaways, body, faq, moreStories }
}

// ---- trip pages ----

export interface TripLike {
  available_to?: string | null
  recap_mode?: string | null
  recap_summary?: string | null
  recap_highlights?: string[] | null
  full_description?: string | null
  short_description?: string | null
  highlights?: string[] | null
  itinerary?: unknown
  price_includes?: string | null
  not_included?: string | null
  ai_faqs?: unknown
  journal_entries?: { date: string; title: string; body: string }[] | null
}

export const splitLines = (value: string | null | undefined): string[] => (value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

export interface TripItineraryItem { day: number | null; title: string; description: string; field: TextField | null }

/** Itinerary stops stored by the Add details intake: [{day, title, description}]. Anything else is ignored. */
export function tripItinerary(pkg: { itinerary?: unknown }): TripItineraryItem[] {
  if (!Array.isArray(pkg.itinerary)) return []
  const out: TripItineraryItem[] = []
  for (const d of pkg.itinerary as unknown[]) {
    const o = d as { day?: unknown; title?: unknown; description?: unknown } | null
    if (!o || typeof o.title !== 'string' || !o.title.trim()) continue
    out.push({ day: typeof o.day === 'number' ? o.day : null, title: o.title.trim(), description: typeof o.description === 'string' ? o.description.trim() : '', field: null })
  }
  return out
}

export function tripFaqs(pkg: { ai_faqs?: unknown }): { question: string; answer: string }[] {
  if (!Array.isArray(pkg.ai_faqs)) return []
  return (pkg.ai_faqs as { question?: unknown; answer?: unknown }[]).filter((f): f is { question: string; answer: string } => !!f && typeof f.question === 'string' && typeof f.answer === 'string' && !!f.question.trim() && !!f.answer.trim())
}

/** Journal entries oldest first, as the trip page shows them. */
export function sortJournal<T extends { date: string }>(entries: T[] | null | undefined): T[] {
  return [...(entries ?? [])].sort((a, b) => String(a?.date ?? '').localeCompare(String(b?.date ?? '')))
}

export interface TripFieldSet {
  fields: TextField[]
  isPast: boolean
  recap: TextField[]
  recapHighlights: TextField[]
  journalEntries: { date: string; title: string; body: string }[]
  journal: TextField[]
  description: TextField[]
  highlights: TextField[]
  itinerary: TripItineraryItem[]
  included: TextField[]
  notIncluded: TextField[]
  faqs: { question: string; answer: string; field: TextField }[]
}

/** The trip page text in reading order. A past trip with a recap shows the recap, then the journal, then the description;
 * a trip that has not happened shows the journal last. */
export function tripFieldSet(pkg: TripLike, today?: string): TripFieldSet {
  const isPast = isPastTrip({ available_to: pkg.available_to ?? null, recap_mode: pkg.recap_mode }, today)
  const recapText = isPast && hasRecap(pkg) ? (pkg.recap_summary as string).trim() : ''
  const recap = recapText ? recapText.split(/\n{2,}/).map((p, i) => mk('trip.recap', i, 'text', p)) : []
  const recapHighlights = recapText ? (pkg.recap_highlights ?? []).filter((h): h is string => typeof h === 'string' && !!h.trim()).map((h, i) => mk('trip.recap-highlights', i, 'text', h)) : []
  const journalEntries = sortJournal(pkg.journal_entries)
  const journal = journalEntries.map((e, i) => mk('trip.journal', i, 'text', str(e?.body)))
  const descriptionText = pkg.full_description || pkg.short_description || ''
  const description = descriptionText ? descriptionText.split(/\n{2,}/).map((p, i) => mk('trip.description', i, 'linkified', p)) : []
  const highlights = (Array.isArray(pkg.highlights) ? pkg.highlights : []).filter((h): h is string => typeof h === 'string' && !!h).map((h, i) => mk('trip.highlights', i, 'text', h))
  const itinerary = tripItinerary(pkg).map((d, i) => ({ ...d, field: d.description ? mk('trip.itinerary', i, 'text', d.description) : null }))
  const included = splitLines(pkg.price_includes).map((t, i) => mk('trip.included', i, 'text', t))
  const notIncluded = splitLines(pkg.not_included).map((t, i) => mk('trip.not-included', i, 'text', t))
  const faqs = tripFaqs(pkg).map((f, i) => ({ ...f, field: mk('trip.faq', i, 'text', f.answer) }))
  const fields = [
    ...recap,
    ...recapHighlights,
    ...(isPast ? journal : []),
    ...description,
    ...highlights,
    ...itinerary.flatMap((d) => (d.field ? [d.field] : [])),
    ...included,
    ...notIncluded,
    ...faqs.map((f) => f.field),
    ...(isPast ? [] : journal),
  ]
  return { fields, isPast, recap, recapHighlights, journalEntries, journal, description, highlights, itinerary, included, notIncluded, faqs }
}

// ---- best-time and compare copy ----

export interface PageCopyLike {
  intro?: string | null
  key_takeaways?: string[] | null
  faq?: { q?: unknown; a?: unknown }[] | null
}

export interface PageCopyFieldSet {
  fields: TextField[]
  intro: TextField | null
  takeaways: TextField[]
  faq: TextField[]
}

export function pageCopyFieldSet(copy: PageCopyLike | null | undefined, kind: 'best-time' | 'compare'): PageCopyFieldSet {
  if (!copy) return { fields: [], intro: null, takeaways: [], faq: [] }
  const intro = str(copy.intro).trim() ? mk(`${kind}.intro`, null, 'html', articleHtml(str(copy.intro))) : null
  const takeaways = (Array.isArray(copy.key_takeaways) ? copy.key_takeaways : []).map((t, i) => mk(`${kind}.takeaways`, i, 'text', str(t)))
  const faq = (Array.isArray(copy.faq) ? copy.faq : []).map((f, i) => mk(`${kind}.faq`, i, 'text', str(f?.a)))
  return { fields: [...(intro ? [intro] : []), ...takeaways, ...faq], intro, takeaways, faq }
}

// ---- static pages ----

export interface HomeFieldSet { fields: TextField[]; hero: TextField; featuresIntro: TextField; features: TextField[]; contact: TextField }

export function homeFieldSet(language: Language = 'en'): HomeFieldSet {
  const hero = mk('home.hero', null, 'text', translate(language, HERO_DESCRIPTION))
  const featuresIntro = mk('home.features-intro', null, 'text', translate(language, FEATURES_SUBTITLE))
  const features = featureItems.map((f, i) => mk('home.features', i, 'text', translate(language, f.description)))
  const contact = mk('home.contact', null, 'text', translate(language, CONTACT_BLURB))
  return { fields: [hero, featuresIntro, ...features, contact], hero, featuresIntro, features, contact }
}

export interface WhoWeAreFieldSet { fields: TextField[]; intro: TextField; sections: TextField[]; closing: TextField }

export function whoWeAreFieldSet(): WhoWeAreFieldSet {
  const intro = mk('who-we-are.intro', null, 'text', WHO_WE_ARE_INTRO)
  const sections = WHO_WE_ARE_SECTIONS.map((s, i) => mk('who-we-are.sections', i, 'text', s.body))
  const closing = mk('who-we-are.closing', null, 'text', WHO_WE_ARE_CLOSING)
  return { fields: [intro, ...sections, closing], intro, sections, closing }
}

export const BLOG_INDEX_INTRO = 'Real departures, real tips, and what actually happens on our group trips.'

export function blogIndexFieldSet(): { fields: TextField[]; intro: TextField } {
  const intro = mk('blog-index.intro', null, 'text', BLOG_INDEX_INTRO)
  return { fields: [intro], intro }
}

/** The sentence under the title of a guide index page. `destinations` has its own wording. */
export function guideIndexIntroText(kind: string, plural: string): string {
  return kind === 'destinations'
    ? 'Where our group trips, cruises and singles getaways go, with a plain-English guide to each place.'
    : `Plain-English guides to ${plural.toLowerCase()} for group travellers: who each one suits, what to expect and how to book it with a group.`
}

export function guideIndexFieldSet(kind: string, plural: string): { fields: TextField[]; intro: TextField } {
  const intro = mk('guide-index.intro', null, 'text', guideIndexIntroText(kind, plural))
  return { fields: [intro], intro }
}

// ---------- linking a whole page ----------

export type LinkifiedPart = Part | { text: string; href: string }

export interface LinkedFields {
  /** Automatic links added on the whole page (for the one disclosure line). */
  count: number
  linked: LinkedItem[]
  /** True when the 50 ms budget ran out and part of the page was left unlinked. */
  truncated: boolean
  html(f: TextField): string
  parts(f: TextField): Part[]
  linkified(f: TextField): LinkifiedPart[]
}

/** Links a whole page: the fields are processed in the order given, sharing ONE state, so the limits are for the page, not
 * per field: 3 links per phrase, 6 per page, one 50 ms time budget, document order wins. Never throws: any failure leaves
 * the rest unlinked. Output for a field is looked up with html(), parts() or linkified() by the field's format; a field that
 * was not processed comes back as its own plain text. */
export function linkPageFields(fields: TextField[], rules: AffiliateRule[] | null | undefined, context: PageContext, opts: { budgetMs?: number } = {}): LinkedFields {
  const state = newLinkerState(opts.budgetMs)
  const html = new Map<string, string>()
  const parts = new Map<string, Part[]>()
  const linkified = new Map<string, LinkifiedPart[]>()
  try {
    const compiled = compileRules(rules, context)
    if (compiled.re) {
      for (const f of fields) {
        if (f.format === 'html') html.set(f.id, linkKeywords(f.value, compiled, { context, state }).output)
        else if (f.format === 'text') parts.set(f.id, linkTextParts(f.value, compiled, { context, state }).parts)
        else {
          const out: LinkifiedPart[] = []
          for (const seg of splitPathLinks(f.value)) {
            if (seg.kind === 'path') out.push({ text: seg.text, href: seg.href })
            else out.push(...linkTextParts(seg.text, compiled, { context, state }).parts)
          }
          linkified.set(f.id, out)
        }
      }
    }
  } catch {
    // keep what was done; everything else renders as plain text
  }
  return {
    count: state.total,
    linked: state.linked,
    truncated: state.truncated,
    html: (f) => html.get(f.id) ?? f.value,
    parts: (f) => parts.get(f.id) ?? [f.value],
    linkified: (f) => linkified.get(f.id) ?? splitPathLinks(f.value).map((s) => (s.kind === 'path' ? { text: s.text, href: s.href } : s.text)),
  }
}

// ---------- the same fields as HTML, for scanning (Preview, usage report) ----------

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;')

/** The HTML the linker would look at for this field: an html field as it is, plain text escaped, and a site link
 * written [words](/path) as a real anchor (so the finder knows that text is already a link). */
export function fieldAsHtml(f: TextField): string {
  if (f.format === 'html') return f.value
  if (f.format === 'text') return escapeText(f.value)
  return splitPathLinks(f.value)
    .map((s) => (s.kind === 'path' ? `<a href="${escapeAttr(s.href)}">${escapeText(s.text)}</a>` : escapeText(s.text)))
    .join('')
}
