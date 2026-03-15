import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getAdminSessionFromRequest } from '@/lib/session'
import { verifyToken } from '@/lib/simple-session'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (pathname === '/admin/login' || pathname.startsWith('/api/admin')) {
    return NextResponse.next()
  }

  // First try the signed session cookie flow
  const session = getAdminSessionFromRequest(request)
  if (session) {
    return NextResponse.next()
  }

  // Fallback: check simple in-memory token in cookie
  const token = request.cookies.get('adminToken')?.value
  const tokenEmail = verifyToken(token)
  if (tokenEmail) {
    return NextResponse.next()
  }

  const loginUrl = new URL('/admin/login', request.url)
  loginUrl.searchParams.set('redirect', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/admin/:path*'],
}