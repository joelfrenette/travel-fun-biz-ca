import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getPackageById } from '@/lib/packages'
import { runTripKitFill, tripKitStatus } from '@/lib/trip-kit-run'
import { undoTripKit } from '@/lib/trip-kit-fill'
import { confirmTripPrice, clearTripPrice } from '@/lib/trip-kit-store'

export const maxDuration = 300

// Trip Page Kit, admin side, for one trip.
//   GET                               scores, "to confirm with an agent" list, the confirmed-price record
//   POST {action:'fill'}              fill this page (cached fact sheet, capped AI calls, every change logged with Undo)
//   POST {action:'confirm_price', by, text}   an agent confirmed a price: ONLY an admin click does this, never the engine
//   POST {action:'clear_price'}       take the confirmed price off the page
//   POST {action:'undo'}              put back the previous kit record (column edits are undone with Revert on the kit source)
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const pkg = await getPackageById(params.id)
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  return NextResponse.json(await tripKitStatus(getSupabaseAdmin(), pkg))
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as { action?: unknown; by?: unknown; text?: unknown; refresh?: unknown } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  const admin = getSupabaseAdmin()

  if (body.action === 'fill') {
    const r = await runTripKitFill(admin, params.id, { refresh: body.refresh === true })
    return NextResponse.json(r, { status: r.ok ? 200 : 422 })
  }
  if (body.action === 'confirm_price') {
    const r = await confirmTripPrice(admin, params.id, { by: String(body.by ?? ''), text: String(body.text ?? '') })
    return r.ok ? NextResponse.json({ ok: true, price: r.record }) : NextResponse.json({ error: r.error }, { status: 400 })
  }
  if (body.action === 'clear_price') return NextResponse.json({ ok: await clearTripPrice(admin, params.id) })
  if (body.action === 'undo') return NextResponse.json({ ok: await undoTripKit(admin, params.id) })
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
