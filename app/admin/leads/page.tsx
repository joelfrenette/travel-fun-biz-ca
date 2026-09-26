"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Users } from "lucide-react"
import type { LeadRow } from "@/lib/leads"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/leads", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setLeads(data.leads || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [])

  const failed = leads.filter((l) => !l.forwarded_to_ghl)

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground">Every contact-form submission, saved here whether or not it reached GoHighLevel - a backup, not a replacement for GHL.</p>
        </div>
      </div>

      <div className="container mx-auto space-y-3 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {failed.length > 0 && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {failed.length} lead{failed.length === 1 ? "" : "s"} never reached GoHighLevel - check the "failed" ones below and follow up manually.
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : leads.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Users className="h-8 w-8" />
            <p>No leads yet. They'll show up here as soon as someone submits the contact form.</p>
          </div>
        ) : (
          leads.map((l) => (
            <Card key={l.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-[220px] flex-1">
                  <p className="font-medium">{l.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {l.email}{l.phone ? ` · ${l.phone}` : ""}{l.package ? ` · ${l.package}` : ""} · {new Date(l.created_at).toLocaleString("en-CA")}
                  </p>
                  {l.ghl_error && <p className="text-xs text-destructive">GHL: {l.ghl_error}</p>}
                </div>
                <Badge variant={l.forwarded_to_ghl ? "default" : "destructive"}>{l.forwarded_to_ghl ? "sent to GHL" : "failed"}</Badge>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
