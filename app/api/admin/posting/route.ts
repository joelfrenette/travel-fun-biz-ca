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
  getTailoredCaptionsEnabled,
  setTailoredCaptionsEnabled,
  type DistributionMode,
} from '@/lib/distribution'
import { uploadPostConfigured, uploadPostListProfiles, uploadPostConnectLink, UPLOAD_POST_DASHBOARD_URL } from '@/lib/upload-post'
import { isAiConfigured } from '@/lib/ai-verify'
import { getProvider, setProvider, getGhlAccounts, setGhlAccounts, type Provider, type GhlAccountRef } from '@/lib/social-provider'
import { ghlSocialConfigured, ghlSocialMissing, ghlListAccounts } from '@/lib/ghl-social'

// The one place to set up where content gets posted: provider, which profile, which connected
// accounts, and whether posts need your OK first. Replaces typing a profile name and a platform list
// into free-text boxes on the Distribution page. Only Upload-Post exists today; the `provider` field
// is returned so a GoHighLevel option can slot in without changing this shape.
export const maxDuration = 30

type PostingMode = 'review' | 'auto' | 'off'
const toDistributionMode: Record<PostingMode, DistributionMode> = { review: 'prepare', auto: 'auto', off: 'off' }
const fromDistributionMode = (m: DistributionMode): PostingMode => (m === 'prepare' ? 'review' : m)

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [mode, accounts, platforms, tailoredCaptions, listed, provider, ghlSelected, ghlListed] = await Promise.all([
      getDistributionMode(admin),
      getDistributionAccounts(admin),
      getDistributionPlatforms(admin),
      getTailoredCaptionsEnabled(admin),
      uploadPostListProfiles(),
      getProvider(admin),
      getGhlAccounts(admin),
      ghlListAccounts(),
    ])
    return NextResponse.json({
      provider,
      ghl: { configured: ghlSocialConfigured(), missing: ghlSocialMissing(), accounts: ghlListed.accounts, selected: ghlSelected, error: ghlListed.error ?? null },
      configured: uploadPostConfigured(),
      profiles: listed.profiles ?? [],
      profilesError: listed.error ?? null,
      selectedProfile: accounts[0] ?? '',
      selectedPlatforms: platforms,
      mode: fromDistributionMode(mode),
      tailoredCaptions,
      aiConfigured: isAiConfigured(),
      dashboardUrl: UPLOAD_POST_DASHBOARD_URL,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    if (body.provider === 'upload-post' || body.provider === 'ghl') {
      const { error } = await setProvider(admin, body.provider as Provider)
      if (error) throw new Error(error)
      return NextResponse.json({ ok: true })
    }
    if (Array.isArray(body.ghlAccounts)) {
      const refs = (body.ghlAccounts as unknown[]).filter(
        (a): a is GhlAccountRef => !!a && typeof (a as GhlAccountRef).id === 'string' && typeof (a as GhlAccountRef).platform === 'string' && typeof (a as GhlAccountRef).name === 'string',
      )
      const { error } = await setGhlAccounts(admin, refs)
      if (error) throw new Error(error)
      return NextResponse.json({ ok: true })
    }
    if (typeof body.profile === 'string') {
      const { error } = await setDistributionAccounts(admin, body.profile.trim() ? [body.profile.trim()] : [])
      if (error) throw new Error(error)
      // A different profile has different connected accounts, so the old platform list no longer applies.
      const cleared = await setDistributionPlatforms(admin, [])
      if (cleared.error) throw new Error(cleared.error)
      return NextResponse.json({ ok: true })
    }
    if (Array.isArray(body.platforms)) {
      const { error } = await setDistributionPlatforms(admin, body.platforms.filter((p: unknown): p is string => typeof p === 'string'))
      if (error) throw new Error(error)
      return NextResponse.json({ ok: true })
    }
    if (typeof body.mode === 'string') {
      if (!(body.mode in toDistributionMode)) return NextResponse.json({ error: 'mode must be review, auto or off' }, { status: 400 })
      const { error } = await setDistributionMode(admin, toDistributionMode[body.mode as PostingMode])
      if (error) throw new Error(error)
      return NextResponse.json({ ok: true })
    }
    if (typeof body.tailoredCaptions === 'boolean') {
      if (body.tailoredCaptions && !isAiConfigured()) return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set in Vercel.' }, { status: 400 })
      const { error } = await setTailoredCaptionsEnabled(admin, body.tailoredCaptions)
      if (error) throw new Error(error)
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'connect-link') {
      const accounts = await getDistributionAccounts(admin)
      const profile = typeof body.profile === 'string' && body.profile.trim() ? body.profile.trim() : accounts[0]
      const url = profile ? await uploadPostConnectLink(profile) : null
      // Falls back to the plain dashboard when the connect-link call fails or no profile exists yet.
      return NextResponse.json({ url: url ?? UPLOAD_POST_DASHBOARD_URL, direct: !!url })
    }
    return NextResponse.json({ error: 'Nothing to do.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
