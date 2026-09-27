"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2 } from "lucide-react"
import type { FunnelResult } from "@/lib/funnel"

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

        {funnel.visitsByChannel.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Visits by channel</p>
            <div className="flex flex-wrap gap-2">
              {funnel.visitsByChannel.map((c) => (
                <Badge key={c.channel} variant="secondary">{c.channel}: {c.count.toLocaleString()}</Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
