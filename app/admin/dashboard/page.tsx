"use client"

import { useEffect, useMemo, useState } from "react"
import { SETUP_STEPS_URL } from "@/lib/admin-nav"
import type { Ga4RangeReport } from "@/lib/ga4"
import type { SearchRangeResult, VisitsRangeResult } from "@/lib/dashboard-data"
import type { TopPagesResponse, TopPostsResponse } from "@/lib/dashboard-top-data"
import type { TopKeywordsResponse } from "@/lib/dashboard-keywords"
import { TopKeywordsCard, TopPagesCard, TopPostsCard } from "@/components/admin/dashboard-top-cards"
import { FunnelPanel } from "@/components/admin/funnel-panel"
import { DashboardRangePills } from "@/components/admin/dashboard-range-pills"
import { StatTile, TrafficChartCard, searchNote, type Loadable, type TrafficInputs } from "@/components/admin/dashboard-cards"
import { DEFAULT_RANGE, RANGE_PHRASE, RANGE_STORAGE_KEY, SERIES_COLORS, bucketFor, resolveRange, type DashRange } from "@/lib/dashboard-range"

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
  const topKeywords = useRangeData<TopKeywordsResponse>("/api/admin/dashboard-top-keywords", range, rangeReady)
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
          <p className="mt-1 text-muted-foreground">Where your visitors come from, what they look at, and what Google shows. The past 30 days to start with.</p>
        </div>
        <div className="flex flex-col gap-1 sm:items-end">
          <DashboardRangePills value={range} onChange={chooseRange} />
          <p className="text-xs text-muted-foreground sm:text-right">The range drives every card below that can follow it. Cards that cannot say so in small text.</p>
        </div>
      </div>

      {/* 1. The first graphic: combined traffic from every source, colour coded, with the breakdown inside it. */}
      <div className="mb-8">
        <TrafficChartCard range={range} bucket={bucketFor(range)} inputs={trafficInputs} setupUrl={SETUP_STEPS_URL} />
      </div>

      {/* 2. Visitors: the few numbers that matter. */}
      <h2 className="mb-3 text-lg font-semibold">Visitors</h2>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Sessions" value={num(g?.sessions)} note={gaNote()} color="#2563eb" loading={gaLoading} />
        <StatTile label="Users" value={num(g?.users)} note={gaNote()} color="#7c3aed" loading={gaLoading} />
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

      {/* 3. Top pages, top posts, top keywords. */}
      <div className="mb-8 space-y-6">
        <TopPagesCard range={range} state={topPages.state} />
        <TopPostsCard range={range} state={topPosts.state} />
        <TopKeywordsCard range={range} state={topKeywords.state} />
      </div>

      <div className="mb-8">
        <FunnelPanel range={range} />
      </div>
    </div>
  )
}

