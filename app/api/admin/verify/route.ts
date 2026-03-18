import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'

export async function POST(request: Request) {
  try {
    const { token } = await request.json()
    const email = validateToken(token)

    if (!email) {
      return NextResponse.json({ valid: false }, { status: 401 })
    }

    return NextResponse.json({ valid: true, email })
  } catch {
    return NextResponse.json({ valid: false }, { status: 500 })
  }
}
