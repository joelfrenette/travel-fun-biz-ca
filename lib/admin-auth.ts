// Simple admin authentication — single user
// Uses signed tokens that don't require server-side storage

import { createHmac, randomBytes } from 'crypto'

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim()
const TOKEN_SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'fallback-secret-change-me'

const TOKEN_TTL = 1000 * 60 * 60 * 24 // 24 hours

export function checkCredentials(email: string, password: string): boolean {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return false
  return (
    email.trim().toLowerCase() === ADMIN_EMAIL &&
    password.trim() === ADMIN_PASSWORD
  )
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
  const signature = createHmac('sha256', TOKEN_SECRET).update(payloadStr).digest('hex')
  
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
  
  // Verify signature
  const expectedSig = createHmac('sha256', TOKEN_SECRET).update(payloadStr).digest('hex')
  if (signature !== expectedSig) {
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

export function revokeToken(token: string): void {
  // With signed tokens, we can't truly revoke without a blocklist
  // For simplicity, we just let them expire naturally
  // In production, you'd add the token to a Redis blocklist
}
