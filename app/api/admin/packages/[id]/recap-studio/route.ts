import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { addOwnQuote, createShare, decideSubmission, editDraft, publishStudio, removeOwnQuote, revokeShare, saveStudio, snoozeTrips, studioView, undoStudio, writeDraft } from '@/lib/recap-store'
import { shareMessage, smsHref, whatsappHref } from '@/lib/recap-studio'
import { SITE_URL } from '@/lib/site'

export const maxDuration = 120

// The Recap Studio's API. Every call is admin only. Nothing here unpublishes a trip, and nothing publishes without the one
// "publish" action, which re-checks the draft first.
//   GET                                      everything the page shows (state, photos, pending items, links, draft, scores)
//   POST {action:'save', answers?, photoOrder?, coverId?}    autosave
//   POST {action:'quote-add', text, firstName, lastName?, consent}   Joel's own quote (the permission tick is required)
//   POST {action:'quote-remove', quoteId}
//   POST {action:'draft'}                    ONE model call (5 a day per trip), saved private with the checks' verdict
//   POST {action:'edit-draft', summary?, highlights?, takeaways?, faqs?}   inline edit, checked again
//   POST {action:'publish'}                  photos to the gallery, recap + FAQs live (logged), page extras saved, IndexNow
//   POST {action:'undo'}
//   POST {action:'share-create', kind:'agent'|'testimonial', agentName?}   the link is shown ONCE (only its hash is stored)
//   POST {action:'share-revoke', shareId}
//   POST {action:'decide', submissionId, decision:'approve'|'reject', text?, answers?}
//   POST {action:'snooze'}                   hides this trip from the daily prompt for 7 days
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const view = await studioView(getSupabaseAdmin(), params.id)
  return view ? NextResponse.json(view) : NextResponse.json({ error: 'Package not found' }, { status: 404 })
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: 'Send {action}.' }, { status: 400 })
  const pkg = await getPackageById(params.id)
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  const admin = getSupabaseAdmin()
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status })

  switch (body.action) {
    case 'save': {
      const r = await saveStudio(admin, params.id, { answers: body.answers, photoOrder: body.photoOrder, coverId: body.coverId })
      return r.ok ? NextResponse.json({ ok: true, errors: r.errors }) : fail(500, r.error)
    }
    case 'quote-add': {
      const r = await addOwnQuote(admin, params.id, { text: body.text, firstName: body.firstName, lastName: body.lastName, consent: body.consent })
      return r.ok ? NextResponse.json({ ok: true }) : fail(400, r.errors[0], { errors: r.errors })
    }
    case 'quote-remove': {
      if (typeof body.quoteId !== 'string') return fail(400, 'quoteId is required')
      const err = await removeOwnQuote(admin, params.id, body.quoteId)
      return err ? fail(500, err) : NextResponse.json({ ok: true })
    }
    case 'draft': {
      const r = await writeDraft(admin, params.id)
      return r.ok ? NextResponse.json({ ok: true, blockers: r.value.blockers }) : fail(r.status, r.error)
    }
    case 'edit-draft': {
      const r = await editDraft(admin, params.id, { summary: body.summary, highlights: body.highlights, takeaways: body.takeaways, faqs: body.faqs })
      return r.ok ? NextResponse.json({ ok: true, blockers: r.value.blockers }) : fail(r.status, r.error)
    }
    case 'publish': {
      const r = await publishStudio(admin, params.id)
      return r.ok ? NextResponse.json({ ok: true, ...r.value }) : fail(r.status, r.error)
    }
    case 'undo':
      return NextResponse.json({ ok: true, ...(await undoStudio(admin, params.id)) })
    case 'share-create': {
      const kind = body.kind === 'testimonial' ? 'testimonial' : 'agent'
      const r = await createShare(admin, params.id, kind, typeof body.agentName === 'string' ? body.agentName : null)
      if (!r.ok) return fail(r.status, r.error)
      const url = `${SITE_URL}${r.value.path}`
      const message = shareMessage(kind, pkg.name, url, r.value.share.agent_name)
      return NextResponse.json({ ok: true, url, message, sms: smsHref(message), whatsapp: whatsappHref(message), shareId: r.value.share.id, expiresAt: r.value.share.expires_at })
    }
    case 'share-revoke': {
      if (typeof body.shareId !== 'string') return fail(400, 'shareId is required')
      const err = await revokeShare(admin, params.id, body.shareId)
      return err ? fail(500, err) : NextResponse.json({ ok: true })
    }
    case 'decide': {
      if (typeof body.submissionId !== 'string' || (body.decision !== 'approve' && body.decision !== 'reject')) return fail(400, 'submissionId and decision are required')
      const r = await decideSubmission(admin, params.id, body.submissionId, body.decision, { text: body.text, answers: body.answers })
      return r.ok ? NextResponse.json({ ok: true }) : fail(r.status, r.error)
    }
    case 'snooze': {
      const err = await snoozeTrips(admin, [params.id])
      return err ? fail(500, err) : NextResponse.json({ ok: true })
    }
    default:
      return fail(400, 'Unknown action')
  }
}
