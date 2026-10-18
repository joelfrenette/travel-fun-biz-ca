"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Link2, Pencil, Plus, Trash2, Type, X } from "lucide-react"
import { GO_PREFIX } from "@/lib/affiliate-go"
import { DEFAULT_DISCLOSURE, MAX_NOTE_LENGTH, TEMPLATE_HELP } from "@/lib/affiliate-partners"
import { LINK_CATEGORIES, LINK_CATEGORY_LABELS, isLinkCategory } from "@/lib/link-categories"
import { EMPTY_ADVANCED, type AdvancedInput } from "@/lib/affiliate-link-partner"
import type { KeywordRow } from "@/lib/affiliate-rules"
import type { UsageReport } from "@/lib/affiliate-usage"
import { AffiliateWordLinker } from "@/components/admin/affiliate-word-linker"

// ONE list of affiliate links. Each row: name, where it goes, category, the words that link to it, clicks, and the buttons
// ON / OFF, Edit and Link a word. ON means the link works and shows on the site; OFF means it is hidden everywhere (its short
// link goes to the home page and its words stop being links). The search button on guide pages (what used to be a separate
// "partner") is the Advanced part of a link's edit form.

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
  category?: string | null
  clicks: Counts
  advanced: AdvancedInput
  searchStatus: Status | null
  partnerAdopted: boolean
  searchClicks: Counts | null
}

interface SearchOnlyRow { id: string; name: string; slug: string; status: Status; hasSearch: boolean; clicks: Counts }
interface GuideOption { kind: string; slug: string; name: string }
interface PageClicks extends Counts { key: string }

interface LinkForm {
  id: string
  slug: string
  url: string
  name: string
  merchant: string
  status: Status
  sort_order: number
  partner_id: string
  page: string // "<kind>/<slug>" or ""
  image_url: string
  note: string
  category: string
  advanced: AdvancedInput
}

const EMPTY_FORM: LinkForm = { id: "", slug: "", url: "", name: "", merchant: "", status: "active", sort_order: 0, partner_id: "", page: "", image_url: "", note: "", category: "", advanced: EMPTY_ADVANCED }

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const isOn = (s: Status | null | undefined) => s === "active"
const nameOf = (l: Pick<AffiliateLinkRow, "title" | "merchant" | "url">) => l.title || l.merchant || l.url

/** "viator.com/d4217-tours..." : the host and the start of the path, so a long affiliate address stays on one line. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}`
    return `${u.host.replace(/^www\./, "")}${rest.length > 18 ? `${rest.slice(0, 18)}...` : rest}`
  } catch {
    return url.length > 32 ? `${url.slice(0, 32)}...` : url
  }
}

function OnOff({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label={label}>
      <button type="button" onClick={() => !on && onChange(true)} className={`px-4 py-2 text-sm font-semibold ${on ? "bg-green-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"}`}>ON</button>
      <button type="button" onClick={() => on && onChange(false)} className={`px-4 py-2 text-sm font-semibold ${!on ? "bg-slate-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"}`}>OFF</button>
    </div>
  )
}

export default function AffiliateLinksPage() {
  const { toast } = useToast()
  const [links, setLinks] = useState<AffiliateLinkRow[]>([])
  const [searchOnly, setSearchOnly] = useState<SearchOnlyRow[]>([])
  const [guides, setGuides] = useState<GuideOption[]>([])
  const [pages, setPages] = useState<PageClicks[]>([])
  const [keywords, setKeywords] = useState<KeywordRow[]>([])
  const [report, setReport] = useState<UsageReport | null>(null)
  const [keywordsMigrated, setKeywordsMigrated] = useState(true)
  const [migrated, setMigrated] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [form, setForm] = useState<LinkForm | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [focus, setFocus] = useState<{ linkId: string; nonce: number } | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  async function fetchJson(url: string) {
    const r = await fetch(url, { headers: authHeaders() })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || "Could not load")
    return data
  }

  async function loadKeywords() {
    try {
      const data = await fetchJson("/api/admin/affiliate-keywords")
      setKeywords(data.keywords || [])
      setReport(data.report || null)
      setKeywordsMigrated(data.migrated !== false)
    } catch {
      setKeywords([])
    }
  }

  async function load() {
    setLoading(true)
    try {
      const data = await fetchJson("/api/admin/affiliate-links")
      setLinks(data.links || [])
      setSearchOnly(data.searchOnly || [])
      setGuides(data.guides || [])
      setPages(data.pages || [])
      setMigrated(data.migrated !== false)
      await loadKeywords()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openEdit(row: AffiliateLinkRow) {
    setForm({
      id: row.id, slug: row.slug, url: row.url, name: row.title || row.merchant || "", merchant: row.merchant ?? "", status: row.status, sort_order: row.sort_order,
      partner_id: row.partner_id ?? "", page: row.guide_kind && row.guide_slug ? `${row.guide_kind}/${row.guide_slug}` : "", image_url: row.image_url ?? "", note: row.note ?? "",
      category: row.category ?? "", advanced: row.advanced ?? EMPTY_ADVANCED,
    })
    setAdvancedOpen(false)
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0)
  }

  function openNew() {
    setForm({ ...EMPTY_FORM })
    setAdvancedOpen(false)
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0)
  }

  function told(refreshed?: { pages?: boolean }) {
    return refreshed && refreshed.pages === false ? "Saved. The pages will catch up within a few minutes." : "Saved. The whole site is updated."
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form) return
    setSaving(true)
    try {
      const isEdit = !!form.id
      const [guide_kind, ...rest] = form.page ? form.page.split("/") : [""]
      const { page: _page, name, advanced, ...fields } = form
      void _page
      const res = await fetch(isEdit ? `/api/admin/affiliate-links/${form.id}` : "/api/admin/affiliate-links", {
        method: isEdit ? "PATCH" : "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ...fields, title: name, guide_kind, guide_slug: rest.join("/"), advanced }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not save")
      toast({ title: isEdit ? "Link updated" : "Link added", description: told(data.refreshed) })
      setForm(null)
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not save", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  async function setOnOff(row: AffiliateLinkRow, on: boolean) {
    try {
      const res = await fetch(`/api/admin/affiliate-links/${row.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ status: on ? "active" : "hidden" }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      toast({ title: on ? "Turned ON" : "Turned OFF", description: told(data.refreshed).replace("Saved. ", "") })
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not update", variant: "destructive" })
    }
  }

  async function setSearchOnlyOnOff(p: SearchOnlyRow, on: boolean) {
    try {
      // A search-button-only row is a partner without a link: it is switched through the partner route (status only).
      const res = await fetch(`/api/admin/affiliate-partners/${p.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ status: on ? "active" : "hidden" }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not update", variant: "destructive" })
    }
  }

  async function onDelete(row: AffiliateLinkRow) {
    if (!confirm(`Delete "${nameOf(row)}"? Its short link ${GO_PREFIX}/${row.slug} will stop working, and the words linked to it stop being links.`)) return
    try {
      const res = await fetch(`/api/admin/affiliate-links/${row.id}`, { method: "DELETE", headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not delete")
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not delete", variant: "destructive" })
    }
  }

  const wordsOf = (id: string) => keywords.filter((k) => k.link_id === id)
  const total = links.length + searchOnly.length

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">Affiliate links</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              One list for every link you earn from. <b>ON</b> means it works and shows on your site. <b>OFF</b> hides it everywhere. Use{" "}
              <code className="rounded bg-muted px-1">{GO_PREFIX}/name</code> wherever you share a link, so changing the web address here fixes every copy.
            </p>
          </div>
          <Button size="lg" onClick={openNew}><Plus className="mr-2 h-4 w-4" /> Add a link</Button>
        </div>
      </div>

      <div className="container mx-auto space-y-6 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {!migrated && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            Photos, notes, page pins and search buttons need one new table in Supabase (file <code>supabase/migrations/0048_things_to_do.sql</code>). Until it is run, those parts stay empty.
          </div>
        )}

        {form && (
          <div ref={formRef}>
            <Card>
              <CardContent className="p-4">
                <form onSubmit={onSubmit} className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold">{form.id ? "Edit link" : "Add a link"}</h2>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setForm(null)}>
                      <X className="mr-1 h-3.5 w-3.5" /> Close
                    </Button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="name">Name *</Label>
                      <Input id="name" placeholder="What you call it, for example Viator" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="url">URL *</Label>
                      <Input id="url" placeholder="https://merchant.com/our-affiliate-link" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="category">Category</Label>
                      <select id="category" className={selectClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                        <option value="">No category</option>
                        {LINK_CATEGORIES.map((c) => <option key={c} value={c}>{LINK_CATEGORY_LABELS[c]}</option>)}
                      </select>
                      <p className="text-xs text-muted-foreground">Links in transport, stays, luggage, connectivity and insurance can appear in &ldquo;Plan the extras for your trip&rdquo; on upcoming trip pages.</p>
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
                  </div>

                  <div className="rounded-lg border">
                    <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
                      <span>Advanced: search button on guide pages</span>
                      <span className="text-xs text-muted-foreground">{advancedOpen ? "Hide" : "Show"}</span>
                    </button>
                    {advancedOpen && (
                      <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
                        <p className="text-sm text-muted-foreground sm:col-span-2">
                          Optional. When this link is ON and has a search link, every guide and destination page gets a &ldquo;Find tours and activities&rdquo; button for it. Leave these empty if you do not need that.
                        </p>
                        <div className="space-y-2">
                          <Label htmlFor="a-partner-id">Partner ID</Label>
                          <Input id="a-partner-id" placeholder="Your ID with this company (from their dashboard)" value={form.advanced.partner_code} onChange={(e) => setForm({ ...form, advanced: { ...form.advanced, partner_code: e.target.value } })} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="a-logo">Logo link</Label>
                          <Input id="a-logo" placeholder="https://... (optional)" value={form.advanced.logo_url} onChange={(e) => setForm({ ...form, advanced: { ...form.advanced, logo_url: e.target.value } })} />
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="a-template">Search link</Label>
                          <Input id="a-template" placeholder="https://partner-site.example/search?q={query}&pid={partner_id}" value={form.advanced.search_template} onChange={(e) => setForm({ ...form, advanced: { ...form.advanced, search_template: e.target.value } })} />
                          <p className="text-xs text-muted-foreground">{TEMPLATE_HELP}. Only https links work. Copy it from the company&rsquo;s dashboard.</p>
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="a-disclosure">Commission wording</Label>
                          <Input id="a-disclosure" placeholder={DEFAULT_DISCLOSURE} value={form.advanced.disclosure} onChange={(e) => setForm({ ...form, advanced: { ...form.advanced, disclosure: e.target.value } })} />
                          <p className="text-xs text-muted-foreground">Shown under the block. Leave empty to use: {DEFAULT_DISCLOSURE}</p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" size="lg" disabled={saving}>
                      {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      {form.id ? "Save changes" : "Add link"}
                    </Button>
                    <Button type="button" size="lg" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : total === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Link2 className="h-8 w-8" />
            <p>No affiliate links yet. Press &ldquo;Add a link&rdquo;.</p>
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-sm">
                  <caption className="px-4 py-3 text-left text-base font-semibold">Affiliate links</caption>
                  <thead className="border-y bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Where it goes</th>
                      <th className="px-4 py-2 font-medium">Category</th>
                      <th className="px-4 py-2 font-medium">Linked words</th>
                      <th className="px-4 py-2 font-medium">Clicks</th>
                      <th className="px-4 py-2 font-medium">ON / OFF</th>
                      <th className="px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((l) => {
                      const words = wordsOf(l.id)
                      return (
                        <tr key={l.id} className={`border-b align-top ${isOn(l.status) ? "" : "bg-muted/20"}`} data-link-row={l.slug}>
                          <td className="px-4 py-3">
                            <p className={`font-medium ${isOn(l.status) ? "" : "text-muted-foreground"}`}>{nameOf(l)}</p>
                            {(l.guide_kind && l.guide_slug) && <p className="text-xs text-muted-foreground">Shown on /{l.guide_kind}/{l.guide_slug}</p>}
                            {l.advanced?.search_template && <p className="text-xs text-muted-foreground">Has a search button{l.searchStatus && !isOn(l.status) && isOn(l.searchStatus) ? " (still ON: press OFF to switch it)" : ""}</p>}
                            {l.partnerAdopted && <p className="text-xs text-muted-foreground">Search button found by name; saved with this link next time you edit it</p>}
                          </td>
                          <td className="px-4 py-3">
                            <code className="rounded bg-muted px-1">{GO_PREFIX}/{l.slug}</code>
                            <p className="mt-0.5 text-xs text-muted-foreground" title={l.url}>{shortUrl(l.url)}</p>
                          </td>
                          <td className="px-4 py-3">
                            {isLinkCategory(l.category) ? <Badge variant="outline" className="text-[10px]" data-category={l.category}>{LINK_CATEGORY_LABELS[l.category]}</Badge> : <span className="text-xs text-muted-foreground">None</span>}
                          </td>
                          <td className="px-4 py-3">
                            {words.length === 0 ? (
                              <span className="text-xs text-muted-foreground">None</span>
                            ) : (
                              <div className="flex max-w-[260px] flex-wrap gap-1">
                                {words.map((k) => (
                                  <Badge key={k.id} variant={k.status === "on" && isOn(l.status) ? "secondary" : "outline"} className={`text-[11px] ${k.status === "on" && isOn(l.status) ? "" : "text-muted-foreground line-through"}`} title={k.status === "on" ? (isOn(l.status) ? "Linking now" : "Not linking: the link is OFF") : "Not linking: this phrase is OFF"}>
                                    {k.phrase}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground" title="last 7 days / last 30 days">
                            <p>{l.clicks.last7} in 7 days</p>
                            <p>{l.clicks.last30} in 30 days</p>
                            {l.searchClicks && l.searchClicks.total > 0 && <p title="clicks on the search button">search: {l.searchClicks.last7} / {l.searchClicks.last30}</p>}
                          </td>
                          <td className="px-4 py-3"><OnOff on={isOn(l.status)} label={`Turn ${nameOf(l)} on or off`} onChange={(on) => setOnOff(l, on)} /></td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              <Button type="button" variant="outline" onClick={() => openEdit(l)}><Pencil className="mr-1.5 h-4 w-4" /> Edit</Button>
                              <Button type="button" variant="outline" onClick={() => setFocus({ linkId: l.id, nonce: Date.now() })}><Type className="mr-1.5 h-4 w-4" /> Link a word</Button>
                              <Button type="button" variant="ghost" onClick={() => onDelete(l)} aria-label={`Delete ${nameOf(l)}`}><Trash2 className="h-4 w-4" /></Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {searchOnly.map((p) => (
                      <tr key={`s-${p.id}`} className="border-b align-top" data-search-only={p.slug}>
                        <td className="px-4 py-3"><p className="font-medium">{p.name}</p><p className="text-xs text-muted-foreground">Search button only</p></td>
                        <td className="px-4 py-3 text-xs text-muted-foreground" colSpan={3}>
                          This search button has no link in the list yet. Add a link named &ldquo;{p.slug}&rdquo; (same short name) and it joins that link automatically.
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{p.clicks.last7} in 7 days<br />{p.clicks.last30} in 30 days</td>
                        <td className="px-4 py-3"><OnOff on={isOn(p.status)} label={`Turn the ${p.name} search button on or off`} onChange={(on) => setSearchOnlyOnOff(p, on)} /></td>
                        <td className="px-4 py-3" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {pages.length > 0 && (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">Search button clicks by page</summary>
            <p className="my-2 text-xs text-muted-foreground">Clicks only, never money: commissions stay in each company&rsquo;s own dashboard.</p>
            <div className="rounded-lg border">
              {pages.map((p) => (
                <div key={p.key} className="flex items-center justify-between gap-3 border-t px-3 py-2 first:border-t-0">
                  <code className="truncate text-xs">/{p.key}</code>
                  <span className="text-xs text-muted-foreground">{p.total} clicks &middot; {p.last7} in 7d &middot; {p.last30} in 30d</span>
                </div>
              ))}
            </div>
          </details>
        )}

        <AffiliateWordLinker
          links={links.map((l) => ({ id: l.id, name: nameOf(l), slug: l.slug, on: isOn(l.status) }))}
          keywords={keywords}
          report={report}
          migrated={keywordsMigrated}
          focus={focus}
          onChanged={() => { loadKeywords(); load() }}
        />
      </div>
    </div>
  )
}
