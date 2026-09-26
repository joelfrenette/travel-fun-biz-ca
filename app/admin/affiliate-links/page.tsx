"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Link2, Pencil, Trash2, X } from "lucide-react"
import { GO_PREFIX } from "@/lib/affiliate-go"

interface AffiliateLinkRow {
  id: string
  slug: string
  status: "draft" | "active" | "hidden"
  url: string
  merchant: string | null
  title: string | null
  sort_order: number
  clicks: { total: number; last7: number; last30: number }
}

interface AffiliateLinkForm {
  id: string
  slug: string
  url: string
  merchant: string
  title: string
  status: "draft" | "active" | "hidden"
  sort_order: number
}

const EMPTY_FORM: AffiliateLinkForm = { id: "", slug: "", url: "", merchant: "", title: "", status: "draft", sort_order: 0 }

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export default function AffiliateLinksPage() {
  const { toast } = useToast()
  const [links, setLinks] = useState<AffiliateLinkRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [form, setForm] = useState<AffiliateLinkForm>(EMPTY_FORM)

  function load() {
    setLoading(true)
    fetch("/api/admin/affiliate-links", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setLinks(data.links || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  function editRow(row: AffiliateLinkRow) {
    setForm({ id: row.id, slug: row.slug, url: row.url, merchant: row.merchant ?? "", title: row.title ?? "", status: row.status, sort_order: row.sort_order })
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const isEdit = !!form.id
      const res = await fetch(isEdit ? `/api/admin/affiliate-links/${form.id}` : "/api/admin/affiliate-links", {
        method: isEdit ? "PATCH" : "POST",
        headers: authHeaders(),
        body: JSON.stringify(form),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not save")
      toast({ title: isEdit ? "Link updated" : "Link created" })
      setForm(EMPTY_FORM)
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not save", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this affiliate link? Its /go short link will stop working immediately.")) return
    try {
      const res = await fetch(`/api/admin/affiliate-links/${id}`, { method: "DELETE", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not delete")
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not delete", variant: "destructive" })
    }
  }

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Affiliate Links</h1>
          <p className="text-sm text-muted-foreground">
            Every card here gets a short link at <code className="rounded bg-muted px-1">{GO_PREFIX}/&lt;slug&gt;</code>. Paste that short
            link anywhere (site, emails, social bios) instead of the merchant's raw URL — changing the URL here fixes every copy that was
            ever published. Only <b>active</b> links redirect; draft and hidden links exist but send nobody anywhere.
          </p>
        </div>
      </div>

      <div className="container mx-auto space-y-6 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <Card>
          <CardContent className="p-4">
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{form.id ? "Edit link" : "Add a link"}</h2>
                {form.id && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setForm(EMPTY_FORM)}>
                    <X className="mr-1 h-3.5 w-3.5" /> Cancel edit
                  </Button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="url">URL *</Label>
                  <Input id="url" placeholder="https://merchant.com/our-affiliate-link" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="slug">Short link slug</Label>
                  <Input id="slug" placeholder="leave blank to auto-generate" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" placeholder="Shown to you here only" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="merchant">Merchant</Label>
                  <Input id="merchant" placeholder="e.g. Trip.com" value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">Status</Label>
                  <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as typeof form.status })}>
                    <SelectTrigger id="status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft (not live)</SelectItem>
                      <SelectItem value="active">Active (redirects)</SelectItem>
                      <SelectItem value="hidden">Hidden (retired)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sort_order">Sort order</Label>
                  <Input id="sort_order" type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) || 0 })} />
                </div>
              </div>

              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {form.id ? "Save changes" : "Create link"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : links.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Link2 className="h-8 w-8" />
            <p>No affiliate links yet. Add one above.</p>
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              {links.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 border-t p-4 first:border-t-0">
                  <div className="min-w-[220px] flex-1">
                    <p className="font-medium">{l.title || l.merchant || l.url}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <code className="rounded bg-muted px-1">{GO_PREFIX}/{l.slug}</code> &middot; {l.url}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Badge variant={l.status === "active" ? "default" : l.status === "hidden" ? "destructive" : "secondary"}>{l.status}</Badge>
                    <span className="text-xs text-muted-foreground" title="total / last 7 days / last 30 days">
                      {l.clicks.total} clicks &middot; {l.clicks.last7} in 7d
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => editRow(l)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => onDelete(l.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
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
