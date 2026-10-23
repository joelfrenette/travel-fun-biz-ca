"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2 } from "lucide-react"
import type { FunnelResult } from "@/lib/funnel"
import { CHANNEL_LABELS, type Channel } from "@/lib/traffic-source"

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { maximumFractionDigits: 0 })}`
}

// The dashboard's one funnel widget - reads lib/funnel.ts's getFunnel() through /api/admin/funnel
// and never re-derives any of these counts itself, so this can't disagree with anywhere else that
// number is shown (see the comment in lib/funnel.ts on why that rule exists).
export function FunnelPanel() {
  const [funnel, setFunnel] = useState<FunnelResult | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/funnel?days=28", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setFunnel(data)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])

  if (error) return <Card className="col-span-full"><CardContent className="p-4 text-sm text-destructive">{error}</CardContent></Card>
  if (!funnel) return <Card className="col-span-full"><CardContent className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></CardContent></Card>

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Funnel — last {funnel.days} days</CardTitle>
        <CardDescription>
          {formatMoney(funnel.revenueCents)} collected (test orders excluded). Stages marked "not tracked yet" have no code recording
          them at all — that's not a zero result, it's a gap. See the setup checklist for what unlocks each one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {funnel.stages.map((stage) => (
            <div key={stage.key} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">{stage.label}</p>
                {!stage.tracked && <Badge variant="outline" className="shrink-0 text-[10px]">not tracked yet</Badge>}
              </div>
              <p className="mt-1 text-2xl font-bold leading-none">{stage.tracked ? stage.count.toLocaleString() : "—"}</p>
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{stage.note}</p>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Visit to lead, by page type</p>
          {funnel.byPageType === null ? (
            <p className="text-[11px] text-muted-foreground">Not measured: the lead pages could not be read.</p>
          ) : funnel.byPageType.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No visits or leads to split by page type yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr><th className="py-1 pr-3 font-medium">Page type</th><th className="py-1 pr-3 font-medium">Visits landed</th><th className="py-1 pr-3 font-medium">Leads (form on this page)</th><th className="py-1 font-medium">Leads per 100 visits</th></tr>
                </thead>
                <tbody>
                  {funnel.byPageType.map((r) => (
                    <tr key={r.type} className="border-t">
                      <td className="py-1 pr-3">{r.label}</td>
                      <td className="py-1 pr-3">{r.visits === null ? "not measured" : r.visits.toLocaleString()}</td>
                      <td className="py-1 pr-3">{r.leads.toLocaleString()}</td>
                      <td className="py-1">{r.per100 === null ? "not measured" : r.per100}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            Enquiry-form views and form starts are not measured here: they exist only as Google Analytics events (form_start, form_submit, cta_view, cta_click, thank_you_view) for visitors who accepted analytics. Visits count the page a visit landed on; a lead counts the page its form was on, so the two can differ.
          </p>
        </div>

        {funnel.visitsByChannel.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Visits by channel</p>
            <div className="flex flex-wrap gap-2">
              {funnel.visitsByChannel.map((c) => (
                <Badge key={c.channel} variant="secondary">{CHANNEL_LABELS[c.channel as Channel] ?? c.channel}: {c.count.toLocaleString()}</Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
