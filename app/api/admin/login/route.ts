import { NextResponse } from 'next/server'
import { checkCredentials, createToken } from '@/lib/admin-auth'

// Per-IP failed-attempt limiter. In-memory, so it is per server instance: on Vercel that
// still throttles a burst against one warm function, which is what a password guesser
// produces. Not a substitute for a strong password.
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 10
const failures = new Map<string, { count: number; resetAt: number }>()

function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown'
}

function isLocked(ip: string): boolean {
  const entry = failures.get(ip)
  if (!entry) return false
  if (Date.now() > entry.resetAt) {
    failures.delete(ip)
    return false
  }
  return entry.count >= MAX_FAILURES
}

function recordFailure(ip: string) {
  const now = Date.now()
  const entry = failures.get(ip)
  if (!entry || now > entry.resetAt) failures.set(ip, { count: 1, resetAt: now + WINDOW_MS })
  else entry.count += 1
}

export async function POST(request: Request) {
  const ip = clientIp(request)
  if (isLocked(ip)) {
    return NextResponse.json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' }, { status: 429 })
  }

  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    if (!(await checkCredentials(email, password))) {
      recordFailure(ip)
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    failures.delete(ip)
    const token = createToken(email)
    return NextResponse.json({ token })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
