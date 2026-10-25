import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { clampDays, expiryFrom, generateToken, isTokenFormat, type InviteLike } from '@/lib/agent-invites'
import { cleanText } from '@/lib/agent-invites'
import { cleanHttpsUrl, cleanLanguages, cleanPackageSlugs, cleanSpecialties, cleanVideoUrls, cleanYears, parseCertifications, type AgentCertification } from '@/lib/agents'

// Self-service profile links (server only: uses node:crypto). Same pattern as the Recap Studio and submit-trip links: a
// random token is shown to the admin ONCE; only its SHA-256 hash is stored; the link expires; it can be revoked.

export const PROFILE_LINK_DEFAULT_DAYS = 14
export const PROFILE_LINK_MAX_SUBMISSIONS = 10

export function makeProfileToken(bytes: (n: number) => Buffer = randomBytes): string {
  return generateToken(bytes)
}

export const hashProfileToken = (token: string): string => createHash('sha256').update(`agent-profile:${token}`).digest('hex')

export function profileTokenMatchesHash(token: string, storedHash: string): boolean {
  if (!isTokenFormat(token)) return false
  const a = Buffer.from(hashProfileToken(token), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function profileLinkExpiry(now: Date, days?: unknown): Date {
  return expiryFrom(now, days == null ? PROFILE_LINK_DEFAULT_DAYS : clampDays(days))
}

export function profileLinkState(link: Pick<InviteLike, 'expires_at' | 'revoked_at'>, now: Date): { ok: true } | { ok: false; reason: 'revoked' | 'expired' } {
  if (link.revoked_at) return { ok: false, reason: 'revoked' }
  if (new Date(link.expires_at).getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  return { ok: true }
}

export function profileLinkMessage(reason: 'revoked' | 'expired'): string {
  return reason === 'expired' ? 'This link has expired. Ask the office for a new one.' : 'This link is no longer active. Ask the office for a new one.'
}

export interface SelfServiceInput {
  bio: string
  headline: string
  specialties: string[]
  certifications: AgentCertification[]
  years_experience: number | null
  languages: string[]
  video_urls: string[]
  photo_url: string | null
  consent_photo: boolean
  consent_bio: boolean
  promoted_package_slugs: string[]
  testimonial_text: string
}

/**
 * Cleans what an agent sent through their link. Only these fields exist; slug, status, featured, achievements, email, phone
 * and notes can never be set from here. Certifications are ALWAYS stored as not verified (an admin ticks them).
 */
export function cleanSelfService(input: Record<string, unknown>): { ok: true; value: SelfServiceInput } | { ok: false; errors: string[] } {
  const bio = cleanText(input.bio, 3000, true)
  const errors: string[] = []
  if (bio.length < 40) errors.push('Please write a short bio (at least a couple of sentences).')
  const specialties = cleanSpecialties(input.specialties)
  if (!specialties.length) errors.push('Please list at least one specialty.')
  if (errors.length) return { ok: false, errors }
  const certs = parseCertifications(input.certifications).map((c) => ({ ...c, verified: false }))
  return {
    ok: true,
    value: {
      bio,
      headline: cleanText(input.headline, 140),
      specialties,
      certifications: certs,
      years_experience: cleanYears(input.years_experience),
      languages: cleanLanguages(input.languages),
      video_urls: cleanVideoUrls(input.video_urls),
      photo_url: cleanHttpsUrl(input.photo_url) || null,
      consent_photo: input.consent_photo === true,
      consent_bio: input.consent_bio === true,
      promoted_package_slugs: cleanPackageSlugs(input.promoted_package_slugs),
      testimonial_text: cleanText(input.testimonial_text, 600, true),
    },
  }
}
