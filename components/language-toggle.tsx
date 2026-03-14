'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Language } from '@/lib/preferences'

interface LanguageToggleProps {
  language: Language
}

export function LanguageToggle({ language }: LanguageToggleProps) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleChange(next: Language) {
    if (next === language) return
    startTransition(async () => {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: next }),
      })
      router.refresh()
    })
  }

  return (
    <Select value={language} onValueChange={(value) => handleChange(value as Language)} disabled={pending}>
      <SelectTrigger className="w-[90px]">
        <SelectValue placeholder="Lang" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="en">EN</SelectItem>
        <SelectItem value="fr">FR</SelectItem>
      </SelectContent>
    </Select>
  )
}
