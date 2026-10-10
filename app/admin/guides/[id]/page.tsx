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
  primary_keyword: string | null
  status: "draft" | "published"
  source: string
  quality_notes: string | null
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
            <Link href="/admin/destinations" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="h-4 w-4" />All guides</Link>
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
              <Button size="sm" disabled={busy} onClick={() => { if (!guide.quality_notes || confirm(`Notes on this guide:\n${guide.quality_notes}\n\nPublish it anyway?`)) act({ method: "PATCH", body: JSON.stringify({ status: "published" }) }, "Published") }}><Eye className="mr-1 h-4 w-4" />Publish</Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm(`Delete the guide "${guide.name}"? This cannot be undone.`)) act({ method: "DELETE" }, "Deleted", () => router.push("/admin/destinations")) }}><Trash2 className="mr-1 h-4 w-4" />Delete</Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto max-w-3xl space-y-8 px-4 py-6">
        <div className="space-y-1 rounded-lg border bg-muted/30 p-4 text-sm">
          <p><span className="font-medium">Review notes: </span>{guide.quality_notes || "The quality checks found nothing."}</p>
          <p className="text-xs text-muted-foreground">Will be at {publicPath}. Read every claim: the checks catch invented numbers, awards and ratings, but not every wrong fact. Meta title: {guide.meta_title}. Meta description: {guide.meta_description}. Main keyword: {guide.primary_keyword}.</p>
        </div>

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
