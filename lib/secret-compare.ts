import { timingSafeEqual } from 'node:crypto'

// Ported verbatim from Nomad Escape Plan (Factory Phase 1: foundation) — no site-specific logic.
/**
 * Compare a presented secret with the expected one in constant time, so the
 * response time doesn't reveal how much of a guess was right. False when either
 * side is missing — an unset secret never matches anything.
 */
export function secretMatches(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
