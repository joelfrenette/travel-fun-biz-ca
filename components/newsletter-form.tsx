"use client"

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { newsletterSchema, type NewsletterValues } from '@/lib/schemas/newsletter'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { newsletterDealOptions } from '@/content/footer'
import { useState } from 'react'
import type { Language } from '@/lib/preferences'
import { translate } from '@/lib/i18n'

interface NewsletterFormProps {
  className?: string
  language: Language
}

export function NewsletterForm({ className, language }: NewsletterFormProps) {
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<NewsletterValues>({
    resolver: zodResolver(newsletterSchema),
    defaultValues: { fullName: '', email: '', phone: '', deals: [] },
  })

  async function onSubmit(values: NewsletterValues) {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })

      if (!response.ok) {
        throw new Error('Failed to subscribe')
      }

      toast({
        title: translate(language, "Success! We'll keep you posted with the latest travel deals."),
        description: translate(language, 'Thank You!'),
      })
      reset({ fullName: '', email: '', phone: '', deals: [] })
    } catch (error) {
      toast({
        title: translate(language, 'Subscription failed'),
        description: translate(language, 'Please try again in a moment.'),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={className}>
      <div className="space-y-4">
        <div>
          <label htmlFor="fullName" className="mb-1 block text-sm font-medium">
            {translate(language, 'What is Your Full Name *')}
          </label>
          <Input
            id="fullName"
            placeholder={translate(language, 'Full Name')}
            autoComplete="name"
            {...register('fullName')}
          />

          {errors.fullName && <p className="text-sm text-red-600">{errors.fullName.message}</p>}
        </div>

        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            {translate(language, 'Enter Your Email *')}
          </label>
          <Input
            id="email"
            type="email"
            placeholder={translate(language, 'Email Address')}
            autoComplete="email"
            {...register('email')}
          />

          {errors.email && <p className="text-sm text-red-600">{errors.email.message}</p>}
        </div>

        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-medium">
            {translate(language, 'Mobile Phone *')}
          </label>
          <Input
            id="phone"
            type="tel"
            placeholder={translate(language, 'Phone Number')}
            autoComplete="tel"
            {...register('phone')}
          />

          {errors.phone && <p className="text-sm text-red-600">{errors.phone.message}</p>}
        </div>

        <div>
          <label htmlFor="deals" className="mb-1 block text-sm font-medium">
            {translate(language, 'Which deals you like? (multi-select) *')}
          </label>
          <select
            id="deals"
            multiple
            className="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm"
            {...register('deals')}
          >
            {newsletterDealOptions.map((option) => (
              <option key={option} value={option}>
                {translate(language, option)}
              </option>
            ))}
          </select>
          {errors.deals && <p className="text-sm text-red-600">{errors.deals.message}</p>}
        </div>

        <Button type="submit" className="w-full bg-[#e31e24] py-6 text-lg font-bold hover:bg-[#c01a1f]" disabled={isSubmitting}>
          {isSubmitting ? translate(language, 'Submitting...') : translate(language, 'SUBMIT')}
        </Button>
      </div>
    </form>
  )
}