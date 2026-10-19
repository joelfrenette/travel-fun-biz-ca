import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_RULES, cleanPhrase, isLinkScope, phraseKey, phraseProblem } from '@/lib/affiliate-linker'
import { KEYWORDS_MIGRATION_MESSAGE, KEYWORD_COLUMNS, isMissingKeywordsTable, normalizeKeywordInput, type KeywordRow } from '@/lib/affiliate-rules'
import { loadStoredReport, loadUsageDocs, previewRule, MAX_USAGE_DOCS } from '@/lib/affiliate-usage'
import { flushPendingUsage, refreshAfterChange, type RefreshDeps } from '@/lib/affiliate-refresh'
import { BAD_BODY_MESSAGE } from '@/lib/admin-body'

// WP22: the actions behind the word-link routes, kept out of the route files so they can be run against an in-memory database.
// Each returns the HTTP status and JSON body for the route to send.

export interface ActionResult {
  status: number
  body: Record<string, unknown>
}

const fail = (status: number, error: string): ActionResult => ({ status, body: { error } })
const missing = (): ActionResult => fail(409, KEYWORDS_MIGRATION_MESSAGE)

/** Pure: the rule that already uses this phrase on a DIFFERENT link (one phrase can only go to one link, otherwise one of them
 * would be silently ignored). `exceptId` leaves out the rule being edited. */
export function phraseConflict(rows: { id: string; phrase: string; link_id: string }[], phrase: string, linkId: string | null, exceptId?: string): { id: string; link_id: string } | null {
  const key = phraseKey(phrase)
  return rows.find((r) => r.id !== exceptId && phraseKey(r.phrase) === key && r.link_id !== linkId) ?? null
}

async function linkNameOf(admin: SupabaseClient, id: string): Promise<string> {
  const { data } = await admin.from('affiliate_links').select('title, merchant, slug').eq('id', id).maybeSingle()
  const l = data as { title?: string | null; merchant?: string | null; slug?: string | null } | null
  return l?.title || l?.merchant || l?.slug || 'another link'
}

const conflictMessage = (phrase: string, linkName: string) => `"${phrase}" already goes to ${linkName}. A phrase can only go to one link: delete it there first, or pick that link.`

async function allRows(admin: SupabaseClient): Promise<{ rows: KeywordRow[] } | { error: ActionResult }> {
  const res = await admin.from('affiliate_keywords').select(KEYWORD_COLUMNS).order('created_at').limit(1000)
  if (res.error) return { error: isMissingKeywordsTable(res.error.message) ? missing() : fail(500, res.error.message) }
  return { rows: (res.data ?? []) as unknown as KeywordRow[] }
}

export async function listKeywords(admin: SupabaseClient, deps?: RefreshDeps): Promise<ActionResult> {
  const got = await allRows(admin)
  if ('error' in got) return got.error.status === 409 ? { status: 200, body: { keywords: [], report: null, migrated: false } } : got.error
  await flushPendingUsage(admin, deps) // a scan that was put off after a change runs now, so the numbers are fresh
  return { status: 200, body: { keywords: got.rows, report: await loadStoredReport(admin), migrated: true } }
}

/** What the finder says about this phrase today (pages, warnings). Never throws; null when it cannot be worked out. */
async function runFinder(admin: SupabaseClient, v: { phrase: string; scope: string; max_per_page: number }) {
  try {
    const site = await loadUsageDocs(admin)
    if (site.error || !isLinkScope(v.scope)) return null
    return previewRule(site.docs, { phrase: v.phrase, scope: v.scope, max_per_page: v.max_per_page }, { totalDocs: site.totalDocs, notes: site.notes, dropped: site.dropped })
  } catch {
    return null
  }
}

export async function createKeyword(admin: SupabaseClient, body: Record<string, unknown> | null, deps?: RefreshDeps): Promise<ActionResult> {
  if (!body) return fail(400, BAD_BODY_MESSAGE)
  const parsed = normalizeKeywordInput(body)
  if (!parsed.ok) return fail(400, parsed.error)
  const got = await allRows(admin)
  if ('error' in got) return got.error
  if (got.rows.length >= MAX_RULES) return fail(400, `You can have at most ${MAX_RULES} linked phrases. Delete one first.`)
  const conflict = phraseConflict(got.rows, parsed.value.phrase, parsed.value.link_id)
  if (conflict) return fail(409, conflictMessage(parsed.value.phrase, await linkNameOf(admin, conflict.link_id)))
  if (got.rows.some((r) => r.link_id === parsed.value.link_id && phraseKey(r.phrase) === phraseKey(parsed.value.phrase))) return fail(409, 'That phrase is already linked to this link.')

  const link = await admin.from('affiliate_links').select('id').eq('id', parsed.value.link_id).maybeSingle()
  if (link.error) return fail(500, link.error.message)
  if (!link.data) return fail(400, 'That link no longer exists. Pick another one.')

  // The server runs the finder itself, so the warnings do not depend on the screen having shown a preview.
  const found = await runFinder(admin, parsed.value)
  const { data, error } = await admin.from('affiliate_keywords').insert({ ...parsed.value, status: 'on' }).select(KEYWORD_COLUMNS).single()
  if (error) {
    if (isMissingKeywordsTable(error.message)) return missing()
    if (/duplicate key|unique/i.test(error.message)) return fail(409, 'That phrase is already linked to this link.')
    return fail(500, error.message)
  }
  const refreshed = await refreshAfterChange(admin, deps)
  // A phrase no page uses yet is still saved (it links wherever it appears from now on); the answer says so plainly.
  const warnings = found ? [...found.warnings, ...(found.emptyNotice ? [found.emptyNotice] : [])] : []
  return { status: 201, body: { keyword: data, refreshed, warnings, pageCount: found?.pageCount ?? null } }
}

export async function updateKeyword(admin: SupabaseClient, id: string, body: Record<string, unknown> | null, deps?: RefreshDeps): Promise<ActionResult> {
  if (!body) return fail(400, BAD_BODY_MESSAGE)
  const got = await allRows(admin)
  if ('error' in got) return got.error
  const current = got.rows.find((r) => r.id === id)
  if (!current) return fail(404, 'That phrase no longer exists.')

  const patch: Record<string, unknown> = {}
  if ('status' in body) {
    if (body.status !== 'on' && body.status !== 'off') return fail(400, 'Status must be on or off.')
    patch.status = body.status
  }
  if ('phrase' in body || 'scope' in body || 'max_per_page' in body || 'link_id' in body) {
    const parsed = normalizeKeywordInput({ phrase: current.phrase, link_id: current.link_id, scope: current.scope, max_per_page: current.max_per_page, ...body })
    if (!parsed.ok) return fail(400, parsed.error)
    if (parsed.value.link_id !== current.link_id) {
      const link = await admin.from('affiliate_links').select('id').eq('id', parsed.value.link_id).maybeSingle()
      if (link.error) return fail(500, link.error.message)
      if (!link.data) return fail(400, 'That link no longer exists. Pick another one.')
    }
    const conflict = phraseConflict(got.rows, parsed.value.phrase, parsed.value.link_id, id)
    if (conflict) return fail(409, conflictMessage(parsed.value.phrase, await linkNameOf(admin, conflict.link_id)))
    if (got.rows.some((r) => r.id !== id && r.link_id === parsed.value.link_id && phraseKey(r.phrase) === phraseKey(parsed.value.phrase))) return fail(409, 'That phrase is already linked to this link.')
    Object.assign(patch, parsed.value)
  }
  if (Object.keys(patch).length === 0) return fail(400, 'Nothing to change.')

  const { data, error } = await admin.from('affiliate_keywords').update(patch).eq('id', id).select(KEYWORD_COLUMNS).single()
  if (error) {
    if (isMissingKeywordsTable(error.message)) return missing()
    if (/duplicate key|unique/i.test(error.message)) return fail(409, 'That phrase is already linked to this link.')
    return fail(500, error.message)
  }
  const refreshed = await refreshAfterChange(admin, deps)
  return { status: 200, body: { keyword: data, refreshed } }
}

export async function deleteKeyword(admin: SupabaseClient, id: string, deps?: RefreshDeps): Promise<ActionResult> {
  const { error } = await admin.from('affiliate_keywords').delete().eq('id', id)
  if (error) return isMissingKeywordsTable(error.message) ? missing() : fail(500, error.message)
  const refreshed = await refreshAfterChange(admin, deps)
  return { status: 200, body: { ok: true, refreshed } }
}

/** Preview: the finder over the published content, plus a warning when the phrase already goes to another link. Writes nothing. */
export async function previewKeyword(admin: SupabaseClient, body: Record<string, unknown> | null): Promise<ActionResult> {
  if (!body) return fail(400, BAD_BODY_MESSAGE)
  const problem = phraseProblem(body.phrase)
  if (problem) return fail(400, problem)
  const phrase = cleanPhrase(body.phrase)
  if (!phrase) return fail(400, 'That phrase cannot be used.')
  const scope = body.scope == null || body.scope === '' ? 'all' : body.scope
  if (!isLinkScope(scope)) return fail(400, 'Pick where the phrase should be linked from the list.')
  const max = Number(body.max_per_page ?? 1)
  if (!Number.isInteger(max) || max < 1 || max > 3) return fail(400, 'Max per page must be 1, 2 or 3.')

  const site = await loadUsageDocs(admin)
  if (site.error) return fail(500, site.error)
  const result = previewRule(site.docs, { phrase, scope, max_per_page: max }, { totalDocs: site.totalDocs, notes: site.notes, dropped: site.dropped })
  const warnings = [...result.warnings]
  const rows = await allRows(admin)
  if (!('error' in rows)) {
    const linkId = typeof body.link_id === 'string' && body.link_id ? body.link_id : null
    const conflict = phraseConflict(rows.rows, phrase, linkId)
    if (conflict) warnings.unshift(conflictMessage(phrase, await linkNameOf(admin, conflict.link_id)) + ' Saving will be refused.')
  }
  return { status: 200, body: { ...result, warnings, limit: MAX_USAGE_DOCS } }
}
