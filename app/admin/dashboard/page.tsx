"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { adminTools, SETUP_STEPS_URL } from "@/lib/admin-nav"
import type { Ga4RangeReport } from "@/lib/ga4"
import type { SearchRangeResult, VisitsRangeResult } from "@/lib/dashboard-data"
import type { TopPagesResponse, TopPostsResponse } from "@/lib/dashboard-top-data"
import { TopPagesCard, TopPostsCard } from "@/components/admin/dashboard-top-cards"
import { FunnelPanel } from "@/components/admin/funnel-panel"
import { DashboardRangePills } from "@/components/admin/dashboard-range-pills"
import { StatTile, TrafficChartCard, searchNote, type Loadable, type TrafficInputs } from "@/components/admin/dashboard-cards"
import { CHANNEL_COLORS, DEFAULT_RANGE, RANGE_PHRASE, RANGE_STORAGE_KEY, SERIES_COLORS, bucketFor, resolveRange, type DashRange } from "@/lib/dashboard-range"

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

/** Fetches one dashboard card's data for a range. Ignores a late answer for a range the user already left. */
function useRangeData<T>(url: string, range: DashRange, enabled: boolean): { state: Loadable<T>; raw: { status: number; json: any } | null } {
  const [state, setState] = useState<Loadable<T>>({ kind: "loading" })
  const [raw, setRaw] = useState<{ status: number; json: any } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ kind: "loading" })
    fetch(`${url}?range=${range}`, { headers: authHeaders() })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        setRaw({ status: res.status, json })
        if (!res.ok || json.error) setState({ kind: "error", message: json.error || `HTTP ${res.status}` })
        else setState({ kind: "ready", data: json as T })
      })
      .catch(() => !cancelled && setState({ kind: "error", message: "network error" }))
    return () => {
      cancelled = true
    }
  }, [url, range, enabled])
  return { state, raw }
}

// ─── Admin Dashboard (its own page; Today lives at /admin) ───────────────────────
export default function AdminDashboardPage() {
  const router = useRouter()
  const [range, setRange] = useState<DashRange>(DEFAULT_RANGE)
  const [rangeReady, setRangeReady] = useState(false)

  // Range comes from the URL first, then localStorage, else 30 days. Read after mount so the server and browser first render match.
  useEffect(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(RANGE_STORAGE_KEY)
    } catch {
      stored = null
    }
    setRange(resolveRange(new URLSearchParams(window.location.search).get("range"), stored))
    setRangeReady(true)
  }, [])

  function chooseRange(next: DashRange) {
    setRange(next)
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, next)
    } catch {
      // storage blocked: the URL still carries the choice
    }
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("range", next)
      window.history.replaceState(null, "", url.toString())
    } catch {
      // ignore
    }
  }

  const ga = useRangeData<Ga4RangeReport>("/api/admin/analytics", range, rangeReady)
  const search = useRangeData<SearchRangeResult>("/api/admin/dashboard-search", range, rangeReady)
  const visits = useRangeData<VisitsRangeResult>("/api/admin/dashboard-visits", range, rangeReady)
  const topPages = useRangeData<TopPagesResponse>("/api/admin/dashboard-top-pages", range, rangeReady)
  const topPosts = useRangeData<TopPostsResponse>("/api/admin/dashboard-top-posts", range, rangeReady)
  const notConnected = ga.raw?.json?.configured === false && ga.state.kind === "ready"
  const phrase = RANGE_PHRASE[range]

  const g = ga.state.kind === "ready" && !notConnected ? ga.state.data.totals : null
  const gaLoading = !rangeReady || ga.state.kind === "loading"
  const gaNote = (extra = "") => (notConnected ? "Google Analytics is not connected" : ga.state.kind === "error" ? "could not be read" : `Google Analytics, ${phrase}${extra}`)
  const num = (n: number | undefined) => (g && n !== undefined ? n.toLocaleString() : null)

  const s = search.state.kind === "ready" ? search.state.data : null
  const searchLoading = !rangeReady || search.state.kind === "loading"
  const searchValue = (n: number | undefined) => (s && s.totals && n !== undefined ? n.toLocaleString() : null)
  const searchTileNote = s ? searchNote(range, s) : search.state.kind === "error" ? "could not be read" : ""

  const v = visits.state.kind === "ready" ? visits.state.data : null
  const visitsLoading = !rangeReady || visits.state.kind === "loading"

  // The three sources for the one traffic chart. null = still loading (the card shows its skeleton).
  const trafficInputs: TrafficInputs = useMemo(() => {
    const gaIn = !rangeReady || ga.state.kind === "loading" ? null : notConnected ? ({ status: "not_connected" } as const) : ga.state.kind === "error" ? ({ status: "error", message: ga.state.message } as const) : ({ status: "ok", report: (ga.state as { kind: "ready"; data: Ga4RangeReport }).data } as const)
    const seIn = !rangeReady || search.state.kind === "loading" ? null : search.state.kind === "error" ? ({ status: "error", message: search.state.message } as const) : ({ status: "ok", data: search.state.data } as const)
    const viIn = !rangeReady || visits.state.kind === "loading" ? null : visits.state.kind === "error" ? ({ status: "error", message: visits.state.message } as const) : ({ status: "ok", data: visits.state.data } as const)
    return { ga: gaIn, search: seIn, visits: viIn }
  }, [rangeReady, ga.state, notConnected, search.state, visits.state])

  return (
    <div className="container mx-auto px-4 py-6">
      <div id="dashboard" className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="mt-1 text-muted-foreground">Traffic, the funnel and every tool. What needs a decision today is on the Today page.</p>
        </div>
        <div className="flex flex-col gap-1 sm:items-end">
          <DashboardRangePills value={range} onChange={chooseRange} />
          <p className="text-xs text-muted-foreground sm:text-right">The range drives every card below that can follow it. Cards that cannot say so in small text.</p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Sessions" value={num(g?.sessions)} note={gaNote()} color="#2563eb" loading={gaLoading} />
        <StatTile label="Users" value={num(g?.users)} note={gaNote()} color="#7c3aed" loading={gaLoading} />
        <StatTile label="Organic search sessions" value={num(g?.organicSearch)} note={gaNote()} color={CHANNEL_COLORS["Organic Search"]} loading={gaLoading} />
        <StatTile label="Direct sessions" value={num(g?.direct)} note={gaNote()} color={CHANNEL_COLORS.Direct} loading={gaLoading} />
        <StatTile label="Referral sessions" value={num(g?.referral)} note={gaNote()} color={CHANNEL_COLORS.Referral} loading={gaLoading} />
        <StatTile label="Social sessions" value={num(g?.social)} note={gaNote()} color={CHANNEL_COLORS["Organic Social"]} loading={gaLoading} />
      </div>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Google Search clicks" value={searchValue(s?.totals?.clicks)} note={searchTileNote} color={SERIES_COLORS.clicks} loading={searchLoading} />
        <StatTile label="Google Search impressions" value={searchValue(s?.totals?.impressions)} note={searchTileNote} color={SERIES_COLORS.impressions} loading={searchLoading} />
        <StatTile
          label="Search click rate and position"
          value={s?.totals && s.source === "live" ? `${(s.totals.ctr * 100).toFixed(1)}% · #${s.totals.position}` : s?.totals ? `${(s.totals.ctr * 100).toFixed(1)}%` : null}
          note={s?.source === "snapshot" ? "click rate only; position needs a live read" : searchTileNote}
          color="#0891b2"
          loading={searchLoading}
        />
        <StatTile
          label="Visits recorded by this site"
          value={v && v.trackingOn && !v.error ? v.total.toLocaleString() : null}
          note={v ? (!v.trackingOn ? "visit tracking is off" : v.error ? "could not be read" : `recorded after consent, ${phrase}`) : visits.state.kind === "error" ? "could not be read" : ""}
          color={SERIES_COLORS.visits}
          loading={visitsLoading}
        />
      </div>

      <div className="mb-8 space-y-6">
        <TrafficChartCard range={range} bucket={bucketFor(range)} inputs={trafficInputs} setupUrl={SETUP_STEPS_URL} />
        <TopPagesCard range={range} state={topPages.state} />
        <TopPostsCard range={range} state={topPosts.state} />
      </div>

      <div className="mb-8">
        <FunnelPanel range={range} />
      </div>

      <div className="mb-4">
        <h2 className="text-lg font-semibold">Admin Tools</h2>
        <p className="text-sm text-muted-foreground">Select a tool to get started. Features will be activated as we build them together.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {adminTools.map((tool) => (
          <Card
            key={tool.title}
            className={`group relative overflow-hidden transition-shadow hover:shadow-lg ${tool.href ? "cursor-pointer" : ""}`}
            onClick={() => tool.href && router.push(tool.href)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="rounded-lg bg-primary/10 p-2">
                  <tool.icon className="h-5 w-5 text-primary" />
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                  tool.status === "Active"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {tool.status}
                </span>
              </div>
              <CardTitle className="mt-3 text-base">{tool.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{tool.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
