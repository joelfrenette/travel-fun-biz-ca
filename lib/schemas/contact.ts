import { z } from 'zod'
import { attributionSchema } from '@/lib/attribution'

export const contactFormSchema = z.object({
  name: z.string().trim().min(1, 'Full name is required'),
  email: z.string().email('Please enter a valid email address'),
  phone: z.string().optional(),
  package: z.string().optional(),
  travelDate: z.string().optional(),
  travelers: z.string().optional(),
  message: z.string().optional(),
  // Honeypot (Factory Phase 10, lib/abuse-guard.ts): real visitors never see or fill this field.
  // A form-filling bot fills every field, so a filled honeypot marks the submission as spam.
  company_website: z.string().optional(),
})

export type ContactFormValues = z.infer<typeof contactFormSchema>

export const contactSubmissionSchema = contactFormSchema.extend({
  submittedAt: z.string().optional(),
  // Hidden hint from an /agents/<slug> page. Not trusted: it is only written into the lead's note for the office to read.
  agent_interest: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  // Hidden hint from a trip page "Request a callback from a live agent" button (lib/lead-desk.ts). callback = hot lead for the lead desk.
  intent: z.enum(['callback', 'quote', 'info']).optional(),
  attribution: attributionSchema.optional(),
})

// package is optional on the form, but the API route fills in 'Custom Package' before anything downstream sees it.
export type ContactSubmission = Omit<z.infer<typeof contactSubmissionSchema>, 'package'> & { package: string }
