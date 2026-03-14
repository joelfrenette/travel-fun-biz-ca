"use client"

import { useState } from "react"
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

  async function handleChange(next: string) {
    const normalized = next === "cad" ? "cad" : "usd"
    setValue(normalized)
    setPending(true)
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: normalized }),
      })
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <Select value={value} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger className="w-[90px]">
        <SelectValue placeholder="Currency" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="usd">USD</SelectItem>
        <SelectItem value="cad">CAD</SelectItem>
      </SelectContent>
    </Select>
  )
}
