"use client"

import { DASH_RANGES, RANGE_LABELS, type DashRange } from "@/lib/dashboard-range"

// Pill selector for the dashboard range. A group of toggle buttons (aria-pressed), so it is operable with Tab, Enter and Space.
// Wraps on narrow screens instead of scrolling sideways.
export function DashboardRangePills({ value, onChange }: { value: DashRange; onChange: (range: DashRange) => void }) {
  return (
    <div role="group" aria-label="Dashboard date range" className="flex flex-wrap gap-2">
      {DASH_RANGES.map((range) => {
        const active = range === value
        return (
          <button
            key={range}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(range)}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted"
            }`}
          >
            {RANGE_LABELS[range]}
          </button>
        )
      })}
    </div>
  )
}
