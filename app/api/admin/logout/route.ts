import { NextResponse } from 'next/server'
import { revokeToken, validateToken } from '@/lib/admin-auth'
import { recordAuthEvent } from '@/lib/auth-log'

export async function POST(request: Request) {
  try {
    const { token } = await request.json()
    if (token) {
      // Only a valid token leaves a log row, so a stranger cannot fill the log.
      if (validateToken(token)) await recordAuthEvent('logout', request)
      revokeToken(token)
    }
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ success: true })
  }
}
