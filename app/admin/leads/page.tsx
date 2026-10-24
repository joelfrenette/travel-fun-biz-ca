"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Users } from "lucide-react"
import type { LeadRow } from "@/lib/leads"
import { PAGE_TYPE_LABELS, pageTypeOfPath } from "@/lib/conversion"
import { needsAgent } from "@/lib/lead-desk"
import { LeadDeskRow } from "@/components/admin/leads-desk"

/** Every source fact stored for a lead, plainest first: the page the form was on, then how the visitor arrived. */
function leadSourceParts(l: LeadRow): string[] {
  return [
    l.page_path && `form on ${l.page_path} (${PAGE_TYPE_LABELS[pageTypeOfPath(l.page_path)].toLowerCase()})`,
    l.utm_source && `campaign source ${l.utm_source}`,
    l.utm_medium && `medium ${l.utm_medium}`,
    l.utm_campaign && `campaign ${l.utm_campaign}`,
    l.utm_content && `content ${l.utm_content}`,
    l.utm_term && `term ${l.utm_term}`,
    l.referrer && `from ${l.referrer}`,
    l.landing_path && `landed on ${l.landing_path}`,
  ].filter((x): x is string => !!x)
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [onlyNeedsAgent, setOnlyNeedsAgent] = useState(false)
  const [deskReady, setDeskReady] = useState(true)
  const [gaReady, setGaReady] = useState(true)

  useEffect(() => {
    fetch("/api/admin/leads", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setLeads(data.leads || [])
        setDeskReady(data.deskReady !== false)
        setGaReady(data.gaReady !== false)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [])

  // Test leads (made-up people used to try the forms) are shown, labelled, but never counted or warned about.
  const failed = leads.filter((l) => !l.forwarded_to_ghl && !l.is_test)
  const waitingForAgent = leads.filter(needsAgent)
  const shown = onlyNeedsAgent ? waitingForAgent : leads
  const patchLead = (id: string, patch: Partial<LeadRow>) => setLeads((all) => all.map((l) => (l.id === id ? { ...l, ...patch } : l)))

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

        <p className="text-xs text-muted-foreground">
          "Analytics id: yes" means the visitor accepted analytics, so this lead can be tied to Google Analytics (and a server-side lead event can be sent when GA4_MEASUREMENT_PROTOCOL_SECRET is set). It is "no" when they declined or never chose. The id itself is never shown.
          {!gaReady && !loading && " The database column is not there yet (migration 0056), so every lead shows no."}
        </p>
        {!deskReady && !loading &&<div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">The lead desk columns are not in the database yet (migration 0055), so hot leads and agents cannot be shown here.</div>}
        {!loading && deskReady && (
          <label className="flex min-h-11 w-fit cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyNeedsAgent} onChange={(e) => setOnlyNeedsAgent(e.target.checked)} className="h-4 w-4" />
            Needs an agent ({waitingForAgent.length})
          </label>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : leads.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Users className="h-8 w-8" />
            <p>No leads yet. They'll show up here as soon as someone submits the contact form.</p>
          </div>
        ) : (
          shown.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No lead is waiting for an agent.</p> : shown.map((l) => (
            <Card key={l.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-[220px] flex-1">
                  <p className="font-medium">{l.name}{l.is_test && <Badge variant="outline" className="ml-2 align-middle text-[10px]">TEST - not counted</Badge>}</p>
                  <p className="text-xs text-muted-foreground">
                    {l.email}{l.phone ? ` · ${l.phone}` : ""}{l.package ? ` · ${l.package}` : ""} · {new Date(l.created_at).toLocaleString("en-CA")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">Lead source:</span>{" "}
                    {(() => {
                      const parts = leadSourceParts(l)
                      return parts.length > 0 ? parts.join(" · ") : "not recorded (the visitor did not accept analytics, or the form was on a page before sources were saved)"
                    })()}
                  </p>
                  <p className="text-xs text-muted-foreground" data-testid="lead-ga-id">
                    <span className="font-semibold text-foreground">Analytics id:</span> {l.has_ga_client_id ? "yes" : "no"}
                  </p>
                  {l.ghl_error &&<p className="text-xs text-destructive">GHL: {l.ghl_error}</p>}
                  <LeadDeskRow lead={l} onChanged={(patch) => patchLead(l.id, patch)} />
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
