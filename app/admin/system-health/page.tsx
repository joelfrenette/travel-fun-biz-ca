"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Activity } from "lucide-react"

interface CronStatus {
  name: string
  light: "green" | "amber" | "gray"
  label: string
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const LIGHT_VARIANT: Record<CronStatus["light"], "default" | "secondary" | "destructive"> = {
  green: "default",
  amber: "destructive",
  gray: "secondary",
}

const LIGHT_LABEL: Record<CronStatus["light"], string> = {
  green: "OK",
  amber: "Needs attention",
  gray: "Never run",
}

export default function SystemHealthPage() {
  const [crons, setCrons] = useState<CronStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  function load() {
    setLoading(true)
    fetch("/api/admin/cron-health", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setCrons(data.crons || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">System Health</h1>
          <p className="text-sm text-muted-foreground">
            Whether each scheduled job is actually running. A cron shows "Never run" until <code>CRON_SECRET</code> is set and its schedule fires for the first time - that's expected while a phase is still dormant, not a bug.
          </p>
        </div>
      </div>

      <div className="container mx-auto space-y-3 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : crons.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Activity className="h-8 w-8" />
            <p>No crons registered yet.</p>
          </div>
        ) : (
          crons.map((c) => (
            <Card key={c.name}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-[220px] flex-1">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.label}</p>
                </div>
                <Badge variant={LIGHT_VARIANT[c.light]}>{LIGHT_LABEL[c.light]}</Badge>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
