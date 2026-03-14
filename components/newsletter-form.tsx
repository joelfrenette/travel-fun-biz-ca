"use client"

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { newsletterSchema, type NewsletterValues } from '@/lib/schemas/newsletter'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { newsletterDealOptions } from '@/content/footer'
import { useState } from 'react'

interface NewsletterFormProps {
  className?: string
}

export function NewsletterForm({ className }: NewsletterFormProps) {
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

      toast({ title: 'Subscribed!', description: 'We will keep you posted with the latest travel deals.' })
      reset({ fullName: '', email: '', phone: '', deals: [] })
    } catch (error) {
      toast({
        title: 'Subscription failed',
        description: 'Please try again in a moment.',
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
            What is Your Full Name *
          </label>
          <Input id="fullName" placeholder="Full Name" autoComplete="name" {...register('fullName')} />
          {errors.fullName && <p className="text-sm text-red-600">{errors.fullName.message}</p>}
        </div>

        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            Enter Your Email *
          </label>
          <Input id="email" type="email" placeholder="Email" autoComplete="email" {...register('email')} />
          {errors.email && <p className="text-sm text-red-600">{errors.email.message}</p>}
        </div>

        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-medium">
            Mobile Phone *
          </label>
          <Input id="phone" type="tel" placeholder="Phone" autoComplete="tel" {...register('phone')} />
          {errors.phone && <p className="text-sm text-red-600">{errors.phone.message}</p>}
        </div>

        <div>
          <label htmlFor="deals" className="mb-1 block text-sm font-medium">
            Which deals you like? (multi-select) *
          </label>
          <select
            id="deals"
            multiple
            className="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm"
            {...register('deals')}
          >
            {newsletterDealOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {errors.deals && <p className="text-sm text-red-600">{errors.deals.message}</p>}
        </div>

        <Button type="submit" className="w-full bg-[#e31e24] py-6 text-lg font-bold hover:bg-[#c01a1f]" disabled={isSubmitting}>
          {isSubmitting ? 'Submitting…' : 'SUBMIT'}
        </Button>
      </div>
    </form>
  )
}
