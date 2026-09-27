"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, Activity, Pause, Play } from "lucide-react"

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
  const [paused, setPaused] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  function load() {
    setLoading(true)
    Promise.all([
      fetch("/api/admin/cron-health", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/automation-kill-switch", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
    ])
      .then(([cronRes, pauseRes]) => {
        if (!cronRes.ok) throw new Error(cronRes.data.error || "Could not load")
        setCrons(cronRes.data.crons || [])
        if (pauseRes.ok) setPaused(!!pauseRes.data.paused)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function toggleAutomation() {
    const next = !paused
    if (!next && !confirm("Resume automated publishing and posting? Autoblog and distribution will go back to whatever mode each was already set to.")) return
    setPauseBusy(true)
    try {
      const res = await fetch("/api/admin/automation-kill-switch", { method: "POST", headers: authHeaders(), body: JSON.stringify({ paused: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setPaused(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setPauseBusy(false)
    }
  }

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

        <Card className={paused ? "border-destructive" : undefined}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">{paused ? "Automation is paused" : "Automation is running normally"}</p>
              <p className="text-sm text-muted-foreground">
                One switch for both autoblog and social distribution. It overrides them without changing their individual settings — flip it back and each resumes whatever mode it already had.
              </p>
            </div>
            <Button variant={paused ? "default" : "destructive"} onClick={toggleAutomation} disabled={loading || pauseBusy}>
              {pauseBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : paused ? <Play className="mr-1.5 h-4 w-4" /> : <Pause className="mr-1.5 h-4 w-4" />}
              {paused ? "Resume automation" : "Pause all automation"}
            </Button>
          </CardContent>
        </Card>

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
