"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Sparkles, Check, X, Trash2, Play } from "lucide-react"
import type { BlogTopicQueueRow } from "@/lib/blog-topics"
import type { AutoblogMode } from "@/lib/autoblog-run"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const MODE_LABEL: Record<AutoblogMode, string> = {
  off: "Off — never writes a post",
  draft: "Draft — writes drafts, never publishes",
  publish: "Publish — auto-publishes when the quality gate passes",
}

export default function BlogTopicQueue() {
  const [topics, setTopics] = useState<BlogTopicQueueRow[]>([])
  const [mode, setMode] = useState<AutoblogMode>("off")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [runNote, setRunNote] = useState("")

  function load() {
    setLoading(true)
    fetch("/api/admin/blog/topics", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setTopics(data.topics || [])
        setMode(data.mode || "off")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function suggest() {
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/admin/blog/topics", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "suggest", count: 3 }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not suggest topics")
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: string, status: BlogTopicQueueRow["status"]) {
    setError("")
    const res = await fetch(`/api/admin/blog/topics/${id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ status }) })
    if (res.ok) load()
    else setError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  async function remove(id: string) {
    if (!confirm("Delete this topic idea?")) return
    const res = await fetch(`/api/admin/blog/topics/${id}`, { method: "DELETE", headers: authHeaders() })
    if (res.ok) load()
    else setError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  async function changeMode(next: AutoblogMode) {
    setError("")
    const res = await fetch("/api/admin/blog/autoblog-mode", { method: "POST", headers: authHeaders(), body: JSON.stringify({ mode: next }) })
    if (res.ok) setMode(next)
    else setError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  async function runNow() {
    setBusy(true)
    setRunNote("")
    setError("")
    try {
      const res = await fetch("/api/admin/blog/autoblog-run", { method: "POST", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setRunNote(data.ran ? `Wrote "${data.postSlug}" (${data.published ? "published" : "draft"}).` : `Nothing written: ${data.note}`)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed")
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const suggested = topics.filter((t) => t.status === "suggested")
  const approved = topics.filter((t) => t.status === "approved")
  const done = topics.filter((t) => t.status === "used" || t.status === "rejected")

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-[220px] flex-1">
            <p className="text-sm font-medium">Autoblog mode</p>
            <p className="text-xs text-muted-foreground">Ships off. Nothing writes or publishes until you change this.</p>
          </div>
          <Select value={mode} onValueChange={(v) => changeMode(v as AutoblogMode)}>
            <SelectTrigger className="w-[280px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["off", "draft", "publish"] as AutoblogMode[]).map((m) => (
                <SelectItem key={m} value={m}>{MODE_LABEL[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={runNow} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
            Run now
          </Button>
        </CardContent>
        {runNote && <CardContent className="p-4 pt-0 text-sm text-muted-foreground">{runNote}</CardContent>}
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">Topic queue</h2>
        <Button size="sm" variant="outline" onClick={suggest} disabled={busy}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
          Suggest 3 topics
        </Button>
      </div>

      {topics.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No topics yet. Suggest some, or approved ones will show here.</p>
      ) : (
        <div className="space-y-2">
          {[...approved, ...suggested, ...done].map((t) => (
            <Card key={t.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-[220px] flex-1">
                  <p className="text-sm font-medium">{t.angle}</p>
                  <p className="text-xs text-muted-foreground">{t.keyword}{t.why ? ` · ${t.why}` : ""}{t.used_slug ? ` · wrote /blog/${t.used_slug}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={t.status === "approved" ? "default" : t.status === "used" ? "secondary" : t.status === "rejected" ? "outline" : "secondary"}>{t.status}</Badge>
                  {t.status === "suggested" && (
                    <>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => patch(t.id, "approved")} title="Approve"><Check className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => patch(t.id, "rejected")} title="Reject"><X className="h-4 w-4" /></Button>
                    </>
                  )}
                  {t.status === "approved" && (
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => patch(t.id, "rejected")} title="Un-approve"><X className="h-4 w-4" /></Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(t.id)} title="Delete"><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
