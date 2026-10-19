import type { SupabaseClient } from '@supabase/supabase-js'
import { dedupeSlug, isRealLink } from '@/lib/affiliate-go'
import { PARTNERS_MIGRATION_MESSAGE, isMissingPartnersTable, normalizePartnerInput, type PartnerRow, type PartnerStatus } from '@/lib/affiliate-partners'

// WP22 part 1: the affiliate list is ONE list. A "partner" (the search button on guide pages, migration 0048) is no longer
// a second thing to manage: it is the advanced settings of a link, stored in the affiliate_partners row that the link's
// partner_id points at. Nothing about how the pages read partners and links changes (lib/things-to-do.ts, lib/trip-extras.ts).
//
// Safety rules for the partner row (it can be a live search button on every guide page):
// - an ADOPTED partner (found by the link's short name, not yet linked) is touched only when the admin typed something, and
//   blank fields then mean "unchanged"; wiping needs the explicit Clear control (advanced.clear);
// - a partner's status changes only when the admin presses ON/OFF on that link (or edits the link and its status really changes);
//   saving the form never downgrades an active partner;
// - the two writes (partner, then the link's partner_id) are undone if the second fails.

export type SaveOutcome = { ok: true } | { ok: false; status: number; error: string }

/** What the advanced section of the edit form holds. Every field is optional text; empty means "not set". */
export interface AdvancedInput {
  /** Our ID with the partner (their dashboard calls it a partner ID, affiliate ID, tracking ID...). */
  partner_code: string
  search_template: string
  logo_url: string
  disclosure: string
}

export const EMPTY_ADVANCED: AdvancedInput = { partner_code: '', search_template: '', logo_url: '', disclosure: '' }

/** The advanced settings as sent: the fields, plus an explicit "clear them" flag. */
export interface AdvancedRequest extends AdvancedInput {
  clear: boolean
}

export const NEEDS_REAL_LINK_MESSAGE = 'Add a real https link first'

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Reads the advanced object out of a request body. Returns null when the body carries none (so a partial update such as
 * ON/OFF never touches the partner settings). */
export function readAdvanced(body: Record<string, unknown>): AdvancedRequest | null {
  const raw = body.advanced
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const a = raw as Record<string, unknown>
  return { partner_code: text(a.partner_code), search_template: text(a.search_template), logo_url: text(a.logo_url), disclosure: text(a.disclosure), clear: a.clear === true }
}

export const hasAdvanced = (a: AdvancedInput | null): boolean => !!a && [a.partner_code, a.search_template, a.logo_url, a.disclosure].some((v) => v !== '')

/** The partner status that goes with a link status. ON links show their search button; OFF ones do not. */
export const partnerStatusFor = (linkStatus: string): PartnerStatus => (linkStatus === 'active' ? 'active' : linkStatus === 'hidden' ? 'hidden' : 'draft')

/** Pure: which partner row belongs to this link? The one its partner_id points at; else the one with the same slug
 * (viator, getyourguide, toursbylocals, tiqets, project-expedition were created before links and partners were one list). */
export function partnerForLink(link: { slug: string | null; partner_id?: string | null }, partners: PartnerRow[]): { partner: PartnerRow | null; adopted: boolean } {
  if (link.partner_id) {
    const linked = partners.find((p) => p.id === link.partner_id)
    if (linked) return { partner: linked, adopted: false }
  }
  const same = link.slug ? partners.find((p) => p.slug === link.slug) : undefined
  return { partner: same ?? null, adopted: !!same }
}

/** Pure: partners that no link claims (by id or by slug). They are shown as "search button only" rows. */
export function orphanPartners(links: { slug: string | null; partner_id?: string | null }[], partners: PartnerRow[]): PartnerRow[] {
  const claimed = new Set<string>()
  for (const l of links) {
    const { partner } = partnerForLink(l, partners)
    if (partner) claimed.add(partner.id)
  }
  return partners.filter((p) => !claimed.has(p.id))
}

/** The advanced fields as the form shows them. */
export const advancedOf = (p: Pick<PartnerRow, 'partner_id' | 'search_template' | 'logo_url' | 'disclosure'> | null): AdvancedInput =>
  p ? { partner_code: p.partner_id ?? '', search_template: p.search_template ?? '', logo_url: p.logo_url ?? '', disclosure: p.disclosure ?? '' } : EMPTY_ADVANCED

/** Checks the advanced fields BEFORE the link is saved, with the same rules as the old partner form. */
export function validateAdvanced(a: AdvancedInput | null): SaveOutcome {
  if (!a || !hasAdvanced(a)) return { ok: true }
  const parsed = normalizePartnerInput({ name: 'x', partner_id: a.partner_code, search_template: a.search_template, logo_url: a.logo_url, disclosure: a.disclosure, status: 'draft' })
  return parsed.ok ? { ok: true } : { ok: false, status: 400, error: parsed.error }
}

const PARTNER_COLUMNS = 'id, slug, name, logo_url, partner_id, search_template, disclosure, status, sort_order'

/** After a link is saved: store the advanced settings in the partner row that goes with it.
 * - the link already has a partner: update its fields (status untouched);
 * - no partner_id but a partner has the link's slug (adopted): only when something was typed (or Clear was pressed), and a
 *   blank field keeps the partner's current value; then link it;
 * - neither, and something was typed: create one partner for this link (one partner per link) and link it;
 * - otherwise nothing is written.
 * A missing partners table (migration 0048) is a clear 409 only when something was typed. If the second write fails the
 * first is undone, so the link and the partner are never left out of step. */
export async function applyAdvanced(
  admin: SupabaseClient,
  link: { id: string; slug: string; status: string; merchant: string | null; title: string | null; sort_order: number; partner_id: string | null },
  advanced: AdvancedRequest,
): Promise<SaveOutcome> {
  const typed = hasAdvanced(advanced)
  const all = await admin.from('affiliate_partners').select(PARTNER_COLUMNS)
  if (all.error) {
    if (isMissingPartnersTable(all.error.message)) return typed ? { ok: false, status: 409, error: PARTNERS_MIGRATION_MESSAGE } : { ok: true }
    return { ok: false, status: 500, error: all.error.message }
  }
  const partners = (all.data ?? []) as unknown as PartnerRow[]
  const { partner, adopted } = partnerForLink(link, partners)
  if (!partner && !typed) return { ok: true }
  // An adopted partner is somebody's live search button: leave it alone unless the admin typed or pressed Clear.
  if (partner && adopted && !typed && !advanced.clear) return { ok: true }

  const keepBlank = !!partner && adopted && !advanced.clear
  const pick = (typedValue: string, current: string | null | undefined) => (keepBlank && typedValue === '' ? current ?? '' : typedValue)
  const parsed = normalizePartnerInput({
    name: partner?.name ?? (link.merchant || link.title || link.slug),
    slug: partner?.slug ?? dedupeSlug(link.slug, partners.map((p) => p.slug)),
    logo_url: pick(advanced.logo_url, partner?.logo_url),
    partner_id: pick(advanced.partner_code, partner?.partner_id),
    search_template: pick(advanced.search_template, partner?.search_template),
    disclosure: pick(advanced.disclosure, partner?.disclosure),
    status: partner ? partner.status : partnerStatusFor(link.status),
    sort_order: partner?.sort_order ?? link.sort_order,
  })
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }

  let partnerId = partner?.id ?? null
  let created = false
  if (partner) {
    const { error } = await admin.from('affiliate_partners').update(parsed.value).eq('id', partner.id)
    if (error) return { ok: false, status: 500, error: error.message }
  } else {
    const { data, error } = await admin.from('affiliate_partners').insert(parsed.value).select('id').single()
    if (error) return { ok: false, status: isMissingPartnersTable(error.message) ? 409 : 500, error: isMissingPartnersTable(error.message) ? PARTNERS_MIGRATION_MESSAGE : error.message }
    partnerId = (data as { id: string }).id
    created = true
  }
  if (partnerId && (adopted || created) && link.partner_id !== partnerId) {
    const { error } = await admin.from('affiliate_links').update({ partner_id: partnerId, updated_at: new Date().toISOString() }).eq('id', link.id)
    if (error) {
      // Undo the partner write so nothing is half done.
      if (created) await admin.from('affiliate_partners').delete().eq('id', partnerId)
      else if (partner) await admin.from('affiliate_partners').update({ name: partner.name, logo_url: partner.logo_url, partner_id: partner.partner_id, search_template: partner.search_template, disclosure: partner.disclosure, status: partner.status, sort_order: partner.sort_order }).eq('id', partner.id)
      return { ok: false, status: 500, error: error.message }
    }
  }
  return { ok: true }
}

async function readLinkForSwitch(admin: SupabaseClient, id: string) {
  let cur = await admin.from('affiliate_links').select('id, slug, url, partner_id').eq('id', id).maybeSingle()
  // Before migration 0048 there is no partner_id column: the link alone is switched.
  if (cur.error && /partner_id/i.test(cur.error.message)) cur = await admin.from('affiliate_links').select('id, slug, url').eq('id', id).maybeSingle()
  return cur
}

/** Sets the status of the search button that goes with a link (by partner_id, else by the same short name). Only called when
 * the admin pressed ON or OFF, or really changed the link's status. */
export async function syncPartnerStatus(admin: SupabaseClient, link: { slug: string | null; partner_id?: string | null }, status: PartnerStatus): Promise<SaveOutcome> {
  const partners = await admin.from('affiliate_partners').select('id, slug')
  if (partners.error) return { ok: true } // no partners table: nothing to follow
  const p = partnerForLink(link, (partners.data ?? []) as unknown as PartnerRow[]).partner
  if (!p) return { ok: true }
  const upd = await admin.from('affiliate_partners').update({ status }).eq('id', p.id)
  return upd.error ? { ok: false, status: 500, error: upd.error.message } : { ok: true }
}

/** ON or OFF for a link and, behind the scenes, for the partner (search button) that goes with it. Turning ON needs a real
 * https link (an empty or placeholder address would send every visitor to the home page). Returns the new link status. */
export async function setLinkOnOff(admin: SupabaseClient, id: string, on: boolean): Promise<{ ok: true; status: 'active' | 'hidden' } | { ok: false; status: number; error: string }> {
  const status = on ? 'active' : 'hidden'
  const cur = await readLinkForSwitch(admin, id)
  if (cur.error) return { ok: false, status: 500, error: cur.error.message }
  if (!cur.data) return { ok: false, status: 404, error: 'That link no longer exists.' }
  const link = cur.data as unknown as { id: string; slug: string | null; url: string | null; partner_id?: string | null }
  if (on && !isRealLink(link.url)) return { ok: false, status: 400, error: NEEDS_REAL_LINK_MESSAGE }
  const { error } = await admin.from('affiliate_links').update({ status, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, status: 500, error: error.message }
  const synced = await syncPartnerStatus(admin, link, status)
  if (!synced.ok) {
    // Put the link back so link and search button do not disagree.
    await admin.from('affiliate_links').update({ status: on ? 'hidden' : 'active' }).eq('id', id)
    return { ok: false, status: synced.status, error: synced.error }
  }
  return { ok: true, status }
}

/** The partner row that goes with a link, read before the link is deleted. Null when there is none. */
export async function partnerIdOfLink(admin: SupabaseClient, id: string): Promise<string | null> {
  try {
    let cur = await admin.from('affiliate_links').select('id, slug, partner_id').eq('id', id).maybeSingle()
    if (cur.error && /partner_id/i.test(cur.error.message)) cur = await admin.from('affiliate_links').select('id, slug').eq('id', id).maybeSingle()
    if (cur.error || !cur.data) return null
    const partners = await admin.from('affiliate_partners').select('id, slug')
    if (partners.error) return null
    return partnerForLink(cur.data as unknown as { slug: string | null; partner_id?: string | null }, (partners.data ?? []) as unknown as PartnerRow[]).partner?.id ?? null
  } catch {
    return null
  }
}

/** After a link was deleted: hide its search button. A partner row is never deleted (it keeps its click history). Best effort. */
export async function hidePartner(admin: SupabaseClient, partnerId: string | null): Promise<void> {
  if (!partnerId) return
  try {
    await admin.from('affiliate_partners').update({ status: 'hidden' }).eq('id', partnerId)
  } catch {
    // the link delete already succeeded; a leftover active search button can be switched OFF from the list
  }
}
