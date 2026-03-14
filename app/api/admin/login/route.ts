import { NextResponse } from 'next/server'
import { verifyAdminCredentials } from '@/lib/auth'
import { setAdminSession } from '@/lib/session'

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

    await setAdminSession({ email })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[admin-login] Unexpected error', error)
    return NextResponse.json({ error: 'Unable to login' }, { status: 500 })
  }
}
