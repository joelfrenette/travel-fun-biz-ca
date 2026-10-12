"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { GuideTakeaways, GuideArticle, GuideFaqList } from "@/components/guide-parts"
import { Loader2, Eye, EyeOff, Trash2, ExternalLink, ArrowLeft } from "lucide-react"

// Draft preview: read a guide (draft or live) exactly as visitors will see its content, with the reasons the
// quality gate gave, before deciding to publish. The same components render the public page. Access works like
// every other admin page: the admin token in the browser, checked by the API route (isAuthorized).

interface PreviewGuide {
  id: string
  kind: string
  slug: string
  name: string
  summary: string
  body: string
  faq: { q: string; a: string }[]
  key_takeaways: string[]
  hero_image_url: string | null
  hero_alt: string | null
  meta_title: string | null
  meta_description: string | null
  og_title: string | null
  og_description: string | null
  primary_keyword: string | null
  parent_slug: string | null
  scope?: string | null
  review_state?: "rejected" | null
  status: "draft" | "published"
  source: string
  quality_notes: string | null
}

const SCOPES = ["country", "region", "city", "port", "supplier", "property", "line", "ship", "class"]

/** The details that can be changed on this screen. Text changes are logged, so the Content edits screen can Undo them. */
function DetailsEditor({ guide, busy, onSave }: { guide: PreviewGuide; busy: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const [scope, setScope] = useState(guide.scope ?? "")
  const [parent, setParent] = useState(guide.parent_slug ?? "")
  const [metaTitle, setMetaTitle] = useState(guide.meta_title ?? "")
  const [metaDescription, setMetaDescription] = useState(guide.meta_description ?? "")
  const [ogTitle, setOgTitle] = useState(guide.og_title ?? "")
  const [ogDescription, setOgDescription] = useState(guide.og_description ?? "")
  const save = () => {
    const patch: Record<string, unknown> = {}
    if (scope !== (guide.scope ?? "")) patch.scope = scope || null
    if (parent.trim() !== (guide.parent_slug ?? "")) patch.parent_slug = parent.trim() || null
    if (metaTitle !== (guide.meta_title ?? "")) patch.meta_title = metaTitle
    if (metaDescription !== (guide.meta_description ?? "")) patch.meta_description = metaDescription
    if (ogTitle !== (guide.og_title ?? "")) patch.og_title = ogTitle
    if (ogDescription !== (guide.og_description ?? "")) patch.og_description = ogDescription
    if (Object.keys(patch).length === 0) return
    onSave(patch)
  }
  return (
    <details className="rounded-lg border p-4 text-sm">
      <summary className="cursor-pointer font-medium">Edit details (scope, parent, search and share text)</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Scope (how wide the page is)</span>
          <select className="h-9 w-full rounded-md border bg-card px-2" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Not set (worked out from the name)</option>
            {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Sits under (the web address name of the page above it, for example italy)</span>
          <input className="h-9 w-full rounded-md border bg-card px-2" value={parent} onChange={(e) => setParent(e.target.value)} />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-xs text-muted-foreground">Search title (up to 70 characters)</span>
          <input className="h-9 w-full rounded-md border bg-card px-2" value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-xs text-muted-foreground">Search description (up to 200 characters)</span>
          <textarea className="w-full rounded-md border bg-card p-2" rows={2} value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Share title</span>
          <input className="h-9 w-full rounded-md border bg-card px-2" value={ogTitle} onChange={(e) => setOgTitle(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Share description</span>
          <input className="h-9 w-full rounded-md border bg-card px-2" value={ogDescription} onChange={(e) => setOgDescription(e.target.value)} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy} onClick={save}>Save changes</Button>
        <span className="text-xs text-muted-foreground">No dashes, no web addresses. Text changes can be undone on the Content edits screen.</span>
      </div>
    </details>
  )
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export default function GuidePreviewPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const { toast } = useToast()
  const [guide, setGuide] = useState<PreviewGuide | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetch(`/api/admin/guides/${params.id}`, { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load the guide")
        setGuide(body.guide)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the guide"))
  }, [params.id])
  useEffect(() => { load() }, [load])

  async function act(init: RequestInit, okTitle: string, after?: () => void) {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/guides/${params.id}`, { ...init, headers: authHeaders() })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: okTitle })
      if (after) after()
      else load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="p-6 text-destructive">{error}</div>
  if (!guide) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const publicPath = `/${guide.kind}/${guide.slug}`

  return (
    <div>
      <div className="sticky top-0 z-10 border-b bg-card">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/admin/guides" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="h-4 w-4" />All pages</Link>
            <span className="font-semibold">{guide.name}</span>
            <Badge variant={guide.status === "published" ? "default" : "secondary"}>{guide.status === "published" ? "Live" : "Draft"}</Badge>
            <Badge variant="outline" className="text-[10px]">{guide.source === "ai" ? "AI-written" : "Manual"}</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {guide.status === "published" ? (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ method: "PATCH", body: JSON.stringify({ status: "draft" }) }, "Unpublished")}><EyeOff className="mr-1 h-4 w-4" />Unpublish</Button>
                <Button size="sm" variant="ghost" asChild><a href={publicPath} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1 h-4 w-4" />View live</a></Button>
              </>
            ) : (
              <>
                <Button size="sm" disabled={busy} onClick={() => { if (!guide.quality_notes || confirm(`Notes on this guide:\n${guide.quality_notes}\n\nPublish it anyway?`)) act({ method: "PATCH", body: JSON.stringify({ status: "published" }) }, "Published") }}><Eye className="mr-1 h-4 w-4" />Publish</Button>
                {guide.review_state === "rejected" ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ method: "PATCH", body: JSON.stringify({ review_state: null }) }, "Back in the review queue")}>Put back in the queue</Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ method: "PATCH", body: JSON.stringify({ review_state: "rejected" }) }, "Rejected", () => router.push("/admin/guides?status=review"))}>Reject</Button>
                )}
              </>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm(`Delete the guide "${guide.name}"? This cannot be undone.`)) act({ method: "DELETE" }, "Deleted", () => router.push("/admin/guides")) }}><Trash2 className="mr-1 h-4 w-4" />Delete</Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto max-w-3xl space-y-8 px-4 py-6">
        <div className="space-y-1 rounded-lg border bg-muted/30 p-4 text-sm">
          <p><span className="font-medium">Review notes: </span>{guide.quality_notes || "The quality checks found nothing."}</p>
          <p className="text-xs text-muted-foreground">Will be at {publicPath}. Read every claim: the checks catch invented numbers, awards and ratings, but not every wrong fact. Meta title: {guide.meta_title}. Meta description: {guide.meta_description}. Main keyword: {guide.primary_keyword}.</p>
        </div>

        <DetailsEditor key={`${guide.id}:${guide.meta_title}:${guide.meta_description}:${guide.scope}:${guide.parent_slug}:${guide.og_title}:${guide.og_description}`} guide={guide} busy={busy} onSave={(patch) => act({ method: "PATCH", body: JSON.stringify(patch) }, "Saved")} />

        <header>
          <h1 className="text-balance text-3xl font-bold text-foreground">{guide.name}</h1>
          <p className="mt-3 text-lg text-foreground">{guide.summary}</p>
        </header>
        {guide.hero_image_url && (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={guide.hero_image_url} alt={guide.hero_alt || guide.name} className="aspect-[16/9] w-full rounded-xl object-cover" />
            <figcaption className="mt-1.5 text-xs text-muted-foreground">Illustrative stock photo.</figcaption>
          </figure>
        )}
        <GuideTakeaways guide={guide} />
        <GuideArticle guide={guide} />
        <GuideFaqList guide={guide} />
      </div>
    </div>
  )
}
