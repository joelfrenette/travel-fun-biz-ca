import type { SupabaseClient } from '@supabase/supabase-js'
import { dedupeSlug } from '@/lib/affiliate-go'
import { PARTNERS_MIGRATION_MESSAGE, isMissingPartnersTable, normalizePartnerInput, type PartnerRow, type PartnerStatus } from '@/lib/affiliate-partners'

// WP22 part 1: the affiliate list is ONE list. A "partner" (the search button on guide pages, migration 0048) is no longer
// a second thing to manage: it is the advanced settings of a link, stored in the affiliate_partners row that the link's
// partner_id points at. Nothing about how the pages read partners and links changes (lib/things-to-do.ts, lib/trip-extras.ts).

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

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Reads the advanced object out of a request body. Returns null when the body carries none (so a partial update such as
 * ON/OFF never touches the partner settings). */
export function readAdvanced(body: Record<string, unknown>): AdvancedInput | null {
  const raw = body.advanced
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  return { partner_code: text(a.partner_code), search_template: text(a.search_template), logo_url: text(a.logo_url), disclosure: text(a.disclosure) }
}

export const hasAdvanced = (a: AdvancedInput | null): boolean => !!a && Object.values(a).some((v) => v !== '')

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
 * - the link already has a partner: update it;
 * - no partner_id but a partner has the link's slug: adopt it (link it) and update it;
 * - neither, and something was typed: create one partner for this link (one partner per link) and link it;
 * - neither and nothing typed: nothing to do.
 * The partner's status follows the link's. A missing partners table (migration 0048) is a clear 409 only when something was typed. */
export async function applyAdvanced(
  admin: SupabaseClient,
  link: { id: string; slug: string; status: string; merchant: string | null; title: string | null; sort_order: number; partner_id: string | null },
  advanced: AdvancedInput,
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

  const parsed = normalizePartnerInput({
    name: partner?.name ?? (link.merchant || link.title || link.slug),
    slug: partner?.slug ?? dedupeSlug(link.slug, partners.map((p) => p.slug)),
    logo_url: advanced.logo_url,
    partner_id: advanced.partner_code,
    search_template: advanced.search_template,
    disclosure: advanced.disclosure,
    status: partnerStatusFor(link.status),
    sort_order: partner?.sort_order ?? link.sort_order,
  })
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }

  let partnerId = partner?.id ?? null
  if (partner) {
    const { error } = await admin.from('affiliate_partners').update(parsed.value).eq('id', partner.id)
    if (error) return { ok: false, status: 500, error: error.message }
  } else {
    const { data, error } = await admin.from('affiliate_partners').insert(parsed.value).select('id').single()
    if (error) return { ok: false, status: isMissingPartnersTable(error.message) ? 409 : 500, error: isMissingPartnersTable(error.message) ? PARTNERS_MIGRATION_MESSAGE : error.message }
    partnerId = (data as { id: string }).id
  }
  if (partnerId && (adopted || !partner) && link.partner_id !== partnerId) {
    const { error } = await admin.from('affiliate_links').update({ partner_id: partnerId, updated_at: new Date().toISOString() }).eq('id', link.id)
    if (error) return { ok: false, status: 500, error: error.message }
  }
  return { ok: true }
}

/** ON or OFF for a link and, behind the scenes, for the partner (search button) that goes with it. Returns the new link status. */
export async function setLinkOnOff(admin: SupabaseClient, id: string, on: boolean): Promise<{ ok: true; status: 'active' | 'hidden' } | { ok: false; status: number; error: string }> {
  const status = on ? 'active' : 'hidden'
  let cur = await admin.from('affiliate_links').select('id, slug, partner_id').eq('id', id).maybeSingle()
  // Before migration 0048 there is no partner_id column: the link alone is switched.
  if (cur.error && /partner_id/i.test(cur.error.message)) cur = await admin.from('affiliate_links').select('id, slug').eq('id', id).maybeSingle()
  if (cur.error) return { ok: false, status: 500, error: cur.error.message }
  if (!cur.data) return { ok: false, status: 404, error: 'That link no longer exists.' }
  const link = cur.data as unknown as { id: string; slug: string | null; partner_id: string | null }
  const { error } = await admin.from('affiliate_links').update({ status, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, status: 500, error: error.message }
  // The partner follows. A database without the partners table (or without partner_id) just has nothing to follow.
  const partners = await admin.from('affiliate_partners').select('id, slug')
  if (!partners.error) {
    const p = partnerForLink(link, (partners.data ?? []) as unknown as PartnerRow[]).partner
    if (p) {
      const upd = await admin.from('affiliate_partners').update({ status }).eq('id', p.id)
      if (upd.error) return { ok: false, status: 500, error: upd.error.message }
    }
  }
  return { ok: true, status }
}

/** Deleting a link also hides its search button (a partner row is never deleted: it keeps its click history). */
export async function hidePartnerOfLink(admin: SupabaseClient, id: string): Promise<void> {
  try {
    const cur = await admin.from('affiliate_links').select('id, slug, partner_id').eq('id', id).maybeSingle()
    if (cur.error || !cur.data) return
    const partners = await admin.from('affiliate_partners').select('id, slug')
    if (partners.error) return
    const p = partnerForLink(cur.data as unknown as { slug: string | null; partner_id: string | null }, (partners.data ?? []) as unknown as PartnerRow[]).partner
    if (p) await admin.from('affiliate_partners').update({ status: 'hidden' }).eq('id', p.id)
  } catch {
    // best effort: the link delete itself must not fail because of this
  }
}
