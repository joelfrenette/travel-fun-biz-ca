"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Undo2 } from "lucide-react"

// Every change the site made to a page by itself (reworded or removed a held phrase, wrote missing meta text or a FAQ,
// fixed a dash or a broken link, added a link), newest first, with an Undo button that puts the original text back.

interface Edit {
  id: string
  content_type: "post" | "guide" | "page_copy"
  path: string
  field: string
  reason: string
  before: string | null
  after: string | null
  method: "ai" | "delete" | "fixer" | "links" | "generate"
  published_after: boolean
  reverted_at: string | null
  created_at: string
}

const FIELD_LABEL: Record<string, string> = {
  body: "Page text",
  links: "Links in the page text",
  title: "Title",
  meta_title: "Meta title",
  meta_description: "Meta description",
  og_title: "Share title",
  og_description: "Share description",
  faq: "FAQ",
  key_takeaways: "Key takeaways",
}
const METHOD_LABEL: Record<Edit["method"], string> = {
  ai: "Reworded by AI",
  delete: "Removed",
  fixer: "Plain fix",
  links: "Link added",
  generate: "Written from the page",
}
const TYPE_LABEL = { post: "Post", guide: "Guide", page_copy: "Page copy" } as const

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const clip = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n)}...` : s)

/** What changed, as short lines: sentences only in the old text and sentences only in the new text. */
function changedBits(edit: Edit): { removed: string[]; added: string[] } {
  const before = edit.before ?? ""
  const after = edit.after ?? ""
  if (edit.field === "faq" || edit.field === "key_takeaways") {
    const items = (raw: string): string[] => {
      try {
        const v = JSON.parse(raw)
        return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : `${x?.q ?? ""} ${x?.a ?? ""}`.trim())) : []
      } catch {
        return []
      }
    }
    const a = items(before)
    const b = items(after)
    return { removed: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)) }
  }
  if (edit.field === "body" || edit.field === "links") {
    const split = (raw: string) => raw.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)
    const a = split(before)
    const b = split(after)
    const bs = new Set(b)
    const as = new Set(a)
    return { removed: a.filter((x) => !bs.has(x)), added: b.filter((x) => !as.has(x)) }
  }
  return { removed: before ? [before] : [], added: after ? [after] : [] }
}

export default function ContentEditsPage() {
  const { toast } = useToast()
  const [edits, setEdits] = useState<Edit[]>([])
  const [type, setType] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/admin/content-edits${type ? `?type=${type}` : ""}`, { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setEdits(data.edits || [])
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [type])
  useEffect(() => { load() }, [load])

  async function revert(edit: Edit, force = false): Promise<void> {
    setBusy(edit.id)
    try {
      const res = await fetch(`/api/admin/content-edits/${edit.id}/revert`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ force }) })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409 && body.needsForce) {
        if (confirm(`${body.error}\n\nPut the original text back anyway?`)) {
          setBusy("")
          return revert(edit, true)
        }
        return
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: "Put back", description: `The original ${FIELD_LABEL[edit.field]?.toLowerCase() ?? edit.field} is back on ${edit.path}.` })
      load()
    } catch (e) {
      toast({ title: "Could not undo", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy("")
    }
  }

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">Content edits</h1>
            <p className="text-sm text-muted-foreground">Every change the site made to a page by itself, newest first. Undo puts the original text back on the page.</p>
          </div>
          <div className="flex items-center gap-2">
            <select className="h-9 rounded-md border bg-card px-3 text-sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by kind of page">
              <option value="">All pages</option>
              <option value="post">Blog posts</option>
              <option value="guide">Guides</option>
              <option value="page_copy">Compare and best-time copy</option>
            </select>
            <Button size="sm" variant="outline" asChild><Link href="/admin/autopilot">Back to Autopilot</Link></Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto space-y-3 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {loading && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
        {!loading && !error && edits.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet. When the site fixes a page by itself, each change shows up here.</p>}
        {edits.map((e) => {
          const bits = changedBits(e)
          return (
            <div key={e.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-[220px] flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <a className="hover:underline" href={e.path} target="_blank" rel="noopener noreferrer">{e.path}</a>
                    <Badge variant="outline" className="text-[10px] uppercase">{TYPE_LABEL[e.content_type]}</Badge>
                    <Badge variant="secondary">{FIELD_LABEL[e.field] ?? e.field}</Badge>
                    <Badge variant="outline">{METHOD_LABEL[e.method]}</Badge>
                    {e.published_after ? <Badge>Live</Badge> : <Badge variant="outline">Draft</Badge>}
                    {e.reverted_at && <Badge variant="destructive">Undone {new Date(e.reverted_at).toLocaleDateString("en-CA", { timeZone: "America/Toronto" })}</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })} &middot; {e.reason}</p>
                </div>
                {!e.reverted_at && (
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { if (confirm(`Put the original ${FIELD_LABEL[e.field]?.toLowerCase() ?? e.field} back on ${e.path}?${e.published_after ? " This changes a live page." : ""}`)) revert(e) }}>
                    {busy === e.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Undo2 className="mr-1 h-4 w-4" />}Undo
                  </Button>
                )}
              </div>
              {(bits.removed.length > 0 || bits.added.length > 0) && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">What changed</summary>
                  <div className="mt-1 space-y-1">
                    {bits.removed.slice(0, 6).map((t, i) => <p key={`r${i}`} className="rounded bg-destructive/10 px-2 py-1 text-destructive">- {clip(t)}</p>)}
                    {bits.added.slice(0, 6).map((t, i) => <p key={`a${i}`} className="rounded bg-emerald-500/10 px-2 py-1 text-emerald-700">+ {clip(t)}</p>)}
                    {bits.removed.length + bits.added.length > 12 && <p className="text-muted-foreground">... and more</p>}
                  </div>
                </details>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
