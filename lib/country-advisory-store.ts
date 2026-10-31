import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict } from '@/lib/app-settings'
import {
  ADVISORY_COLUMNS,
  ADVISORY_MODE_KEY,
  advisoryTitle,
  CA_ADVISORY_SOURCE_KEY,
  UK_ADVISORY_SOURCE_KEY,
  confirmedSlugs,
  countrySlugOf,
  parseAdvisoryMode,
  planCanadaWrite,
  planUkWrite,
  type AdvisoryLogRow,
  type AdvisoryMode,
  type CaEvent,
  type CountryAdvisoryRow,
  type UkEvent,
  type WritePlan,
} from '@/lib/country-advisory'

// Travel advisories: the database side. Every read here fails closed (an unreadable table or setting means "no page", "mode off",
// "no write"), and the dual write NEVER throws into the news ingest: a problem becomes a note, and the news posts go on as before.

/** The switch, read fail-closed: anything unreadable or unrecognised is 'off'. */
export async function getAdvisoryMode(admin: SupabaseClient): Promise<AdvisoryMode> {
  try {
    const r = await getSettingStrict(admin, ADVISORY_MODE_KEY)
    return r.error ? 'off' : parseAdvisoryMode(r.value)
  } catch {
    return 'off'
  }
}

export async function setAdvisoryMode(admin: SupabaseClient, mode: AdvisoryMode): Promise<{ error?: string }> {
  if (mode !== 'off' && mode !== 'log' && mode !== 'on') return { error: 'the mode must be off, log or on' }
  const { error } = await admin.from('app_settings').upsert({ key: ADVISORY_MODE_KEY, value: mode, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  return error ? { error: error.message } : {}
}

export async function readAdvisoryRow(admin: SupabaseClient, slug: string): Promise<CountryAdvisoryRow | null> {
  const { data, error } = await admin.from('country_advisories').select(ADVISORY_COLUMNS).eq('slug', slug).maybeSingle()
  if (error) throw new Error(`country_advisories: ${error.message}`)
  return (data as CountryAdvisoryRow | null) ?? null
}

/** Published rows (any data state), or [] when the table cannot be read. */
export async function listPublishedAdvisories(admin: SupabaseClient): Promise<CountryAdvisoryRow[]> {
  try {
    const { data, error } = await admin.from('country_advisories').select(ADVISORY_COLUMNS).eq('status', 'published').limit(1000)
    return error ? [] : ((data ?? []) as CountryAdvisoryRow[])
  } catch {
    return []
  }
}

export async function readAdvisoryLog(admin: SupabaseClient, slug: string): Promise<AdvisoryLogRow[]> {
  try {
    const { data, error } = await admin
      .from('country_advisory_log')
      .select('country_slug, source_key, guid, kind, level_from, level_to, text, source_url, source_published_at, news_item_id, created_at')
      .eq('country_slug', slug)
      .order('created_at', { ascending: false })
      .limit(200)
    return error ? [] : ((data ?? []) as AdvisoryLogRow[])
  } catch {
    return []
  }
}

/** Log rows for several countries at once, grouped by country (for the sitemap and the index). */
export async function readLogsBySlug(admin: SupabaseClient, slugs: string[]): Promise<Record<string, AdvisoryLogRow[]>> {
  const out: Record<string, AdvisoryLogRow[]> = {}
  if (slugs.length === 0) return out
  try {
    const { data, error } = await admin
      .from('country_advisory_log')
      .select('country_slug, source_key, guid, kind, level_from, level_to, text, source_url, source_published_at, news_item_id, created_at')
      .in('country_slug', slugs)
      .limit(5000)
    if (error) return out
    for (const l of (data ?? []) as AdvisoryLogRow[]) (out[l.country_slug] ??= []).push(l)
  } catch {
    /* an unreadable log only means no dates */
  }
  return out
}

export interface WriteOutcome {
  ok: boolean
  /** A NEW log row went in (false for a repeat guid or a failed write). */
  logged: boolean
  levelChange: { slug: string; name: string; from: string; to: string } | null
  note?: string
}

async function applyPlan(admin: SupabaseClient, plan: WritePlan): Promise<WriteOutcome> {
  if (!plan.ok) return { ok: false, logged: false, levelChange: null, note: plan.note }
  const nowIso = new Date().toISOString()
  const { row } = plan
  if (plan.created) {
    const { error } = await admin.from('country_advisories').insert({ ...row, updated_at: nowIso })
    if (error) return { ok: false, logged: false, levelChange: null, note: `country_advisories: ${error.message}`.slice(0, 200) }
  } else {
    const { slug, ...patch } = row
    const { error } = await admin.from('country_advisories').update({ ...patch, updated_at: nowIso }).eq('slug', slug)
    if (error) return { ok: false, logged: false, levelChange: null, note: `country_advisories: ${error.message}`.slice(0, 200) }
  }
  if (!plan.log) return { ok: true, logged: false, levelChange: null }
  const { data: seen, error: seenErr } = await admin.from('country_advisory_log').select('guid').eq('source_key', plan.log.source_key).eq('guid', plan.log.guid).maybeSingle()
  if (seenErr) return { ok: false, logged: false, levelChange: null, note: `country_advisory_log: ${seenErr.message}`.slice(0, 200) }
  if (seen) return { ok: true, logged: false, levelChange: null }
  const { error: logErr } = await admin.from('country_advisory_log').insert(plan.log)
  if (logErr) {
    if ((logErr as { code?: string }).code === '23505') return { ok: true, logged: false, levelChange: null }
    return { ok: false, logged: false, levelChange: null, note: `country_advisory_log: ${logErr.message}`.slice(0, 200) }
  }
  const lc = plan.log.kind === 'level_change' && plan.log.level_from && plan.log.level_to ? { slug: row.slug, name: row.name, from: plan.log.level_from, to: plan.log.level_to } : null
  return { ok: true, logged: true, levelChange: lc }
}

export async function writeCanadaEvent(admin: SupabaseClient, ev: CaEvent, prevLevel: string | null, now: Date, unsafe?: (t: string) => boolean): Promise<WriteOutcome> {
  try {
    const slug = countrySlugOf(ev.name)
    const existing = slug ? await readAdvisoryRow(admin, slug) : null
    return await applyPlan(admin, planCanadaWrite(existing, ev, prevLevel, now.toISOString(), unsafe))
  } catch (e) {
    return { ok: false, logged: false, levelChange: null, note: e instanceof Error ? e.message.slice(0, 200) : 'unexpected error' }
  }
}

export async function writeUkEvent(admin: SupabaseClient, ev: UkEvent, now: Date, unsafe?: (t: string) => boolean): Promise<WriteOutcome> {
  try {
    const slug = countrySlugOf(ev.country)
    const existing = slug ? await readAdvisoryRow(admin, slug) : null
    return await applyPlan(admin, planUkWrite(existing, ev, now.toISOString(), unsafe))
  } catch (e) {
    return { ok: false, logged: false, levelChange: null, note: e instanceof Error ? e.message.slice(0, 200) : 'unexpected error' }
  }
}

/** After a good read of the Canada snapshot: the countries whose stored level it CONFIRMS get a fresh ca_checked_at. Returns how many. */
export async function markCanadaChecked(admin: SupabaseClient, snapshot: { stateKey?: string; stateLevel?: string }[], now: Date): Promise<number> {
  try {
    const { data, error } = await admin.from('country_advisories').select('slug, iso, ca_level').not('iso', 'is', null)
    if (error) return 0
    const slugs = confirmedSlugs(snapshot, (data ?? []) as { slug: string; iso: string | null; ca_level: string | null }[])
    if (slugs.length === 0) return 0
    const { error: upErr } = await admin.from('country_advisories').update({ ca_checked_at: now.toISOString() }).in('slug', slugs)
    return upErr ? 0 : slugs.length
  } catch {
    return 0
  }
}

export { CA_ADVISORY_SOURCE_KEY, UK_ADVISORY_SOURCE_KEY }

/** What the posting pass reads for a country advisory ledger row (path /travel-advisories/<country>): only a published page with a
 * Canadian level, only while the mode is 'on'. The caption text is the government's own level wording in quote marks, attributed,
 * and nothing else. Null = nothing is posted. Throws on a database error so the pass retries it. */
export async function loadAdvisoryPostSource(admin: SupabaseClient, countrySlug: string): Promise<{ title: string; cover_image_url: null; meta_description: string; grounding: string; faqQuestions: string[]; keyTakeaways: string[] } | null> {
  if ((await getAdvisoryMode(admin)) !== 'on') return null
  const row = await readAdvisoryRow(admin, countrySlug)
  if (!row || row.status !== 'published' || !row.ca_level) return null
  const line = `The Government of Canada's advisory for ${row.name} now reads: "${row.ca_level.replace(/"/g, "'")}".`
  return { title: advisoryTitle(row), cover_image_url: null, meta_description: line, grounding: line, faqQuestions: [], keyTakeaways: [line] }
}
