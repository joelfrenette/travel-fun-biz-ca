"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
  const [accountsText, setAccountsText] = useState("")
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
        setAccountsText((data.accounts || []).join(", "))
        setQueue(data.queue || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  async function saveMode(next: string) {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/distribution", { method: "POST", headers: authHeaders(), body: JSON.stringify({ mode: next }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not save")
      setMode(next)
      toast({ title: "Distribution mode updated" })
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not save", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  async function saveAccounts() {
    setSaving(true)
    try {
      const accounts = accountsText.split(",").map((s) => s.trim()).filter(Boolean)
      const res = await fetch("/api/admin/distribution", { method: "POST", headers: authHeaders(), body: JSON.stringify({ accounts }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not save")
      toast({ title: "Accounts list saved" })
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not save", variant: "destructive" })
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
          <p className="text-sm text-muted-foreground">
            This is the enrollment ledger only — no posting provider is wired in yet (that needs a real choice between GHL Social Planner,
            Ayrshare and Upload-Post, plus a Shotstack decision for video). Mode stays "off" by default; nothing here posts anything until
            that decision is made and built.
          </p>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="space-y-2">
              <Label>Distribution mode</Label>
              <Select value={mode} onValueChange={saveMode} disabled={saving}>
                <SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off (default) — nothing gets enrolled</SelectItem>
                  <SelectItem value="prepare">Prepare — enroll new posts, held for manual approval</SelectItem>
                  <SelectItem value="auto">Auto — enroll new posts, queued automatically</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Allowed accounts (comma-separated, provider-agnostic placeholder)</Label>
              <Textarea value={accountsText} onChange={(e) => setAccountsText(e.target.value)} placeholder="Nothing can post until a real provider is chosen and this is filled in." rows={2} />
              <Button size="sm" variant="outline" onClick={saveAccounts} disabled={saving}>Save accounts</Button>
            </div>
          </CardContent>
        </Card>

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
