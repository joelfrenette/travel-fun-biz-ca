import { z } from 'zod'
import { attributionSchema } from '@/lib/attribution'

export const contactFormSchema = z.object({
  name: z.string().min(1, 'Full name is required'),
  email: z.string().email('Please enter a valid email address'),
  phone: z.string().optional(),
  package: z.string().min(1, 'Please select a package'),
  travelDate: z.string().optional(),
  travelers: z.string().optional(),
  message: z.string().optional(),
})

export type ContactFormValues = z.infer<typeof contactFormSchema>

export const contactSubmissionSchema = contactFormSchema.extend({
  submittedAt: z.string().optional(),
  attribution: attributionSchema.optional(),
})

export type ContactSubmission = z.infer<typeof contactSubmissionSchema>
