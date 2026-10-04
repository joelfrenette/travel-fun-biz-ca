import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import {
  getDistributionMode,
  setDistributionMode,
  getDistributionAccounts,
  setDistributionAccounts,
  getDistributionPlatforms,
  setDistributionPlatforms,
  listDistributionQueue,
  setDistributionStage,
  getTailoredCaptionsEnabled,
  setTailoredCaptionsEnabled,
  syncPendingDistribution,
  type DistributionMode,
} from '@/lib/distribution'
import { uploadPostConfigured } from '@/lib/upload-post'
import { isAiConfigured } from '@/lib/ai-verify'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [mode, accounts, platforms, queue, tailoredCaptions] = await Promise.all([
      getDistributionMode(admin),
      getDistributionAccounts(admin),
      getDistributionPlatforms(admin),
      listDistributionQueue(admin),
      getTailoredCaptionsEnabled(admin),
    ])
    return NextResponse.json({
      mode,
      accounts,
      platforms,
      queue,
      providerConfigured: uploadPostConfigured(),
      tailoredCaptions,
      aiConfigured: isAiConfigured(),
    })
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

    if (Array.isArray(body.platforms)) {
      const { error } = await setDistributionPlatforms(admin, body.platforms)
      if (error) throw new Error(error)
      return NextResponse.json({ platforms: await getDistributionPlatforms(admin) })
    }

    if (typeof body.tailoredCaptions === 'boolean') {
      if (body.tailoredCaptions && !isAiConfigured()) {
        return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set - add it in Vercel before turning this on.' }, { status: 400 })
      }
      const { error } = await setTailoredCaptionsEnabled(admin, body.tailoredCaptions)
      if (error) throw new Error(error)
      return NextResponse.json({ tailoredCaptions: body.tailoredCaptions })
    }

    if (body.action === 'sync') {
      const note = await syncPendingDistribution(admin)
      return NextResponse.json({ note })
    }

    if (body.action === 'approve' || body.action === 'hold') {
      if (typeof body.slug !== 'string' || !body.slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 })
      await setDistributionStage(admin, body.slug, body.action === 'approve' ? 'queued' : 'held')
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Nothing to do — pass mode, accounts, platforms, or {action, slug}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
