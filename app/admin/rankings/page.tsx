"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, TrendingUp, TrendingDown, LineChart } from "lucide-react"
import { googlePageOf, movementOf } from "@/lib/rankings"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PAGE_TYPE_LABEL, pageTypeOf, type PageType, type SitePage } from "@/lib/site-pages"

interface RankedPage extends SitePage {
  position: number | null
  clicks: number
  impressions: number
  topKeyword: string | null
}

// Same column widths for the header and every row of the "every page" table.
const PAGE_COLS = "grid grid-cols-[minmax(0,2fr)_90px_minmax(0,1.4fr)_84px_84px_64px_80px] items-center gap-3"

function AllPagesTable({ pages }: { pages: RankedPage[] }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px]">
        <div className={`${PAGE_COLS} border-b pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground`}>
          <span>Page</span>
          <span>Type</span>
          <span>Top keyword</span>
          <span className="text-center">Google page</span>
          <span className="text-center">Position (1-100)</span>
          <span className="text-right">Clicks</span>
          <span className="text-right">Impressions</span>
        </div>
        {pages.map((p) => {
          const pos = p.position != null ? Math.round(p.position) : 0
          return (
            <div key={p.path} className={`${PAGE_COLS} border-t py-2 first:border-t-0`}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={p.title}>{p.title}</p>
                <p className="truncate text-xs text-muted-foreground" title={p.path}>{p.path}</p>
              </div>
              <Badge variant="outline" className="w-fit text-[10px]">{PAGE_TYPE_LABEL[p.type].replace(/s$/, "")}</Badge>
              <p className="truncate text-sm text-muted-foreground" title={p.topKeyword ?? "Not reported by Google yet"}>{p.topKeyword ?? "-"}</p>
              <span className="text-center text-xl font-bold">{pos >= 1 ? `Page ${googlePageOf(p.position as number)}` : "-"}</span>
              <span className="text-center text-2xl font-bold">{pos >= 1 ? pos : <span className="text-sm font-normal text-muted-foreground">not ranking yet</span>}</span>
              <span className="text-right text-sm tabular-nums">{p.clicks}</span>
              <span className="text-right text-sm tabular-nums">{p.impressions}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

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
  /** The page for a keyword, or the top keyword for a page (null until Search Console reports it). */
  other?: string | null
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

// Same column widths for the header and every row, so the headed columns line up.
const COLS = "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_72px_84px_84px_84px] items-center gap-3"

function MoverTable({ movers, nameLabel, otherLabel, emptyOther }: { movers: Mover[]; nameLabel: string; otherLabel: string; emptyOther: string }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div className={`${COLS} border-b pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground`}>
          <span>{nameLabel}</span>
          <span>{otherLabel}</span>
          <span>Trend</span>
          <span className="text-center">Movement</span>
          <span className="text-center">Google page</span>
          <span className="text-center">Position (1-100)</span>
        </div>
        {movers.map((m) => (
          <MoverRow key={m.key} m={m} emptyOther={emptyOther} />
        ))}
      </div>
    </div>
  )
}

function MoverRow({ m, emptyOther }: { m: Mover; emptyOther: string }) {
  const move = movementOf(m.change)
  const position = Math.round(m.latest)
  return (
    <div className={`${COLS} border-t py-2 first:border-t-0`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium" title={m.key}>{m.key}</p>
        <p className="text-xs text-muted-foreground">{m.clicks} clicks &middot; {m.impressions} impressions</p>
      </div>
      <p className="truncate text-sm text-muted-foreground" title={m.other ?? emptyOther}>{m.other ?? "-"}</p>
      <svg width="64" height="24" className="text-muted-foreground">
        <polyline points={sparkPoints(m.series, 64, 24)} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className={`flex items-center justify-center gap-1 text-sm font-semibold ${move.dir === "same" ? "text-muted-foreground" : move.dir === "up" ? "text-emerald-600" : "text-destructive"}`}>
        {move.dir === "same" ? "0" : (
          <>
            {move.dir === "up" ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            {move.dir === "up" ? "Up" : "Down"} {move.amount}
          </>
        )}
      </span>
      <span className="text-center text-xl font-bold">{position >= 1 ? `Page ${googlePageOf(m.latest)}` : "-"}</span>
      <span className="text-center text-2xl font-bold">{position >= 1 ? position : "-"}</span>
    </div>
  )
}

export default function RankingsPage() {
  const [days, setDays] = useState<RankDayRow[]>([])
  const [queryMovers, setQueryMovers] = useState<Mover[]>([])
  const [pageMovers, setPageMovers] = useState<Mover[]>([])
  const [pages, setPages] = useState<RankedPage[]>([])
  // One dropdown filters all three tables by kind of page.
  const [typeFilter, setTypeFilter] = useState<"all" | PageType>("all")
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
        setPages(Array.isArray(data.pages) ? data.pages : [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [])

  const latest = days[days.length - 1]
  const matches = (path: string | null | undefined) => typeFilter === "all" || (!!path && pageTypeOf(path) === typeFilter)
  const visiblePages = pages
    .filter((p) => matches(p.path))
    .sort((a, b) => (a.position != null ? 0 : 1) - (b.position != null ? 0 : 1) || (a.position ?? 0) - (b.position ?? 0) || a.title.localeCompare(b.title))
  const visibleQueryMovers = queryMovers.filter((m) => matches(m.other))
  const visiblePageMovers = pageMovers.filter((m) => matches(m.key))

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

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">Show</span>
              <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as "all" | PageType)}>
                <SelectTrigger className="h-9 w-[220px] text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All pages</SelectItem>
                  <SelectItem value="package">Packages ({pages.filter((p) => p.type === "package").length})</SelectItem>
                  <SelectItem value="destination">Destinations ({pages.filter((p) => p.type === "destination").length})</SelectItem>
                  <SelectItem value="guide">Guides ({pages.filter((p) => p.type === "guide").length})</SelectItem>
                  <SelectItem value="blog">Blog posts ({pages.filter((p) => p.type === "blog").length})</SelectItem>
                  <SelectItem value="home">Home page</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">Every package, destination and blog page is tracked, ranking or not.</span>
            </div>

            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Every page ({visiblePages.length})</h2>
                {visiblePages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No pages of this kind yet.</p>
                ) : (
                  <AllPagesTable pages={visiblePages} />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Biggest keyword movers</h2>
                {visibleQueryMovers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Not enough history yet - check back after a few more days of snapshots.</p>
                ) : (
                  <MoverTable movers={visibleQueryMovers} nameLabel="Keyword" otherLabel="Page" emptyOther="Not reported by Google yet" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Biggest page movers</h2>
                {visiblePageMovers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Not enough history yet - check back after a few more days of snapshots.</p>
                ) : (
                  <MoverTable movers={visiblePageMovers} nameLabel="Page" otherLabel="Top keyword" emptyOther="Not reported by Google yet" />
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
