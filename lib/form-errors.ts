import {
  GUIDE_FORM_FALLBACK_PACKAGE,
  classifyGuideFormFailure,
  guideFormMessage,
} from '@/lib/guide-lead-form'

// Shared pure helpers for any lead form: the plain error text for a failed submit, and the package fallback.
// Reuses the guide form's wording so every form says the same thing (scripts/check-contact-form.ts).

export const FORM_FALLBACK_PACKAGE = GUIDE_FORM_FALLBACK_PACKAGE

/** The package value to send: the chosen one, else Custom Package. */
export function submitPackage(value?: string | null): string {
  const name = (value ?? '').replace(/\s+/g, ' ').trim()
  return name || FORM_FALLBACK_PACKAGE
}

/** Plain message for a failed submit. status null means the request never got a response (network failure). */
export function formErrorMessage(status: number | null, phone?: string | null): string {
  return guideFormMessage(classifyGuideFormFailure(status), phone)
}
