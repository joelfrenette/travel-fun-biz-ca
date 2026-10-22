"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2, Trash2, FileText, Pencil, ExternalLink, Eye, EyeOff, ArrowUp, ArrowDown, X } from "lucide-react"
import type { ReactNode } from "react"
import type { Post } from "@/lib/posts"
import PostThumb from "@/components/admin/post-thumb"
import { thumbTypeFor, ownImage } from "@/lib/post-defaults"
import {
  POST_TYPES, TYPE_LABEL, SORTS, PAGE_SIZE, DEFAULT_POST_QUERY,
  buildRow, parsePostQuery, serializePostQuery, filterPosts, sortPosts, paginate, distinctValues, statusPatch,
  type AdminPostMeta, type AdminPostRow, type PostQuery, type PostSort, type BulkAction, type PostType,
} from "@/lib/blog-admin-filters"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const SORT_LABEL: Record<PostSort, string> = { date: "Date", name: "Name", type: "Type", supplier: "Supplier", city: "City", country: "Country" }
const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm"

interface Props {
  posts: Post[]
  meta: Record<string, AdminPostMeta>
  loading: boolean
  /** Remove / replace posts locally after an action (no full reload, so filters and scroll stay put). */
  onPostsChange: (next: Post[]) => void
  onError: (message: string) => void
  /** Show only this kind of post and hide the Type filter (the News page passes "news"). Omit for every kind. */
  lockedType?: PostType
  /** Supplier / city / country filters come from a linked trip; a kind that is never linked to one hides them. Default true. */
  showTripFilters?: boolean
  /** Extra per-row buttons for one kind of post (for example Approve / Reject on a news brief). Rendered before Edit. */
  extraActions?: (row: AdminPostRow, busy: boolean) => ReactNode
  /** Wording for the empty list, so each page can say what a post is called there. */
  emptyText?: string
}

export default function BlogPostsList({ posts, meta, loading, onPostsChange, onError, lockedType, showTripFilters = true, extraActions, emptyText }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const parsedQuery = useMemo(() => parsePostQuery(searchParams), [searchParams])
  const query = useMemo(() => (lockedType ? { ...parsedQuery, type: lockedType } : parsedQuery), [parsedQuery, lockedType])

  // The search box keeps its own text so typing is instant; the URL follows a moment later.
  const [searchText, setSearchText] = useState(query.q)
  useEffect(() => setSearchText(query.q), [query.q])
  useEffect(() => {
    if (searchText === query.q) return
    const t = setTimeout(() => update({ q: searchText, page: 1 }), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText])

  function update(patch: Partial<PostQuery>) {
    const next = { ...query, ...patch, ...(lockedType ? { type: "" as const } : {}) }
    const params = serializePostQuery(next)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const rows = useMemo(() => posts.map((p) => buildRow(p, meta[p.id])), [posts, meta])
  const filtered = useMemo(() => sortPosts(filterPosts(rows, query), query.sort, query.dir), [rows, query])
  const view = paginate(filtered, query.page, PAGE_SIZE)
  const suppliers = useMemo(() => distinctValues(rows, "supplier"), [rows])
  const cities = useMemo(() => distinctValues(rows, "city"), [rows])
  const countries = useMemo(() => distinctValues(rows, "country"), [rows])
  const filtersActive = serializePostQuery({ ...query, ...(lockedType ? { type: "" as const } : {}), page: 1, sort: DEFAULT_POST_QUERY.sort, dir: DEFAULT_POST_QUERY.dir }).toString() !== ""

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  // Drop selections for rows that no longer exist (deleted, or the list reloaded).
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(posts.map((p) => p.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [posts])

  const pageIds = view.items.map((r) => r.id)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  function togglePage(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of pageIds) on ? next.add(id) : next.delete(id)
      return next
    })
  }
  function toggleOne(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      on ? next.add(id) : next.delete(id)
      return next
    })
  }

  function patchLocal(updated: Post) {
    onPostsChange(posts.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)))
  }

  async function setStatus(row: AdminPostRow, action: "publish" | "unpublish") {
    if (action === "unpublish" && !confirm(`Unpublish "${row.title}"? It goes back to a draft and disappears from the public site. Nothing is deleted and you can publish it again.`)) return
    setBusy(true)
    setNote("")
    try {
      const res = await fetch(`/api/admin/blog/${row.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(statusPatch(action, row, new Date().toISOString())) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      patchLocal(data.post)
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not change the status")
    } finally {
      setBusy(false)
    }
  }

  async function remove(row: AdminPostRow) {
    if (!confirm(`Delete "${row.title}"? This cannot be undone.`)) return
    const res = await fetch(`/api/admin/blog/${row.id}`, { method: "DELETE", headers: authHeaders() })
    if (res.ok) onPostsChange(posts.filter((x) => x.id !== row.id))
    else onError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  async function bulk(action: BulkAction) {
    const ids = [...selected]
    if (ids.length === 0) return
    const n = ids.length
    const noun = `${n} post${n === 1 ? "" : "s"}`
    if (action === "unpublish" && !confirm(`Unpublish ${noun}? They go back to drafts and disappear from the public site. Nothing is deleted.`)) return
    if (action === "delete" && !confirm(`Delete ${noun}? This cannot be undone.`)) return
    setBusy(true)
    setNote("")
    try {
      const res = await fetch("/api/admin/blog/bulk", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action, ids, ...(action === "delete" ? { confirm: "delete" } : {}) }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const results = (data.results || []) as { id: string; ok: boolean; note: string }[]
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id))
      if (action === "delete") onPostsChange(posts.filter((p) => !okIds.has(p.id)))
      else onPostsChange(posts.map((p) => (okIds.has(p.id) ? { ...p, status: action === "publish" ? "published" : "draft" } : p)))
      setSelected(new Set(results.filter((r) => !r.ok).map((r) => r.id)))
      const failed = results.filter((r) => !r.ok)
      const titleOf = (id: string) => posts.find((p) => p.id === id)?.title ?? id
      setNote(`${data.okCount} of ${results.length} done.${failed.length ? ` Failed: ${failed.map((f) => `${titleOf(f.id)} (${f.note})`).join("; ")}. Those stay selected.` : ""}`)
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk action failed")
    } finally {
      setBusy(false)
    }
  }

  function sortBy(col: PostSort) {
    update(query.sort === col ? { dir: query.dir === "asc" ? "desc" : "asc", page: 1 } : { sort: col, dir: col === "date" ? "desc" : "asc", page: 1 })
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-9 min-w-[220px] flex-1" placeholder="Search title, slug or keywords" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search posts" />
            <select className={selectClass} value={query.status} onChange={(e) => update({ status: e.target.value as PostQuery["status"], page: 1 })} aria-label="Status">
              <option value="all">All statuses</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
            </select>
            {!lockedType && (
              <select className={selectClass} value={query.type} onChange={(e) => update({ type: e.target.value as PostQuery["type"], page: 1 })} aria-label="Type">
                <option value="">All types</option>
                {POST_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {showTripFilters && (
              <>
                <select className={selectClass} value={query.supplier} onChange={(e) => update({ supplier: e.target.value, page: 1 })} aria-label="Supplier">
                  <option value="">Any supplier</option>
                  {suppliers.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <select className={selectClass} value={query.city} onChange={(e) => update({ city: e.target.value, page: 1 })} aria-label="City">
                  <option value="">Any city</option>
                  {cities.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <select className={selectClass} value={query.country} onChange={(e) => update({ country: e.target.value, page: 1 })} aria-label="Country">
                  <option value="">Any country</option>
                  {countries.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </>
            )}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">From
              <Input type="date" className="h-9 w-[150px]" value={query.from} onChange={(e) => update({ from: e.target.value, page: 1 })} />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">To
              <Input type="date" className="h-9 w-[150px]" value={query.to} onChange={(e) => update({ to: e.target.value, page: 1 })} />
            </label>
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={() => router.replace(pathname, { scroll: false })}><X className="mr-1 h-4 w-4" />Clear filters</Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Sort by</span>
            {SORTS.map((col) => (
              <Button key={col} variant={query.sort === col ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => sortBy(col)}>
                {SORT_LABEL[col]}
                {query.sort === col && (query.dir === "asc" ? <ArrowUp className="ml-1 h-3 w-3" /> : <ArrowDown className="ml-1 h-3 w-3" />)}
              </Button>
            ))}
            <span className="ml-auto" aria-live="polite">{loading ? "Loading..." : `${filtered.length} of ${rows.length} post${rows.length === 1 ? "" : "s"}`}</span>
          </div>
          {(showTripFilters && suppliers.length === 0 && cities.length === 0 && countries.length === 0 && rows.length > 0) && (
            <p className="text-xs text-muted-foreground">Supplier, city and country come from the trip a post is linked to. No post is linked to a trip yet, so those filters are empty.</p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card/30 px-3 py-2">
        <Checkbox checked={allOnPage} onCheckedChange={(v) => togglePage(v === true)} aria-label="Select all posts on this page" disabled={pageIds.length === 0} />
        <span className="text-sm">{selected.size === 0 ? "Select all on this page" : `${selected.size} selected`}</span>
        {selected.size > 0 && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk("publish")}><Eye className="mr-1.5 h-4 w-4" />Publish {selected.size}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk("unpublish")}><EyeOff className="mr-1.5 h-4 w-4" />Unpublish {selected.size}</Button>
            <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => bulk("delete")}><Trash2 className="mr-1.5 h-4 w-4" />Delete {selected.size}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(new Set())}>Clear selection</Button>
          </>
        )}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      {note && <p className="text-sm text-muted-foreground" role="status">{note}</p>}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
          <FileText className="h-8 w-8" />
          <p>{emptyText ?? "No posts yet. Write your first one."}</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No posts match these filters.</p>
      ) : (
        <>
          {view.items.map((row) => {
            const scheduled = row.status === "published" && !!row.publish_date && row.publish_date > today
            return (
              <Card key={row.id}>
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <Checkbox checked={selected.has(row.id)} onCheckedChange={(v) => toggleOne(row.id, v === true)} aria-label={`Select ${row.title}`} />
                  <Link href={`/admin/blog/${row.id}`} aria-label={`Edit ${row.title}`} className="shrink-0">
                    <PostThumb src={ownImage(row)} alt={`Thumbnail for ${row.title}`} type={thumbTypeFor(row.type)} size="sm" />
                  </Link>
                  <div className="min-w-[200px] flex-1">
                    <Link href={`/admin/blog/${row.id}`} className="font-medium hover:underline">{row.title}</Link>
                    <p className="text-xs text-muted-foreground">
                      /blog/{row.slug}{row.date ? ` · ${row.date}` : ""}
                      {row.tags.length > 0 ? ` · ${row.tags.join(", ")}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {showTripFilters ? `Supplier: ${row.supplier || "-"} · City: ${row.city || "-"} · Country: ${row.country || "-"}` : ""}
                      {row.type === "news" ? `${showTripFilters ? " · " : ""}Source: ${row.source || "-"}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{TYPE_LABEL[row.type]}</Badge>
                    {scheduled ? (
                      <Badge variant="outline">scheduled {row.publish_date}</Badge>
                    ) : (
                      <Badge variant={row.status === "published" ? "default" : "secondary"}>{row.status}</Badge>
                    )}
                    {extraActions?.(row, busy)}
                    <Button asChild variant="ghost" size="icon" className="h-8 w-8" title="Edit"><Link href={`/admin/blog/${row.id}`}><Pencil className="h-4 w-4" /></Link></Button>
                    {row.status === "published" ? (
                      <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy} onClick={() => setStatus(row, "unpublish")} title="Unpublish"><EyeOff className="h-4 w-4" /></Button>
                    ) : (
                      <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy} onClick={() => setStatus(row, "publish")} title="Publish"><Eye className="h-4 w-4" /></Button>
                    )}
                    {row.status === "published" && (
                      <Button asChild variant="ghost" size="icon" className="h-8 w-8" title="View on site"><a href={`/blog/${row.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /></a></Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(row)} title="Delete"><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
          {view.pages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2 text-sm">
              <Button variant="outline" size="sm" disabled={view.page <= 1} onClick={() => update({ page: view.page - 1 })}>Previous</Button>
              <span className="text-muted-foreground">Page {view.page} of {view.pages} ({PAGE_SIZE} per page)</span>
              <Button variant="outline" size="sm" disabled={view.page >= view.pages} onClick={() => update({ page: view.page + 1 })}>Next</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
