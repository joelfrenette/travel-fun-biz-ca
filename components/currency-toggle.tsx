'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Currency } from '@/lib/preferences'

interface CurrencyToggleProps {
  currency: Currency
}

export function CurrencyToggle({ currency }: CurrencyToggleProps) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleChange(next: Currency) {
    if (next === currency) return
    startTransition(async () => {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currency: next }),
      })
      router.refresh()
    })
  }

  return (
    <Select value={currency} onValueChange={(value) => handleChange(value as Currency)} disabled={pending}>
      <SelectTrigger className="w-[110px]">
        <SelectValue placeholder="Currency" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="usd">USD</SelectItem>
        <SelectItem value="cad">CAD</SelectItem>
      </SelectContent>
    </Select>
  )
}
