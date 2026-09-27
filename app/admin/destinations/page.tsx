"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, Save, Trash2, MapPin } from "lucide-react"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

interface Row {
  slug: string
  destination: string
  blurb: { blurb: string; source: "ai" | "manual"; updated_at: string } | null
}

// Roadmap use case f267e278: descriptive text for the destination a package is in, shown on
// /destinations/[slug]. Deliberately no per-package data here - the blurb is about the place,
// not any one trip, so it's one row per destination shared across every package there.
export default function DestinationsAdminPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<Record<string, "generating" | "saving" | "deleting" | undefined>>({})

  function load() {
    setLoading(true)
    setError("")
    fetch("/api/admin/destinations", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setRows(data.destinations || [])
        setDrafts(Object.fromEntries((data.destinations || []).map((r: Row) => [r.slug, r.blurb?.blurb || ""])))
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  async function generate(row: Row) {
    setBusy((b) => ({ ...b, [row.slug]: "generating" }))
    setError("")
    try {
      const res = await fetch(`/api/admin/destinations/${row.slug}/generate`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ destination: row.destination }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Generation failed")
      setDrafts((d) => ({ ...d, [row.slug]: data.blurb }))
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed")
    } finally {
      setBusy((b) => ({ ...b, [row.slug]: undefined }))
    }
  }

  async function save(row: Row) {
    setBusy((b) => ({ ...b, [row.slug]: "saving" }))
    setError("")
    try {
      const res = await fetch(`/api/admin/destinations/${row.slug}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ destination: row.destination, blurb: drafts[row.slug] || "" }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Save failed")
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setBusy((b) => ({ ...b, [row.slug]: undefined }))
    }
  }

  async function remove(row: Row) {
    if (!confirm(`Remove the blurb for ${row.destination}? The destination page will show no blurb until you add one again.`)) return
    setBusy((b) => ({ ...b, [row.slug]: "deleting" }))
    setError("")
    try {
      const res = await fetch(`/api/admin/destinations/${row.slug}`, { method: "DELETE", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Delete failed")
      setDrafts((d) => ({ ...d, [row.slug]: "" }))
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed")
    } finally {
      setBusy((b) => ({ ...b, [row.slug]: undefined }))
    }
  }

  if (loading) return <div className="flex items-center justify-center p-12"><Loader2 className="h-6 w-6 animate-spin" /></div>

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Destinations</h1>
        <p className="text-sm text-muted-foreground">
          A short blurb about each place, shown on its /destinations page above the trip listings. The AI writer sticks to general, non-numeric
          travel-guide language (no dates, prices, visa rules, or "best month" claims, since those go stale) - always read it before saving.
        </p>
      </div>

      {error && <div className="whitespace-pre-line rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <div className="space-y-4">
        {rows.map((row) => (
          <Card key={row.slug}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base"><MapPin className="h-4 w-4" />{row.destination}</CardTitle>
                {row.blurb && <Badge variant={row.blurb.source === "ai" ? "secondary" : "outline"}>{row.blurb.source === "ai" ? "AI-written" : "Manually edited"}</Badge>}
              </div>
              <CardDescription>/destinations/{row.slug}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={drafts[row.slug] || ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [row.slug]: e.target.value }))}
                rows={3}
                placeholder="No blurb yet - generate one with AI or write it yourself."
              />
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => generate(row)} disabled={!!busy[row.slug]}>
                  {busy[row.slug] === "generating" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
                  {row.blurb ? "Regenerate with AI" : "Generate with AI"}
                </Button>
                <Button type="button" size="sm" onClick={() => save(row)} disabled={!!busy[row.slug] || !drafts[row.slug]?.trim()}>
                  {busy[row.slug] === "saving" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                  Save
                </Button>
                {row.blurb && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => remove(row)} disabled={!!busy[row.slug]}>
                    {busy[row.slug] === "deleting" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                    Remove
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No destinations yet - add a package with a destination first.</p>}
      </div>
    </div>
  )
}
