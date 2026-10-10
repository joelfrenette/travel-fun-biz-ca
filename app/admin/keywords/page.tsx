"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Search, Trash2, ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Plus, Sparkles } from "lucide-react"
import type { KeywordRow, KeywordSuggestion, LookupResult } from "@/lib/keywords"
import { PAGE_TYPE_LABEL, suggestPage, type PageType, type SitePage } from "@/lib/site-pages"

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
  const [balanceUsd, setBalanceUsd] = useState<number | null>(null)
  const [configured, setConfigured] = useState(true)
  // Every package, destination and blog page (the target dropdown), and the page Google really shows
  // for each keyword (keyed by lowercase keyword).
  const [pages, setPages] = useState<SitePage[]>([])
  const [rankedOn, setRankedOn] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState(false)
  // Score per phrase (winnability, demand, intent, timing) and the topics that would be written next.
  const [scores, setScores] = useState<Record<string, { score: number; parts: { winnability: number; demand: number; intent: number; timing: number }; eligible: boolean; reasons: string[]; packageName: string | null; primary: string; secondary: string[] }>>({})
  // Ideas from autocomplete, People Also Ask and Reddit, saved for you to track; and whether the weekly search happened.
  const [ideas, setIdeas] = useState<{ phrase: string; source: string; seed: string }[]>([])
  const [finding, setFinding] = useState(false)
  const [nextUpList, setNextUpList] = useState<{ keyword: string; score: number; packageName: string | null; secondary: string[]; parts: { winnability: number; demand: number; intent: number; timing: number } }[]>([])
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
  // Keyword ideas: real suggestions from a seed phrase (DataForSEO Labs), never auto-saved -
  // the admin picks which ones are worth tracking.
  const [seedInput, setSeedInput] = useState("")
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<KeywordSuggestion[]>([])
  const [suggestError, setSuggestError] = useState("")
  const [suggestStatus, setSuggestStatus] = useState("")
  const [savingSuggestion, setSavingSuggestion] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch("/api/admin/keywords", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then((kw) => {
        if (!kw.ok) throw new Error(kw.data.error || "Could not load keywords")
        setRows(kw.data.keywords || [])
        setBalanceUsd(kw.data.balanceUsd ?? null)
        setConfigured(kw.data.configured !== false)
        setPages(Array.isArray(kw.data.pages) ? kw.data.pages : [])
        setRankedOn(kw.data.rankedOn && typeof kw.data.rankedOn === "object" ? kw.data.rankedOn : {})
        setScores(kw.data.scores && typeof kw.data.scores === "object" ? kw.data.scores : {})
        setNextUpList(Array.isArray(kw.data.nextUp) ? kw.data.nextUp : [])
        setIdeas(Array.isArray(kw.data.ideas) ? kw.data.ideas : [])
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
      if (data.balanceUsd != null) setBalanceUsd(data.balanceUsd)
      setStatus(`${data.fetched} looked up ($${data.costUsd.toFixed(4)}), ${data.cached} served from cache.`)
      setInput("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed")
    } finally {
      setLooking(false)
    }
  }

  async function getSuggestions() {
    if (seedInput.trim().length < 2) return
    setSuggesting(true); setSuggestError(""); setSuggestStatus(""); setSuggestions([])
    try {
      const res = await fetch("/api/admin/keywords/suggest", { method: "POST", headers: authHeaders(), body: JSON.stringify({ seed: seedInput.trim(), country }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const already = new Set(rows.filter((r) => r.country === country).map((r) => r.keyword))
      setSuggestions((data.suggestions || []).filter((s: KeywordSuggestion) => !already.has(s.keyword)))
      setSuggestStatus(`${data.suggestions?.length || 0} ideas ($${(data.costUsd ?? 0).toFixed(4)}).`)
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : "Could not get suggestions")
    } finally {
      setSuggesting(false)
    }
  }

  async function addSuggestion(s: KeywordSuggestion) {
    setSavingSuggestion((m) => ({ ...m, [s.keyword]: true }))
    try {
      const res = await fetch("/api/admin/keywords/suggest", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ suggestion: s, country }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setRows((rs) => {
        const byKey = new Map(rs.map((r) => [r.id, r]))
        byKey.set(data.row.id, data.row)
        return Array.from(byKey.values())
      })
      setSuggestions((list) => list.filter((x) => x.keyword !== s.keyword))
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSavingSuggestion((m) => ({ ...m, [s.keyword]: false }))
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

  // Add a Search Console phrase to the list without spending anything.
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

  // The dropdown lists EVERY page of the site, grouped: home, packages, destinations, blog posts.
  const pageByPath = new Map(pages.map((p) => [p.path, p]))
  const labelOf = (p: SitePage) => `${p.title}${p.status && p.status !== "published" ? ` (${p.status})` : ""}`
  const groups = (["home", "package", "destination", "guide", "blog"] as PageType[]).map((type) => ({ type, items: pages.filter((p) => p.type === type) })).filter((g) => g.items.length)
  // A target saved earlier that is not in the list (a page since removed) still shows, so it is never hidden.
  const orphanTargets = Array.from(new Set(rows.map((r) => r.target_path).filter((t): t is string => !!t && !pageByPath.has(t))))

  async function findIdeas() {
    setFinding(true); setError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ collectIdeas: true }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (Array.isArray(data.ideas)) setIdeas(data.ideas)
      setStatus(data.note || "Done.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not find ideas")
    } finally {
      setFinding(false)
    }
  }

  // Track an idea (free: it joins the list; look it up later to get volume), then remove it from the ideas.
  async function trackIdea(phrase: string) {
    setTracking((t) => ({ ...t, [phrase]: true }))
    try {
      const res = await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ keywords: [phrase], country, track_only: true }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const added: KeywordRow[] = Array.isArray(data.rows) ? data.rows : []
      setRows((rs) => { const byKey = new Map(rs.map((r) => [r.id, r])); added.forEach((r) => byKey.set(r.id, r)); return Array.from(byKey.values()) })
      await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ dropIdea: phrase }) })
      setIdeas((l) => l.filter((i) => i.phrase !== phrase))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not track")
    } finally {
      setTracking((t) => ({ ...t, [phrase]: false }))
    }
  }

  async function connectAll() {
    setConnecting(true); setError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ connectAll: true }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (Array.isArray(data.keywords)) setRows(data.keywords)
      setStatus(data.connected ? `Connected ${data.connected} keyword${data.connected === 1 ? "" : "s"} to the page they rank on.` : "Nothing to connect: every keyword that ranks already has a target page.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect")
    } finally {
      setConnecting(false)
    }
  }
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
            <p className="text-sm text-muted-foreground">Search volume from DataForSEO, your real Google and Bing numbers, and the page each phrase should rank for.</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Button variant="outline" size="sm" onClick={connectAll} disabled={connecting || rows.length === 0} title="Set the target page of every keyword that has none to the page Google really shows for it. Pages you chose by hand are never changed. This also runs by itself every day.">
              {connecting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}Connect keywords to their pages
            </Button>
            <Button variant="outline" size="sm" onClick={refreshSearchData} disabled={refreshing || !searchDataAvailable || rows.length === 0} title={searchDataAvailable ? "Pull the last 28 days from Search Console and Bing" : "Set up Search Console or Bing first"}>
              {refreshing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}Refresh search data
            </Button>
            <span className="text-muted-foreground">Balance</span>
            <Badge variant="outline" className="font-mono">{balanceUsd == null ? "—" : `$${balanceUsd.toFixed(2)}`}</Badge>
          </div>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {!configured && (
          <Card className="border-destructive/50"><CardContent className="p-4 text-sm">
            <span className="font-medium">DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set in Vercel.</span> Add your DataForSEO login and password and redeploy; the cached list below still works.
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
                {pendingCount} phrase{pendingCount === 1 ? "" : "s"} · real money, a small fraction of a cent per phrase; phrases looked up in the last 30 days are free (served from cache).
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
                Refresh even if cached (spends real money)
              </label>
              <Button className="w-full" onClick={lookup} disabled={looking || pendingCount === 0 || !configured}>
                {looking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}Look up
              </Button>
              {status && <p className="text-xs text-muted-foreground">{status}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div>
              <h2 className="font-semibold">Get keyword ideas</h2>
              <p className="text-xs text-muted-foreground">Type one real phrase (a destination, a package type) and get real related phrases with real search volume - things you haven&apos;t thought of yet, not just a lookup of what you already typed.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") getSuggestions() }}
                placeholder="e.g. river cruise for singles"
                className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
              />
              <Button onClick={getSuggestions} disabled={suggesting || seedInput.trim().length < 2 || !configured}>
                {suggesting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}Get ideas
              </Button>
            </div>
            {suggestStatus && <p className="text-xs text-muted-foreground">{suggestStatus}</p>}
            {suggestError && <p className="text-sm text-destructive">{suggestError}</p>}
            {suggestions.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase">
                    <tr>
                      <th className="p-2 text-left">Phrase</th>
                      <th className="p-2 text-right">Volume / mo</th>
                      <th className="p-2 text-right">CPC</th>
                      <th className="p-2 text-right">Competition</th>
                      <th className="w-20 p-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {suggestions.map((s) => (
                      <tr key={s.keyword}>
                        <td className="p-2 font-medium">{s.keyword}</td>
                        <td className="p-2 text-right tabular-nums">{s.volume == null ? "—" : s.volume.toLocaleString()}</td>
                        <td className="p-2 text-right tabular-nums">{s.cpc == null ? "—" : `$${s.cpc.toFixed(2)}`}</td>
                        <td className="p-2 text-right tabular-nums">{s.competition == null ? "—" : s.competition}</td>
                        <td className="p-2 text-right">
                          <Button variant="outline" size="sm" className="h-7" onClick={() => addSuggestion(s)} disabled={!!savingSuggestion[s.keyword]}>
                            {savingSuggestion[s.keyword] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {nextUpList.length > 0 && (
          <Card>
            <CardContent className="space-y-2 p-4">
              <div>
                <h2 className="font-semibold">Next blog posts (best first)</h2>
                <p className="text-xs text-muted-foreground">Score out of 100: winnability 40% (low competition, a specific phrase, Google already showing you), demand 25%, intent to book 20%, timing 15% (publish 3 to 12 months before departure). Only phrases about a trip you really sell, that nothing covers yet. A volume of 0 means Google does not report small numbers, not that nobody searches.</p>
              </div>
              <ol className="space-y-1 text-sm">
                {nextUpList.map((n, i) => (
                  <li key={n.keyword} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="w-5 text-muted-foreground">{i + 1}.</span>
                    <span className="font-medium">{n.keyword}</span>
                    <Badge variant="outline">{n.score}/100</Badge>
                    {n.packageName && <span className="text-xs text-muted-foreground">about {n.packageName}</span>}
                    {n.secondary.length > 0 && <span className="text-xs text-muted-foreground">+ also covers: {n.secondary.slice(0, 3).join(", ")}</span>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">Keyword ideas ({ideas.length})</h2>
                <p className="text-xs text-muted-foreground">What people really type into Google (autocomplete), the questions Google shows under searches (People Also Ask), and Reddit questions once Reddit is connected. Found automatically once a week for a couple of cents. Track one to add it to your list for free; look it up later to get its search volume.</p>
              </div>
              <Button variant="outline" size="sm" onClick={findIdeas} disabled={finding || !configured} title="Costs about 2 to 4 cents">
                {finding ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}Find ideas now
              </Button>
            </div>
            {ideas.length === 0 ? (
              <p className="text-sm text-muted-foreground">No ideas waiting. Press &quot;Find ideas now&quot; or wait for the weekly search.</p>
            ) : (
              <ul className="max-h-[320px] space-y-1 overflow-y-auto text-sm">
                {ideas.map((i) => (
                  <li key={i.phrase} className="flex flex-wrap items-center justify-between gap-2 border-t pt-1 first:border-t-0 first:pt-0">
                    <span><span className="font-medium">{i.phrase}</span> <Badge variant="outline" className="ml-1 text-[10px]">{i.source === "question" ? "question" : i.source === "reddit" ? "Reddit" : "autocomplete"}</Badge> <span className="text-xs text-muted-foreground">from &quot;{i.seed}&quot;</span></span>
                    <Button variant="outline" size="sm" className="h-7" onClick={() => trackIdea(i.phrase)} disabled={!!tracking[i.phrase]}>
                      {tracking[i.phrase] ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}Track
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {untracked.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-semibold">Phrases Google already shows you for</h2>
                  <p className="text-xs text-muted-foreground">Top Search Console queries from the last 28 days that are not on your list yet. Track costs nothing; look up later to add volume.</p>
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
                  <th className="p-3 text-right" title="How good a blog topic this phrase is, out of 100 (hover a score for the reasons)">Score</th>
                  <th className="p-3 text-left" title="The page Google really shows for this phrase (Search Console, last 28 days)">Ranks on (Google)</th>
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
                    <td className="p-3 text-right tabular-nums" title={(scores[row.keyword]?.reasons ?? []).join(". ")}>
                      {scores[row.keyword] ? (
                        <>
                          <div className={scores[row.keyword].eligible ? "font-semibold" : "text-muted-foreground"}>{scores[row.keyword].score}</div>
                          <div className="text-[10px] text-muted-foreground">{scores[row.keyword].eligible ? "usable" : "not usable"}</div>
                        </>
                      ) : "—"}
                    </td>
                    <td className="p-3 text-xs">
                      {(() => {
                        const ranked = rankedOn[row.keyword.toLowerCase()]
                        if (ranked) {
                          const match = row.target_path === ranked
                          return (
                            <div className="space-y-1">
                              <div className="max-w-[220px] truncate font-medium" title={ranked}>{pageByPath.get(ranked)?.title ?? ranked}</div>
                              {match ? <Badge variant="outline" className="text-[10px]">target matches</Badge> : (
                                <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => setTarget(row, ranked)} disabled={!!saving[row.id]}>{row.target_path ? "Different from target: use this" : "Use as target"}</Button>
                              )}
                            </div>
                          )
                        }
                        const suggestion = row.target_path ? null : suggestPage(row.keyword, pages)
                        return suggestion ? (
                          <div className="space-y-1">
                            <div className="text-muted-foreground">Not ranking yet. Best fit:</div>
                            <div className="max-w-[220px] truncate font-medium" title={suggestion.path}>{suggestion.title}</div>
                            <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => setTarget(row, suggestion.path)} disabled={!!saving[row.id]}>Use suggestion</Button>
                          </div>
                        ) : <span className="text-muted-foreground">Not ranking yet</span>
                      })()}
                    </td>
                    <td className="p-3">
                      <Select value={row.target_path || NO_TARGET} onValueChange={(v) => setTarget(row, v === NO_TARGET ? null : v)} disabled={!!saving[row.id]}>
                        <SelectTrigger className="h-8 w-[240px] text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-[360px]">
                          <SelectItem value={NO_TARGET}>Not assigned</SelectItem>
                          {groups.map((g) => (
                            <SelectGroup key={g.type}>
                              <SelectLabel>{PAGE_TYPE_LABEL[g.type]} ({g.items.length})</SelectLabel>
                              {g.items.map((p) => (
                                <SelectItem key={p.path} value={p.path}>{labelOf(p)}{pageCounts[p.path] ? ` · ${pageCounts[p.path]}` : ""}</SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                          {orphanTargets.map((t) => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
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
