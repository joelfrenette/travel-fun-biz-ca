import { NextResponse } from 'next/server'
import { verifyAdminCredentials } from '@/lib/auth'
import { createSessionValue } from '@/lib/session'
import { createToken } from '@/lib/simple-session'

export async function POST(request: Request) {
  try {
    let body: any = {}
    const contentType = request.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      body = await request.json()
    } else {
      // support form submissions (browser form POST)
      const form = await request.formData()
      body = Object.fromEntries(form.entries())
    }

    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const redirect = typeof body.redirect === 'string' ? body.redirect : ''

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    const valid = await verifyAdminCredentials(email, password)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // Create an in-memory token and return it as a host-only cookie
    const token = createToken(email)

    const cookieOptions: any = {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 8,
    }

    if (redirect) {
      const loginUrl = new URL(redirect, request.url)
      const res = NextResponse.redirect(loginUrl)
      res.cookies.set('adminToken', token, cookieOptions)
      console.log('[admin-login] issued simple token and redirect for', email)
      return res
    }

    const res = NextResponse.json({ success: true })
    res.cookies.set('adminToken', token, cookieOptions)
    console.log('[admin-login] issued simple token for', email)
    return res
  } catch (error) {
    console.error('[admin-login] Unexpected error', error)
    return NextResponse.json({ error: 'Unable to login' }, { status: 500 })
  }
}