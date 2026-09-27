import type { JournalEntry } from "@/lib/packages"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"

interface TripJournalProps {
  entries: JournalEntry[]
  language: Language
}

// Dated traveler updates ("where we went, what happened") for one trip - roadmap use case
// 6aed9806. Admin-entered by hand (app/admin/packages/page.tsx's JournalEditor), displayed here
// as a simple dated timeline. Renders nothing when there's nothing to show.
export function TripJournal({ entries, language }: TripJournalProps) {
  if (!entries || entries.length === 0) return null
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date))

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-foreground">{translate(language, "Trip Journal")}</h2>
      <ol className="space-y-6 border-l-2 border-border pl-6">
        {sorted.map((entry, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[29px] top-1.5 h-3 w-3 rounded-full border-2 border-background bg-primary" aria-hidden="true" />
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {new Date(`${entry.date}T00:00:00`).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}
            </p>
            <h3 className="mt-0.5 font-semibold text-foreground">{entry.title}</h3>
            <p className="mt-1 whitespace-pre-line text-pretty text-sm leading-relaxed text-muted-foreground">{entry.body}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}
