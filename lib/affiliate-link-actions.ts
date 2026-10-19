import type { SupabaseClient } from '@supabase/supabase-js'
import { dedupeSlug, isRealLink } from '@/lib/affiliate-go'
import { normalizeAffiliateLinkInput, saveLink } from '@/lib/affiliate-links-admin'
import { applyAdvanced, hidePartner, partnerIdOfLink, partnerStatusFor, readAdvanced, setLinkOnOff, syncPartnerStatus, validateAdvanced, NEEDS_REAL_LINK_MESSAGE } from '@/lib/affiliate-link-partner'
import { refreshAfterChange, type RefreshDeps } from '@/lib/affiliate-refresh'
import { BAD_BODY_MESSAGE } from '@/lib/admin-body'

// WP22: the write actions behind the Affiliate links routes, kept out of the route files so they can be exercised against an
// in-memory database. Each returns the HTTP status and JSON body for the route to send. Every path that saved anything
// refreshes the whole site before answering, including the paths that then fail.

export interface ActionResult {
  status: number
  body: Record<string, unknown>
}

type LinkRowShape = { id: string; slug: string; status: string; merchant: string | null; title: string | null; sort_order: number; partner_id?: string | null }

const fail = (status: number, error: string): ActionResult => ({ status, body: { error } })

/** Adds a link. It always starts OFF (hidden); the admin switches it on. */
export async function createLink(admin: SupabaseClient, rawBody: Record<string, unknown> | null, deps?: RefreshDeps): Promise<ActionResult> {
  if (!rawBody) return fail(400, BAD_BODY_MESSAGE)
  const parsed = normalizeAffiliateLinkInput(rawBody)
  if (!parsed.ok) return fail(400, parsed.error)
  parsed.value.status = 'hidden'
  const advanced = readAdvanced(rawBody)
  const check = validateAdvanced(advanced)
  if (!check.ok) return fail(check.status, check.error)

  // A brand-new card never 500s on a slug collision: it is deduped against every taken slug.
  const { data: existing, error: existingError } = await admin.from('affiliate_links').select('slug')
  if (existingError) return fail(500, existingError.message)
  const slug = dedupeSlug(parsed.value.slug, (existing ?? []).map((r) => (r as { slug: string }).slug))

  const saved = await saveLink(admin, { ...parsed.value, slug })
  if (!saved.ok) return fail(saved.status, saved.error)
  const s = saved.data as unknown as LinkRowShape
  if (advanced) {
    const applied = await applyAdvanced(admin, { ...s, partner_id: s.partner_id ?? null }, advanced)
    if (!applied.ok) {
      await admin.from('affiliate_links').delete().eq('id', s.id) // do not leave a half-added link
      await refreshAfterChange(admin, deps)
      return fail(applied.status, `The link was not added, because its search button settings could not be saved: ${applied.error}`)
    }
  }
  const refreshed = await refreshAfterChange(admin, deps)
  return { status: 201, body: { link: { ...saved.data, clicks: { total: 0, last7: 0, last30: 0 } }, refreshed } }
}

/** ON or OFF (a body that is only a status), or a full edit. */
export async function editLink(admin: SupabaseClient, id: string, rawBody: Record<string, unknown> | null, deps?: RefreshDeps): Promise<ActionResult> {
  if (!rawBody) return fail(400, BAD_BODY_MESSAGE)
  const keys = Object.keys(rawBody)
  if (keys.length === 1 && keys[0] === 'status') {
    const wanted = rawBody.status
    if (wanted !== 'active' && wanted !== 'hidden') return fail(400, 'Status must be active (ON) or hidden (OFF).')
    const result = await setLinkOnOff(admin, id, wanted === 'active')
    if (!result.ok) return fail(result.status, result.error)
    const refreshed = await refreshAfterChange(admin, deps)
    return { status: 200, body: { ok: true, status: result.status, refreshed } }
  }

  const { data: current } = await admin.from('affiliate_links').select('*').eq('id', id).maybeSingle()
  const before = current as (LinkRowShape & { url?: string }) | null
  if (!before) return fail(404, 'That link no longer exists.')
  // An unchanged legacy URL stays editable (status, sort order...); only a new or changed URL must be https.
  const parsed = normalizeAffiliateLinkInput(rawBody, { previousUrl: before.url ?? null })
  if (!parsed.ok) return fail(400, parsed.error)
  // ON needs a real link, however the status is sent.
  if (parsed.value.status === 'active' && !isRealLink(parsed.value.url)) return fail(400, NEEDS_REAL_LINK_MESSAGE)
  const advanced = readAdvanced(rawBody)
  const check = validateAdvanced(advanced)
  if (!check.ok) return fail(check.status, check.error)

  // Editing keeps its own slug unless the admin typed a different one: a collision is a clear error, not a silent rename.
  const { data: taken, error: takenError } = await admin.from('affiliate_links').select('slug').neq('id', id)
  if (takenError) return fail(500, takenError.message)
  if ((taken ?? []).some((r) => (r as { slug: string }).slug === parsed.value.slug)) return fail(409, `The short link "/go/${parsed.value.slug}" is already used by another card.`)

  const saved = await saveLink(admin, parsed.value, id)
  if (!saved.ok) return fail(saved.status, saved.error)
  const s = saved.data as unknown as LinkRowShape
  let failure: ActionResult | null = null
  // The search button follows only a REAL change of the link's status (the form never downgrades a live one by itself).
  if (before.status !== s.status) {
    const synced = await syncPartnerStatus(admin, { slug: s.slug, partner_id: s.partner_id ?? null }, partnerStatusFor(s.status))
    if (!synced.ok) failure = fail(synced.status, synced.error)
  }
  if (!failure && advanced) {
    const applied = await applyAdvanced(admin, { ...s, partner_id: s.partner_id ?? null }, advanced)
    if (!applied.ok) failure = fail(applied.status, applied.error)
  }
  if (failure) {
    // Put the link back as it was so link and search button agree, and refresh anyway.
    const { id: _id, ...old } = before as Record<string, unknown>
    void _id
    await admin.from('affiliate_links').update(old).eq('id', id)
    await refreshAfterChange(admin, deps)
    return { status: failure.status, body: { error: `Nothing was changed: ${failure.body.error as string}` } }
  }
  const refreshed = await refreshAfterChange(admin, deps)
  return { status: 200, body: { link: saved.data, refreshed } }
}

/** Deletes a link (its phrases go with it) and then hides its search button. The button is only touched once the delete worked. */
export async function removeLink(admin: SupabaseClient, id: string, deps?: RefreshDeps): Promise<ActionResult> {
  const partnerId = await partnerIdOfLink(admin, id)
  const { error } = await admin.from('affiliate_links').delete().eq('id', id)
  if (error) return fail(500, error.message)
  await hidePartner(admin, partnerId)
  const refreshed = await refreshAfterChange(admin, deps)
  return { status: 200, body: { ok: true, refreshed } }
}
