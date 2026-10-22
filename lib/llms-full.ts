import { supabase } from '@/integrations/supabase/client'
import { guideKinds, guidePath, isGuideKind, withoutThinPages, type GuideKind } from '@/lib/guides'
import { UNSAFE, safeTitle } from '@/lib/llms-txt'
import { absoluteUrl, site } from '@/lib/site'

// /llms-full.txt: the longer sibling of /llms.txt. One short paragraph per published guide (name, kind, parent, a stored
// summary, URL). Same rules as llms.txt: published rows only, read with the public client; thin safe-page guides are left
// out (withoutThinPages); no prices, phone numbers, emails or web addresses (a sentence that holds one is dropped).

export const LLMS_FULL_MAX_GUIDES = 400
export const LLMS_FULL_PARAGRAPH_MAX = 420

const LONG_DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']', 'g')

export interface FullGuideRow {
  kind: GuideKind
  slug: string
  name: string
  parent_slug: string | null
  meta_description: string | null
  summary: string | null
  quality_notes?: string | null
}

/** One paragraph from stored text: markdown taken off, long dashes replaced, any sentence with a price, phone number, email
 * or web address dropped, cut at LLMS_FULL_PARAGRAPH_MAX on a sentence or word end. Empty when nothing safe is left. Pure. */
export function safeParagraph(raw: string | null | undefined, max = LLMS_FULL_PARAGRAPH_MAX): string {
  const flat = (raw ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]/g, '').replace(LONG_DASHES, '-').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const sentences = flat.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [flat]
  let out = ''
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (UNSAFE.test(s)) continue
    const next = out ? `${out} ${s}` : s
    if (next.length > max) {
      if (!out) out = `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}.`
      break
    }
    out = next
  }
  return out
}

/** The paragraph for a guide: its stored meta description, else its stored summary. Pure. */
export function guideParagraph(g: Pick<FullGuideRow, 'meta_description' | 'summary'>): string {
  return safeParagraph(g.meta_description) || safeParagraph(g.summary)
}

/** The file text. Thin safe-page guides are dropped here too (a caller may pass raw rows). Pure: same rows, same text. */
export function buildLlmsFull(rows: FullGuideRow[], max = LLMS_FULL_MAX_GUIDES): string {
  const live = withoutThinPages(rows as (FullGuideRow & { quality_notes?: string | null })[]) as FullGuideRow[]
  const byKey = new Map(live.map((g) => [g.slug, g.name] as const))
  const place = site.address.locality ? `${site.address.locality}, ${site.address.region}` : ''
  const head = [
    `# ${site.name}: full guide summaries`,
    '',
    `> ${site.tagline}`,
    '',
    `${site.name} is a travel agency${place ? ` based in ${place}` : ''}. Below is one short paragraph for each published guide. Prices, dates and availability change, so this file quotes none: please send people to the page itself, or to ${absoluteUrl('/')} to reach us.`,
    '',
    `Short version of this file: ${absoluteUrl('/llms.txt')}`,
  ]
  const body: string[] = []
  let count = 0
  for (const kind of Object.keys(guideKinds) as GuideKind[]) {
    const items = live.filter((g) => g.kind === kind && safeTitle(g.name)).sort((a, b) => a.name.localeCompare(b.name))
    if (items.length === 0) continue
    const section: string[] = ['', `## ${guideKinds[kind].plural}`]
    for (const g of items) {
      if (count >= max) break
      count++
      const parentName = g.parent_slug ? safeTitle(byKey.get(g.parent_slug)) : ''
      const para = guideParagraph(g)
      section.push('', `### ${safeTitle(g.name)}`, `- Type: ${guideKinds[kind].label}`)
      if (parentName) section.push(`- Part of: ${parentName}`)
      section.push(`- URL: ${absoluteUrl(guidePath(kind, g.slug))}`)
      if (para) section.push('', para)
    }
    body.push(...section)
  }
  return `${[...head, ...body].join('\n')}\n`
}

/** Reads published guides (public client). Never throws: a failed read gives an empty list and a short file. */
export async function getLlmsFullRows(): Promise<FullGuideRow[]> {
  try {
    const { data, error } = await supabase
      .from('guides')
      .select('kind, slug, name, parent_slug, meta_description, summary, quality_notes')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[llms-full] read failed:', error.message)
      return []
    }
    return ((data ?? []) as unknown as FullGuideRow[]).filter((g) => isGuideKind(g.kind) && g.slug && g.name)
  } catch (e) {
    console.error('[llms-full] read failed:', e instanceof Error ? e.message : e)
    return []
  }
}
