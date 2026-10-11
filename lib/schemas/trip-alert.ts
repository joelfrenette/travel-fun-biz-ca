import { z } from 'zod'
import { attributionSchema } from '@/lib/attribution'

// "Tell me about the next one" on a past trip's page (growth loop WP14). Email is required, name is optional.
// The tag is NOT sent by the browser: the server looks the trip up by `slug` and reads its alert tag, so nobody
// can tag themselves into a list by editing the request.
export const tripAlertSchema = z.object({
  slug: z.string().trim().min(1).max(200),
  email: z.string().trim().email('Enter a valid email'),
  name: z.string().trim().max(120).optional(),
  // Express consent (CASL): an unticked box the visitor ticks themselves, never pre-ticked. Refused without it,
  // here and on the server.
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick the box so we are allowed to email you' }),
  // Honeypot (lib/abuse-guard.ts): real visitors never see or fill this field.
  company_website: z.string().optional(),
})

export type TripAlertValues = z.infer<typeof tripAlertSchema>

export const tripAlertSubmissionSchema = tripAlertSchema.extend({
  attribution: attributionSchema.optional(),
})

export type TripAlertSubmission = z.infer<typeof tripAlertSubmissionSchema>
