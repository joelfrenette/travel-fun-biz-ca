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
import { DEFAULT_DISCLOSURE, MAX_NOTE_LENGTH, TEMPLATE_HELP } from "@/lib/affiliate-partners"

type Status = "draft" | "active" | "hidden"
interface Counts { total: number; last7: number; last30: number }

interface AffiliateLinkRow {
  id: string
  slug: string
  status: Status
  url: string
  merchant: string | null
  title: string | null
  sort_order: number
  partner_id?: string | null
  guide_kind?: string | null
  guide_slug?: string | null
  image_url?: string | null
  note?: string | null
  clicks: Counts
}

interface PartnerRow {
  id: string
  slug: string
  name: string
  logo_url: string | null
  partner_id: string | null
  search_template: string | null
  disclosure: string | null
  status: Status
  sort_order: number
  clicks: Counts
}

interface GuideOption { kind: string; slug: string; name: string }
interface PageClicks extends Counts { key: string }

interface AffiliateLinkForm {
  id: string
  slug: string
  url: string
  merchant: string
  title: string
  status: Status
  sort_order: number
  partner_id: string
  page: string // "<kind>/<slug>" or ""
  image_url: string
  note: string
}

interface PartnerForm {
  id: string
  name: string
  slug: string
  logo_url: string
  partner_id: string
  search_template: string
  disclosure: string
  status: Status
  sort_order: number
}

const EMPTY_FORM: AffiliateLinkForm = { id: "", slug: "", url: "", merchant: "", title: "", status: "draft", sort_order: 0, partner_id: "", page: "", image_url: "", note: "" }
const EMPTY_PARTNER: PartnerForm = { id: "", name: "", slug: "", logo_url: "", partner_id: "", search_template: "", disclosure: "", status: "draft", sort_order: 0 }

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const statusVariant = (s: Status) => (s === "active" ? "default" : s === "hidden" ? "destructive" : "secondary")

export default function AffiliateLinksPage() {
  const { toast } = useToast()
  const [links, setLinks] = useState<AffiliateLinkRow[]>([])
  const [partners, setPartners] = useState<PartnerRow[]>([])
  const [guides, setGuides] = useState<GuideOption[]>([])
  const [pages, setPages] = useState<PageClicks[]>([])
  const [partnerTotal, setPartnerTotal] = useState<Counts>({ total: 0, last7: 0, last30: 0 })
  const [migrated, setMigrated] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingPartner, setSavingPartner] = useState(false)
  const [error, setError] = useState("")
  const [form, setForm] = useState<AffiliateLinkForm>(EMPTY_FORM)
  const [partnerForm, setPartnerForm] = useState<PartnerForm>(EMPTY_PARTNER)

  function load() {
    setLoading(true)
    fetch("/api/admin/affiliate-links", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setLinks(data.links || [])
        setPartners(data.partners || [])
        setGuides(data.guides || [])
        setPages(data.pages || [])
        setPartnerTotal(data.partnerClicksAll || { total: 0, last7: 0, last30: 0 })
        setMigrated(data.migrated !== false)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  function editRow(row: AffiliateLinkRow) {
    setForm({
      id: row.id, slug: row.slug, url: row.url, merchant: row.merchant ?? "", title: row.title ?? "", status: row.status, sort_order: row.sort_order,
      partner_id: row.partner_id ?? "", page: row.guide_kind && row.guide_slug ? `${row.guide_kind}/${row.guide_slug}` : "", image_url: row.image_url ?? "", note: row.note ?? "",
    })
  }

  function editPartner(p: PartnerRow) {
    setPartnerForm({
      id: p.id, name: p.name, slug: p.slug, logo_url: p.logo_url ?? "", partner_id: p.partner_id ?? "", search_template: p.search_template ?? "",
      disclosure: p.disclosure ?? "", status: p.status, sort_order: p.sort_order,
    })
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const isEdit = !!form.id
      const [guide_kind, ...rest] = form.page ? form.page.split("/") : [""]
      const { page: _page, ...fields } = form
      void _page
      const res = await fetch(isEdit ? `/api/admin/affiliate-links/${form.id}` : "/api/admin/affiliate-links", {
        method: isEdit ? "PATCH" : "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ...fields, guide_kind, guide_slug: rest.join("/") }),
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

  async function onSubmitPartner(e: React.FormEvent) {
    e.preventDefault()
    setSavingPartner(true)
    try {
      const isEdit = !!partnerForm.id
      const res = await fetch(isEdit ? `/api/admin/affiliate-partners/${partnerForm.id}` : "/api/admin/affiliate-partners", {
        method: isEdit ? "PATCH" : "POST",
        headers: authHeaders(),
        body: JSON.stringify(partnerForm),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not save")
      toast({ title: isEdit ? "Partner updated" : "Partner created" })
      setPartnerForm(EMPTY_PARTNER)
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not save", variant: "destructive" })
    } finally {
      setSavingPartner(false)
    }
  }

  async function hidePartner(p: PartnerRow) {
    try {
      const res = await fetch(`/api/admin/affiliate-partners/${p.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ ...p, status: p.status === "hidden" ? "active" : "hidden" }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not update", variant: "destructive" })
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

  const partnerName = (id: string | null | undefined) => partners.find((p) => p.id === id)?.name

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
        {!migrated && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            Partners and page links need one new table in Supabase (file <code>supabase/migrations/0048_things_to_do.sql</code>). Until it is run, this section stays empty.
          </div>
        )}

        {/* ---------------- Partners ---------------- */}
        <Card>
          <CardContent className="space-y-4 p-4">
            <div>
              <h2 className="font-semibold">Partners</h2>
              <p className="text-sm text-muted-foreground">
                Each <b>active</b> partner with a search link gets a &ldquo;Find tours and activities&rdquo; button in the &ldquo;Fun things to do&rdquo; block on every guide and destination page. Nothing is shown until you add one.
              </p>
            </div>

            <form onSubmit={onSubmitPartner} className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{partnerForm.id ? "Edit partner" : "Add a partner"}</h3>
                {partnerForm.id && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPartnerForm(EMPTY_PARTNER)}>
                    <X className="mr-1 h-3.5 w-3.5" /> Cancel edit
                  </Button>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="p-name">Name *</Label>
                  <Input id="p-name" placeholder="The partner's name, as visitors should see it" value={partnerForm.name} onChange={(e) => setPartnerForm({ ...partnerForm, name: e.target.value })} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-partner-id">Partner ID</Label>
                  <Input id="p-partner-id" placeholder="Your ID with this partner (from their dashboard)" value={partnerForm.partner_id} onChange={(e) => setPartnerForm({ ...partnerForm, partner_id: e.target.value })} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="p-template">Search link</Label>
                  <Input id="p-template" placeholder="https://partner-site.example/search?q={query}&pid={partner_id}" value={partnerForm.search_template} onChange={(e) => setPartnerForm({ ...partnerForm, search_template: e.target.value })} />
                  <p className="text-xs text-muted-foreground">
                    {TEMPLATE_HELP}. Only https links work. This screen does not know any partner's link format, so copy it from their dashboard.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-logo">Logo link</Label>
                  <Input id="p-logo" placeholder="https://... (optional)" value={partnerForm.logo_url} onChange={(e) => setPartnerForm({ ...partnerForm, logo_url: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-slug">Short name for web addresses</Label>
                  <Input id="p-slug" placeholder="leave blank to auto-generate" disabled={!!partnerForm.id} title={partnerForm.id ? "Fixed after creation, because page links use it" : undefined} value={partnerForm.slug} onChange={(e) => setPartnerForm({ ...partnerForm, slug: e.target.value })} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="p-disclosure">Commission wording</Label>
                  <Input id="p-disclosure" placeholder={DEFAULT_DISCLOSURE} value={partnerForm.disclosure} onChange={(e) => setPartnerForm({ ...partnerForm, disclosure: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Shown under the block. Leave empty to use: {DEFAULT_DISCLOSURE}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-status">Status</Label>
                  <Select value={partnerForm.status} onValueChange={(v) => setPartnerForm({ ...partnerForm, status: v as Status })}>
                    <SelectTrigger id="p-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft (not shown)</SelectItem>
                      <SelectItem value="active">Active (shown on pages)</SelectItem>
                      <SelectItem value="hidden">Hidden (retired)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-sort">Sort order</Label>
                  <Input id="p-sort" type="number" value={partnerForm.sort_order} onChange={(e) => setPartnerForm({ ...partnerForm, sort_order: Number(e.target.value) || 0 })} />
                </div>
              </div>
              <Button type="submit" disabled={savingPartner}>
                {savingPartner ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {partnerForm.id ? "Save partner" : "Create partner"}
              </Button>
            </form>

            {partners.length > 0 && (
              <div className="rounded-lg border">
                {partners.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-t p-3 first:border-t-0">
                    <div className="min-w-[200px] flex-1">
                      <p className="font-medium">{p.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.search_template ? "Search link set" : "No search link (cards only)"}
                        {p.partner_id ? ` · ID ${p.partner_id}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                      <span className="text-xs text-muted-foreground" title="search button clicks: total / last 7 days / last 30 days">
                        {p.clicks.total} clicks &middot; {p.clicks.last7} in 7d &middot; {p.clicks.last30} in 30d
                      </span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => editPartner(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => hidePartner(p)}>{p.status === "hidden" ? "Unhide" : "Hide"}</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {pages.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Partner search clicks by page</h3>
                <p className="mb-2 text-xs text-muted-foreground">Clicks on the automatic &ldquo;Find tours and activities&rdquo; buttons, all partners together ({partnerTotal.total} total, {partnerTotal.last7} in 7 days, {partnerTotal.last30} in 30 days). Clicks only, never money: commissions stay in each partner's dashboard.</p>
                <div className="rounded-lg border text-sm">
                  {pages.map((p) => (
                    <div key={p.key} className="flex items-center justify-between gap-3 border-t px-3 py-2 first:border-t-0">
                      <code className="truncate text-xs">/{p.key}</code>
                      <span className="text-xs text-muted-foreground">{p.total} clicks &middot; {p.last7} in 7d &middot; {p.last30} in 30d</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---------------- Links ---------------- */}
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
                  <Input id="title" placeholder="Shown on the card (and to you here)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="merchant">Merchant</Label>
                  <Input id="merchant" placeholder="e.g. Trip.com" value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="partner">Partner</Label>
                  <select id="partner" className={selectClass} value={form.partner_id} onChange={(e) => setForm({ ...form, partner_id: e.target.value })}>
                    <option value="">No partner</option>
                    {partners.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status !== "active" ? ` (${p.status})` : ""}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="page">Page</Label>
                  <select id="page" className={selectClass} value={form.page} onChange={(e) => setForm({ ...form, page: e.target.value })}>
                    <option value="">Not shown on a page</option>
                    {guides.map((g) => <option key={`${g.kind}/${g.slug}`} value={`${g.kind}/${g.slug}`}>{g.name} ({g.kind})</option>)}
                  </select>
                  <p className="text-xs text-muted-foreground">Pick a page to show this link as a card in its &ldquo;Fun things to do&rdquo; block.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="image_url">Photo link</Label>
                  <Input id="image_url" placeholder="https://... (optional)" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="note">Note ({form.note.length}/{MAX_NOTE_LENGTH})</Label>
                  <Input id="note" maxLength={MAX_NOTE_LENGTH} placeholder="One or two plain sentences, written by you" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
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
                    {(l.guide_kind || l.partner_id) && (
                      <p className="truncate text-xs text-muted-foreground">
                        {l.guide_kind && l.guide_slug ? `Page: /${l.guide_kind}/${l.guide_slug}` : ""}
                        {l.guide_kind && l.partner_id ? " · " : ""}
                        {l.partner_id ? `Partner: ${partnerName(l.partner_id) ?? "unknown"}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Badge variant={statusVariant(l.status)}>{l.status}</Badge>
                    <span className="text-xs text-muted-foreground" title="total / last 7 days / last 30 days">
                      {l.clicks.total} clicks &middot; {l.clicks.last7} in 7d &middot; {l.clicks.last30} in 30d
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
