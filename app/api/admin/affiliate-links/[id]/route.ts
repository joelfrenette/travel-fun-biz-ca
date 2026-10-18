import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { normalizeAffiliateLinkInput, saveLink } from '@/lib/affiliate-links-admin'
import { applyAdvanced, hidePartnerOfLink, readAdvanced, setLinkOnOff, validateAdvanced } from '@/lib/affiliate-link-partner'
import { refreshAfterChange } from '@/lib/affiliate-refresh'

// Every change here (edit, ON, OFF, delete) refreshes the whole site afterwards: the word links read the link at display
// time, so cached pages, the in-memory rules and the usage report are what has to be brought up to date.

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    // ON or OFF: a body that is only a status. The link and, behind the scenes, its search button are switched together.
    const keys = Object.keys(body as object)
    if (keys.length === 1 && keys[0] === 'status') {
      const wanted = (body as { status?: unknown }).status
      if (wanted !== 'active' && wanted !== 'hidden') return NextResponse.json({ error: 'Status must be active (ON) or hidden (OFF).' }, { status: 400 })
      const result = await setLinkOnOff(admin, params.id, wanted === 'active')
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
      const refreshed = await refreshAfterChange(admin)
      return NextResponse.json({ ok: true, status: result.status, refreshed })
    }

    // An unchanged legacy URL stays editable (status, sort order...); only a new or changed URL must be https.
    const { data: current } = await admin.from('affiliate_links').select('url').eq('id', params.id).maybeSingle()
    const parsed = normalizeAffiliateLinkInput(body, { previousUrl: (current as { url?: string } | null)?.url ?? null })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const advanced = readAdvanced(body as Record<string, unknown>)
    const advancedCheck = validateAdvanced(advanced)
    if (!advancedCheck.ok) return NextResponse.json({ error: advancedCheck.error }, { status: advancedCheck.status })

    // Editing keeps its own slug unless the admin typed a different one — a real collision here
    // is a mistake worth a clear error, not a silent rename, so this does NOT dedupe automatically.
    const { data: taken, error: takenError } = await admin.from('affiliate_links').select('slug').neq('id', params.id)
    if (takenError) throw new Error(takenError.message)
    if ((taken ?? []).some((r) => r.slug === parsed.value.slug)) {
      return NextResponse.json({ error: `The short link "/go/${parsed.value.slug}" is already used by another card.` }, { status: 409 })
    }

    const saved = await saveLink(admin, parsed.value, params.id)
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status })
    if (advanced) {
      const s = saved.data as { id: string; slug: string; status: string; merchant: string | null; title: string | null; sort_order: number; partner_id?: string | null }
      const applied = await applyAdvanced(admin, { ...s, partner_id: s.partner_id ?? null }, advanced)
      if (!applied.ok) return NextResponse.json({ error: `The link was saved, but its search button settings were not: ${applied.error}` }, { status: applied.status })
    }
    const refreshed = await refreshAfterChange(admin)
    return NextResponse.json({ link: saved.data, refreshed })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    await hidePartnerOfLink(admin, params.id)
    // The phrases of this link go with it (the keywords table deletes them with the link).
    const { error } = await admin.from('affiliate_links').delete().eq('id', params.id)
    if (error) throw new Error(error.message)
    const refreshed = await refreshAfterChange(admin)
    return NextResponse.json({ ok: true, refreshed })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
