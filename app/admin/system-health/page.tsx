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
  const [visitsOn, setVisitsOn] = useState(false)
  const [visitsBusy, setVisitsBusy] = useState(false)
  const [ackOn, setAckOn] = useState(false)
  const [ackConfigured, setAckConfigured] = useState(false)
  const [ackBusy, setAckBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  function load() {
    setLoading(true)
    Promise.all([
      fetch("/api/admin/cron-health", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/automation-kill-switch", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/visit-tracking", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/lead-ack", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
    ])
      .then(([cronRes, pauseRes, visitsRes, ackRes]) => {
        if (ackRes.ok) {
          setAckOn(!!ackRes.data.on)
          setAckConfigured(!!ackRes.data.configured)
        }
        if (!cronRes.ok) throw new Error(cronRes.data.error || "Could not load")
        setCrons(cronRes.data.crons || [])
        if (pauseRes.ok) setPaused(!!pauseRes.data.paused)
        if (visitsRes.ok) setVisitsOn(!!visitsRes.data.on)
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

  async function toggleVisits() {
    const next = !visitsOn
    if (next && !confirm("Turn visit counting on? Do this only after your lawyer has approved the cookie wording. Only people who click Accept on the cookie banner are counted.")) return
    setVisitsBusy(true)
    try {
      const res = await fetch("/api/admin/visit-tracking", { method: "POST", headers: authHeaders(), body: JSON.stringify({ on: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setVisitsOn(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setVisitsBusy(false)
    }
  }

  async function toggleAck() {
    const next = !ackOn
    if (next && !confirm("Turn on the instant lead reply? Every new real lead will get a short confirmation email. Do this only after the wording in lib/lead-ack-copy.ts has been approved for CASL.")) return
    setAckBusy(true)
    try {
      const res = await fetch("/api/admin/lead-ack", { method: "POST", headers: authHeaders(), body: JSON.stringify({ on: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setAckOn(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setAckBusy(false)
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

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-[220px] flex-1">
              <p className="font-medium">{visitsOn ? "Visit counting is ON" : "Visit counting is OFF"}</p>
              <p className="text-sm text-muted-foreground">
                When on, this site counts visits itself, but only for people who click Accept on the cookie banner. It saves the page, the website they came from, the campaign tag, a random number and the time spent. It never saves an IP address. Turn this on only after your lawyer has approved the cookie wording. Records are deleted after 13 months.
              </p>
            </div>
            <Button variant={visitsOn ? "outline" : "default"} onClick={toggleVisits} disabled={loading || visitsBusy}>
              {visitsBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {visitsOn ? "Turn visit counting off" : "Turn visit counting on"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-[220px] flex-1">
              <p className="font-medium">{ackOn ? "Instant lead reply is ON" : "Instant lead reply is OFF"}</p>
              <p className="text-sm text-muted-foreground">
                When on, a new real lead gets one short "we got your message" email (at most one per address per 24 hours). It makes no promise about response time. The wording is a draft in <code>lib/lead-ack-copy.ts</code> and should be approved for CASL before this is turned on.
                {!ackConfigured && " Not ready yet: set RESEND_API_KEY and LEAD_ACK_FROM_EMAIL (an address on a domain verified in Resend), or nothing will be sent."}
              </p>
            </div>
            <Button variant={ackOn ? "outline" : "default"} onClick={toggleAck} disabled={loading || ackBusy}>
              {ackBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {ackOn ? "Turn instant reply off" : "Turn instant reply on"}
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
