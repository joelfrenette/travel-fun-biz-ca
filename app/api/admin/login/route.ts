import { NextResponse } from 'next/server'
import { verifyAdminCredentials } from '@/lib/auth'
import { createSessionValue } from '@/lib/session'

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

    // Create session token and either redirect (form flow) or return JSON
    const sessionValue = createSessionValue({ email })

    const cookieOptions: any = {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 8,
    }

    // Use host-only cookie (no explicit domain) to avoid domain mismatches.

    if (redirect) {
      // Return a redirect response with Set-Cookie so the browser receives the cookie and follows the redirect
      const loginUrl = new URL(redirect, request.url)
      const res = NextResponse.redirect(loginUrl)
      res.cookies.set('adminSession', sessionValue, cookieOptions)
      console.log('[admin-login] issued session and redirect for', email)
      return res
    }

    // JSON API flow: set cookie on JSON response
    const res = NextResponse.json({ success: true })
    res.cookies.set('adminSession', sessionValue, cookieOptions)

    console.log('[admin-login] issued session for', email)
    return res
  } catch (error) {
    console.error('[admin-login] Unexpected error', error)
    return NextResponse.json({ error: 'Unable to login' }, { status: 500 })
  }
}