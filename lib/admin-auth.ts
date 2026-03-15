// Simple admin authentication — single user, server-side only
// Token is a random string stored in a server-side Map

import { randomBytes } from 'crypto'

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim()

// In-memory token store: token -> { email, expires }
const tokens = new Map<string, { email: string; expires: number }>()

const TOKEN_TTL = 1000 * 60 * 60 * 24 // 24 hours

export function checkCredentials(email: string, password: string): boolean {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return false
  return (
    email.trim().toLowerCase() === ADMIN_EMAIL &&
    password.trim() === ADMIN_PASSWORD
  )
}

export function createToken(email: string): string {
  // Clean up expired tokens
  for (const [key, val] of tokens) {
    if (val.expires < Date.now()) tokens.delete(key)
  }

  const token = randomBytes(32).toString('hex')
  tokens.set(token, { email, expires: Date.now() + TOKEN_TTL })
  return token
}

export function validateToken(token: string): string | null {
  if (!token) return null
  const entry = tokens.get(token)
  if (!entry) return null
  if (entry.expires < Date.now()) {
    tokens.delete(token)
    return null
  }
  return entry.email
}

export function revokeToken(token: string): void {
  tokens.delete(token)
}
