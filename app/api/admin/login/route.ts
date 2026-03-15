import { NextResponse } from 'next/server'
import { checkCredentials, createToken } from '@/lib/admin-auth'

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    if (!checkCredentials(email, password)) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const token = createToken(email)
    return NextResponse.json({ token })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
