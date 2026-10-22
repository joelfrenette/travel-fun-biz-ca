"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Wrench } from "lucide-react"
import { DISTRIBUTION_MODE_TEXT } from "@/lib/posts-page-summary"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

interface Facts {
  distributionMode: "off" | "prepare" | "auto"
  paused: boolean
  publishMode: "draft" | "publish" | null
  caps: { perDay: number; perWeek: number } | null
  usage: { today: number | null; week: number | null } | null
  heal: { cap: number; used: number; readable: boolean; waiting: string; healedToday: number } | null
  catchup: { enabled: boolean; key: string }
  backfill: { state: "none" | "running" | "cancelled" | "done"; written: number; waiting: number }
  safePages: { count: number; attemptsUsed: number; maxAttempts: number; usedUp: number; ready: number } | null
  orphans: { count: number; checked: number; at: string } | null
  photosNeeded: number | null
}

/** The Automation card on Posts: Guides. It reports what runs on its own and holds the two admin-only actions that cost something
 * or change what gets posted: the old-guide social catch-up switch and the global Heal now. Everything else is read only here; the
 * publish mode, caps and backfill are changed in the cards below. */
export default function GuidesAutomationCard({ refreshKey = 0, onChanged }: { refreshKey?: number; onChanged?: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<Facts | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")

  const load = useCallback(() => {
    fetch("/api/admin/posts/automation?type=guides", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load")
        setData(body as Facts)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])
  useEffect(() => { load() }, [load, refreshKey])

  async function toggleCatchup(next: boolean) {
    setBusy("catchup")
    try {
      const res = await fetch("/api/admin/posts/automation", { method: "POST", headers: authHeaders(), body: JSON.stringify({ setting: "guide_catchup_posts", enabled: next }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: next ? "Old-guide posting is on" : "Old-guide posting is off" })
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy("")
    }
  }

  async function healNow() {
    if (!confirm("Run the heal step now? It rewrites held pages with the AI, uses part of today's AI-call limit, and every change can be undone from Content edits. It can take a few minutes.")) return
    setBusy("heal")
    try {
      const res = await fetch("/api/admin/content-edits", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "heal-now" }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: "Heal finished", description: body.note })
      load()
      onChanged?.()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy("")
    }
  }

  const backfillText = !data ? "" : data.backfill.state === "running" ? `running: ${data.backfill.written} written, ${data.backfill.waiting} waiting` : data.backfill.state === "cancelled" ? "cancelled" : data.backfill.state === "done" ? `finished (${data.backfill.written} written)` : "not started"

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">Automation</p>
          {data?.publishMode && <Badge variant={data.publishMode === "publish" ? "default" : "secondary"}>Guides: {data.publishMode === "publish" ? "publish mode" : "review mode"}</Badge>}
          {data?.caps && <Badge variant="outline">{data.caps.perDay} a day, {data.caps.perWeek} a week</Badge>}
          {data?.paused && <Badge variant="destructive">Paused by kill switch</Badge>}
        </div>
        {!data && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && (
          <>
            <p className="text-sm">
              {data.publishMode === "publish"
                ? "A destination or cruise line guide that passes every check goes live by itself. Named places (hotels, resorts, ships, river cruises, yachts) always wait for you."
                : data.publishMode === "draft"
                  ? "Every new guide is saved as a draft and waits for your review."
                  : "The publish mode could not be read."}
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>
                Daily heal budget: {data.heal ? (data.heal.readable ? `${data.heal.used} of ${data.heal.cap} AI calls used today` : "could not be read (no rewriting runs, which is safe)") : "unknown"}
                {data.heal ? ` · ${data.heal.healedToday} item${data.heal.healedToday === 1 ? "" : "s"} healed today` : ""}
                {data.heal?.waiting ? ` · ${data.heal.waiting}` : ""}
              </li>
              <li>New guides written: {data.usage ? `${data.usage.today ?? "?"} today, ${data.usage.week ?? "?"} in the last 7 days` : "unknown"}</li>
              <li>Backfill: {backfillText} (start or cancel it in the Backfill card below)</li>
              <li>
                Safe pages: {data.safePages ? `${data.safePages.count} live, ${data.safePages.attemptsUsed} upgrade tries used, ${data.safePages.usedUp} out of tries, ${data.safePages.ready} ready for the next try` : "could not be read"} (details in the Safe pages card below)
              </li>
              <li>
                Orphans (live pages nothing links to):{" "}
                {data.orphans ? <Link href="/admin/guides?filter=orphans" className="underline">{data.orphans.count}</Link> : "could not be counted"}
              </li>
              <li>
                Guides with duplicate or missing photos: {typeof data.photosNeeded === "number" ? data.photosNeeded : "could not be read"} (the daily heal gives up to 3 a day a fresh photo; every change can be undone from Content edits)
              </li>
              <li>
                Social posting: {DISTRIBUTION_MODE_TEXT[data.distributionMode]} · <Link href="/admin/distribution" className="underline">Post Distribution</Link>
              </li>
            </ul>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <p className="min-w-[240px] flex-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Post old guides to social: {data.catchup.enabled ? "on" : "off"}. </span>
                When on, the posting pass also enrols one older live guide a day (within the daily guide limit) that was never posted. Off until the titled covers are proven.
              </p>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => toggleCatchup(!data.catchup.enabled)}>
                {busy === "catchup" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{data.catchup.enabled ? "Turn off" : "Turn on"}
              </Button>
            </div>
            <div>
              <Button size="sm" variant="outline" disabled={!!busy || data.paused} onClick={healNow} title="Runs the daily heal step now. It uses today's AI-call limit; every change can be undone from Content edits.">
                {busy === "heal" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}Heal now (all held pages)
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
