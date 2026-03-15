import { NextResponse } from 'next/server'
import { verifyAdminCredentials } from '@/lib/auth'
import { createSessionValue } from '@/lib/session'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    const valid = await verifyAdminCredentials(email, password)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Create session token and return it with an explicit Set-Cookie on the response
    const sessionValue = createSessionValue({ email })
    const res = NextResponse.json({ success: true })

    // Set cookie on the response so the browser receives it reliably
    res.cookies.set('adminSession', sessionValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 8,
    })

    console.log('[admin-login] issued session for', email)
    return res
  } catch (error) {
    console.error('[admin-login] Unexpected error', error)
    return NextResponse.json({ error: 'Unable to login' }, { status: 500 })
  }
}