import { randomBytes } from 'crypto'

type Entry = { email: string; expires: number }

const store = new Map<string, Entry>()
const TTL_MS = 1000 * 60 * 60 * 8 // 8 hours

export function createToken(email: string): string {
  const token = randomBytes(24).toString('base64url')
  const expires = Date.now() + TTL_MS
  store.set(token, { email, expires })

  // schedule cleanup
  setTimeout(() => store.delete(token), TTL_MS)
  return token
}

export function verifyToken(token?: string): string | null {
  if (!token) return null
  const entry = store.get(token)
  if (!entry) return null
  if (entry.expires < Date.now()) {
    store.delete(token)
    return null
  }
  return entry.email
}

export function clearToken(token: string) {
  store.delete(token)
}
