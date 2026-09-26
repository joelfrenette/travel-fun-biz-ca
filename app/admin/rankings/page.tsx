"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, TrendingUp, TrendingDown, LineChart } from "lucide-react"

interface RankDayRow {
  day: string
  top10: number
  top50: number
  top100: number
  queries: number
  clicks: number
  impressions: number
}

interface Mover {
  key: string
  first: number
  latest: number
  change: number
  clicks: number
  impressions: number
  series: { day: string; position: number }[]
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

function sparkPoints(series: { position: number }[], width: number, height: number): string {
  if (series.length < 2) return ""
  const values = series.map((p) => p.position)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * width
      const y = ((p.position - min) / span) * (height - 2) + 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
}

function MoverRow({ m }: { m: Mover }) {
  const up = m.change > 0
  const flat = m.change === 0
  return (
    <div className="flex items-center justify-between gap-3 border-t py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{m.key}</p>
        <p className="text-xs text-muted-foreground">
          #{m.first.toFixed(1)} &rarr; #{m.latest.toFixed(1)} &middot; {m.clicks} clicks &middot; {m.impressions} impressions
        </p>
      </div>
      <svg width="80" height="24" className="flex-shrink-0 text-muted-foreground">
        <polyline points={sparkPoints(m.series, 80, 24)} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className={`flex items-center gap-1 text-sm font-medium ${flat ? "text-muted-foreground" : up ? "text-emerald-600" : "text-destructive"}`}>
        {!flat && (up ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />)}
        {Math.abs(m.change).toFixed(1)}
      </span>
    </div>
  )
}

export default function RankingsPage() {
  const [days, setDays] = useState<RankDayRow[]>([])
  const [queryMovers, setQueryMovers] = useState<Mover[]>([])
  const [pageMovers, setPageMovers] = useState<Mover[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/rankings", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setDays(data.days || [])
        setQueryMovers(data.queryMovers || [])
        setPageMovers(data.pageMovers || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [])

  const latest = days[days.length - 1]

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Search Rankings</h1>
          <p className="text-sm text-muted-foreground">Where your pages and keywords sit in Google, tracked once a day by the SEO rankings snapshot.</p>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : days.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <LineChart className="h-8 w-8" />
            <p>No data yet.</p>
            <p className="max-w-md text-sm">This fills in once <code className="rounded bg-muted px-1">CRON_SECRET</code> is set and the daily SEO rankings snapshot runs for the first time. Check the System Health page to see whether it's running.</p>
          </div>
        ) : (
          <>
            {latest && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ["Top 10", latest.top10],
                  ["Top 50", latest.top50],
                  ["Top 100", latest.top100],
                  ["Keywords tracked", latest.queries],
                ].map(([label, value]) => (
                  <Card key={label as string}>
                    <CardContent className="p-4">
                      <p className="text-2xl font-bold">{value}</p>
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Biggest keyword movers</h2>
                {queryMovers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Not enough history yet - check back after a few more days of snapshots.</p>
                ) : (
                  queryMovers.map((m) => <MoverRow key={m.key} m={m} />)
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Biggest page movers</h2>
                {pageMovers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Not enough history yet - check back after a few more days of snapshots.</p>
                ) : (
                  pageMovers.map((m) => <MoverRow key={m.key} m={m} />)
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
