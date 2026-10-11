"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { supabase } from "@/integrations/supabase/client"
import { Loader2, Upload, Link as LinkIcon, FileText, Image as ImageIcon, ClipboardPaste, Trash2, Undo2, ChevronDown, ChevronRight, ExternalLink } from "lucide-react"

// The "Add details" card on a trip's editor (growth loop WP11). Drop a screenshot or PDF, add a link or paste
// text; the site reads it, fills the empty parts of the trip page, and shows every field with its evidence.
// Only types and plain data cross to the server (nothing from lib/package-enrich is imported at runtime).

const BUCKET = "package-sources"
/** A request to the server is limited to about 4.5 MB on Vercel, so bigger files go straight to storage. */
const SERVER_UPLOAD_MAX = 4 * 1024 * 1024

interface FieldChange {
  field: string
  current: unknown
  proposed: unknown
  evidence: string | null
  autoApply: boolean
  reason: string
  held?: boolean
}
interface PackageEdit { field: string; before: unknown; after: unknown; method: "auto" | "click"; at: string; reverted?: boolean }
interface SourceItem {
  id: string
  kind: "screenshot" | "pdf" | "url" | "text"
  file_name: string | null
  source_url: string | null
  status: "uploaded" | "extracted" | "applied" | "failed"
  error: string | null
  created_at: string
  text_chars: number
  applied_fields: string[]
  package_edits: PackageEdit[]
  extracted_fields: { draft?: { dropped?: { field: string; value: string; reason: string }[]; missing?: string[] }; proposal?: { facts?: FieldChange[]; copy?: FieldChange[]; copyNote?: string | null } } | null
  input_tokens: number | null
  output_tokens: number | null
  model_calls: number
  cost_usd: number
  preview_url: string | null
}
interface Completeness { score: number; reasons: string[]; thin: boolean }

const FIELD_LABEL: Record<string, string> = {
  destination: "Destination", country: "Country", region: "Region", supplier: "Supplier", duration: "Duration", duration_days: "Length in days",
  price_display: "Price shown", price_value: "Price number", currency: "Currency", available_from: "First date", available_to: "Last date",
  departure_dates: "Departure dates", price_includes: "What is included", not_included: "What is not included", max_people: "Largest group",
  booking_url: "Booking link", more_info_url: "More info link", category: "Category", itinerary: "Itinerary", full_description: "Full description",
  highlights: "Highlights", meta_title: "Search title", meta_description: "Search description", keywords: "Keywords",
}

function authHeaders(json = true): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

function show(value: unknown): string {
  if (value == null || value === "") return "(empty)"
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)"
    return value
      .map((v) => {
        if (v && typeof v === "object") {
          const o = v as { day?: number | null; title?: string; description?: string }
          return `${o.day != null ? `Day ${o.day}: ` : ""}${o.title ?? ""}${o.description ? `. ${o.description}` : ""}`
        }
        return String(v)
      })
      .join("\n")
  }
  return String(value)
}

function Pill({ c }: { c: Completeness }) {
  const tone = c.thin ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" : c.score < 80 ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{c.thin ? "Thin page" : c.score < 80 ? "Getting there" : "Full page"}: {c.score}/100</span>
}

const KIND_LABEL = { screenshot: "Screenshot", pdf: "PDF", url: "Link", text: "Pasted text" } as const
const STATUS_LABEL = { uploaded: "Added, not read yet", extracted: "Read, nothing filled in", applied: "Details filled in", failed: "Could not read" } as const

export function PackageSourcesPanel({ packageId, onChanged }: { packageId: string; onChanged?: () => void }) {
  const { toast } = useToast()
  const [sources, setSources] = useState<SourceItem[]>([])
  const [completeness, setCompleteness] = useState<Completeness | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [url, setUrl] = useState("")
  const [text, setText] = useState("")
  const [open, setOpen] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/packages/${packageId}/sources`, { headers: authHeaders(false) })
      const body = await res.json().catch(() => ({}))
      if (body.completeness) setCompleteness(body.completeness)
      if (!res.ok) throw new Error(body.error || `Could not load sources (HTTP ${res.status})`)
      setSources(body.sources ?? [])
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sources")
    }
  }, [packageId])

  useEffect(() => {
    load()
  }, [load])

  async function call(path: string, init: RequestInit, label: string) {
    const res = await fetch(`/api/admin/packages/${packageId}/sources${path}`, init)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `${label} failed (HTTP ${res.status})`)
    return body
  }

  async function extract(id: string) {
    setBusy(`extract:${id}`)
    try {
      const r = await call(`/${id}/extract`, { method: "POST", headers: authHeaders() }, "Reading the source")
      const n = (r.applied ?? []).length
      toast({ title: n ? `Filled in ${n} part${n === 1 ? "" : "s"} of the trip page` : "Read the source", description: n ? (r.applied as string[]).map((f) => FIELD_LABEL[f] ?? f).join(", ") : "Nothing was filled in automatically. Open Review to see what was found." })
      setOpen(id)
      onChanged?.()
    } catch (e) {
      toast({ title: "Could not read that source", description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
    } finally {
      setBusy("")
      load()
    }
  }

  /** Adds a source and reads it straight away: pressing Add is the admin's go-ahead for the one AI call. */
  async function addAndRead(add: () => Promise<{ source: { id: string } }>) {
    setBusy("add")
    try {
      const r = await add()
      await load()
      setBusy("")
      await extract(r.source.id)
    } catch (e) {
      toast({ title: "Could not add that", description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
      setBusy("")
      load()
    }
  }

  async function addFile(file: File) {
    await addAndRead(async () => {
      if (file.size <= SERVER_UPLOAD_MAX) {
        const form = new FormData()
        form.append("file", file)
        return call("", { method: "POST", headers: authHeaders(false), body: form }, "Upload")
      }
      const prep = await call("", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "upload-url" }) }, "Preparing the upload")
      const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || undefined })
      if (up.error) throw new Error(up.error.message)
      return call("", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "register", path: prep.path, name: file.name }) }, "Adding the file")
    })
  }

  async function apply(id: string, fields: string[]) {
    setBusy(`apply:${id}`)
    try {
      const r = await call(`/${id}/apply`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ fields }) }, "Applying")
      toast({ title: "Trip page updated", description: (r.applied as string[]).map((f) => FIELD_LABEL[f] ?? f).join(", ") || "Nothing changed" })
      onChanged?.()
    } catch (e) {
      toast({ title: "Could not apply that", description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
    } finally {
      setBusy("")
      load()
    }
  }

  async function revert(id: string) {
    if (!confirm("Put back everything this source changed on the trip page?")) return
    setBusy(`revert:${id}`)
    try {
      const r = await call(`/${id}/revert`, { method: "POST", headers: authHeaders() }, "Reverting")
      const left = (r.skipped ?? []) as { field: string; reason: string }[]
      toast({ title: `Put back ${(r.reverted ?? []).length} part${(r.reverted ?? []).length === 1 ? "" : "s"}`, description: left.length ? `Left alone because you changed them since: ${left.map((s) => FIELD_LABEL[s.field] ?? s.field).join(", ")}` : undefined })
      onChanged?.()
    } catch (e) {
      toast({ title: "Could not revert", description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
    } finally {
      setBusy("")
      load()
    }
  }

  async function remove(s: SourceItem) {
    const live = s.package_edits.filter((e) => !e.reverted).length
    const ask = live
      ? `This source changed ${live} part${live === 1 ? "" : "s"} of the trip page. Put those back and delete the source?`
      : "Delete this source and its stored file?"
    if (!confirm(ask)) return
    setBusy(`delete:${s.id}`)
    try {
      await call(`/${s.id}${live ? "?revert=1" : ""}`, { method: "DELETE", headers: authHeaders(false) }, "Delete")
      if (live) onChanged?.()
    } catch (e) {
      toast({ title: "Could not delete", description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
    } finally {
      setBusy("")
      load()
    }
  }

  const working = busy !== ""

  return (
    <Card className="mx-auto mb-6 max-w-4xl">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" />Add details</CardTitle>
          {completeness && <Pill c={completeness} />}
        </div>
        <CardDescription>
          Drop a screenshot of a Facebook post or event, a supplier PDF, a link, or paste text. The site reads it and fills in the parts of this trip page that are empty. It never changes something that is already filled in unless you click Replace, and every change can be put back.
          {completeness && completeness.reasons.length > 0 && <span className="mt-1 block text-xs">Missing: {completeness.reasons.join("; ")}.</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f && !working) addFile(f) }}
          onClick={() => !working && fileInput.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors ${dragging ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/60"} ${working ? "opacity-60" : ""}`}
        >
          {busy === "add" ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6 text-muted-foreground" />}
          <p className="font-medium">Drop a screenshot or PDF here, or click to choose one</p>
          <p className="text-xs text-muted-foreground">PNG, JPG, WebP or PDF, up to 10 MB (PDFs up to 30 pages, up to 5 screenshots per trip). It is read right away: one AI read, a few cents.</p>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) addFile(f) }}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-medium"><LinkIcon className="h-4 w-4" />A link to the trip</p>
            <div className="flex gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://supplier.example.com/trip" disabled={working} />
              <Button disabled={working || !url.trim()} onClick={() => addAndRead(async () => { const r = await call("", { method: "POST", headers: authHeaders(), body: JSON.stringify({ url }) }, "Adding the link"); setUrl(""); return r })}>Read it</Button>
            </div>
            <p className="text-xs text-muted-foreground">Facebook and Instagram links need a login and cannot be read. Use a screenshot instead.</p>
          </div>
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-medium"><ClipboardPaste className="h-4 w-4" />Or paste the text</p>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Paste a supplier email, a flyer, or the words of a post" disabled={working} />
            <Button disabled={working || text.trim().length < 40} onClick={() => addAndRead(async () => { const r = await call("", { method: "POST", headers: authHeaders(), body: JSON.stringify({ text }) }, "Adding the text"); setText(""); return r })}>Read it</Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Sources for this trip ({sources.length})</p>
          {sources.length === 0 && <p className="text-sm text-muted-foreground">Nothing added yet.</p>}
          {sources.map((s) => {
            const live = s.package_edits.filter((e) => !e.reverted)
            const proposal = s.extracted_fields?.proposal
            const changes = [...(proposal?.facts ?? []), ...(proposal?.copy ?? [])]
            const isOpen = open === s.id
            const Icon = s.kind === "pdf" ? FileText : s.kind === "screenshot" ? ImageIcon : s.kind === "url" ? LinkIcon : ClipboardPaste
            return (
              <div key={s.id} className="rounded-md border">
                <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-[180px] flex-1">
                    <p className="font-medium">{KIND_LABEL[s.kind]}{s.file_name ? `: ${s.file_name}` : s.source_url ? `: ${s.source_url}` : ""}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(s.created_at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}
                      {s.model_calls > 0 && s.input_tokens != null ? ` | ${(s.input_tokens + (s.output_tokens ?? 0)).toLocaleString("en-CA")} tokens, about $${s.cost_usd.toFixed(2)} (estimate)` : ""}
                    </p>
                  </div>
                  <Badge variant={s.status === "failed" ? "destructive" : s.status === "applied" ? "default" : "secondary"}>{STATUS_LABEL[s.status]}</Badge>
                  <div className="flex flex-wrap gap-1">
                    {(s.status === "uploaded" || s.status === "failed") && (
                      <Button size="sm" disabled={working} onClick={() => extract(s.id)}>{busy === `extract:${s.id}` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}{s.status === "failed" ? "Try again" : "Read it"}</Button>
                    )}
                    {changes.length > 0 && (
                      <Button size="sm" variant="outline" onClick={() => setOpen(isOpen ? null : s.id)}>{isOpen ? <ChevronDown className="mr-1 h-3.5 w-3.5" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}Review</Button>
                    )}
                    {s.preview_url && <Button size="sm" variant="ghost" asChild><a href={s.preview_url} target="_blank" rel="noopener noreferrer" title="Opens for 60 seconds"><ExternalLink className="mr-1 h-3.5 w-3.5" />View</a></Button>}
                    {live.length > 0 && <Button size="sm" variant="outline" disabled={working} onClick={() => revert(s.id)}>{busy === `revert:${s.id}` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Undo2 className="mr-1 h-3.5 w-3.5" />}Revert its changes</Button>}
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={working} onClick={() => remove(s)}><Trash2 className="mr-1 h-3.5 w-3.5" />{live.length ? "Revert and delete" : "Delete"}</Button>
                  </div>
                </div>
                {s.error && <p className="border-t px-3 py-2 text-xs text-destructive">{s.error}</p>}
                {isOpen && (
                  <div className="space-y-3 border-t p-3">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-left text-muted-foreground"><tr><th className="p-2">Part of the page</th><th className="p-2">On the page when read</th><th className="p-2">Found in the source</th><th className="p-2">What happened</th></tr></thead>
                        <tbody className="divide-y">
                          {changes.map((c) => {
                            const edit = live.find((e) => e.field === c.field)
                            const hadValue = !(c.current == null || c.current === "" || (Array.isArray(c.current) && c.current.length === 0))
                            return (
                              <tr key={c.field} className="align-top">
                                <td className="p-2 font-medium">{FIELD_LABEL[c.field] ?? c.field}</td>
                                <td className="max-w-[200px] whitespace-pre-line break-words p-2 text-muted-foreground">{show(c.current)}</td>
                                <td className="max-w-[280px] whitespace-pre-line break-words p-2">
                                  {show(c.proposed)}
                                  {c.evidence && <span className="mt-1 block text-muted-foreground">Source says: &ldquo;{c.evidence}&rdquo;</span>}
                                </td>
                                <td className="max-w-[240px] p-2">
                                  {edit ? (
                                    <Badge variant="default">{edit.method === "auto" ? "Applied automatically" : "Applied by you"}</Badge>
                                  ) : c.held ? (
                                    <><Badge variant="destructive">Held back</Badge><span className="mt-1 block text-muted-foreground">{c.reason}</span></>
                                  ) : (
                                    <>
                                      <span className="block text-muted-foreground">{c.reason}</span>
                                      <Button size="sm" variant="outline" className="mt-1" disabled={working} onClick={() => apply(s.id, [c.field])}>{busy === `apply:${s.id}` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}{hadValue ? "Replace" : "Use this"}</Button>
                                    </>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {proposal?.copyNote && <p className="text-xs text-muted-foreground">{proposal.copyNote}</p>}
                    {(s.extracted_fields?.draft?.dropped?.length ?? 0) > 0 && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Left out because it was not in the source ({s.extracted_fields!.draft!.dropped!.length})</summary>
                        <ul className="ml-4 mt-1 list-disc">{s.extracted_fields!.draft!.dropped!.map((d, i) => <li key={i}>{FIELD_LABEL[d.field] ?? d.field}: {d.value} ({d.reason})</li>)}</ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">Changes are saved on the trip right away. The form below reloads after a change, so save anything you typed there first. FAQs and gallery photos are not filled in from a source: use the buttons in the form.</p>
      </CardContent>
    </Card>
  )
}
