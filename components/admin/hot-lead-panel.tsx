"use client"

import { useEffect, useMemo, useState } from "react"
import { Clock, Mail, Phone, UserCheck } from "lucide-react"
import type { HotLeadCardData } from "@/lib/today-cards"
import { filterAgents, groupPickerEntries, officeBadge, waitLight, waitMinutes, waitText, type PickerEntry } from "@/lib/lead-desk"
import { authHeaders } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// The hot lead card's own panel: who waits and for how long, one tap to call or write, and the "Assign to" picker.
// The office chooses. The list only puts agents whose specialties match the trip first, tagged "suggested"; no agent is
// ever selected for you, and choosing one takes a second tap (it sends that agent an email with the lead's details).

const BY_KEY = "leadDeskAssignedBy"
const LIGHT_CLASS = { green: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400", amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400", red: "bg-red-600/10 text-red-700 dark:text-red-400" } as const

function readBy(): string {
  try {
    return localStorage.getItem(BY_KEY) || ""
  } catch {
    return ""
  }
}

export function HotLeadPanel({ hot, busy, onLater, onAssigned }: { hot: HotLeadCardData; busy: boolean; onLater: () => void; onAssigned: (message: string, warnings: string[]) => void }) {
  const [tick, setTick] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const [agents, setAgents] = useState<PickerEntry[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [query, setQuery] = useState("")
  const [chosen, setChosen] = useState<PickerEntry | null>(null)
  const [by, setBy] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")

  // The waiting time and its colour keep moving while the card is on screen.
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => setBy(readBy()), [])

  const minutes = waitMinutes(hot.createdAt, tick)
  const light = waitLight(minutes)

  const openPicker = async () => {
    setOpen(true)
    setChosen(null)
    setError("")
    if (agents) return
    try {
      const res = await fetch(`/api/admin/leads/assign?leadId=${encodeURIComponent(hot.leadId)}`, { headers: authHeaders(), cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as { agents?: PickerEntry[]; error?: string }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setAgents(body.agents ?? [])
      setLoadError("")
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the agents.")
    }
  }

  const shown = useMemo(() => filterAgents(agents ?? [], query), [agents, query])
  // Office team first (they are agents too), then the ones who know this kind of trip, then everyone else.
  const groups = useMemo(() => groupPickerEntries(shown), [shown])
  const sections: { key: string; heading: string; entries: PickerEntry[] }[] = [
    { key: "office", heading: "Office team", entries: groups.office },
    { key: "suggested", heading: "Suggested by specialty", entries: groups.suggested },
    { key: "others", heading: "Everyone else", entries: groups.others },
  ].filter((g) => g.entries.length > 0)

  const row = (e: PickerEntry) => (
    <li key={e.agent.id}>
      <button
        type="button"
        onClick={() => setChosen(e)}
        aria-pressed={chosen?.agent.id === e.agent.id}
        className={cn("flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted", chosen?.agent.id === e.agent.id && "border-emerald-600 bg-emerald-600/10")}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{e.agent.display_name}</span>
          {e.agent.specialties.length > 0 && <span className="block truncate text-xs text-muted-foreground">{e.agent.specialties.slice(0, 4).join(", ")}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {officeBadge(e.agent.office_role) && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold" data-testid="office-badge">{officeBadge(e.agent.office_role)}</span>}
          {e.suggested && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">suggested</span>}
        </span>
      </button>
    </li>
  )

  const confirm = async () => {
    if (!chosen || sending) return
    setSending(true)
    setError("")
    try {
      try {
        localStorage.setItem(BY_KEY, by.trim().slice(0, 40))
      } catch {
        // storage can be blocked; the name is just asked again next time
      }
      const res = await fetch("/api/admin/leads/assign", { method: "POST", headers: authHeaders(), body: JSON.stringify({ leadId: hot.leadId, agentId: chosen.agent.id, assignedBy: by }) })
      const body = (await res.json().catch(() => ({}))) as { message?: string; warnings?: string[]; error?: string }
      if (!res.ok) {
        setError(body.error || "That did not work. Please try again.")
        return
      }
      onAssigned(body.message || "Assigned.", body.warnings ?? [])
    } catch {
      setError("Could not reach the server. Please try again.")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-3 space-y-3" data-testid="hot-lead-panel">
      <p className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold", LIGHT_CLASS[light])} aria-live="polite" data-testid="hot-lead-wait">
        <Clock className="h-4 w-4" aria-hidden="true" /> Waiting {waitText(minutes)}
        {light === "red" ? " (over 15 minutes)" : light === "amber" ? " (over 5 minutes)" : ""}
      </p>

      <div className="flex flex-wrap gap-2">
        {hot.phone ? (
          <a href={`tel:${hot.phone.replace(/[^\d+]/g, "")}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted">
            <Phone className="h-4 w-4" aria-hidden="true" /> Call {hot.phone}
          </a>
        ) : (
          <span className="inline-flex min-h-11 items-center rounded-lg border border-dashed px-3 text-sm text-muted-foreground">No phone number given</span>
        )}
        <a href={`mailto:${hot.email}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted">
          <Mail className="h-4 w-4" aria-hidden="true" /> {hot.email}
        </a>
      </div>

      {!open && (
        <div className="grid grid-cols-2 gap-3">
          <button type="button" disabled={busy} onClick={onLater} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 px-2 py-3 text-base font-semibold hover:bg-muted disabled:opacity-40">
            <Clock className="h-5 w-5 shrink-0" aria-hidden="true" /> Later (30 min)
          </button>
          <button type="button" disabled={busy} onClick={() => void openPicker()} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-2 py-3 text-base font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">
            <UserCheck className="h-5 w-5 shrink-0" aria-hidden="true" /> Assign to...
          </button>
        </div>
      )}

      {open && (
        <div className="rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">Choose who works this lead</p>
            <button type="button" onClick={() => { setOpen(false); setChosen(null) }} className="min-h-9 rounded-md px-2 text-sm underline underline-offset-2">Close</button>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">The list is only a help. The office team is listed first (they are agents too), then agents who know this kind of trip. Nobody is chosen until you choose.</p>
          <label className="sr-only" htmlFor="agent-search">Search agents</label>
          <input id="agent-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or what they know" className="mb-2 h-11 w-full rounded-md border bg-background px-3 text-sm" autoComplete="off" />
          {loadError && <p role="alert" className="mb-2 text-sm text-destructive">{loadError}</p>}
          {!agents && !loadError && <p className="text-sm text-muted-foreground">Loading agents...</p>}
          {agents && agents.length === 0 && <p className="text-sm text-muted-foreground">No agents are on the roster yet. Add them in Agents first.</p>}
          <div className="max-h-64 space-y-2 overflow-y-auto" aria-label="Agents">
            {sections.map((g) => (
              <section key={g.key} aria-label={g.heading} data-testid={`picker-${g.key}`}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.heading}</h3>
                <ul className="space-y-1">{g.entries.map(row)}</ul>
              </section>
            ))}
            {agents && agents.length > 0 && shown.length === 0 && <p className="text-sm text-muted-foreground">No agent matches that search.</p>}
          </div>

          {chosen && (
            <div className="mt-3 space-y-2 border-t pt-3">
              <label className="block text-sm" htmlFor="assigned-by">Your first name (so the record shows who chose)</label>
              <input id="assigned-by" value={by} onChange={(e) => setBy(e.target.value)} maxLength={40} className="h-11 w-full rounded-md border bg-background px-3 text-sm" autoComplete="off" />
              <p className="text-xs text-muted-foreground">This emails {chosen.agent.display_name} the lead&apos;s details and tags the contact in GoHighLevel.</p>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <button type="button" disabled={sending} onClick={() => void confirm()} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-base font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">
                <UserCheck className="h-5 w-5" aria-hidden="true" /> {sending ? "Assigning..." : `Assign to ${chosen.agent.display_name}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
