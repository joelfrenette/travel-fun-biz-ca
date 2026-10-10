"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Sparkles, Trash2, Eye, EyeOff, ExternalLink } from "lucide-react"

// The guide pages (destinations, hotels, resorts, cruise lines, ships, river cruises, yachts) in the admin.
// "card" is the small summary on the Autopilot page; "full" is the whole list on the Destinations page.
// Only types are shared with the server (no runtime import of lib/guides, which would pull the data layer
// into the browser bundle), so the kind list is repeated here.

const KINDS = [
  { kind: "destinations", label: "Destinations", prefix: "/destinations" },
  { kind: "hotels", label: "Hotels", prefix: "/hotels" },
  { kind: "resorts", label: "Resorts", prefix: "/resorts" },
  { kind: "cruise-lines", label: "Cruise lines", prefix: "/cruise-lines" },
  { kind: "ships", label: "Ships", prefix: "/ships" },
  { kind: "river-cruises", label: "River cruises", prefix: "/river-cruises" },
  { kind: "yachts", label: "Yachts", prefix: "/yachts" },
] as const

type Kind = (typeof KINDS)[number]["kind"]
const prefixOf = (kind: string) => KINDS.find((k) => k.kind === kind)?.prefix ?? `/${kind}`
const labelOf = (kind: string) => KINDS.find((k) => k.kind === kind)?.label ?? kind

interface GuideRow {
  id: string
  kind: Kind
  slug: string
  name: string
  status: "draft" | "published"
  source: "ai" | "manual"
  quality_notes: string | null
  created_at: string
}

interface Candidate {
  kind: Kind
  name: string
  slug: string
  parent_slug: string | null
  origin: "destination" | "package" | "seed"
}

interface Data {
  guides: GuideRow[]
  candidates: Candidate[]
  caps: { perDay: number; perWeek: number }
  usage: { today: number | null; week: number | null }
  counts: { kind: Kind; published: number; draft: number; candidates: number }[]
  failures: Record<string, { n: number; name: string; kind: string; last: string }>
  publishMode: "draft" | "publish"
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const ORIGIN_LABEL: Record<Candidate["origin"], string> = { destination: "a trip goes here", package: "from a package name, check it is really a hotel, ship or line", seed: "suggested name" }

export function GuidesPanel({ variant }: { variant: "card" | "full" }) {
  const { toast } = useToast()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<string>("")
  const [newKind, setNewKind] = useState<Kind>("hotels")
  const [newName, setNewName] = useState("")

  const load = useCallback(() => {
    fetch("/api/admin/guides", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load guides")
        setData(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load guides"))
  }, [])
  useEffect(() => { load() }, [load])

  async function call(key: string, url: string, init: RequestInit, okTitle: string) {
    setBusy(key)
    try {
      const res = await fetch(url, { ...init, headers: authHeaders() })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: okTitle, description: body.note })
      load()
      return body
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
      return null
    } finally {
      setBusy("")
    }
  }

  const setMode = (mode: "draft" | "publish") => call("mode", "/api/admin/guides", { method: "PATCH", body: JSON.stringify({ publishMode: mode }) }, mode === "draft" ? "Guides now wait for your review" : "Clean guides can now go live")
  const post = (key: string, payload: Record<string, unknown>, okTitle: string) => call(key, "/api/admin/guides", { method: "POST", body: JSON.stringify(payload) }, okTitle)
  const writeOne = (c: { kind: Kind; name: string; parent_slug?: string | null }) =>
    post(`write:${c.kind}:${c.name}`, { action: "write", kind: c.kind, name: c.name, parent_slug: c.parent_slug ?? undefined }, "Guide written")

  if (error) return <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
  if (!data) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  const capsControl = (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <label className="flex items-center gap-1.5">
        Per day
        <select className="h-8 rounded-md border bg-card px-2 text-sm" value={data.caps.perDay} disabled={!!busy} onChange={(e) => post("caps", { action: "caps", perDay: Number(e.target.value), perWeek: data.caps.perWeek }, "Saved")} aria-label="Guides per day">
          {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? "Off" : n}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        Per week
        <select className="h-8 rounded-md border bg-card px-2 text-sm" value={data.caps.perWeek} disabled={!!busy} onChange={(e) => post("caps", { action: "caps", perDay: data.caps.perDay, perWeek: Number(e.target.value) }, "Saved")} aria-label="Guides per week">
          {[0, 1, 2, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n === 0 ? "Off" : n}</option>)}
        </select>
      </label>
      <span>
        Used: {data.usage.today ?? "?"} today, {data.usage.week ?? "?"} in the last 7 days
      </span>
    </div>
  )

  const modeControl = (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
      <p className="min-w-[240px] flex-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{data.publishMode === "draft" ? "Review mode (recommended at first): " : "Publish mode: "}</span>
        {data.publishMode === "draft"
          ? "every new guide is saved as a draft and nothing goes live until you open it and click Publish."
          : "a guide that passes every check goes live by itself, but only destination and cruise line guides. Hotel, resort, ship, river cruise and yacht guides always wait for you."}
      </p>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setMode(data.publishMode === "draft" ? "publish" : "draft")}>
        {busy === "mode" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{data.publishMode === "draft" ? "Switch to publish mode" : "Switch back to review mode"}
      </Button>
    </div>
  )

  const countsLine = (
    <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {data.counts.map((c) => (
        <li key={c.kind} className="flex justify-between gap-3">
          <span>{labelOf(c.kind)}</span>
          <span className="text-muted-foreground">{c.published} live, {c.draft} draft, {c.candidates} ideas</span>
        </li>
      ))}
    </ul>
  )

  if (variant === "card") {
    const next = data.candidates.filter((c) => c.origin !== "package" && !(data.failures[`${c.kind}:${c.slug}`]?.n >= 2)).slice(0, 5)
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Guide pages</h2>
              <p className="text-xs text-muted-foreground">Destination, hotel, resort, cruise line, ship, river cruise and yacht pages for Google. The pipeline writes a few a week, within the caps below, and publishes one only when it passes the checks (no invented numbers, awards or ratings).</p>
            </div>
            <Button size="sm" disabled={!!busy} onClick={() => post("next", { action: "write-next" }, "Guide written")} title="Writes the next guide in the rotation right now. Ignores the daily and weekly caps. Takes up to two minutes.">
              {busy === "next" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}Write one guide now
            </Button>
          </div>
          {modeControl}
          {countsLine}
          {capsControl}
          {next.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Next ideas: </span>
              {next.map((c) => `${c.name} (${labelOf(c.kind).toLowerCase()})`).join(", ")}
            </div>
          )}
          <Link href="/admin/destinations" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Manage every guide <ExternalLink className="h-3 w-3" /></Link>
        </CardContent>
      </Card>
    )
  }

  // full
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="font-semibold">Guide pages</h2>
          <p className="text-xs text-muted-foreground">
            A guide is written from general travel knowledge plus your real trips. It goes live by itself only if it passes the checks; otherwise it is saved as a draft with the reasons. Read a draft on its page
            before you publish it. Nothing here is visible to visitors until it is published.
          </p>
          {modeControl}
          {countsLine}
          {capsControl}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="text-sm font-semibold">Write a guide by name</h3>
          <p className="text-xs text-muted-foreground">A name that has failed twice is skipped, so it cannot keep spending AI credits. Click Dismiss on the Needs attention item on the Autopilot page to try it again.</p>
          <div className="flex flex-wrap gap-2">
            <select className="h-9 rounded-md border bg-card px-3 text-sm" value={newKind} onChange={(e) => setNewKind(e.target.value as Kind)} aria-label="Kind of guide">
              {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
            <Input className="h-9 w-64" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name, for example Sandals Resorts" aria-label="Guide name" />
            <Button size="sm" disabled={!!busy || newName.trim().length < 2} onClick={async () => { if (await writeOne({ kind: newKind, name: newName.trim() })) setNewName("") }}>
              {busy.startsWith(`write:${newKind}:${newName.trim()}`) ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}Write it
            </Button>
          </div>
        </CardContent>
      </Card>

      {Object.keys(data.failures).length > 0 && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          {Object.values(data.failures).map((f) => <p key={`${f.kind}:${f.name}`}>{f.name} ({labelOf(f.kind).toLowerCase()}): failed {f.n} time{f.n === 1 ? "" : "s"}. {f.last}</p>)}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="p-4"><h3 className="text-sm font-semibold">Written guides ({data.guides.length})</h3></div>
          {data.guides.length === 0 ? (
            <p className="border-t p-4 text-sm text-muted-foreground">None yet. Write one below, or turn Autopilot on and the pipeline writes a few a week.</p>
          ) : (
            data.guides.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 border-t p-4">
                <div className="min-w-[220px] flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {g.name}
                    <Badge variant="outline" className="text-[10px] uppercase">{labelOf(g.kind)}</Badge>
                    <Badge variant={g.status === "published" ? "default" : "secondary"}>{g.status === "published" ? "Live" : "Draft"}</Badge>
                    <Badge variant="outline" className="text-[10px]">{g.source === "ai" ? "AI-written" : "Manual"}</Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">{prefixOf(g.kind)}/{g.slug}</p>
                  {g.quality_notes && <p className="text-xs text-destructive">Held back: {g.quality_notes}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {g.status === "published" ? (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => call(`s:${g.id}`, `/api/admin/guides/${g.id}`, { method: "PATCH", body: JSON.stringify({ status: "draft" }) }, "Unpublished")}>
                      {busy === `s:${g.id}` ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <EyeOff className="mr-1 h-4 w-4" />}Unpublish
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { if (!g.quality_notes || confirm(`The checks held this guide back:\n${g.quality_notes}\n\nPublish it anyway?`)) call(`s:${g.id}`, `/api/admin/guides/${g.id}`, { method: "PATCH", body: JSON.stringify({ status: "published" }) }, "Published") }}>
                      {busy === `s:${g.id}` ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}Publish
                    </Button>
                  )}
                  <Button size="sm" variant="outline" asChild><Link href={`/admin/guides/${g.id}`}><Eye className="mr-1 h-4 w-4" />Preview</Link></Button>
                  {g.status === "published" && (
                    <Button size="sm" variant="ghost" asChild><a href={`${prefixOf(g.kind)}/${g.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1 h-4 w-4" />View</a></Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (confirm(`Delete the guide "${g.name}"? This cannot be undone.`)) call(`d:${g.id}`, `/api/admin/guides/${g.id}`, { method: "DELETE" }, "Deleted") }}>
                    {busy === `d:${g.id}` ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}Delete
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="p-4"><h3 className="text-sm font-semibold">Ideas not written yet ({data.candidates.length})</h3></div>
          {data.candidates.length === 0 ? (
            <p className="border-t p-4 text-sm text-muted-foreground">Every idea has a guide.</p>
          ) : (
            data.candidates.map((c) => {
              const key = `write:${c.kind}:${c.name}`
              const failed = data.failures[`${c.kind}:${c.slug}`]
              return (
                <div key={`${c.kind}:${c.slug}`} className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
                  <div className="min-w-[220px] flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {c.name}
                      <Badge variant="outline" className="text-[10px] uppercase">{labelOf(c.kind)}</Badge>
                      <span className="text-xs font-normal text-muted-foreground">{ORIGIN_LABEL[c.origin]}</span>
                    </p>
                    {failed && <p className="text-xs text-destructive">Failed {failed.n} time{failed.n === 1 ? "" : "s"}: {failed.last}</p>}
                  </div>
                  <Button size="sm" variant="outline" disabled={!!busy || (failed?.n ?? 0) >= 2} title={(failed?.n ?? 0) >= 2 ? "Failed twice. Dismiss it on the Autopilot page to try again." : undefined} onClick={() => writeOne(c)}>
                    {busy === key ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}Write
                  </Button>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}
