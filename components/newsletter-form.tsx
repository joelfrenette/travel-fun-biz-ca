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
        throw new Error('Subscription failed')
      }

      toast({ title: translate('Subscribed!', language), description: translate('We will keep you posted with the latest travel deals.', language) })
      reset({ fullName: '', email: '', phone: '', deals: [] })
    } catch (error) {
      toast({
        title: translate('Subscription failed', language),
        description: translate('Please try again in a moment.', language),
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
            {translate('What is Your Full Name *', language)}
          </label>
          <Input id="fullName" placeholder="Full Name" autoComplete="name" {...register('fullName')} />
          {errors.fullName && <p className="text-sm text-destructive">{errors.fullName.message}</p>}
        </div>

        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            {translate('Enter Your Email *', language)}
          </label>
          <Input id="email" type="email" placeholder="Email" autoComplete="email" {...register('email')} />
          {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
        </div>

        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-medium">
            {translate('Mobile Phone *', language)}
          </label>
          <Input id="phone" type="tel" placeholder="Phone" autoComplete="tel" {...register('phone')} />
          {errors.phone && <p className="text-sm text-destructive">{errors.phone.message}</p>}
        </div>

        <div>
          <label htmlFor="deals" className="mb-1 block text-sm font-medium">
            {translate('Which deals you like? (multi-select) *', language)}
          </label>
          <select id="deals" multiple className="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm" {...register('deals')}>
            {newsletterDealOptions.map((option) => (
              <option key={option} value={option}>
                {translate(option, language)}
              </option>
            ))}
          </select>
          {errors.deals && <p className="text-sm text-destructive">{errors.deals.message}</p>}
        </div>

        <Button type="submit" className="w-full bg-[#e31e24] py-6 text-lg font-bold hover:bg-[#c01a1f]" disabled={isSubmitting}>
          {isSubmitting ? translate('Submitting...', language) : translate('SUBMIT', language)}
        </Button>
      </div>
    </form>
  )
}