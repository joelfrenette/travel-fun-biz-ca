import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SHARE_TOKEN_BYTES } from '@/lib/recap-studio'

// Recap link tokens (server only: uses node:crypto). A token is 32 random bytes as 43 url-safe characters. It is shown to the
// admin ONCE; only its SHA-256 hash is stored, so a database leak does not leak working links.

/** `bytes` is injectable for tests. */
export function generateShareToken(bytes: (n: number) => Buffer = randomBytes): string {
  return bytes(SHARE_TOKEN_BYTES).toString('base64url')
}

export const hashShareToken = (token: string): string => createHash('sha256').update(`recap-share:${token}`).digest('hex')

/** Constant-time check that a presented token matches a stored hash. */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashShareToken(token), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
