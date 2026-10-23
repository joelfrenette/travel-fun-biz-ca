"use client"

import { useEffect, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Language } from "@/lib/preferences"

interface LanguageToggleProps {
  language: Language
}

export function LanguageToggle({ language }: LanguageToggleProps) {
  const [value, setValue] = useState<Language>(language)
  const [pending, setPending] = useState(false)
  // The header mounts two toggles (desktop and mobile); after router.refresh() the server sends the new value, so follow it.
  useEffect(() => setValue(language), [language])

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
      // A full reload, not router.refresh(): the page is served from a different copy (cacheable default vs the
      // visitor's own language) once the cookie exists, and a soft refresh cannot swap between the two.
      window.location.reload()
    } finally {
      setPending(false)
    }
  }

  return (
    <Select value={value} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger className="w-[90px] text-foreground" aria-label="Select language">
        {/* Label passed as children so it renders on the server and shows before hydration. */}
        <SelectValue placeholder="Lang">{value === "fr" ? "FR" : value === "es" ? "SP" : "EN"}</SelectValue>
      </SelectTrigger>

      <SelectContent>
        <SelectItem value="en">EN</SelectItem>
        <SelectItem value="fr">FR</SelectItem>
        <SelectItem value="es">SP</SelectItem>
      </SelectContent>
    </Select>
  )
}