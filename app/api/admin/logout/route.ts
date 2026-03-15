import { NextResponse } from 'next/server'
import { revokeToken } from '@/lib/admin-auth'

export async function POST(request: Request) {
  try {
    const { token } = await request.json()
    if (token) revokeToken(token)
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ success: true })
  }
}
