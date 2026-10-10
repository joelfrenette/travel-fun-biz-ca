"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Sparkles, Trash2, Eye, EyeOff, ExternalLink } from "lucide-react"

// The written intro, takeaways and FAQ for the Compare and Best time to visit pages, as a small card on the
// Autopilot page: counts, the next page in the rotation, the caps, a "write one now" button and a list with
// Publish / Unpublish. No runtime import of lib/page-copy (it would pull the data layer into the browser bundle).

interface Row {
  id: string
  path: string
  page_type: "compare" | "best-time"
  status: "draft" | "published"
  quality_notes: string | null
  created_at: string
}

interface Candidate {
  path: string
  type: "compare" | "best-time"
  label: string
}

interface Data {
  rows: Row[]
  next: Candidate | null
  caps: { perDay: number; perWeek: number }
  usage: { today: number | null; week: number | null }
  counts: { published: number; draft: number; missing: number; total: number }
  failures: Record<string, { n: number; path: string; last: string }>
  publishMode: "draft" | "publish"
}

const TYPE_LABEL = { compare: "Compare", "best-time": "Best time" } as const
const INITIAL_ROWS = 6

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export function PageCopyPanel() {
  const { toast } = useToast()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(() => {
    fetch("/api/admin/page-copy", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load page copy")
        setData(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load page copy"))
  }, [])
  useEffect(() => { load() }, [load])

  async function call(key: string, url: string, init: RequestInit, okTitle: string) {
    setBusy(key)
    try {
      const res = await fetch(url, { ...init, headers: authHeaders() })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: okTitle, description: body.note })
      load()
      return body
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
      return null
    } finally {
      setBusy("")
    }
  }

  const post = (key: string, payload: Record<string, unknown>, okTitle: string) => call(key, "/api/admin/page-copy", { method: "POST", body: JSON.stringify(payload) }, okTitle)

  if (error) return <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
  if (!data) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  const setMode = (mode: "draft" | "publish") => call("mode", "/api/admin/page-copy", { method: "PATCH", body: JSON.stringify({ publishMode: mode }) }, mode === "draft" ? "Page copy now waits for your review" : "Clean page copy can now go live")
  const rows = showAll ? data.rows : data.rows.slice(0, INITIAL_ROWS)
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Compare and best-time page copy</h2>
            <p className="text-xs text-muted-foreground">A written intro, key takeaways and FAQ for each Compare and Best time to visit page, built only from the trips the page lists. The pipeline writes a few a week within the caps below and publishes one only when it passes the checks (no invented numbers, weather or ratings); otherwise it waits here as a draft.</p>
          </div>
          <Button size="sm" disabled={!!busy || !data.next} onClick={() => post("next", { action: "write-next" }, "Page copy written")} title="Writes the next page in the rotation right now. Ignores the daily and weekly caps. Takes up to a minute.">
            {busy === "next" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}Write one now
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
          <p className="min-w-[240px] flex-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{data.publishMode === "draft" ? "Review mode (recommended at first): " : "Publish mode: "}</span>
            {data.publishMode === "draft"
              ? "every new page copy is saved as a draft and nothing goes live until you click Publish."
              : "copy that passes every check goes live by itself; copy that fails a check is still saved as a draft."}
          </p>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setMode(data.publishMode === "draft" ? "publish" : "draft")}>
            {busy === "mode" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{data.publishMode === "draft" ? "Switch to publish mode" : "Switch back to review mode"}
          </Button>
        </div>

        <p className="text-sm">
          <span className="font-medium">{data.counts.published}</span> live, <span className="font-medium">{data.counts.draft}</span> draft, <span className="font-medium">{data.counts.missing}</span> still missing (of {data.counts.total} pages).
          <span className="text-muted-foreground"> Next: {data.next ? `${data.next.label} (${TYPE_LABEL[data.next.type].toLowerCase()})` : "nothing left to write"}</span>
        </p>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            Per day
            <select className="h-8 rounded-md border bg-card px-2 text-sm" value={data.caps.perDay} disabled={!!busy} onChange={(e) => post("caps", { action: "caps", perDay: Number(e.target.value), perWeek: data.caps.perWeek }, "Saved")} aria-label="Pages of copy per day">
              {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? "Off" : n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Per week
            <select className="h-8 rounded-md border bg-card px-2 text-sm" value={data.caps.perWeek} disabled={!!busy} onChange={(e) => post("caps", { action: "caps", perDay: data.caps.perDay, perWeek: Number(e.target.value) }, "Saved")} aria-label="Pages of copy per week">
              {[0, 1, 2, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n === 0 ? "Off" : n}</option>)}
            </select>
          </label>
          <span>Used: {data.usage.today ?? "?"} today, {data.usage.week ?? "?"} in the last 7 days</span>
        </div>

        {Object.keys(data.failures).length > 0 && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {Object.values(data.failures).map((f) => <p key={f.path}>{f.path}: failed {f.n} time{f.n === 1 ? "" : "s"}. {f.last}</p>)}
          </div>
        )}

        {data.rows.length > 0 && (
          <div className="rounded-lg border">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 last:border-b-0">
                <div className="min-w-[200px] flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {r.path}
                    <Badge variant="outline" className="text-[10px] uppercase">{TYPE_LABEL[r.page_type]}</Badge>
                    <Badge variant={r.status === "published" ? "default" : "secondary"}>{r.status === "published" ? "Live" : "Draft"}</Badge>
                  </p>
                  {r.quality_notes && <p className="text-xs text-destructive">Held back: {r.quality_notes}</p>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.status === "published" ? (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => call(`s:${r.id}`, `/api/admin/page-copy/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "draft" }) }, "Unpublished")}>
                      {busy === `s:${r.id}` ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <EyeOff className="mr-1 h-4 w-4" />}Unpublish
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { if (!r.quality_notes || confirm(`The checks held this copy back:\n${r.quality_notes}\n\nPublish it anyway?`)) call(`s:${r.id}`, `/api/admin/page-copy/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "published" }) }, "Published") }}>
                      {busy === `s:${r.id}` ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}Publish
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" asChild><a href={r.path} target="_blank" rel="noopener noreferrer" title="Opens the live page. A draft is not shown on it."><ExternalLink className="mr-1 h-4 w-4" />View page</a></Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} title="Deletes this copy so it can be written again" onClick={() => { if (confirm(`Delete the copy for ${r.path}? This cannot be undone.`)) call(`d:${r.id}`, `/api/admin/page-copy/${r.id}`, { method: "DELETE" }, "Deleted") }}>
                    {busy === `d:${r.id}` ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {data.rows.length > INITIAL_ROWS && (
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${data.rows.length}`}
          </button>
        )}
      </CardContent>
    </Card>
  )
}
