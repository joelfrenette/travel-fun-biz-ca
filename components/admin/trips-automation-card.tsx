"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "lucide-react"
import { DISTRIBUTION_MODE_TEXT } from "@/lib/posts-page-summary"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

interface Facts {
  distributionMode: "off" | "prepare" | "auto"
  paused: boolean
  tripSocial: { enabled: boolean; key: string }
  caps: { perTripDays: number; perWeek: number; holdHours: number; text: string }
  heldNow: number | null
  enrolledThisWeek: number | null
  pastTripsNeedingRecap: number | null
  drift: { findings: number | null }
}

/** The Automation card on Posts: Trips. The posting rules are fixed in code, so they are shown, not edited. The one switch here is
 * "post trips to social automatically", which uses the same exact-'true' setting as the Post Distribution page. */
export default function TripsAutomationCard() {
  const { toast } = useToast()
  const [data, setData] = useState<Facts | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetch("/api/admin/posts/automation?type=trips", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load")
        setData(body as Facts)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])
  useEffect(() => { load() }, [load])

  async function toggle(next: boolean) {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/posts/automation", { method: "POST", headers: authHeaders(), body: JSON.stringify({ setting: "trip_social_posts", enabled: next }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: next ? "Automatic trip posts are on" : "Automatic trip posts are off" })
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const n = (v: number | null) => (v === null ? "could not be read" : String(v))

  return (
    <div className="border-b bg-card/30">
      <div className="container mx-auto px-4 py-3">
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">Automation</p>
              {data && <Badge variant={data.tripSocial.enabled ? "default" : "secondary"}>Trip social posts: {data.tripSocial.enabled ? "on" : "off"}</Badge>}
              {data && <Badge variant="outline">{data.caps.text}</Badge>}
              {data?.paused && <Badge variant="destructive">Paused by kill switch</Badge>}
            </div>
            {!data && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {data && (
              <>
                <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
                  <p className="min-w-[240px] flex-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Post trips to social automatically: {data.tripSocial.enabled ? "on" : "off"}. </span>
                    When on, one published trip with a price and dates is queued for social, up to the weekly limit below. It never posts a trip with no price or no dates, or one that already happened. Social posting itself must also be on in Post Distribution.
                  </p>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => toggle(!data.tripSocial.enabled)}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{data.tripSocial.enabled ? "Turn off" : "Turn on"}
                  </Button>
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  <li>Limits: {data.caps.text}. A queued trip post waits {data.caps.holdHours} hours before it can go out on its own.</li>
                  <li>This week: {n(data.enrolledThisWeek)} of {data.caps.perWeek} trip posts queued · {n(data.heldNow)} waiting on a hold or your approval</li>
                  <li>
                    Social posting: {DISTRIBUTION_MODE_TEXT[data.distributionMode]} · <Link href="/admin/distribution" className="underline">Post Distribution</Link>
                  </li>
                  <li>Promote this package: open a published trip with the three-dot menu on a row below and choose Promote. That posts it now and counts toward the same limits.</li>
                  <li>
                    Past trips: {n(data.pastTripsNeedingRecap)} published past trip{data.pastTripsNeedingRecap === 1 ? "" : "s"} still need a recap (past trips are never unpublished).
                  </li>
                  <li>
                    Drift check: {data.drift.findings === null ? "could not run just now" : data.drift.findings === 0 ? "no published post disagrees with its trip's current data" : `${data.drift.findings} published post${data.drift.findings === 1 ? "" : "s"} disagree with their trip's current data (see Needs attention)`}
                  </li>
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
