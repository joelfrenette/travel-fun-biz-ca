import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { isShotstackConfigured, buildVideoEdit, submitRender, getRenderStatus } from '@/lib/shotstack'
import type { VideoScript } from '@/lib/video-script'

export const maxDuration = 30

/** Manual, admin-triggered only - submits a render job for a script the admin already reviewed
 * (via /video-script). Costs real money per render once SHOTSTACK_API_KEY is set; never called
 * from a cron. lib/shotstack.ts is NOT yet live-tested against a real Shotstack account - the
 * first real submission here should be treated as that test, not a known-working feature. */
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isShotstackConfigured()) return NextResponse.json({ error: 'SHOTSTACK_API_KEY is not set - add it in Vercel to render video.' }, { status: 503 })
  try {
    const body = (await request.json()) as { script?: VideoScript }
    if (!body.script || !Array.isArray(body.script.beats) || body.script.beats.length === 0) {
      return NextResponse.json({ error: 'A valid script is required - generate one first.' }, { status: 400 })
    }
    const edit = buildVideoEdit(body.script)
    const result = await submitRender(edit)
    if (!result.ok) return NextResponse.json({ error: result.error || 'Shotstack rejected the render.' }, { status: 502 })
    return NextResponse.json({ renderId: result.renderId })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

/** Polls one render's progress by id (?renderId=...). */
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isShotstackConfigured()) return NextResponse.json({ error: 'SHOTSTACK_API_KEY is not set.' }, { status: 503 })
  const renderId = new URL(request.url).searchParams.get('renderId')
  if (!renderId) return NextResponse.json({ error: 'renderId is required' }, { status: 400 })
  const status = await getRenderStatus(renderId)
  if (!status.ok) return NextResponse.json({ error: status.error || 'Could not read render status.' }, { status: 502 })
  return NextResponse.json(status)
}
