import { NextResponse } from 'next/server'
import { secretMatches } from '@/lib/secret-compare'

// Ported from Nomad Escape Plan (Factory Phase 1: foundation), adapted only in import paths.
/**
 * The gate in front of every /api/cron/* route this program adds. Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on scheduled runs.
 *
 * It refuses outright when CRON_SECRET isn't set. These jobs will spend AI credits, post
 * publicly and send email once later phases wire them up, so "no secret configured" must never
 * mean "anyone may run them" — which is what an `if (secret && ...)` check would do on a
 * deployment where the variable was forgotten.
 *
 * Returns the response to send back, or null when the caller may proceed. No cron route exists
 * yet in this phase; this is the shared gate every future one calls first.
 */
export function cronUnauthorized(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'cron_secret_not_set' }, { status: 503 })
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  return secretMatches(token, secret) ? null : NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}
