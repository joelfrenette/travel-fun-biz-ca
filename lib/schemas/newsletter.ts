import { z } from 'zod'

export const newsletterSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  email: z.string().email('Enter a valid email'),
  phone: z.string().min(7, 'Enter a valid phone number'),
  deals: z.array(z.string()).min(1, 'Select at least one deal preference'),
})

export type NewsletterValues = z.infer<typeof newsletterSchema>
