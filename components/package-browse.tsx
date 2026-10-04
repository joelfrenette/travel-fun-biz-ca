"use client"

import { useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PackageCard } from "@/components/package-card"
import type { BrowsePackage } from "@/lib/packages"
import type { Language } from "@/lib/preferences"
import type { Currency } from "@/lib/currency"
import { translate } from "@/lib/i18n"

const ALL_CATEGORIES = "__all__"
const ALL_DURATIONS = "__all__"

interface DurationBand {
  value: string
  label: string
  test: (days: number) => boolean
}

// Bands are derived from how this project's own packages describe themselves (duration_days is a
// real column), not an invented industry taxonomy - adjust here if the real data stops fitting.
const DURATION_BANDS: DurationBand[] = [
  { value: "short", label: "Up to 4 days", test: (d) => d <= 4 },
  { value: "week", label: "5 to 10 days", test: (d) => d >= 5 && d <= 10 },
  { value: "long", label: "11+ days", test: (d) => d >= 11 },
]

interface PackageBrowseProps {
  packages: BrowsePackage[]
  language: Language
  currency: Currency
  usdToTargetRate: number
}

export function PackageBrowse({ packages, language, currency, usdToTargetRate }: PackageBrowseProps) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [duration, setDuration] = useState(ALL_DURATIONS)
  const [upcomingOnly, setUpcomingOnly] = useState(false)

  const categories = useMemo(() => {
    const seen = new Set<string>()
    packages.forEach((p) => { if (p.category) seen.add(p.category) })
    return Array.from(seen).sort()
  }, [packages])

  const availableDurationBands = useMemo(
    () => DURATION_BANDS.filter((band) => packages.some((p) => p.durationDays != null && band.test(p.durationDays))),
    [packages],
  )

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const band = DURATION_BANDS.find((b) => b.value === duration)
    return packages.filter((p) => {
      if (q && !`${p.name} ${p.destination}`.toLowerCase().includes(q)) return false
      if (category !== ALL_CATEGORIES && p.category !== category) return false
      if (band && (p.durationDays == null || !band.test(p.durationDays))) return false
      if (upcomingOnly && (!p.availableFrom || p.availableFrom < today)) return false
      return true
    })
  }, [packages, query, category, duration, upcomingOnly, today])

  return (
    <div>
      <div className="mb-8 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={translate(language, "Search by trip or destination")}
          aria-label={translate(language, "Search by trip or destination")}
        />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="sm:w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>{translate(language, "All styles")}</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>{translate(language, c)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {availableDurationBands.length > 0 && (
          <Select value={duration} onValueChange={setDuration}>
            <SelectTrigger className="sm:w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_DURATIONS}>{translate(language, "Any length")}</SelectItem>
              {availableDurationBands.map((b) => (
                <SelectItem key={b.value} value={b.value}>{translate(language, b.label)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
          <input type="checkbox" checked={upcomingOnly} onChange={(e) => setUpcomingOnly(e.target.checked)} />
          {translate(language, "Upcoming departures only")}
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">
          {translate(language, "No trips match those filters. Try widening your search.")}
        </p>
      ) : (
        <div className="grid gap-6 md:grid-cols-3">
          {filtered.map((pkg) => (
            <PackageCard key={pkg.id} package={pkg} language={language} currency={currency} usdToTargetRate={usdToTargetRate} />
          ))}
        </div>
      )}
    </div>
  )
}
