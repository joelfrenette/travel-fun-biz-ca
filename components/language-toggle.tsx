"use client"

import { useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useRouter } from "next/navigation"
import type { Language } from "@/lib/preferences"

interface LanguageToggleProps {
  language: Language
}

export function LanguageToggle({ language }: LanguageToggleProps) {
  const router = useRouter()
  const [value, setValue] = useState<Language>(language)
  const [pending, setPending] = useState(false)

  async function handleChange(nextValue: string) {
    const normalized = nextValue === "fr" ? "fr" : nextValue === "es" ? "es" : "en"
    setValue(normalized)
    setPending(true)
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ language: normalized }),
      })
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <Select value={value} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger className="w-[90px]" aria-label="Select language">
        <SelectValue placeholder="Lang" />
      </SelectTrigger>

      <SelectContent>
        <SelectItem value="en">EN</SelectItem>
        <SelectItem value="fr">FR</SelectItem>
        <SelectItem value="es">SP</SelectItem>
      </SelectContent>
    </Select>
  )
}