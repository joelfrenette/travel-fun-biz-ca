import { NextResponse } from 'next/server'
import { secretMatches } from '@/lib/secret-compare'

// Same fail-closed pattern as lib/cron-auth.ts, adapted for a webhook GHL calls rather than a
// scheduled job: refuses outright when GOHIGHLEVEL_WEBHOOK_SECRET isn't set, so a forgotten env
// var never means "anyone may post a fake purchase," which is what an `if (secret && ...)` check
// would do on a deployment where the variable was forgotten.
export function ghlWebhookUnauthorized(providedSecret: string | null | undefined): NextResponse | null {
  const secret = process.env.GOHIGHLEVEL_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: 'webhook_secret_not_set' }, { status: 503 })
  return secretMatches(providedSecret, secret) ? null : NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}
