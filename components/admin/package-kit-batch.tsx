"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Loader2, Wand2 } from "lucide-react"

// "Fill all thin pages": goes through the thinnest trips ONE AT A TIME (each is its own request, so a timeout on one never loses
// the others) and shows progress. Each fill is capped and cached on the server; the daily AI limit stops the loop cleanly.

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}`, "Content-Type": "application/json" }
}

interface Row {
  id: string
  name: string
  score: number
}

export function PackageKitBatch({ onDone }: { onDone?: () => void }) {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  async function run() {
    setRunning(true)
    setLog([])
    const list = await fetch("/api/admin/packages/trip-kit", { headers: authHeaders() })
    if (!list.ok) {
      setLog(["Could not read the list of trips."])
      setRunning(false)
      return
    }
    const trips = ((await list.json()) as { trips: Row[] }).trips
    setProgress({ done: 0, total: trips.length })
    if (trips.length === 0) setLog(["Every trip page is at 75 or more and has its route record."])
    let done = 0
    for (const t of trips) {
      setLog((l) => [...l, `${t.name}: filling (now ${t.score})`])
      try {
        const res = await fetch(`/api/admin/packages/${t.id}/trip-kit`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "fill" }) })
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; after?: { completeness: { score: number }; seo: { score: number } } }
        setLog((l) => [...l.slice(0, -1), j.ok ? `${t.name}: complete ${t.score} to ${j.after?.completeness.score}, SEO ${j.after?.seo.score}` : `${t.name}: not filled (${j.error ?? "see the trip"})`])
        if (!j.ok && /limit/i.test(j.error ?? "")) break
      } catch {
        setLog((l) => [...l.slice(0, -1), `${t.name}: the request failed, moving on`])
      }
      done++
      setProgress({ done, total: trips.length })
    }
    setRunning(false)
    onDone?.()
  }

  return (
    <div className="mb-4 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={run} disabled={running}>{running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}Fill all thin pages</Button>
        {progress && <span className="text-sm text-muted-foreground">{progress.done} of {progress.total} done</span>}
      </div>
      {log.length > 0 && <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" role="status">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </div>
  )
}
