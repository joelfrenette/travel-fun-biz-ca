"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Search, Trash2, ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Plus } from "lucide-react"
import type { KeywordRow, LookupResult } from "@/lib/keywords"
import type { DbPackage } from "@/lib/packages"

const NO_TARGET = "__none__"
type SortField = "keyword" | "volume" | "cpc" | "competition" | "gsc_impressions" | "bing_impressions"

interface SearchConfigured { searchConsole: boolean; bing: boolean; siteUrl: string }
interface UntrackedQuery { query: string; clicks: number; impressions: number; ctr: number; position: number }

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

function Sparkline({ trend }: { trend: KeywordRow["trend"] }) {
  if (!trend || trend.length < 2) return <span className="text-xs text-muted-foreground">no trend</span>
  const values = trend.map((t) => t.value)
  const max = Math.max(...values, 1)
  const w = 96, h = 24
  const points = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(" ")
  const first = trend[0], last = trend[trend.length - 1]
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Monthly volume from ${first.month} ${first.year} to ${last.month} ${last.year}`} className="block">
      <polyline points={points} fill="none" strokeWidth={1.5} className="stroke-primary" />
    </svg>
  )
}

export default function KeywordsPage() {
  const [rows, setRows] = useState<KeywordRow[]>([])
  const [credits, setCredits] = useState<number | null>(null)
  const [configured, setConfigured] = useState(true)
  const [packages, setPackages] = useState<Pick<DbPackage, "id" | "name" | "slug" | "status">[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState("")
  const [country, setCountry] = useState<"ca" | "us">("ca")
  const [force, setForce] = useState(false)
  const [looking, setLooking] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")
  const [sortField, setSortField] = useState<SortField>("volume")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  // Search Console + Bing: real impressions and clicks for the site, next to the vendor volumes.
  const [searchConfigured, setSearchConfigured] = useState<SearchConfigured | null>(null)
  const [untracked, setUntracked] = useState<UntrackedQuery[]>([])
  const [searchError, setSearchError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [tracking, setTracking] = useState<Record<string, boolean>>({})

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/keywords", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/packages", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
    ])
      .then(([kw, pk]) => {
        if (!kw.ok) throw new Error(kw.data.error || "Could not load keywords")
        setRows(kw.data.keywords || [])
        setCredits(kw.data.credits ?? null)
        setConfigured(kw.data.configured !== false)
        if (pk.ok) setPackages(pk.data.packages || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))

    // Discovery is a separate request so a slow or failing Google call never blocks the list.
    fetch("/api/admin/keywords/search-data", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (data.configured) setSearchConfigured(data.configured)
        setUntracked(Array.isArray(data.untracked) ? data.untracked : [])
        if (!ok) setSearchError(data.error || "Search Console discovery failed")
      })
      .catch((e) => setSearchError(e instanceof Error ? e.message : "Search Console discovery failed"))
  }, [])

  const pendingCount = useMemo(() => {
    const seen = new Set<string>()
    input.split(/\r?\n|,/).forEach((s) => { const k = s.trim().toLowerCase().replace(/\s+/g, " "); if (k.length >= 2) seen.add(k) })
    return seen.size
  }, [input])

  const sorted = useMemo(() => {
    const list = [...rows]
    list.sort((a, b) => {
      const av = a[sortField], bv = b[sortField]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === "string" ? av.localeCompare(String(bv)) : Number(av) - Number(bv)
      return sortDir === "asc" ? cmp : -cmp
    })
    return list
  }, [rows, sortField, sortDir])

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc")
    else { setSortField(field); setSortDir(field === "keyword" ? "asc" : "desc") }
  }

  async function lookup() {
    setLooking(true); setError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ keywords: input, country, force }) })
      const data: LookupResult & { error?: string } = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      data.rows.forEach((r) => byKey.set(r.id, r))
      setRows(Array.from(byKey.values()))
      if (data.credits != null) setCredits(data.credits)
      setStatus(`${data.fetched} looked up (${data.creditsConsumed} credit${data.creditsConsumed === 1 ? "" : "s"}), ${data.cached} served from cache.`)
      setInput("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed")
    } finally {
      setLooking(false)
    }
  }

  async function refreshSearchData() {
    setRefreshing(true); setSearchError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords/search-data", { method: "POST", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (Array.isArray(data.keywords)) setRows(data.keywords)
      const parts = []
      if (data.configured?.searchConsole) parts.push(`Search Console updated ${data.gscUpdated} of ${data.tracked}`)
      if (data.configured?.bing) parts.push(`Bing updated ${data.bingUpdated} of ${data.tracked}`)
      setStatus(parts.join(" · ") + ".")
      if (Array.isArray(data.errors) && data.errors.length > 0) setSearchError(data.errors.slice(0, 3).join(" | ") + (data.errors.length > 3 ? ` (+${data.errors.length - 3} more)` : ""))
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Refresh failed")
    } finally {
      setRefreshing(false)
    }
  }

  // Add a Search Console phrase to the list without spending a Keywords Everywhere credit.
  async function track(q: UntrackedQuery) {
    setTracking((t) => ({ ...t, [q.query]: true }))
    try {
      const res = await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ keywords: [q.query], country, track_only: true }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const added: KeywordRow[] = Array.isArray(data.rows) ? data.rows : []
      setRows((rs) => {
        const byKey = new Map(rs.map((r) => [r.id, r]))
        // Show the Search Console numbers right away; the next refresh persists them.
        added.forEach((r) => byKey.set(r.id, { ...r, gsc_clicks: r.gsc_clicks ?? q.clicks, gsc_impressions: r.gsc_impressions ?? q.impressions, gsc_position: r.gsc_position ?? Math.round(q.position * 10) / 10 }))
        return Array.from(byKey.values())
      })
      setUntracked((u) => u.filter((x) => x.query !== q.query))
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Could not track")
    } finally {
      setTracking((t) => ({ ...t, [q.query]: false }))
    }
  }

  async function setTarget(row: KeywordRow, target_path: string | null) {
    setSaving((s) => ({ ...s, [row.id]: true }))
    const previous = row.target_path
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, target_path } : r)))
    try {
      const res = await fetch(`/api/admin/keywords/${row.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ target_path }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    } catch (e) {
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, target_path: previous } : r)))
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving((s) => ({ ...s, [row.id]: false }))
    }
  }

  async function remove(row: KeywordRow) {
    if (!confirm(`Remove "${row.keyword}" from your research list?`)) return
    const res = await fetch(`/api/admin/keywords/${row.id}`, { method: "DELETE", headers: authHeaders() })
    if (res.ok) setRows((rs) => rs.filter((r) => r.id !== row.id))
    else setError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  const targetOptions = [
    { value: "/", label: "Home page" },
    ...packages.map((p) => ({ value: `/packages/${p.slug}`, label: `${p.name}${p.status !== "published" ? ` (${p.status})` : ""}` })),
  ]
  const pageCounts = rows.reduce<Record<string, number>>((acc, r) => { if (r.target_path) acc[r.target_path] = (acc[r.target_path] || 0) + 1; return acc }, {})
  const searchDataAvailable = !!(searchConfigured?.searchConsole || searchConfigured?.bing)
  const lastSearchFetch = rows.reduce<string | null>((latest, r) => {
    const t = r.gsc_fetched_at || r.bing_fetched_at
    return t && (!latest || t > latest) ? t : latest
  }, null)

  const SortIcon = ({ field }: { field: SortField }) => sortField === field ? (sortDir === "asc" ? <ArrowUp className="ml-1 inline h-3 w-3" /> : <ArrowDown className="ml-1 inline h-3 w-3" />) : <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">Keyword Research</h1>
            <p className="text-sm text-muted-foreground">Search volume from Keywords Everywhere, your real Google and Bing numbers, and the page each phrase should rank for.</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Button variant="outline" size="sm" onClick={refreshSearchData} disabled={refreshing || !searchDataAvailable || rows.length === 0} title={searchDataAvailable ? "Pull the last 28 days from Search Console and Bing" : "Set up Search Console or Bing first"}>
              {refreshing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}Refresh search data
            </Button>
            <span className="text-muted-foreground">Credits</span>
            <Badge variant="outline" className="font-mono">{credits == null ? "—" : credits.toLocaleString()}</Badge>
          </div>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {!configured && (
          <Card className="border-destructive/50"><CardContent className="p-4 text-sm">
            <span className="font-medium">KEYWORD_DATA_API_KEY is not set in Vercel.</span> Add your Keywords Everywhere API key and redeploy; the cached list below still works.
          </CardContent></Card>
        )}
        {searchConfigured && !searchConfigured.searchConsole && (
          <Card className="border-amber-500/50"><CardContent className="p-4 text-sm">
            <span className="font-medium">Search Console is not connected.</span> Set GOOGLE_SERVICE_ACCOUNT_KEY in Vercel and add the service account email as a user on the <span className="font-mono">{searchConfigured.siteUrl}</span> property. Until then the Google columns stay empty.
          </CardContent></Card>
        )}
        {searchConfigured && !searchConfigured.bing && (
          <Card className="border-amber-500/50"><CardContent className="p-4 text-sm">
            <span className="font-medium">Bing Webmaster is not connected.</span> Verify the site in Bing Webmaster Tools, generate an API key, and set BING_WEBMASTER_API_KEY in Vercel.
          </CardContent></Card>
        )}

        <Card>
          <CardContent className="grid gap-4 p-4 lg:grid-cols-[1fr_260px]">
            <div className="space-y-2">
              <Label htmlFor="kw-input">Phrases to look up (one per line)</Label>
              <Textarea id="kw-input" rows={5} value={input} onChange={(e) => setInput(e.target.value)} placeholder={"group travel for singles over 50\ncroatia yacht cruise 2027\nrhine river cruise from canada"} />
              <p className="text-xs text-muted-foreground">
                {pendingCount} phrase{pendingCount === 1 ? "" : "s"} · costs at most {pendingCount} credit{pendingCount === 1 ? "" : "s"}; phrases looked up in the last 30 days are free.
              </p>
            </div>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Country</Label>
                <Select value={country} onValueChange={(v) => setCountry(v as "ca" | "us")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ca">Canada (CAD)</SelectItem>
                    <SelectItem value="us">United States (USD)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                Refresh even if cached (spends credits)
              </label>
              <Button className="w-full" onClick={lookup} disabled={looking || pendingCount === 0 || !configured}>
                {looking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}Look up
              </Button>
              {status && <p className="text-xs text-muted-foreground">{status}</p>}
            </div>
          </CardContent>
        </Card>

        {untracked.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-semibold">Phrases Google already shows you for</h2>
                  <p className="text-xs text-muted-foreground">Top Search Console queries from the last 28 days that are not on your list yet. Track costs no credits; look up later to add volume.</p>
                </div>
                <Badge variant="outline">{untracked.length}</Badge>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="discover-table">
                  <thead className="text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-1 text-left">Query</th>
                      <th className="py-1 text-right">Impressions</th>
                      <th className="py-1 text-right">Clicks</th>
                      <th className="py-1 text-right">Position</th>
                      <th className="w-24 py-1"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {untracked.map((q) => (
                      <tr key={q.query}>
                        <td className="py-1.5 font-medium">{q.query}</td>
                        <td className="py-1.5 text-right tabular-nums">{q.impressions.toLocaleString()}</td>
                        <td className="py-1.5 text-right tabular-nums">{q.clicks.toLocaleString()}</td>
                        <td className="py-1.5 text-right tabular-nums">{q.position.toFixed(1)}</td>
                        <td className="py-1.5 text-right">
                          <Button variant="outline" size="sm" className="h-7" onClick={() => track(q)} disabled={!!tracking[q.query]}>
                            {tracking[q.query] ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}Track
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {searchError && <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{searchError}</div>}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="p-3 text-left"><button onClick={() => toggleSort("keyword")}>Phrase<SortIcon field="keyword" /></button></th>
                  <th className="p-3 text-right"><button onClick={() => toggleSort("volume")}>Volume / mo<SortIcon field="volume" /></button></th>
                  <th className="p-3 text-right"><button onClick={() => toggleSort("cpc")}>CPC<SortIcon field="cpc" /></button></th>
                  <th className="p-3 text-right"><button onClick={() => toggleSort("competition")}>Competition<SortIcon field="competition" /></button></th>
                  <th className="p-3 text-left">12-month trend</th>
                  <th className="p-3 text-right" title="Search Console, last 28 days: impressions / clicks / average position"><button onClick={() => toggleSort("gsc_impressions")}>Google 28d<SortIcon field="gsc_impressions" /></button></th>
                  <th className="p-3 text-right" title="Bing Webmaster: impressions on Bing in the latest month"><button onClick={() => toggleSort("bing_impressions")}>Bing / mo<SortIcon field="bing_impressions" /></button></th>
                  <th className="p-3 text-left">Target page</th>
                  <th className="w-10 p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sorted.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/30">
                    <td className="p-3">
                      <div className="font-medium">{row.keyword}</div>
                      <div className="text-xs text-muted-foreground">{row.country.toUpperCase()} · {row.volume == null && new Date(row.fetched_at).getTime() === 0 ? "not looked up" : new Date(row.fetched_at).toLocaleDateString("en-CA")}</div>
                    </td>
                    <td className="p-3 text-right tabular-nums">{row.volume == null ? "—" : row.volume.toLocaleString()}</td>
                    <td className="p-3 text-right tabular-nums">{row.cpc == null ? "—" : `${row.cpc_currency || ""}${row.cpc.toFixed(2)}`}</td>
                    <td className="p-3 text-right tabular-nums">{row.competition == null ? "—" : row.competition.toFixed(2)}</td>
                    <td className="p-3"><Sparkline trend={row.trend} /></td>
                    <td className="p-3 text-right tabular-nums">
                      {row.gsc_impressions == null ? "—" : (
                        <>
                          <div>{row.gsc_impressions.toLocaleString()} <span className="text-xs text-muted-foreground">impr</span></div>
                          <div className="text-xs text-muted-foreground">{(row.gsc_clicks ?? 0).toLocaleString()} clicks{row.gsc_position != null ? ` · pos ${row.gsc_position.toFixed(1)}` : ""}</div>
                        </>
                      )}
                    </td>
                    <td className="p-3 text-right tabular-nums">{row.bing_impressions == null ? "—" : row.bing_impressions.toLocaleString()}</td>
                    <td className="p-3">
                      <Select value={row.target_path || NO_TARGET} onValueChange={(v) => setTarget(row, v === NO_TARGET ? null : v)} disabled={!!saving[row.id]}>
                        <SelectTrigger className="h-8 w-[220px] text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_TARGET}>Not assigned</SelectItem>
                          {targetOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{o.label}{pageCounts[o.value] ? ` · ${pageCounts[o.value]}` : ""}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-3 text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(row)} title="Remove"><Trash2 className="h-4 w-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div className="py-12 text-center text-muted-foreground">No phrases yet. Paste a few above to start.</div>}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          One target phrase per page. A page with two or more phrases assigned is a sign to split it or pick one.
          {lastSearchFetch && <> Search data last refreshed {new Date(lastSearchFetch).toLocaleString("en-CA")}.</>}
        </p>
      </div>
    </div>
  )
}
