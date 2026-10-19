import type { Attribution } from '@/lib/attribution'

// Pure helpers for the inline lead form on guide pages (components/guide-lead-form.tsx). Kept out of the component so
// the payload and the error messages can be checked offline (scripts/check-guide-lead-form.ts). The payload matches
// contactSubmissionSchema in lib/schemas/contact.ts, which /api/submit-lead validates.

export const GUIDE_FORM_FALLBACK_PACKAGE = 'Custom Package'

export interface GuideLeadInput {
  name: string
  email: string
  phone?: string
  message?: string
  /** The guide's linked trip name, if any. */
  packageName?: string | null
  /** The honeypot field value as the browser holds it. Real visitors leave it empty. */
  honeypot?: string
  attribution?: Attribution
  /** ISO time of submit. */
  submittedAt?: string
}

export interface GuideLeadPayload {
  name: string
  email: string
  phone?: string
  package: string
  message?: string
  company_website: string
  submittedAt?: string
  attribution?: Attribution
}

/** The trip name to send: the linked trip, else Custom Package. */
export function guideFormPackage(packageName?: string | null): string {
  const name = (packageName ?? '').replace(/\s+/g, ' ').trim()
  return name || GUIDE_FORM_FALLBACK_PACKAGE
}

/** Only name and email are required. */
export function guideFormMissing(input: { name?: string; email?: string }): Array<'name' | 'email'> {
  const missing: Array<'name' | 'email'> = []
  if (!(input.name ?? '').trim()) missing.push('name')
  if (!(input.email ?? '').trim()) missing.push('email')
  return missing
}

export function buildGuideLeadPayload(input: GuideLeadInput): GuideLeadPayload {
  const phone = (input.phone ?? '').trim()
  const message = (input.message ?? '').trim()
  const payload: GuideLeadPayload = {
    name: input.name.trim(),
    email: input.email.trim(),
    package: guideFormPackage(input.packageName),
    company_website: input.honeypot ?? '',
  }
  if (phone) payload.phone = phone
  if (message) payload.message = message
  if (input.submittedAt) payload.submittedAt = input.submittedAt
  if (input.attribution) payload.attribution = input.attribution
  return payload
}

export type GuideFormFailure = 'rate_limited' | 'network' | 'invalid' | 'server'

/** Which failure a response status (or no response at all) means. */
export function classifyGuideFormFailure(status: number | null): GuideFormFailure {
  if (status === null) return 'network'
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'invalid'
  return 'server'
}

/** The text shown to the visitor. The phone is site.phone, passed in; with no number the call line is left out. */
export function guideFormMessage(failure: GuideFormFailure, phone?: string | null): string {
  const p = (phone ?? '').trim()
  const call = p ? ` or call or text our AI agent on ${p}` : ''
  switch (failure) {
    case 'rate_limited':
      return `We have received several enquiries from this device in a short time. Please wait a few minutes and try again${call}.`
    case 'network':
      return `We could not reach our server. Check your connection and try again${call}.`
    case 'invalid':
      return 'Please check your name and email address and try again.'
    default:
      return `Something went wrong on our side. Please try again${call}.`
  }
}
