"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

type Row = { name: string; email: string }
const MAX = 10
const DEFAULT_ROWS: Row[] = [{ name: "Joel", email: "" }, { name: "Shelby", email: "" }, { name: "Leslie", email: "" }]

/** Who gets the hot lead alert email (app_settings.lead_desk_alert_emails). Names are labels only. */
export function LeadAlertRecipientsCard() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let live = true
    fetch("/api/admin/lead-alert-recipients", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!live) return
        if (!ok) throw new Error(body.error || "Could not load")
        const stored = (body.recipients ?? []) as Row[]
        // Nothing saved yet: show the three usual people with blank addresses so the fields are easy to fill in.
        setRows(stored.length ? stored : DEFAULT_ROWS)
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load"))
    return () => { live = false }
  }, [])

  function edit(i: number, patch: Partial<Row>) {
    setSaved(false)
    setRows((cur) => (cur ? cur.map((r, j) => (j === i ? { ...r, ...patch } : r)) : cur))
  }

  async function save() {
    if (!rows) return
    setSaving(true)
    setError("")
    setSaved(false)
    try {
      const res = await fetch("/api/admin/lead-alert-recipients", { method: "POST", headers: authHeaders(), body: JSON.stringify({ recipients: rows }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setRows((body.recipients as Row[]).length ? body.recipients : DEFAULT_ROWS)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-2 rounded-md border bg-muted/30 p-3" aria-label="Lead alert recipients" data-testid="lead-alert-recipients">
      <p className="text-sm font-medium">Lead alert recipients</p>
      <p className="text-xs text-muted-foreground">
        Everyone listed here gets an email when a hot lead arrives. The name is only a label for this screen. Leave an address blank to skip that row. Up to {MAX} addresses.
      </p>
      {rows === null && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {rows && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="w-36" placeholder="Name" aria-label={`Name for recipient ${i + 1}`} value={r.name} maxLength={40} onChange={(e) => edit(i, { name: e.target.value })} />
              <Input className="min-w-[220px] flex-1" type="email" placeholder="name@example.com" aria-label={`Email for recipient ${i + 1}`} value={r.email} onChange={(e) => edit(i, { email: e.target.value })} />
              <Button size="sm" variant="outline" type="button" onClick={() => { setSaved(false); setRows(rows.filter((_, j) => j !== i)) }}>Remove</Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" type="button" disabled={rows.length >= MAX} onClick={() => { setSaved(false); setRows([...rows, { name: "", email: "" }]) }}>Add another person</Button>
            <Button size="sm" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save recipients"}</Button>
            {saved && <span className="text-xs text-muted-foreground">Saved.</span>}
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  )
}
