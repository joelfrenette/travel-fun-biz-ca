// session.ts - minimal signed cookie utilities for admin access
import { cookies } from 'next/headers'
import { createHmac } from 'crypto'
import type { NextRequest } from 'next/server'

const SESSION_COOKIE = 'adminSession'
const SESSION_SECRET = process.env.SESSION_SECRET

function assertSecret() {
  if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET env var missing')
  }
}

function sign(value: string): string {
  assertSecret()
  return createHmac('sha256', SESSION_SECRET!).update(value).digest('hex')
}

function encode(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function decode(value: string): Record<string, string> | null {
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8')
    return JSON.parse(json)
  } catch (error) {
    console.error('[session] Failed to decode payload', error)
    return null
  }
}

export function createSessionValue(payload: Record<string, string>): string {
  const encoded = encode(payload)
  const signature = sign(encoded)
  const combined = `${encoded}.${signature}`
  // Log lengths (do not log secrets)
  console.log('[session] createSessionValue', {
    encodedLength: encoded.length,
    signatureLength: signature.length,
  })
  return combined
}

export function parseSessionValue(value?: string): Record<string, string> | null {
  if (!value) return null
  const [encoded, signature] = value.split('.')
  if (!encoded || !signature) return null

  try {
    const expected = sign(encoded)
    if (expected !== signature) {
      console.warn('[session] Signature mismatch when parsing session')
      return null
    }
  } catch (error) {
    console.error('[session] Signature validation failed', error)
    return null
  }

  return decode(encoded)
}

export async function setAdminSession(payload: Record<string, string>) {
  const value = createSessionValue(payload)
  // log that we're setting the cookie (do not expose the cookie value)
  console.log('[session] Setting session cookie', { cookieName: SESSION_COOKIE })
  cookies().set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8, // 8 hours
  })
}

export async function clearAdminSession() {
  cookies().delete(SESSION_COOKIE)
}

export function getAdminSession(): Record<string, string> | null {
  const raw = cookies().get(SESSION_COOKIE)?.value
  return parseSessionValue(raw)
}

export function getAdminSessionFromRequest(request: NextRequest): Record<string, string> | null {
  const raw = request.cookies.get(SESSION_COOKIE)?.value
  const parsed = parseSessionValue(raw)
  if (!parsed && raw) {
    console.warn('[session] Failed to parse session from request cookie', { rawLength: raw.length })
  }
  return parsed
}