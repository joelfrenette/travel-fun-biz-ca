"use client"

import { useEffect, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useRouter } from "next/navigation"
import type { Currency } from "@/lib/currency"

interface CurrencyToggleProps {
  currency: Currency
}

export function CurrencyToggle({ currency }: CurrencyToggleProps) {
  const router = useRouter()
  const [value, setValue] = useState<Currency>(currency)
  const [pending, setPending] = useState(false)
  // The header mounts two toggles (desktop and mobile); after router.refresh() the server sends the new value, so follow it.
  useEffect(() => setValue(currency), [currency])

  async function handleChange(next: string) {
    const normalized = next === "cad" ? "cad" : next === "aud" ? "aud" : next === "eur" ? "eur" : "usd"
    setValue(normalized)
    setPending(true)
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currency: normalized }),
      })
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <Select value={value} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger className="w-[90px] text-foreground" aria-label="Select currency">
        {/* Label passed as children so it renders on the server and shows before hydration. */}
        <SelectValue placeholder="Currency">{value.toUpperCase()}</SelectValue>
      </SelectTrigger>

      <SelectContent>
        <SelectItem value="usd">USD</SelectItem>
        <SelectItem value="cad">CAD</SelectItem>
        <SelectItem value="aud">AUD</SelectItem>
        <SelectItem value="eur">EUR</SelectItem>
      </SelectContent>
    </Select>
  )
}