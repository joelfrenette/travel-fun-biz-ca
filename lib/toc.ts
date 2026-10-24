// Table of contents for long posts and guides (hub WP6). Pure: takes the article HTML that is about to be shown (after the
// word linker), gives every <h2> an id and returns the contents list. Nothing stored is changed. The list exists only when the
// article has at least TOC_MIN_H2 headings; a shorter article comes back byte for byte as it went in.

export interface TocItem {
  id: string
  text: string
}

export const TOC_MIN_H2 = 4

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' }

/** Plain text of an HTML fragment: tags removed, the common entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Why go to Lisbon?" -> "why-go-to-lisbon". */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
}

const H2_RE = /<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi
const ID_ATTR_RE = /\sid\s*=\s*"([^"]*)"/i

/** Gives every <h2> an id (kept when it already has one; made from its text otherwise, unique on the page, prefixed `sec-` so
 * it can never collide with an id the page already uses) and lists them. */
export function addHeadingIds(html: string): { html: string; items: TocItem[] } {
  const items: TocItem[] = []
  const used = new Set<string>()
  const out = (html || '').replace(H2_RE, (_m, attrs: string | undefined, inner: string) => {
    const text = plainText(inner)
    const existing = attrs?.match(ID_ATTR_RE)?.[1]
    let id = existing || `sec-${slugifyHeading(text) || 'section'}`
    if (!existing) {
      const base = id
      let n = 2
      while (used.has(id)) id = `${base}-${n++}`
    }
    used.add(id)
    if (text) items.push({ id, text })
    return existing ? `<h2${attrs ?? ''}>${inner}</h2>` : `<h2${attrs ?? ''} id="${id}">${inner}</h2>`
  })
  return { html: out, items }
}

/** The article HTML with heading ids, and the list for the contents box. With fewer than `minH2` headings the list is empty and
 * the HTML is returned unchanged. `extra` entries (for example the FAQ section that sits after the article) are appended to the list. */
export function buildToc(html: string, opts: { minH2?: number; extra?: TocItem[] } = {}): { html: string; items: TocItem[] } {
  const min = opts.minH2 ?? TOC_MIN_H2
  const withIds = addHeadingIds(html)
  if (withIds.items.length < min) return { html, items: [] }
  return { html: withIds.html, items: [...withIds.items, ...(opts.extra ?? []).filter((e) => e.id && e.text)] }
}
