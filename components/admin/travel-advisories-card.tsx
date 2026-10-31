"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

type Mode = "off" | "log" | "on"

const MODE_TEXT: Record<Mode, string> = {
  off: "Off: nothing is recorded and there are no advisory pages.",
  log: "Log: country advisories are recorded as the news feeds change, but no public page exists yet.",
  on: "On: the pages are public at /travel-advisories, listed in the sitemap, and linked from matching destination guides. A change in a government risk level can also be posted to social (once per country per 7 days, through Post Distribution).",
}

/** The travel advisories switch (app_settings.country_advisories_mode). Off by default. Sits with the other news switches. */
export default function TravelAdvisoriesCard() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [counts, setCounts] = useState<{ countries: number | null; published: number | null; tablesReady: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let live = true
    fetch("/api/admin/travel-advisories", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!live) return
        if (!ok) throw new Error(body.error || "Could not load")
        setMode(body.mode as Mode)
        setCounts({ countries: body.countries, published: body.published, tablesReady: !!body.tablesReady })
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load"))
    return () => { live = false }
  }, [])

  async function change(next: Mode) {
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/admin/travel-advisories", { method: "POST", headers: authHeaders(), body: JSON.stringify({ mode: next }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setMode(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3" data-testid="travel-advisories-card">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-[240px] flex-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Travel advisory pages: {mode ?? "loading"}. </span>
          {mode ? MODE_TEXT[mode] : null}
        </p>
        {mode === null && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {mode !== null && (
          <select
            aria-label="Travel advisory pages mode"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={mode}
            disabled={saving}
            onChange={(e) => change(e.target.value as Mode)}
          >
            <option value="off">Off (default)</option>
            <option value="log">Log only</option>
            <option value="on">On (pages public)</option>
          </select>
        )}
      </div>
      {counts && (
        <p className="text-xs text-muted-foreground">
          {counts.tablesReady
            ? `${counts.countries ?? 0} countr${counts.countries === 1 ? "y" : "ies"} on file, ${counts.published ?? 0} published.`
            : "The tables are not there yet: run migration 0062 in the Supabase SQL editor before using Log or On."}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
