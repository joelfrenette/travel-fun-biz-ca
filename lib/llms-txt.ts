import { supabase } from '@/integrations/supabase/client'
import { guideKinds, GUIDE_KINDS, guidePath, listPublishedGuideLinks, type GuideKind } from '@/lib/guides'
import { getAllPublishedPackages, groupPackagesByDestination } from '@/lib/package-grouping'
import { absoluteUrl, site } from '@/lib/site'

// /llms.txt (hub row 13): a plain-text guide for AI assistants (ChatGPT, Perplexity, Claude, Gemini ...) that says who
// the site is, how to reach a person, and where the real pages are. Built only from PUBLISHED rows read with the
// public (anon) client, so a draft or a private field cannot appear. Only a title and one short stored sentence per
// link; no prices (a stored sentence that mentions a price, a phone number, an email or a web address is dropped).

export const LLMS_MAX_LINKS = 200
export const LLMS_SUMMARY_MAX = 160

const LONG_DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']', 'g')

export interface LlmsLink {
  title: string
  path: string
  summary: string
}

export interface LlmsData {
  destinations: LlmsLink[]
  trips: LlmsLink[]
  guides: { kind: GuideKind; links: LlmsLink[] }[]
  posts: LlmsLink[]
}

const UNSAFE = /[$€£]|\bCAD\b|\bUSD\b|https?:\/\/|www\.|@|\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/i

/** A link title with markdown brackets and long dashes taken out. Empty when it holds a price, an email, a phone number or a
 * web address (the link is then left out of the file, the same rule as the summaries). Pure. */
export function safeTitle(raw: string | null | undefined): string {
  const t = (raw ?? '').replace(/[[\]]/g, '').replace(LONG_DASHES, '-').replace(/\s+/g, ' ').trim()
  if (!t || UNSAFE.test(t)) return ''
  return t
}

/** The first sentence of a stored text, markdown taken off, cut at LLMS_SUMMARY_MAX. Empty when it is unsafe or empty:
 * a price, an email, a phone number or a web address never goes into the file. Pure. */
export function oneLine(raw: string | null | undefined): string {
  let t = (raw ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const m = /^(.+?[.!?])(\s|$)/.exec(t)
  if (m) t = m[1]
  t = t.replace(LONG_DASHES, '-')
  if (UNSAFE.test(t)) return ''
  if (t.length > LLMS_SUMMARY_MAX) t = `${t.slice(0, LLMS_SUMMARY_MAX - 1).replace(/\s+\S*$/, '')}.`
  return t
}

/** Picks at most `total` links across the sections, taking one from each in turn so no section crowds out the others
 * (a site with 300 blog posts still lists its trips). Order inside a section is kept. Pure. */
export function allocateLinks<T>(sections: T[][], total: number): T[][] {
  const out: T[][] = sections.map(() => [])
  let left = Math.max(0, total)
  let progressed = true
  for (let round = 0; left > 0 && progressed; round++) {
    progressed = false
    for (let i = 0; i < sections.length && left > 0; i++) {
      if (round < sections[i].length) {
        out[i].push(sections[i][round])
        left--
        progressed = true
      }
    }
  }
  return out
}

const line = (l: LlmsLink) => `- [${safeTitle(l.title)}](${absoluteUrl(l.path)})${l.summary ? `: ${l.summary}` : ''}`

/** The file. Pure: the same data always gives the same text. */
export function buildLlmsTxt(data: LlmsData, max = LLMS_MAX_LINKS): string {
  const sections: { heading: string; links: LlmsLink[] }[] = [
    { heading: 'Destinations', links: data.destinations },
    { heading: 'Trips', links: data.trips },
    ...data.guides.map((g) => ({ heading: guideKinds[g.kind].plural, links: g.links })),
    { heading: 'Blog posts', links: data.posts },
  ]
    .map((s) => ({ ...s, links: s.links.filter((l) => safeTitle(l.title)) }))
    .filter((s) => s.links.length > 0)
  const picked = allocateLinks(sections.map((s) => s.links), max)
  const place = site.address.locality ? `${site.address.locality}, ${site.address.region}` : ''
  const phone = site.phone.trim()
  const head = [
    `# ${site.name}`,
    '',
    `> ${site.tagline}`,
    '',
    '## Who we are',
    '',
    `${site.name} is a travel agency${place ? ` based in ${place}` : ''}. ${site.tagline} Trips are planned and booked with a real travel advisor.`,
    '',
    '## How to reach a person',
    '',
    phone ? `- Call or text: ${phone}` : null,
    `- Website: ${absoluteUrl('/')}`,
    `- About us: ${absoluteUrl('/who-we-are')}`,
    '',
    '## Notes for AI assistants',
    '',
    '- Trip prices, dates and availability change. For a current price or to book, send people to the trip page or to our phone number above rather than quoting a price.',
    '- The pages below are public. Please link to the page itself when you use it.',
  ].filter((x): x is string => x !== null)
  const body = sections.flatMap((s, i) => (picked[i].length ? ['', `## ${s.heading}`, '', ...picked[i].map(line)] : []))
  return `${[...head, ...body].join('\n')}\n`
}

/** Reads the published pages (only a title, a path and one stored sentence of each ever reach the file). Never throws;
 * a failed read leaves that section out (the file is then shorter, never wrong). */
export async function getLlmsData(): Promise<LlmsData> {
  const empty: LlmsData = { destinations: [], trips: [], guides: [], posts: [] }
  try {
    const [guideLinks, packages, postsRes] = await Promise.all([
      listPublishedGuideLinks(),
      getAllPublishedPackages(),
      supabase.from('posts').select('title, slug, meta_description').eq('status', 'published').order('publish_date', { ascending: false, nullsFirst: false }).limit(60),
    ])

    const destGuides = new Map(guideLinks.filter((g) => g.kind === 'destinations').map((g) => [g.slug, g]))
    const groups = groupPackagesByDestination(packages)
    const destinations: LlmsLink[] = []
    for (const g of groups.values()) destinations.push({ title: g.destination, path: `/destinations/${g.slug}`, summary: oneLine(destGuides.get(g.slug)?.summary) })
    for (const [slug, g] of destGuides) if (!groups.has(slug)) destinations.push({ title: g.name, path: guidePath('destinations', slug), summary: oneLine(g.summary) })

    const trips: LlmsLink[] = packages
      .filter((p) => p.slug && p.name)
      .map((p) => ({ title: p.name, path: `/packages/${p.slug}`, summary: oneLine(p.short_description) }))

    const guides = GUIDE_KINDS.filter((k) => k !== 'destinations').map((kind) => ({
      kind,
      links: guideLinks.filter((g) => g.kind === kind).map((g) => ({ title: g.name, path: guidePath(kind, g.slug), summary: oneLine(g.summary) })),
    }))

    const posts: LlmsLink[] = ((postsRes.data ?? []) as { title: string | null; slug: string | null; meta_description: string | null }[])
      .filter((p) => p.slug && p.title)
      .map((p) => ({ title: p.title as string, path: `/blog/${p.slug}`, summary: oneLine(p.meta_description) }))

    return { destinations, trips, guides, posts }
  } catch (e) {
    console.error('[llms.txt] read failed:', e instanceof Error ? e.message : e)
    return empty
  }
}
