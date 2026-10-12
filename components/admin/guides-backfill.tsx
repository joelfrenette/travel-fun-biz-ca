"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { Loader2, ListChecks, Play, Ban } from "lucide-react"

// The one-time pages backfill (growth loop WP16). Three steps, in this order, and the second one costs nothing:
//   1. "Preview the list": a DRY RUN. It lists the pages the published trips would create and what writing them could
//      cost. It makes no AI call and writes nothing.
//   2. Read the estimate and choose how many pages to write in the first batch (never uncapped).
//   3. "Start the backfill": stores the list. The ordinary pipeline step then writes them, a few a day, until the
//      batch is done, and carries on at the normal daily cap for the rest. Every page still goes through the same
//      checks as any other page, and pages that name a business wait in the Review queue unless the checks are clean.

interface PlanPage { kind: string; slug: string; name: string; scope: string | null; origin: string }
interface Estimate { guides: number; callsMin: number; callsMax: number; usdMin: number; usdMax: number }
interface Plan {
  pages: PlanPage[]
  skipped: { kind: string; name: string; reason: string }[]
  byKind: { kind: string; count: number }[]
  namedCount: number
  estimateAll: Estimate
  suggestedBatch: number
  hardMax: number
  alreadyRunning: { written: number; waiting: number; remainingBatch: number } | null
}
interface Status {
  started_at: string
  batch_cap: number
  cancelled_at: string | null
  listed: number
  written: number
  waiting: number
  remainingBatch: number
  bursting: boolean
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const money = (n: number) => `$${n.toFixed(2)}`
const KIND_LABEL: Record<string, string> = { destinations: "Destinations", hotels: "Hotels", resorts: "Resorts", "cruise-lines": "Cruise lines", ships: "Ships", "river-cruises": "River cruises", yachts: "Yachts" }

export function GuidesBackfillCard({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [batch, setBatch] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const loadStatus = useCallback(() => {
    fetch("/api/admin/guides", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load the backfill")
        setStatus(body.backfill ?? null)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the backfill"))
  }, [])
  useEffect(() => { loadStatus() }, [loadStatus])

  async function post(key: string, payload: Record<string, unknown>) {
    setBusy(key)
    try {
      const res = await fetch("/api/admin/guides", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
      return null
    } finally {
      setBusy("")
    }
  }

  async function preview() {
    const body = await post("plan", { action: "backfill-plan" })
    if (body) {
      setPlan(body)
      setBatch(String(body.suggestedBatch))
    }
  }

  async function start() {
    if (!plan) return
    const n = Number(batch)
    if (!Number.isInteger(n) || n < 1 || n > plan.hardMax) {
      toast({ title: "Choose a batch size", description: `Enter a whole number from 1 to ${Math.min(plan.hardMax, plan.pages.length)}.`, variant: "destructive" })
      return
    }
    const est = estimate(plan, n)
    if (!confirm(`Write the first ${Math.min(n, plan.pages.length)} pages now (estimated ${money(est.usdMin)} to ${money(est.usdMax)}), then the remaining ${Math.max(0, plan.pages.length - n)} one a day?`)) return
    const body = await post("start", { action: "backfill-start", confirm: true, batchCap: n, expectedCount: plan.pages.length })
    if (body) {
      toast({ title: "Backfill started", description: body.note })
      setPlan(null)
      loadStatus()
      onChanged?.()
    }
  }

  async function cancel() {
    if (!confirm("Stop the backfill? Pages already written stay. The daily cap goes back to normal.")) return
    const body = await post("cancel", { action: "backfill-cancel" })
    if (body) {
      toast({ title: "Backfill cancelled", description: body.note })
      loadStatus()
    }
  }

  const running = !!status && !status.cancelled_at && status.waiting > 0

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[260px] flex-1">
            <h2 className="flex items-center gap-2 font-semibold">One-time backfill from your trips {running && <Badge>Running</Badge>}</h2>
            <p className="text-xs text-muted-foreground">
              Builds a page for every destination, hotel, resort, ship, cruise line, river cruise and yacht your live trips name. Nothing is written until you start it. Every page goes through the same
              checks as any other page; a page that names a business goes live only if the checks are clean, otherwise it waits in the Review queue below.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!!busy} onClick={preview}>
              {busy === "plan" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ListChecks className="mr-1 h-4 w-4" />}Preview the list (free)
            </Button>
            {running && (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={cancel}>
                {busy === "cancel" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Ban className="mr-1 h-4 w-4" />}Cancel
              </Button>
            )}
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {status && (
          <p className="text-xs text-muted-foreground">
            {status.cancelled_at ? "Cancelled. " : ""}
            Listed {status.listed}, written {status.written}, still waiting {status.waiting}. First batch: {status.batch_cap} pages{status.bursting ? `, ${status.remainingBatch} left in the batch` : ", used up, so the rest follow the normal daily cap"}.
          </p>
        )}

        {plan && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            {plan.alreadyRunning && plan.alreadyRunning.waiting > 0 ? (
              <p className="text-sm">A backfill is already running ({plan.alreadyRunning.waiting} pages waiting). It carries on by itself. Cancel it above if you want to start over.</p>
            ) : plan.pages.length === 0 ? (
              <p className="text-sm">Nothing to backfill: every page your trips name already exists{plan.skipped.length ? ", or was skipped (below)" : ""}.</p>
            ) : (
              <>
                <p className="text-sm">
                  <span className="font-medium">{plan.pages.length} pages</span> would be written ({plan.byKind.map((k) => `${k.count} ${KIND_LABEL[k.kind]?.toLowerCase() ?? k.kind}`).join(", ")}). {plan.namedCount} of them name a business and go to the Review queue unless the checks are clean.
                </p>
                <p className="text-sm">
                  Estimated cost for all {plan.estimateAll.guides}: <span className="font-medium">{money(plan.estimateAll.usdMin)} to {money(plan.estimateAll.usdMax)}</span> ({plan.estimateAll.callsMin} to {plan.estimateAll.callsMax} AI calls, at the site&apos;s usual per-call estimate; the real bill may differ). This preview made no AI call.
                </p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    Write this many in the first batch
                    <Input className="h-8 w-20" inputMode="numeric" value={batch} onChange={(e) => setBatch(e.target.value)} aria-label="First batch size" />
                  </label>
                  {Number.isInteger(Number(batch)) && Number(batch) >= 1 && (
                    <span className="text-xs text-muted-foreground">about {money(estimate(plan, Number(batch)).usdMin)} to {money(estimate(plan, Number(batch)).usdMax)} (max {Math.min(plan.hardMax, plan.pages.length)})</span>
                  )}
                  <Button size="sm" disabled={!!busy} onClick={start}>
                    {busy === "start" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}Start the backfill
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">The first batch is written by the next pipeline passes, up to five a day. After that the remaining pages follow at the normal daily cap. It never goes past the number you choose.</p>
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">See the {plan.pages.length} pages</summary>
                  <ul className="mt-2 grid gap-x-6 sm:grid-cols-2">
                    {plan.pages.map((p) => <li key={`${p.kind}:${p.slug}`}>{p.name} <span className="text-muted-foreground">({KIND_LABEL[p.kind]?.toLowerCase() ?? p.kind}{p.scope ? `, ${p.scope}` : ""})</span></li>)}
                  </ul>
                </details>
              </>
            )}
            {plan.skipped.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer font-medium">{plan.skipped.length} left out</summary>
                <ul className="mt-2 space-y-0.5">
                  {plan.skipped.map((s) => <li key={`${s.kind}:${s.name}`}>{s.name}: {s.reason}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The same range the server shows, from the stored per-call numbers (2 to 4 calls a page at $0.05 a call). */
function estimate(plan: Plan, n: number): Estimate {
  const perMin = plan.estimateAll.guides > 0 ? plan.estimateAll.usdMin / plan.estimateAll.guides : 0.1
  const perMax = plan.estimateAll.guides > 0 ? plan.estimateAll.usdMax / plan.estimateAll.guides : 0.2
  const count = Math.min(n, plan.pages.length)
  return { guides: count, callsMin: 0, callsMax: 0, usdMin: Math.round(count * perMin * 100) / 100, usdMax: Math.round(count * perMax * 100) / 100 }
}
