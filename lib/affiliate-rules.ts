import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { isValidSlug, isRealLink } from '@/lib/affiliate-go'
import { cleanPhrase, isLinkScope, phraseProblem, type AffiliateRule, type LinkScope } from '@/lib/affiliate-linker'

// WP22: reading and validating the word-link rules (table affiliate_keywords, migration 0050).

export type KeywordStatus = 'on' | 'off'

export interface KeywordRow {
  id: string
  phrase: string
  link_id: string
  scope: LinkScope
  max_per_page: number
  status: KeywordStatus
  created_at?: string
}

export const KEYWORD_COLUMNS = 'id, phrase, link_id, scope, max_per_page, status, created_at'
export const KEYWORDS_MIGRATION_MESSAGE = 'Run migration 0050 first (supabase/migrations/0050_affiliate_keywords.sql in the Supabase SQL editor), then try again.'

/** True when a database error only means the keywords table is not there yet (migration 0050 not applied). */
export const isMissingKeywordsTable = (message: string | null | undefined): boolean =>
  !!message && /affiliate_keywords/i.test(message) && /does not exist|schema cache|could not find|relation/i.test(message)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface KeywordInput {
  phrase: string
  link_id: string
  scope: LinkScope
  max_per_page: number
}

export type KeywordValidation = { ok: true; value: KeywordInput } | { ok: false; error: string }

/** Validates one rule typed in the admin. Never throws. The link must exist: the route checks that with a read. */
export function normalizeKeywordInput(raw: Record<string, unknown>): KeywordValidation {
  const problem = phraseProblem(raw.phrase)
  if (problem) return { ok: false, error: problem }
  const phrase = cleanPhrase(raw.phrase)
  if (!phrase) return { ok: false, error: 'That phrase cannot be used.' }
  const link_id = String(raw.link_id ?? '').trim()
  if (!UUID.test(link_id)) return { ok: false, error: 'Pick the link from the list.' }
  const scopeRaw = raw.scope == null || raw.scope === '' ? 'all' : raw.scope
  if (!isLinkScope(scopeRaw)) return { ok: false, error: 'Pick where the phrase should be linked from the list.' }
  const n = Number(raw.max_per_page ?? 1)
  if (!Number.isInteger(n) || n < 1 || n > 3) return { ok: false, error: 'Max per page must be 1, 2 or 3.' }
  return { ok: true, value: { phrase, link_id, scope: scopeRaw, max_per_page: n } }
}

interface JoinedRow {
  id: string
  phrase: string
  scope: string
  max_per_page: number
  affiliate_links?: { slug: string | null; status: string; url?: string | null } | { slug: string | null; status: string; url?: string | null }[] | null
}

/** Pure: joined rows (keyword plus its link) to usable rules. Only a link that is ON (status active) with a real short-link slug counts. */
export function rowsToRules(rows: JoinedRow[] | null | undefined): AffiliateRule[] {
  const out: AffiliateRule[] = []
  for (const r of rows ?? []) {
    const link = Array.isArray(r.affiliate_links) ? r.affiliate_links[0] : r.affiliate_links
    if (!link || link.status !== 'active' || !isValidSlug(link.slug) || !isRealLink(link.url)) continue
    if (!isLinkScope(r.scope) || !cleanPhrase(r.phrase)) continue
    out.push({ id: r.id, phrase: r.phrase, slug: link.slug, scope: r.scope, max_per_page: r.max_per_page })
  }
  return out
}

export const RULES_TTL_MS = 60_000
let cache: { at: number; rules: AffiliateRule[] } | null = null

/** A slow database must not slow a public page down: after this long the page renders with no word links. */
export const RULES_TIMEOUT_MS = 1500
let inFlight: Promise<AffiliateRule[]> | null = null

export function clearAffiliateRulesCache(): void {
  cache = null
  inFlight = null
}

async function queryRules(db: SupabaseClient): Promise<AffiliateRule[]> {
  try {
    const res = await db
      .from('affiliate_keywords')
      .select('id, phrase, scope, max_per_page, link_id, affiliate_links!inner(slug, status, url)')
      .eq('status', 'on')
      .order('created_at')
      .limit(1000)
    return res.error ? [] : rowsToRules((res.data ?? []) as unknown as JoinedRow[])
  } catch {
    return []
  }
}

/** The ON rules whose link is ON, for the public pages. One query (the keyword rows with their link joined), kept in
 * memory for 60 seconds; requests that arrive while it runs share that one query. FAILS OPEN: any error, a query slower
 * than RULES_TIMEOUT_MS, or migration 0050 not applied yet, is "no rules" (no links, never a 500, never a hung page). */
export async function loadAffiliateRules(opts: { client?: SupabaseClient; now?: number; timeoutMs?: number } = {}): Promise<AffiliateRule[]> {
  const now = opts.now ?? Date.now()
  if (cache && now - cache.at < RULES_TTL_MS) return cache.rules
  if (inFlight) return inFlight
  let run: Promise<AffiliateRule[]>
  try {
    run = queryRules(opts.client ?? getSupabaseAdmin())
  } catch {
    run = Promise.resolve([])
  }
  const timeoutMs = opts.timeoutMs ?? RULES_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const guarded = Promise.race([
    run.then((r) => ({ rules: r, timedOut: false })),
    new Promise<{ rules: AffiliateRule[]; timedOut: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ rules: [], timedOut: true }), timeoutMs)
    }),
  ]).then((out) => {
    if (timer) clearTimeout(timer)
    // A timed-out read is remembered for only 5 seconds (not a minute), so pages are not each held up while the database is slow.
    cache = { at: out.timedOut ? now - (RULES_TTL_MS - 5000) : now, rules: out.rules }
    inFlight = null
    return out.rules
  })
  inFlight = guarded
  return guarded
}
