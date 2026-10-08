"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Share2 } from "lucide-react"

interface DistributionRow {
  slug: string
  title: string
  stage: "queued" | "held" | "done" | "failed"
  attempts: number
  last_error: string | null
  created_at: string
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export default function DistributionPage() {
  const { toast } = useToast()
  const [mode, setMode] = useState<string>("off")
  const [providerConfigured, setProviderConfigured] = useState(false)
  const [queue, setQueue] = useState<DistributionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  function load() {
    setLoading(true)
    fetch("/api/admin/distribution", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setMode(data.mode || "off")
        setProviderConfigured(!!data.providerConfigured)
        setQueue(data.queue || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  async function syncPending() {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/distribution", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "sync" }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not sync")
      toast({ title: "Sync complete", description: data.note })
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not sync", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  async function setStage(slug: string, action: "approve" | "hold") {
    try {
      const res = await fetch("/api/admin/distribution", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action, slug }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not update")
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not update", variant: "destructive" })
    }
  }

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Post Distribution</h1>
          <p className="text-sm text-muted-foreground">Posts waiting for your OK, queued to go out, and finished. Approve a held post to send it.</p>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <p className="text-muted-foreground">
              Mode now: <span className="font-medium text-foreground">{mode === "prepare" ? "review each post first" : mode === "auto" ? "post automatically" : "off"}</span>
              {providerConfigured ? "" : " (UPLOAD_POST_API_KEY is not set)"}. The profile, connected accounts and mode are set in one place on the Content Autopilot page.
            </p>
            <Button size="sm" variant="outline" asChild><a href="/admin/autopilot">Open posting settings</a></Button>
          </CardContent>
        </Card>

        {queue.some((r) => r.stage === "held") && (
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3 text-sm">
            <span className="text-muted-foreground">Some held posts may just be waiting on Upload-Post to confirm they actually posted.</span>
            <Button size="sm" variant="outline" onClick={syncPending} disabled={saving}>Sync pending</Button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : queue.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Share2 className="h-8 w-8" />
            <p>Nothing enrolled yet.</p>
            <p className="max-w-md text-sm">Set mode to "prepare" or "auto" above, then publish a blog post — it will show up here.</p>
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              {queue.map((row) => (
                <div key={row.slug} className="flex flex-wrap items-center justify-between gap-3 border-t p-4 first:border-t-0">
                  <div className="min-w-[220px] flex-1">
                    <p className="font-medium">{row.title}</p>
                    <p className="text-xs text-muted-foreground">{row.slug} &middot; {new Date(row.created_at).toLocaleDateString("en-CA")}</p>
                    {row.last_error && <p className="text-xs text-destructive">{row.last_error}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={row.stage === "held" ? "secondary" : row.stage === "failed" ? "destructive" : "default"}>{row.stage}</Badge>
                    {row.stage === "held" && <Button size="sm" variant="outline" onClick={() => setStage(row.slug, "approve")}>Approve</Button>}
                    {row.stage === "queued" && <Button size="sm" variant="outline" onClick={() => setStage(row.slug, "hold")}>Hold</Button>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
