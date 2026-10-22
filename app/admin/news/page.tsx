"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, RefreshCw, ExternalLink, ArrowUp, ArrowDown } from "lucide-react"
import {
  HEALTH_LABEL, NEWS_STATUSES, ITEM_SORTS, DEFAULT_ITEM_QUERY, countByStatus, filterSortItems,
  type SourceHealth, type NewsItemView, type ItemQuery, type ItemSort,
} from "@/lib/news-admin"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

type NewsMode = "off" | "draft" | "publish"

interface SourceRow {
  key: string
  name: string
  type: "feed" | "json"
  typeLabel: string
  url: string
  tier: 1 | 2
  enabledInCode: boolean
  off: boolean
  lastFetchAt: string | null
  lastOkAt: string | null
  fails: number
  lastError: string | null
  itemsSeen: number
  health: SourceHealth
}

const MODE_TEXT: Record<NewsMode, { label: string; help: string }> = {
  off: { label: "Off", help: "Nothing is read and nothing is written. The news poster is fully stopped." },
  draft: { label: "Draft", help: "Feeds are read and short briefs are written, checked and saved as DRAFT posts. Nothing goes live until you publish a draft yourself." },
  publish: { label: "Publish", help: "A brief that passes the quality gate and the judge goes live on its own and is posted to social. Only switch to this on purpose." },
}

const SORT_LABEL: Record<ItemSort, string> = { when: "Date", title: "Title", source: "Source", status: "Status" }
const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm"
const healthVariant = (h: SourceHealth): "default" | "secondary" | "destructive" | "outline" => (h === "ok" ? "default" : h === "blocked" || h === "failing" ? "destructive" : h === "off" ? "secondary" : "outline")

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "never")

export default function NewsAdminPage() {
  const [mode, setMode] = useState<NewsMode>("draft")
  const [perDay, setPerDay] = useState<number | null>(null)
  const [sources, setSources] = useState<SourceRow[]>([])
  const [items, setItems] = useState<NewsItemView[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [tableProblem, setTableProblem] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [note, setNote] = useState("")
  const [query, setQuery] = useState<ItemQuery>(DEFAULT_ITEM_QUERY)
  const [shown, setShown] = useState(50)

  function load() {
    setLoading(true)
    fetch("/api/admin/news", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setMode(data.mode || "draft")
        setPerDay(typeof data.perDay === "number" ? data.perDay : null)
        setSources(data.sources || [])
        setItems(data.items || [])
        setTotals(data.statusTotals || {})
        setTableProblem(data.tableProblem || "")
        if (data.offSettingError) setError(`Could not read which sources are switched off (${data.offSettingError}). The switches below may be wrong until this is fixed.`)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/admin/news", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  async function changeMode(next: NewsMode) {
    setError(""); setNote("")
    try {
      await post({ action: "mode", mode: next })
      setMode(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the mode")
    }
  }

  async function toggleSource(s: SourceRow) {
    setError(""); setNote("")
    try {
      await post({ action: "source", key: s.key, off: !s.off })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the source")
    }
  }

  async function fetchNow() {
    setBusy(true); setError(""); setNote("")
    try {
      const data = await post({ action: "fetch" })
      const r = data.result as { fetched: string[]; waiting: string[]; stored: number; rejected: number; duplicates: number; failed: { key: string; error: string }[]; tableProblem?: string }
      setNote(
        `Read ${r.fetched.length} feed${r.fetched.length === 1 ? "" : "s"}, ${r.waiting.length} not due yet (each is read at most every 30 minutes). Stored ${r.stored} new item${r.stored === 1 ? "" : "s"}, ${r.duplicates} repeats skipped.` +
          (r.failed.length ? ` Failed: ${r.failed.map((f) => `${f.key} (${f.error})`).join("; ")}.` : "") +
          (r.tableProblem ? ` Table problem: ${r.tableProblem}.` : ""),
      )
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed")
    } finally {
      setBusy(false)
    }
  }

  const nameOf = useMemo(() => {
    const m = new Map(sources.map((s) => [s.key, s.name]))
    return (k: string) => m.get(k) ?? k
  }, [sources])
  const counts = useMemo(() => (Object.keys(totals).length ? { new: 0, queued: 0, published: 0, rejected: 0, expired: 0, ...totals } : countByStatus(items)), [totals, items])
  const filtered = useMemo(() => filterSortItems(items, query, nameOf), [items, query, nameOf])

  function setQ(patch: Partial<ItemQuery>) {
    setQuery((q) => ({ ...q, ...patch }))
    setShown(50)
  }
  function sortBy(col: ItemSort) {
    setQ(query.sort === col ? { dir: query.dir === "asc" ? "desc" : "asc" } : { sort: col, dir: col === "when" ? "desc" : "asc" })
  }

  if (loading && sources.length === 0) return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">News (Feeds and Briefs)</h1>
            <p className="text-sm text-muted-foreground">Official advisories, storm bulletins and trade news are read from a fixed list of feeds. Short briefs about them become blog posts.</p>
          </div>
          <Button variant="outline" onClick={load} disabled={loading}><RefreshCw className="mr-1.5 h-4 w-4" />Refresh</Button>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {tableProblem && <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">The news items table could not be read: {tableProblem}. If it says the table does not exist, migration 0047 has not been applied yet.</div>}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {NEWS_STATUSES.map((s) => (
            <Card key={s}>
              <CardContent className="p-3">
                <p className="text-2xl font-bold">{counts[s] ?? 0}</p>
                <p className="text-xs capitalize text-muted-foreground">{s}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-[220px] flex-1">
                <p className="text-sm font-medium">News mode</p>
                <p className="text-xs text-muted-foreground">{MODE_TEXT[mode].help}</p>
                <p className="text-xs text-muted-foreground">Briefs per day: {perDay === null ? "could not be read" : perDay}. Changing the mode takes effect at the next scheduled run.</p>
              </div>
              <Select value={mode} onValueChange={(v) => changeMode(v as NewsMode)}>
                <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["off", "draft", "publish"] as NewsMode[]).map((m) => <SelectItem key={m} value={m}>{MODE_TEXT[m].label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={fetchNow} disabled={busy || mode === "off"} title={mode === "off" ? "News is off" : "Read the feeds now (free, no AI)"}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}Fetch feeds now
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Fetch feeds now only reads the allowlisted feeds and stores the items. It makes no AI call, writes no post and publishes nothing.</p>
            {note && <p className="text-sm" role="status">{note}</p>}
          </CardContent>
        </Card>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Sources</h2>
          <p className="text-xs text-muted-foreground">The list of feeds is fixed in code. The switch only turns a feed off or on without a deploy; use it when a site blocks us.</p>
          {sources.map((s) => (
            <Card key={s.key}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-[240px] flex-1">
                  <p className="text-sm font-medium">{s.name} <span className="text-xs font-normal text-muted-foreground">({s.key})</span></p>
                  <p className="break-all text-xs text-muted-foreground">{s.typeLabel} · tier {s.tier} · <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">{s.url}</a></p>
                  <p className="text-xs text-muted-foreground">Last fetched: {fmt(s.lastFetchAt)} · last success: {fmt(s.lastOkAt)} · items seen: {s.itemsSeen}</p>
                  {(s.health === "blocked" || s.health === "failing" || s.health === "warning") && s.lastError && (
                    <p className="text-xs text-destructive">
                      {s.health === "blocked" ? "This site is refusing our reader. We do not work around a block: switch the source off. " : ""}
                      Failed {s.fails} time{s.fails === 1 ? "" : "s"} in a row. Last error: {s.lastError}
                    </p>
                  )}
                  {!s.enabledInCode && <p className="text-xs text-muted-foreground">Disabled in code (lib/news-sources.ts), so it is never read.</p>}
                </div>
                <Badge variant={healthVariant(s.health)}>{s.enabledInCode ? HEALTH_LABEL[s.health] : "Disabled in code"}</Badge>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" role="switch" checked={!s.off} disabled={!s.enabledInCode} onChange={() => toggleSource(s)} aria-label={`${s.name} ${s.off ? "off" : "on"}`} />
                  {s.off ? "OFF" : "ON"}
                </label>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Items</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-9 min-w-[200px] flex-1" placeholder="Search title or reason" value={query.q} onChange={(e) => setQ({ q: e.target.value })} aria-label="Search items" />
            <select className={selectClass} value={query.status} onChange={(e) => setQ({ status: e.target.value })} aria-label="Status">
              <option value="">All statuses</option>
              {NEWS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className={selectClass} value={query.source} onChange={(e) => setQ({ source: e.target.value })} aria-label="Source">
              <option value="">All sources</option>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.name} ({s.key})</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Sort by</span>
            {ITEM_SORTS.map((col) => (
              <Button key={col} variant={query.sort === col ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => sortBy(col)}>
                {SORT_LABEL[col]}
                {query.sort === col && (query.dir === "asc" ? <ArrowUp className="ml-1 h-3 w-3" /> : <ArrowDown className="ml-1 h-3 w-3" />)}
              </Button>
            ))}
            <span className="ml-auto">{filtered.length} of {items.length} item{items.length === 1 ? "" : "s"} (newest {items.length} loaded)</span>
          </div>
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{items.length === 0 ? "No items yet. They appear after the first feed read." : "No items match these filters."}</p>
          ) : (
            filtered.slice(0, shown).map((i) => (
              <Card key={i.id}>
                <CardContent className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-[240px] flex-1">
                    <a href={i.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium hover:underline">{i.title}<ExternalLink className="h-3 w-3" /></a>
                    <p className="text-xs text-muted-foreground">
                      {nameOf(i.source_key)} · {i.category} · published {fmt(i.published_at)} · fetched {fmt(i.fetched_at)}
                    </p>
                    {i.reject_reason && <p className="text-xs text-muted-foreground">Reason: {i.reject_reason}</p>}
                  </div>
                  <Badge variant={i.status === "published" ? "default" : i.status === "rejected" ? "destructive" : "secondary"}>{i.status}</Badge>
                  {i.post_slug && (
                    <Button asChild variant="outline" size="sm"><Link href={`/admin/blog?q=${encodeURIComponent(i.post_slug)}`}>Draft post</Link></Button>
                  )}
                </CardContent>
              </Card>
            ))
          )}
          {filtered.length > shown && (
            <div className="flex justify-center"><Button variant="outline" size="sm" onClick={() => setShown((n) => n + 50)}>Show 50 more</Button></div>
          )}
        </div>
      </div>
    </div>
  )
}
