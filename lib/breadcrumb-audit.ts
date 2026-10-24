import type { Finding } from '@/lib/site-crawl'

// BREADCRUMBS AUDIT (SEO engine 4). Breadcrumbs show Google (and visitors) where a page sits: Home > Destinations > Caribbean. A page has them
// when it carries BreadcrumbList structured data (JSON-LD) AND a visible breadcrumb trail. This is a pure, read-only check over page
// facts (the site crawl already collects each page's JSON-LD blocks); it changes nothing. Guides, blog posts, trips and "from your city"
// pages are the four kinds that should have them.

export type CrumbPageKind = 'guide' | 'post' | 'trip' | 'from'

export const CRUMB_KIND_LABEL: Record<CrumbPageKind, string> = { guide: 'Guide pages', post: 'Blog posts', trip: 'Trip pages', from: '"From your city" pages' }

/** Which of the four kinds a public path is, or null for any other page. Pure. */
export function crumbKindOf(path: string): CrumbPageKind | null {
  const p = path.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/'
  if (/^\/blog\/[^/]+$/.test(p)) return 'post'
  if (/^\/packages\/[^/]+$/.test(p)) return 'trip'
  if (/^\/from\/[^/]+$/.test(p)) return 'from'
  if (/^\/(destinations|hotels|resorts|cruise-lines|ships|river-cruises|yachts)\/[^/]+$/.test(p)) return 'guide'
  return null
}

export interface CrumbPageFacts {
  path: string
  /** The raw JSON-LD blocks of the page. */
  jsonLd: string[]
  /** The page HTML, when available, to look for the visible trail. Absent: the visible trail is not judged. */
  html?: string
}

function hasBreadcrumbType(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasBreadcrumbType)
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    const t = o['@type']
    if (t === 'BreadcrumbList' || (Array.isArray(t) && t.includes('BreadcrumbList'))) return true
    return hasBreadcrumbType(o['@graph'])
  }
  return false
}

/** True when any JSON-LD block holds a BreadcrumbList with at least two items. Pure. */
export function hasBreadcrumbJsonLd(blocks: readonly string[]): boolean {
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!hasBreadcrumbType(parsed)) continue
      const text = JSON.stringify(parsed)
      if ((text.match(/"ListItem"/g) ?? []).length >= 2) return true
    } catch {
      // a broken block is reported by the structured-data check, not here
    }
  }
  return false
}

/** True when the HTML holds a visible breadcrumb trail (a nav labelled breadcrumb, or an element with a breadcrumb class). Pure. */
export function hasVisibleBreadcrumb(html: string): boolean {
  return /<nav[^>]+aria-label=["'][^"']*breadcrumb/i.test(html) || /class=["'][^"']*breadcrumb/i.test(html)
}

export interface CrumbKindReport {
  checked: number
  missingJsonLd: string[]
  missingVisible: string[]
}

export interface BreadcrumbAudit {
  byKind: Record<CrumbPageKind, CrumbKindReport>
  /** Page kinds where NONE of the checked pages has the data, or none the visible trail: a whole type is missing it. */
  missingKinds: { kind: CrumbPageKind; what: 'structured data' | 'visible trail' }[]
}

/** Checks the pages and says which kinds lack breadcrumbs. Pure. */
export function auditBreadcrumbs(pages: readonly CrumbPageFacts[]): BreadcrumbAudit {
  const empty = (): CrumbKindReport => ({ checked: 0, missingJsonLd: [], missingVisible: [] })
  const byKind: Record<CrumbPageKind, CrumbKindReport> = { guide: empty(), post: empty(), trip: empty(), from: empty() }
  const visibleJudged: Record<CrumbPageKind, number> = { guide: 0, post: 0, trip: 0, from: 0 }
  for (const p of pages) {
    const kind = crumbKindOf(p.path)
    if (!kind) continue
    const r = byKind[kind]
    r.checked++
    if (!hasBreadcrumbJsonLd(p.jsonLd)) r.missingJsonLd.push(p.path)
    if (typeof p.html === 'string') {
      visibleJudged[kind]++
      if (!hasVisibleBreadcrumb(p.html)) r.missingVisible.push(p.path)
    }
  }
  const missingKinds: BreadcrumbAudit['missingKinds'] = []
  for (const kind of ['guide', 'post', 'trip', 'from'] as CrumbPageKind[]) {
    const r = byKind[kind]
    if (r.checked > 0 && r.missingJsonLd.length === r.checked) missingKinds.push({ kind, what: 'structured data' })
    if (visibleJudged[kind] > 0 && r.missingVisible.length === visibleJudged[kind]) missingKinds.push({ kind, what: 'visible trail' })
  }
  return { byKind, missingKinds }
}

/** The audit as crawl findings of severity "info", one per page missing the structured data (the visible trail is reported only when the HTML was given). Pure. */
export function breadcrumbFindings(pages: readonly CrumbPageFacts[], baseUrl: string): Finding[] {
  const out: Finding[] = []
  const audit = auditBreadcrumbs(pages)
  for (const kind of Object.keys(audit.byKind) as CrumbPageKind[]) {
    for (const path of audit.byKind[kind].missingJsonLd) {
      out.push({ url: `${baseUrl.replace(/\/+$/, '')}${path}`, kind: 'breadcrumb-missing', severity: 'info', message: 'The page has no breadcrumb structured data (BreadcrumbList).', hint: 'Breadcrumbs show Google where the page sits on the site. Tell Claude the address and the page type.' })
    }
  }
  return out
}
