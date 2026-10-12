"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { GuidesBackfillCard } from "@/components/admin/guides-backfill"
import { EmptyBlurbsCard } from "@/components/admin/empty-blurbs"
import { Loader2, Eye, Pencil, ExternalLink, ArrowDown, ArrowUp, Check, X, RotateCcw } from "lucide-react"

// The Pages list (growth loop WP16): every guide page in one searchable, sortable, filterable table, with a review
// queue for drafts the site wrote but would not publish by itself. Search, sort, filters and paging all run on the
// server (/api/admin/guides/list); this page only draws one page of rows. Editing a page happens on its own screen
// (/admin/guides/<id>), where text edits are logged so the Content edits screen can Undo them.

type Status = "all" | "published" | "draft" | "review" | "rejected"
type Sort = "name" | "kind" | "scope" | "status" | "updated" | "words" | "score" | "inbound" | "clicks"

interface Row {
  id: string
  kind: string
  slug: string
  name: string
  scope: string | null
  status: "draft" | "published"
  source: "ai" | "manual"
  review_state: "rejected" | null
  quality_notes: string | null
  updated_at: string
  words: number
  score: number | null
  inbound: number
  clicks: number | null
  path: string
}

interface ListData {
  rows: Row[]
  total: number
  page: number
  pages: number
  statusCounts: Record<Status, number>
  inboundKnown: boolean
  kinds: { kind: string; label: string }[]
  scopes: { scope: string; label: string }[]
  shownScope: Record<string, string | null>
  needsMigration: boolean
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const STATUS_CHIPS: { id: Status; label: string }[] = [
  { id: "all", label: "All" },
  { id: "published", label: "Live" },
  { id: "draft", label: "Drafts" },
  { id: "review", label: "Review queue" },
  { id: "rejected", label: "Rejected" },
]

const COLUMNS: { sort: Sort; label: string; className?: string }[] = [
  { sort: "name", label: "Name" },
  { sort: "kind", label: "Kind" },
  { sort: "scope", label: "Scope" },
  { sort: "status", label: "Status" },
  { sort: "updated", label: "Updated" },
  { sort: "words", label: "Words", className: "text-right" },
  { sort: "score", label: "Score", className: "text-right" },
  { sort: "inbound", label: "Links in", className: "text-right" },
  { sort: "clicks", label: "Clicks", className: "text-right" },
]

export default function GuidesListPage() {
  const { toast } = useToast()
  const [data, setData] = useState<ListData | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [q, setQ] = useState("")
  const [typed, setTyped] = useState("")
  const [sort, setSort] = useState<Sort>("updated")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const [kind, setKind] = useState("")
  const [scope, setScope] = useState("")
  const [status, setStatus] = useState<Status>("all")
  const [orphans, setOrphans] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const first = useRef(true)

  // A link from Needs attention (?filter=orphans) or the review queue (?status=review) opens the list already filtered.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get("filter") === "orphans") setOrphans(true)
    const s = p.get("status")
    if (s === "review" || s === "published" || s === "draft" || s === "rejected") setStatus(s)
  }, [])

  // Search waits a moment after typing stops, so one letter does not fire one request.
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [typed])

  const load = useCallback(() => {
    const params = new URLSearchParams({ sort, dir, status, page: String(page), pageSize: String(pageSize) })
    if (q) params.set("q", q)
    if (kind) params.set("kind", kind)
    if (scope) params.set("scope", scope)
    if (orphans) params.set("orphans", "1")
    setLoading(true)
    fetch(`/api/admin/guides/list?${params}`, { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load the pages")
        setData(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the pages"))
      .finally(() => setLoading(false))
  }, [q, sort, dir, kind, scope, status, orphans, page, pageSize])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (first.current) first.current = false; else setSelected(new Set()) }, [q, sort, dir, kind, scope, status, orphans, page, pageSize])

  function clickSort(next: Sort) {
    if (next === sort) setDir(dir === "asc" ? "desc" : "asc")
    else { setSort(next); setDir(next === "name" || next === "kind" || next === "scope" || next === "status" ? "asc" : "desc") }
    setPage(1)
  }

  async function bulk(action: "publish" | "reject" | "restore") {
    const ids = [...selected]
    if (ids.length === 0) return
    if (action === "publish" && !confirm(`Publish ${ids.length} draft${ids.length === 1 ? "" : "s"}? Drafts the checks held back are skipped; open those one by one.`)) return
    setBusy(action)
    try {
      const res = await fetch("/api/admin/guides/list", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action, ids }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      const skipped: { name: string; reason: string }[] = body.skipped ?? []
      const done = action === "publish" ? body.published : body.changed
      toast({ title: `${done ?? 0} page${done === 1 ? "" : "s"} ${action === "publish" ? "published" : action === "reject" ? "rejected" : "restored"}`, description: skipped.length ? `Skipped ${skipped.length}: ${skipped.slice(0, 3).map((s) => `${s.name} (${s.reason})`).join("; ")}` : undefined })
      setSelected(new Set())
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy("")
    }
  }

  const rows = data?.rows ?? []
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const scopeLabel = (id: string) => data?.scopes.find((s) => s.scope === id)?.label ?? id

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Pages</h1>
        <p className="text-sm text-muted-foreground">
          Every destination, hotel, resort, cruise line, ship, river cruise and yacht page in one list. Search it, sort it, and open a page to edit it. Pages the site wrote but would not publish by itself wait in the Review queue.
        </p>
      </div>

      <GuidesBackfillCard onChanged={load} />

      {data?.needsMigration && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          The scope labels need one database update: run supabase/migrations/0041_guide_scope.sql in the Supabase SQL editor. Until then scopes are worked out from the name and Reject is not available.
        </div>
      )}
      {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_CHIPS.map((c) => (
              <Button key={c.id} size="sm" variant={status === c.id ? "default" : "outline"} onClick={() => { setStatus(c.id); setPage(1) }}>
                {c.label}{data ? ` (${data.statusCounts[c.id]})` : ""}
              </Button>
            ))}
            {orphans && (
              <Badge variant="secondary" className="gap-1">
                Only pages nothing links to
                <button type="button" aria-label="Clear the orphan filter" onClick={() => { setOrphans(false); setPage(1) }}><X className="h-3 w-3" /></button>
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-9 w-64" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search name, address, scope" aria-label="Search pages" />
            <select className="h-9 rounded-md border bg-card px-3 text-sm" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1) }} aria-label="Kind">
              <option value="">All kinds</option>
              {(data?.kinds ?? []).map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
            <select className="h-9 rounded-md border bg-card px-3 text-sm" value={scope} onChange={(e) => { setScope(e.target.value); setPage(1) }} aria-label="Scope">
              <option value="">All scopes</option>
              {(data?.scopes ?? []).map((s) => <option key={s.scope} value={s.scope}>{s.label}</option>)}
              <option value="none">No scope</option>
            </select>
            <select className="h-9 rounded-md border bg-card px-3 text-sm" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} aria-label="Rows per page">
              {[25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            <Button size="sm" variant="outline" disabled={!!busy || selected.size === 0} onClick={() => bulk("publish")} title="Publishes the selected drafts that the checks did not hold back.">
              {busy === "publish" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}Publish drafts
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy || selected.size === 0} onClick={() => bulk("reject")} title="Marks the selected drafts as rejected so they leave the review queue.">
              {busy === "reject" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <X className="mr-1 h-4 w-4" />}Reject drafts
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy || selected.size === 0} onClick={() => bulk("restore")} title="Puts rejected drafts back in the review queue.">
              {busy === "restore" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}Restore
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="w-8 p-3">
                  <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                </th>
                {COLUMNS.map((c) => (
                  <th key={c.sort} className={`p-3 ${c.className ?? ""}`}>
                    <button type="button" className="inline-flex items-center gap-1 font-semibold uppercase hover:text-foreground" onClick={() => clickSort(c.sort)}>
                      {c.label}
                      {sort === c.sort && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    </button>
                  </th>
                ))}
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const shown = data?.shownScope[r.id] ?? null
                const inQueue = r.status === "draft" && r.source === "ai" && r.review_state !== "rejected"
                return (
                  <tr key={r.id} className="border-b align-top hover:bg-muted/30">
                    <td className="p-3">
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n })} />
                    </td>
                    <td className="max-w-[260px] p-3">
                      <Link href={`/admin/guides/${r.id}`} className="font-medium text-foreground hover:underline">{r.name}</Link>
                      <p className="truncate text-xs text-muted-foreground">{r.path}</p>
                      {r.status === "draft" && r.quality_notes && <p className="mt-0.5 text-xs text-destructive">{r.quality_notes}</p>}
                    </td>
                    <td className="p-3">{data?.kinds.find((k) => k.kind === r.kind)?.label ?? r.kind}</td>
                    <td className="p-3">{shown ? <span title={r.scope ? "Set by hand or when written" : "Worked out from the name"}>{scopeLabel(shown)}{r.scope ? "" : "*"}</span> : <span className="text-muted-foreground">Not set</span>}</td>
                    <td className="p-3">
                      <Badge variant={r.status === "published" ? "default" : "secondary"}>{r.status === "published" ? "Live" : inQueue ? "Review" : r.review_state === "rejected" ? "Rejected" : "Draft"}</Badge>
                    </td>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">{new Date(r.updated_at).toLocaleDateString("en-CA")}</td>
                    <td className="p-3 text-right">{r.words}</td>
                    <td className="p-3 text-right">{r.score ?? <span className="text-muted-foreground">-</span>}</td>
                    <td className="p-3 text-right">{r.status !== "published" ? <span className="text-muted-foreground">-</span> : r.inbound < 0 ? <span className="text-muted-foreground">?</span> : r.inbound === 0 ? <span className="font-medium text-destructive">0</span> : r.inbound}</td>
                    <td className="p-3 text-right">{r.clicks ?? <span className="text-muted-foreground">-</span>}</td>
                    <td className="whitespace-nowrap p-3 text-right">
                      <Button size="sm" variant="outline" asChild><Link href={`/admin/guides/${r.id}`}>{inQueue ? <Eye className="mr-1 h-4 w-4" /> : <Pencil className="mr-1 h-4 w-4" />}{inQueue ? "Review" : "Edit"}</Link></Button>
                      {r.status === "published" && (
                        <Button size="sm" variant="ghost" asChild><a href={r.path} target="_blank" rel="noopener noreferrer" aria-label={`View ${r.name}`}><ExternalLink className="h-4 w-4" /></a></Button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">No pages match. Clear the search or the filters.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {data && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {data.total} page{data.total === 1 ? "" : "s"}
            {!data.inboundKnown && " (links in could not be counted just now)"}
            . Score is the daily SEO score; a * on a scope means it was worked out from the name.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={data.page <= 1 || loading} onClick={() => setPage(data.page - 1)}>Previous</Button>
            <span>Page {data.page} of {data.pages}</span>
            <Button size="sm" variant="outline" disabled={data.page >= data.pages || loading} onClick={() => setPage(data.page + 1)}>Next</Button>
          </div>
        </div>
      )}

      <EmptyBlurbsCard />
    </div>
  )
}
