// Types and the small item builder for the SEO / AEO / GEO playbook (lib/seo-playbook.ts).
// Portable on purpose: no imports from the rest of the app, so this folder of files can be copied into the shared
// autoblogging hub or another project as it is.

export const CATEGORIES = ['technical', 'onpage', 'content', 'schema', 'aeo', 'geo', 'local', 'links', 'social', 'performance', 'measurement'] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  technical: 'Technical SEO',
  onpage: 'On-page',
  content: 'Content strategy',
  schema: 'Schema and structured data',
  aeo: 'AEO (answer engines)',
  geo: 'GEO (generative engines)',
  local: 'Local SEO and profiles',
  links: 'Links',
  social: 'Social and profiles',
  performance: 'Performance and UX',
  measurement: 'Measurement',
}

export type Automation = 'auto' | 'assisted' | 'manual'
export type AppliesTo = 'all auto-blog sites' | 'local business' | 'ecommerce' | 'travel'
export type Source = 'joel-list-a' | 'joel-list-b' | 'joel-idea' | 'best-practice' | `influencer:${string}`

export interface PlaybookItem {
  id: string
  title: string
  category: Category
  /** 5 = biggest effect on search and AI visibility. */
  impact: 1 | 2 | 3 | 4 | 5
  /** 1 = minutes, 2 = an afternoon, 3 = days. */
  effort: 1 | 2 | 3
  automation: Automation
  verify: { kind: 'check' | 'manual'; checkId?: string }
  /** One plain sentence. */
  why: string
  /** Grade-6 steps. */
  how: string[]
  appliesTo: AppliesTo
  source: Source
  /** Set on every risky tactic: what goes wrong if it is done badly. */
  caution?: string
  /** The admin page where the fix is done, when one exists. */
  fixHref?: string
}

interface Extra {
  applies?: AppliesTo
  src?: Source
  caution?: string
  href?: string
}

const AUTO = { a: 'auto', s: 'assisted', m: 'manual' } as const

/**
 * Builder. `check` is the id of the automated check in lib/seo-playbook-audit.ts, or '' for a manual item.
 * `how` is steps separated by " | ".
 */
export function it(
  id: string,
  category: Category,
  impact: 1 | 2 | 3 | 4 | 5,
  effort: 1 | 2 | 3,
  automation: 'a' | 's' | 'm',
  check: string,
  title: string,
  why: string,
  how: string,
  extra: Extra = {},
): PlaybookItem {
  const item: PlaybookItem = {
    id,
    title,
    category,
    impact,
    effort,
    automation: AUTO[automation],
    verify: check ? { kind: 'check', checkId: check } : { kind: 'manual' },
    why,
    how: how.split(' | ').map((s) => s.trim()).filter(Boolean),
    appliesTo: extra.applies ?? 'all auto-blog sites',
    source: extra.src ?? 'best-practice',
  }
  if (extra.caution) item.caution = extra.caution
  if (extra.href) item.fixHref = extra.href
  return item
}
