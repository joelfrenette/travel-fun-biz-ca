"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Search, Trash2, ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Plus, Sparkles, Check, X, CalendarDays } from "lucide-react"
import type { KeywordRow } from "@/lib/keywords"
import type { IntelKeyword, IntelPayload, IdeaProgress, KeywordProgress } from "@/lib/keyword-intel"
import { INTENT_LABEL, OPPORTUNITY_LABEL, type Intent, type Opportunity } from "@/lib/keyword-cluster"
import { PAGE_TYPE_LABEL, suggestPage, type PageType, type SitePage } from "@/lib/site-pages"

const NO_TARGET = "__none__"
const ALL = "__all__"
type SortField = "keyword" | "volume" | "cpc" | "competition" | "position" | "impressions" | "clicks" | "score"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const OPP_CLASS: Record<Opportunity, string> = {
  RANKING: "bg-emerald-600 text-white hover:bg-emerald-600",
  ALMOST: "bg-amber-500 text-white hover:bg-amber-500",
  SHOOT_FOR: "bg-blue-600 text-white hover:bg-blue-600",
  TARGETED: "border border-foreground/30 bg-transparent text-foreground hover:bg-transparent",
  SKIP: "bg-muted text-muted-foreground hover:bg-muted",
}

function OppBadge({ opp, reason }: { opp: Opportunity | null; reason?: string | null }) {
  if (!opp) return <span className="text-xs text-muted-foreground">not scored</span>
  return <Badge className={`text-[10px] ${OPP_CLASS[opp]}`} title={reason ?? undefined}>{OPPORTUNITY_LABEL[opp]}</Badge>
}

/** Position change: positive means the position number fell, so the page moved UP in Google. */
function Change({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-muted-foreground" title="Not enough daily snapshots yet to compare">n/a</span>
  if (Math.abs(value) < 0.5) return <span className="text-xs text-muted-foreground">no change</span>
  const up = value > 0
  return (
    <span className={`inline-flex items-center text-xs font-medium ${up ? "text-emerald-600" : "text-red-600"}`}>
      {up ? <ArrowUp className="mr-0.5 h-3 w-3" /> : <ArrowDown className="mr-0.5 h-3 w-3" />}
      {Math.round(Math.abs(value))}
    </span>
  )
}

const num = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString())
const pos = (n: number | null | undefined) => (n == null ? "-" : n.toFixed(1))
const dateOf = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : null)

function ProgressTable({ rows }: { rows: KeywordProgress[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase text-muted-foreground">
          <tr>
            <th className="py-1 text-left">Keyword</th>
            <th className="py-1 text-right">Google position</th>
            <th className="py-1 text-right">vs 7 days</th>
            <th className="py-1 text-right">vs 28 days</th>
            <th className="py-1 text-right">Clicks (28d)</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.keyword}>
              <td className="py-1">{r.keyword} {r.role === "primary" && <Badge variant="outline" className="ml-1 text-[9px]">main</Badge>}</td>
              <td className="py-1 text-right tabular-nums">{r.position == null ? <span className="text-muted-foreground">not shown yet</span> : pos(r.position)}</td>
              <td className="py-1 text-right"><Change value={r.change7} /></td>
              <td className="py-1 text-right"><Change value={r.change28} /></td>
              <td className="py-1 text-right tabular-nums">{num(r.clicks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function KeywordsPage() {
  const [intel, setIntel] = useState<IntelPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [running, setRunning] = useState(false)
  const [showStages, setShowStages] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [phrase, setPhrase] = useState("")
  const [adding, setAdding] = useState(false)
  const [busyIdea, setBusyIdea] = useState<Record<string, boolean>>({})
  const [scheduling, setScheduling] = useState<string | null>(null)
  const [scheduleDate, setScheduleDate] = useState("")
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [sortField, setSortField] = useState<SortField>("volume")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [oppFilter, setOppFilter] = useState<string>(ALL)
  const [intentFilter, setIntentFilter] = useState<string>(ALL)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const r = await fetch("/api/admin/keywords/intel", { headers: authHeaders() })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setIntel(data as IntelPayload)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function runEngine() {
    setRunning(true); setError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords/engine", { method: "POST", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setStatus(data.run?.note || "Done.")
      setShowStages(true)
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The engine run failed")
    } finally {
      setRunning(false)
    }
  }

  async function refreshSearchData() {
    setRefreshing(true); setError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords/search-data", { method: "POST", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setStatus(`Search Console updated ${data.gscUpdated} of ${data.tracked} phrases.${Array.isArray(data.errors) && data.errors.length ? ` ${data.errors.slice(0, 2).join(" | ")}` : ""}`)
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed")
    } finally {
      setRefreshing(false)
    }
  }

  async function connectAll() {
    setConnecting(true); setError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ connectAll: true }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setStatus(data.connected ? `Connected ${data.connected} keyword${data.connected === 1 ? "" : "s"} to the page they rank on.` : "Nothing to connect: every keyword that ranks already has a target page.")
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect")
    } finally {
      setConnecting(false)
    }
  }

  // "Add a phrase": free tracking by default; the second button also looks up its Google volume (a fraction of a cent).
  async function addPhrase(lookup: boolean) {
    if (!intel || phrase.trim().length < 2) return
    setAdding(true); setError(""); setStatus("")
    try {
      const res = await fetch("/api/admin/keywords", { method: "POST", headers: authHeaders(), body: JSON.stringify({ keywords: phrase, country: intel.country, ...(lookup ? {} : { track_only: true }) }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setStatus(lookup ? `${data.fetched} looked up ($${Number(data.costUsd ?? 0).toFixed(4)}), ${data.cached} served from cache.` : "Added. The next engine run will score it.")
      setPhrase("")
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add")
    } finally {
      setAdding(false)
    }
  }

  async function setIdeaStatus(id: string, next: "approved" | "rejected" | "suggested", scheduled_for?: string) {
    setBusyIdea((b) => ({ ...b, [id]: true })); setError("")
    try {
      const res = await fetch(`/api/admin/blog/topics/${id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ status: next, ...(scheduled_for ? { scheduled_for } : {}) }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      setScheduling(null)
      await load(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setBusyIdea((b) => ({ ...b, [id]: false }))
    }
  }

  function patchRow(id: string, patch: Partial<KeywordRow>) {
    setIntel((cur) => (cur ? { ...cur, keywords: cur.keywords.map((k) => (k.row.id === id ? { ...k, row: { ...k.row, ...patch } } : k)) } : cur))
  }

  async function saveRow(row: KeywordRow, patch: { target_path?: string | null; note?: string | null }) {
    setSaving((s) => ({ ...s, [row.id]: true }))
    const previous = { target_path: row.target_path, note: row.note }
    patchRow(row.id, patch)
    try {
      const res = await fetch(`/api/admin/keywords/${row.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(patch) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    } catch (e) {
      patchRow(row.id, previous)
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving((s) => ({ ...s, [row.id]: false }))
    }
  }

  async function remove(row: KeywordRow) {
    if (!confirm(`Remove "${row.keyword}" from your research list?`)) return
    const res = await fetch(`/api/admin/keywords/${row.id}`, { method: "DELETE", headers: authHeaders() })
    if (res.ok) setIntel((cur) => (cur ? { ...cur, keywords: cur.keywords.filter((k) => k.row.id !== row.id) } : cur))
    else setError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  const sortValue = (k: IntelKeyword, f: SortField): string | number | null => {
    switch (f) {
      case "keyword": return k.row.keyword
      case "volume": return k.row.volume
      case "cpc": return k.row.cpc
      case "competition": return k.row.competition
      case "position": return k.row.gsc_position
      case "impressions": return k.row.gsc_impressions
      case "clicks": return k.row.gsc_clicks
      case "score": return k.score
    }
  }

  const visible = useMemo(() => {
    if (!intel) return []
    const list = intel.keywords.filter((k) => (oppFilter === ALL || k.opportunity === oppFilter) && (intentFilter === ALL || k.intent === intentFilter))
    list.sort((a, b) => {
      const av = sortValue(a, sortField), bv = sortValue(b, sortField)
      if (av == null && bv == null) return a.row.keyword.localeCompare(b.row.keyword)
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === "string" ? av.localeCompare(String(bv)) : Number(av) - Number(bv)
      return sortDir === "asc" ? cmp : -cmp
    })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intel, sortField, sortDir, oppFilter, intentFilter])

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc")
    else { setSortField(field); setSortDir(field === "keyword" ? "asc" : "desc") }
  }
  const SortIcon = ({ field }: { field: SortField }) => sortField === field ? (sortDir === "asc" ? <ArrowUp className="ml-1 inline h-3 w-3" /> : <ArrowDown className="ml-1 inline h-3 w-3" />) : <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  if (!intel) return <div className="container mx-auto px-4 py-8"><div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error || "Could not load the Keyword Research page."}</div></div>

  const { engine, sources } = intel
  const pages: SitePage[] = intel.pages
  const pageByPath = new Map(pages.map((p) => [p.path, p]))
  const labelOf = (p: SitePage) => `${p.title}${p.status && p.status !== "published" ? ` (${p.status})` : ""}`
  const groups = (["home", "package", "destination", "guide", "blog"] as PageType[]).map((type) => ({ type, items: pages.filter((p) => p.type === type) })).filter((g) => g.items.length)
  const orphanTargets = Array.from(new Set(intel.keywords.map((k) => k.row.target_path).filter((t): t is string => !!t && !pageByPath.has(t))))
  const pageCounts = intel.keywords.reduce<Record<string, number>>((acc, k) => { if (k.row.target_path) acc[k.row.target_path] = (acc[k.row.target_path] || 0) + 1; return acc }, {})
  const progressOf = new Map<string, IdeaProgress>(intel.progress.map((p) => [p.id, p]))
  const writtenPosts = intel.progress.filter((p) => p.status === "used")
  const last = engine.lastRun
  const nextAt = engine.nextRunAt ? new Date(engine.nextRunAt) : null
  const nextLabel = !nextAt || nextAt.getTime() <= Date.now() ? "at the next Autopilot pass" : dateOf(engine.nextRunAt)
  const lastSearchFetch = intel.keywords.reduce<string | null>((latest, k) => (k.row.gsc_fetched_at && (!latest || k.row.gsc_fetched_at > latest) ? k.row.gsc_fetched_at : latest), null)

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto space-y-3 px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold">Keyword Research</h1>
              <p className="text-sm text-muted-foreground">Which keywords to aim for, which ones you already rank for, and the next blog posts to write, each with the keywords it is shooting for. Google volume only.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Button size="sm" variant="outline" onClick={connectAll} disabled={connecting || intel.keywords.length === 0} title="Set the target page of every keyword that has none to the page Google really shows for it. Pages you chose by hand are never changed.">
                {connecting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}Connect keywords to their pages
              </Button>
              <Button size="sm" variant="outline" onClick={refreshSearchData} disabled={refreshing || !sources.searchConsole || intel.keywords.length === 0} title={sources.searchConsole ? "Pull the last 28 days from Google Search Console" : "Connect Google Search Console first"}>
                {refreshing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}Refresh search data
              </Button>
              <Button onClick={runEngine} disabled={running} title="Researches keywords, scores them, groups them into topics and plans the next blog ideas. Ignores the weekly schedule, never the weekly budget.">
                {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}Run the engine now
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Budget left this week: <span className="font-mono text-foreground">${engine.budgetLeftUsd.toFixed(2)}</span> of ${engine.budgetUsd.toFixed(2)}{engine.balanceUsd != null ? ` · DataForSEO balance $${engine.balanceUsd.toFixed(2)}` : ""}</span>
            <span>Last run: {last ? <>{dateOf(last.at)} ({last.trigger === "button" ? "button" : "weekly"}, {last.ok ? "ok" : "problem"}, spent about ${last.spentUsd.toFixed(2)})</> : "never"}</span>
            <span>Next automatic run: {nextLabel}</span>
            {last && last.stages.length > 0 && <button className="underline" onClick={() => setShowStages((s) => !s)}>{showStages ? "Hide" : "Show"} what it did</button>}
          </div>
          {showStages && last && (
            <ul className="space-y-0.5 rounded-md border bg-background p-2 text-xs">
              {last.stages.map((s) => (
                <li key={s.stage}><span className="font-mono font-medium">{s.stage}</span> {s.ok ? "" : <span className="text-destructive">(problem) </span>}<span className="text-muted-foreground">{s.note}{s.spentUsd ? ` · $${s.spentUsd.toFixed(3)}` : ""}</span></li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addPhrase(false) }}
              placeholder="Add a phrase, e.g. rhine river cruise from canada"
              className="h-8 min-w-[260px] flex-1 rounded-md border bg-background px-3 text-sm"
            />
            <Button size="sm" variant="outline" onClick={() => addPhrase(false)} disabled={adding || phrase.trim().length < 2} title="Free: starts tracking the phrase"><Plus className="mr-1 h-3 w-3" />Add</Button>
            <Button size="sm" variant="outline" onClick={() => addPhrase(true)} disabled={adding || phrase.trim().length < 2 || !sources.dataforseo} title="Adds the phrase and looks up its Google volume now (a small fraction of a cent per phrase; phrases looked up in the last 30 days are free)">Add and look up volume</Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto space-y-6 px-4 py-4">
        {engine.needsMigration && (
          <Card className="border-amber-500/50"><CardContent className="p-4 text-sm">
            <span className="font-medium">One database update is waiting.</span> Run <span className="font-mono">supabase/migrations/0032_keyword_intel.sql</span> in the Supabase SQL editor. Until then the lists below are worked out live, but the engine cannot save its verdicts or new blog ideas.
          </CardContent></Card>
        )}
        {!sources.dataforseo && (
          <Card className="border-amber-500/50"><CardContent className="p-4 text-sm">
            <span className="font-medium">DataForSEO is not connected</span> (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD in Vercel). The saved list below still works; the engine just cannot fetch new Google volumes.
          </CardContent></Card>
        )}
        {!sources.searchConsole && (
          <Card className="border-amber-500/50"><CardContent className="p-4 text-sm">
            <span className="font-medium">Google Search Console is not connected.</span> Set GOOGLE_SERVICE_ACCOUNT_KEY in Vercel and add the service account email as a user on your Search Console property. Until then the position, impression and click columns stay empty and nothing can show as ranking.
          </CardContent></Card>
        )}
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {status && <div className="rounded-lg border bg-muted/40 p-3 text-sm">{status}</div>}

        {/* NEXT BLOG IDEAS */}
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Next blog ideas</h2>
            <p className="text-xs text-muted-foreground">Each idea comes with the keyword set its post will shoot for (the first one is the main keyword). Approve the ones you like: the autoblog writes approved ideas first, and the ranking of every keyword is tracked under the idea.</p>
          </div>
          {intel.ideas.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">No ideas waiting. Press &quot;Run the engine now&quot;, or wait for the weekly run.</CardContent></Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {intel.ideas.map((idea) => {
                const prog = progressOf.get(idea.id)
                const busy = !!busyIdea[idea.id]
                return (
                  <Card key={idea.id}>
                    <CardContent className="space-y-2 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h3 className="min-w-[200px] flex-1 font-medium">{idea.title_idea || idea.angle}</h3>
                        <div className="flex items-center gap-1">
                          {idea.score != null && <Badge variant="outline">{idea.score}/100</Badge>}
                          <Badge variant={idea.status === "approved" ? "default" : "secondary"}>{idea.status}{idea.scheduled_for ? ` · ${idea.scheduled_for}` : ""}</Badge>
                        </div>
                      </div>
                      {idea.title_idea && <p className="text-xs text-muted-foreground">{idea.angle}</p>}
                      <div className="flex flex-wrap gap-1">
                        {idea.keywordSet.map((k, i) => (
                          <Badge key={k} variant={i === 0 ? "default" : "outline"} className="text-[11px] font-normal">{k}</Badge>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">{idea.why}{idea.packageName ? ` · package: ${idea.packageName}` : ""}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        {idea.status === "suggested" && (
                          <>
                            <Button size="sm" onClick={() => setIdeaStatus(idea.id, "approved")} disabled={busy}><Check className="mr-1 h-3 w-3" />Approve</Button>
                            <Button size="sm" variant="outline" onClick={() => setIdeaStatus(idea.id, "rejected")} disabled={busy}><X className="mr-1 h-3 w-3" />Reject</Button>
                          </>
                        )}
                        {idea.status === "approved" && (
                          <Button size="sm" variant="outline" onClick={() => setIdeaStatus(idea.id, "rejected")} disabled={busy}><X className="mr-1 h-3 w-3" />Un-approve</Button>
                        )}
                        {scheduling === idea.id ? (
                          <>
                            <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm" />
                            <Button size="sm" onClick={() => scheduleDate && setIdeaStatus(idea.id, "approved", scheduleDate)} disabled={busy || !scheduleDate}>Schedule</Button>
                            <Button size="sm" variant="ghost" onClick={() => setScheduling(null)}>Cancel</Button>
                          </>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => { setScheduling(idea.id); setScheduleDate(idea.scheduled_for ?? "") }} disabled={busy}><CalendarDays className="mr-1 h-3 w-3" />Schedule</Button>
                        )}
                      </div>
                      {prog && prog.keywords.some((k) => k.position != null) && (
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground">Where these keywords stand in Google today</summary>
                          <ProgressTable rows={prog.keywords} />
                        </details>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}

          {writtenPosts.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <div>
                  <h3 className="font-semibold">Posts written for a keyword set: ranking progress</h3>
                  <p className="text-xs text-muted-foreground">Google position now, and how it moved against about 7 and 28 days ago. Search Console lags a day or two, and a change shows &quot;n/a&quot; until there are enough daily snapshots.</p>
                </div>
                {writtenPosts.slice(0, 8).map((p) => (
                  <details key={p.id} className="rounded-md border p-2" open={writtenPosts.length === 1}>
                    <summary className="cursor-pointer text-sm font-medium">{p.title}{p.usedSlug ? <a className="ml-2 text-xs font-normal underline" href={`/blog/${p.usedSlug}`} target="_blank" rel="noreferrer">/blog/{p.usedSlug}</a> : null}</summary>
                    <ProgressTable rows={p.keywords} />
                  </details>
                ))}
              </CardContent>
            </Card>
          )}
        </section>

        {/* KEYWORDS WE RANK FOR */}
        <section className="space-y-2">
          <div>
            <h2 className="text-lg font-semibold">Keywords we rank for ({intel.rankFor.length})</h2>
            <p className="text-xs text-muted-foreground">Google already shows the site for these (positions 1 to 30 in the last 28 days). Most impressions first. The change columns compare today with about 7 and 28 days ago; green is up.</p>
          </div>
          {intel.rankFor.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">{sources.searchConsole ? "No researched phrase is in Google's top 30 for us yet. Press \"Refresh search data\" to pull the latest numbers." : "Connect Google Search Console to see which keywords you rank for."}</CardContent></Card>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase">
                  <tr>
                    <th className="p-2 text-left">Keyword</th>
                    <th className="p-2 text-right">Position</th>
                    <th className="p-2 text-right">vs 7 days</th>
                    <th className="p-2 text-right">vs 28 days</th>
                    <th className="p-2 text-right">Impressions</th>
                    <th className="p-2 text-right">Clicks</th>
                    <th className="p-2 text-left">Page</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {intel.rankFor.map((r) => (
                    <tr key={r.keyword}>
                      <td className="p-2 font-medium">{r.keyword} <OppBadge opp={r.opportunity} /></td>
                      <td className="p-2 text-right tabular-nums">{pos(r.position)}</td>
                      <td className="p-2 text-right"><Change value={r.change7} /></td>
                      <td className="p-2 text-right"><Change value={r.change28} /></td>
                      <td className="p-2 text-right tabular-nums">{num(r.impressions)}</td>
                      <td className="p-2 text-right tabular-nums">{num(r.clicks)}</td>
                      <td className="p-2 text-xs"><span className="inline-block max-w-[240px] truncate" title={r.page ?? undefined}>{r.page ? (pageByPath.get(r.page)?.title ?? r.page) : "-"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* KEYWORDS WE SHOULD SHOOT FOR */}
        <section className="space-y-2">
          <div>
            <h2 className="text-lg font-semibold">Keywords we should shoot for ({intel.shootFor.length})</h2>
            <p className="text-xs text-muted-foreground">Topics about a trip we really sell, that no page targets yet and that score well (winnability 40%, demand 25%, intent to book 20%, timing 15%). Highest Google volume first. A volume of &quot;-&quot; means Google does not report small numbers, not that nobody searches.</p>
          </div>
          {intel.shootFor.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">Nothing to shoot for right now. Run the engine to research more phrases.</CardContent></Card>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase">
                  <tr>
                    <th className="p-2 text-left">Keyword topic</th>
                    <th className="p-2 text-right">Google volume / mo</th>
                    <th className="p-2 text-right">Competition</th>
                    <th className="p-2 text-left">Intent</th>
                    <th className="p-2 text-right">Score</th>
                    <th className="p-2 text-left">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {intel.shootFor.map((s) => (
                    <tr key={s.clusterId}>
                      <td className="p-2">
                        <div className="font-medium">{s.primary}</div>
                        <div className="text-xs text-muted-foreground" title={s.secondary.join(", ")}>{s.secondaryCount > 0 ? `+ ${s.secondaryCount} related phrase${s.secondaryCount === 1 ? "" : "s"}` : "single phrase"}{s.packageName ? ` · ${s.packageName}` : ""}</div>
                      </td>
                      <td className="p-2 text-right tabular-nums">{num(s.volume)}</td>
                      <td className="p-2 text-right tabular-nums">{s.competition == null ? "-" : s.competition <= 1 ? Math.round(s.competition * 100) : Math.round(s.competition)}</td>
                      <td className="p-2 text-xs">{INTENT_LABEL[s.intent as Intent] ?? s.intent}</td>
                      <td className="p-2 text-right tabular-nums">{s.score}</td>
                      <td className="max-w-[360px] p-2 text-xs text-muted-foreground">{s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ALL KEYWORDS */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">All keywords ({visible.length}{visible.length !== intel.keywords.length ? ` of ${intel.keywords.length}` : ""})</h2>
              <p className="text-xs text-muted-foreground">Sorted by Google volume, highest first. Click a heading to sort. One target phrase per page: a page with two or more phrases assigned is a sign to split it or pick one.</p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <select value={oppFilter} onChange={(e) => setOppFilter(e.target.value)} className="h-8 rounded-md border bg-background px-2" aria-label="Filter by opportunity">
                <option value={ALL}>All opportunities</option>
                {(Object.keys(OPPORTUNITY_LABEL) as Opportunity[]).map((o) => <option key={o} value={o}>{OPPORTUNITY_LABEL[o]}</option>)}
              </select>
              <select value={intentFilter} onChange={(e) => setIntentFilter(e.target.value)} className="h-8 rounded-md border bg-background px-2" aria-label="Filter by intent">
                <option value={ALL}>All intents</option>
                {(Object.keys(INTENT_LABEL) as Intent[]).map((i) => <option key={i} value={i}>{INTENT_LABEL[i]}</option>)}
              </select>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="p-2 text-left"><button onClick={() => toggleSort("keyword")}>Keyword<SortIcon field="keyword" /></button></th>
                  <th className="p-2 text-right"><button onClick={() => toggleSort("volume")}>Google volume / mo<SortIcon field="volume" /></button></th>
                  <th className="p-2 text-right"><button onClick={() => toggleSort("cpc")}>CPC<SortIcon field="cpc" /></button></th>
                  <th className="p-2 text-right"><button onClick={() => toggleSort("competition")}>Competition<SortIcon field="competition" /></button></th>
                  <th className="p-2 text-right" title="Search Console, last 28 days"><button onClick={() => toggleSort("position")}>Position<SortIcon field="position" /></button></th>
                  <th className="p-2 text-right"><button onClick={() => toggleSort("impressions")}>Impressions<SortIcon field="impressions" /></button></th>
                  <th className="p-2 text-right"><button onClick={() => toggleSort("clicks")}>Clicks<SortIcon field="clicks" /></button></th>
                  <th className="p-2 text-left" title="The page Google really shows for this phrase, or its target page">Page</th>
                  <th className="p-2 text-left"><button onClick={() => toggleSort("score")}>Opportunity<SortIcon field="score" /></button></th>
                  <th className="p-2 text-left">Topic</th>
                  <th className="p-2 text-left">Target page</th>
                  <th className="p-2 text-left">Note</th>
                  <th className="w-10 p-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((k) => {
                  const row = k.row
                  const ranked = k.rankedOn
                  const suggestion = row.target_path ? null : suggestPage(row.keyword, pages)
                  return (
                    <tr key={row.id} className="align-top hover:bg-muted/30">
                      <td className="p-2">
                        <div className="font-medium">{row.keyword}</div>
                        <div className="text-xs text-muted-foreground">{row.country.toUpperCase()}{k.intent ? ` · ${INTENT_LABEL[k.intent as Intent] ?? k.intent}` : ""}{row.volume == null && new Date(row.fetched_at).getTime() === 0 ? " · not looked up" : ""}</div>
                      </td>
                      <td className="p-2 text-right tabular-nums">{num(row.volume)}</td>
                      <td className="p-2 text-right tabular-nums">{row.cpc == null ? "-" : `${row.cpc_currency === "usd" ? "$" : ""}${row.cpc.toFixed(2)}`}</td>
                      <td className="p-2 text-right tabular-nums">{row.competition == null ? "-" : row.competition <= 1 ? Math.round(row.competition * 100) : Math.round(row.competition)}</td>
                      <td className="p-2 text-right tabular-nums">{pos(row.gsc_position)}</td>
                      <td className="p-2 text-right tabular-nums">{num(row.gsc_impressions)}</td>
                      <td className="p-2 text-right tabular-nums">{num(row.gsc_clicks)}</td>
                      <td className="p-2 text-xs">
                        {ranked ? (
                          <div className="space-y-1">
                            <div className="max-w-[200px] truncate font-medium" title={ranked}>{pageByPath.get(ranked)?.title ?? ranked}</div>
                            {row.target_path !== ranked && (
                              <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => saveRow(row, { target_path: ranked })} disabled={!!saving[row.id]}>{row.target_path ? "Different from target: use this" : "Use as target"}</Button>
                            )}
                          </div>
                        ) : suggestion ? (
                          <div className="space-y-1">
                            <div className="text-muted-foreground">Best fit:</div>
                            <div className="max-w-[200px] truncate font-medium" title={suggestion.path}>{suggestion.title}</div>
                            <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => saveRow(row, { target_path: suggestion.path })} disabled={!!saving[row.id]}>Use suggestion</Button>
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="p-2" title={[k.reason, ...k.reasons].filter(Boolean).join(". ")}>
                        <OppBadge opp={k.opportunity} reason={k.reason} />
                        {k.score != null && <div className="mt-0.5 text-[10px] text-muted-foreground">score {k.score}</div>}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {k.clusterPrimary ? (k.clusterPrimary === row.keyword ? (k.clusterSize > 1 ? `main of ${k.clusterSize}` : "alone") : <span title={k.clusterPrimary}>{`part of "${k.clusterPrimary}"`}</span>) : "-"}
                      </td>
                      <td className="p-2">
                        <Select value={row.target_path || NO_TARGET} onValueChange={(v) => saveRow(row, { target_path: v === NO_TARGET ? null : v })} disabled={!!saving[row.id]}>
                          <SelectTrigger className="h-8 w-[220px] text-xs"><SelectValue /></SelectTrigger>
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
                      <td className="p-2">
                        <input
                          type="text"
                          defaultValue={row.note ?? ""}
                          key={`${row.id}:${row.note ?? ""}`}
                          placeholder="note (start with 'skipped' to skip)"
                          className="h-8 w-[170px] rounded-md border bg-background px-2 text-xs"
                          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (row.note ?? "")) saveRow(row, { note: v || null }) }}
                        />
                      </td>
                      <td className="p-2 text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(row)} title="Remove"><Trash2 className="h-4 w-4" /></Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {intel.keywords.length === 0 && <div className="py-12 text-center text-muted-foreground">No phrases yet. Add one above, or press &quot;Run the engine now&quot;.</div>}
            {intel.keywords.length > 0 && visible.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No phrase matches these filters.</div>}
          </div>
        </section>

        {/* SOURCES */}
        <p className="border-t pt-3 text-xs text-muted-foreground">
          Sources: Google volume and competition from DataForSEO ({sources.dataforseo ? "connected" : "not connected"}); your own positions, impressions and clicks from Google Search Console ({sources.searchConsole ? "connected" : "not connected"}); Google autocomplete and People Also Ask, found through DataForSEO; {sources.reddit ? "Reddit: connected" : "Reddit: not connected (add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET)"}; Google Trends peak months ({sources.trendsKnown} destination{sources.trendsKnown === 1 ? "" : "s"} known).
          {lastSearchFetch && <> Search data last refreshed {dateOf(lastSearchFetch)}.</>}
        </p>
      </div>
    </div>
  )
}
