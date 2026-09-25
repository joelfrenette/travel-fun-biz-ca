// Simple admin authentication — single user
// Uses signed tokens that don't require server-side storage

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import bcrypt from 'bcryptjs'

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
const ADMIN_PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim()

const TOKEN_TTL = 1000 * 60 * 60 * 24 // 24 hours

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET is not set — cannot sign or verify admin session tokens')
  }
  return secret
}

export async function checkCredentials(email: string, password: string): Promise<boolean> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) return false
  if (email.trim().toLowerCase() !== ADMIN_EMAIL) return false
  return bcrypt.compare(password.trim(), ADMIN_PASSWORD_HASH)
}

/**
 * Create a signed token containing email and expiry
 * Format: base64(payload).signature
 */
export function createToken(email: string): string {
  const payload = {
    email: email.trim().toLowerCase(),
    exp: Date.now() + TOKEN_TTL,
    nonce: randomBytes(8).toString('hex'),
  }

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', getSessionSecret()).update(payloadStr).digest('hex')

  return `${payloadStr}.${signature}`
}

/**
 * Validate a signed token and return the email if valid
 */
export function validateToken(token: string): string | null {
  if (!token || typeof token !== 'string') return null

  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [payloadStr, signature] = parts

  let secret: string
  try {
    secret = getSessionSecret()
  } catch (e) {
    console.error('[admin-auth]', e instanceof Error ? e.message : e)
    return null
  }

  // Verify signature in constant time so a forged token can't be probed byte by byte
  const expectedSig = createHmac('sha256', secret).update(payloadStr).digest('hex')
  const given = Buffer.from(signature, 'hex')
  const expected = Buffer.from(expectedSig, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    console.log('[admin-auth] Invalid signature')
    return null
  }

  // Decode and check expiry
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'))

    if (!payload.email || !payload.exp) {
      console.log('[admin-auth] Invalid payload structure')
      return null
    }

    if (payload.exp < Date.now()) {
      console.log('[admin-auth] Token expired')
      return null
    }

    // Verify email matches admin
    if (payload.email !== ADMIN_EMAIL) {
      console.log('[admin-auth] Email mismatch')
      return null
    }

    return payload.email
  } catch (e) {
    console.log('[admin-auth] Failed to parse token:', e)
    return null
  }
}

/** True when the request carries a valid admin bearer token. */
export function isAuthorized(request: Request): boolean {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
  return !!validateToken(token)
}

export function revokeToken(_token: string): void {
  // Tokens are stateless HMAC-signed and expire on their own after TOKEN_TTL.
  // True revocation would need a server-side blocklist (e.g. Redis), which
  // this single-admin app doesn't need yet.
}
