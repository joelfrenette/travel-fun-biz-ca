import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import {
  getDistributionMode,
  setDistributionMode,
  getDistributionAccounts,
  setDistributionAccounts,
  listDistributionQueue,
  setDistributionStage,
  type DistributionMode,
} from '@/lib/distribution'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [mode, accounts, queue] = await Promise.all([
      getDistributionMode(admin),
      getDistributionAccounts(admin),
      listDistributionQueue(admin),
    ])
    return NextResponse.json({ mode, accounts, queue })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

const MODES: DistributionMode[] = ['off', 'prepare', 'auto']

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    if (typeof body.mode === 'string') {
      if (!MODES.includes(body.mode)) return NextResponse.json({ error: `mode must be one of ${MODES.join(', ')}` }, { status: 400 })
      const { error } = await setDistributionMode(admin, body.mode)
      if (error) throw new Error(error)
      return NextResponse.json({ mode: body.mode })
    }

    if (Array.isArray(body.accounts)) {
      const { error } = await setDistributionAccounts(admin, body.accounts)
      if (error) throw new Error(error)
      return NextResponse.json({ accounts: await getDistributionAccounts(admin) })
    }

    if (body.action === 'approve' || body.action === 'hold') {
      if (typeof body.slug !== 'string' || !body.slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 })
      await setDistributionStage(admin, body.slug, body.action === 'approve' ? 'queued' : 'held')
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Nothing to do — pass mode, accounts, or {action, slug}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
