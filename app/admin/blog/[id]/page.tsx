"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Save, Upload, ExternalLink } from "lucide-react"
import type { Post, PostInput } from "@/lib/posts"
import { generateSlug } from "@/lib/utils"
import { renderMarkdown, readingTimeMinutes } from "@/lib/markdown"

function authHeaders(json = true): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

const emptyForm: PostInput = { title: "", slug: "", body: "", cover_image_url: "", tags: [], status: "draft", publish_date: null, meta_title: "", meta_description: "" }

export default function BlogEditPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const isNew = params.id === "new"

  const [form, setForm] = useState<PostInput>(emptyForm)
  const [slugTouched, setSlugTouched] = useState(false)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (isNew) return
    fetch("/api/admin/blog", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        const post: Post | undefined = (data.posts || []).find((p: Post) => p.id === params.id)
        if (!post) throw new Error("Post not found")
        setForm(post)
        setSlugTouched(true)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [isNew, params.id])

  function setTitle(title: string) {
    setForm((f) => ({ ...f, title, slug: slugTouched ? f.slug : generateSlug(title) }))
  }

  const preview = useMemo(() => renderMarkdown(form.body || ""), [form.body])
  const minutes = useMemo(() => readingTimeMinutes(form.body || ""), [form.body])

  async function save() {
    setSaving(true); setError("")
    try {
      const payload = { ...form, tags: Array.isArray(form.tags) ? form.tags : [] }
      const res = isNew
        ? await fetch("/api/admin/blog", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) })
        : await fetch(`/api/admin/blog/${params.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(payload) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      router.push("/admin/blog")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  async function uploadCover(file: File) {
    setUploading(true); setError("")
    try {
      const body = new FormData()
      body.append("file", file)
      const res = await fetch("/api/admin/upload-image", { method: "POST", headers: authHeaders(false), body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setForm((f) => ({ ...f, cover_image_url: data.url }))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  if (loading) return <div className="flex justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <h1 className="text-xl font-bold">{isNew ? "New Post" : "Edit Post"}</h1>
          <div className="flex items-center gap-2">
            {!isNew && form.status === "published" && form.slug && (
              <Button variant="outline" asChild>
                <a href={`/blog/${form.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />View live</a>
              </Button>
            )}
            <Button onClick={save} disabled={saving || !form.title?.trim() || !form.slug?.trim()}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}Save
            </Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
              <Label>Title</Label>
              <Input value={form.title || ""} onChange={(e) => setTitle(e.target.value)} placeholder="10 Reasons a Group Cruise Beats a Solo Trip" />
            </div>
            <div className="space-y-1.5 lg:col-span-2">
              <Label>Slug</Label>
              <Input value={form.slug || ""} onChange={(e) => { setSlugTouched(true); setForm((f) => ({ ...f, slug: generateSlug(e.target.value) })) }} />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status || "draft"} onValueChange={(v) => setForm((f) => ({ ...f, status: v as "draft" | "published" }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Publish date</Label>
              <Input type="date" value={form.publish_date || ""} onChange={(e) => setForm((f) => ({ ...f, publish_date: e.target.value || null }))} />
              <p className="text-xs text-muted-foreground">Blank publishes immediately once status is Published.</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Tags (comma separated)</Label>
              <Input
                value={(form.tags || []).join(", ")}
                onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }))}
                placeholder="cruises, singles travel"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
              <Label>Cover image</Label>
              <div className="flex flex-wrap items-center gap-3">
                {form.cover_image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.cover_image_url} alt="" className="h-16 w-28 rounded border object-cover" />
                )}
                <Input className="max-w-sm" value={form.cover_image_url || ""} onChange={(e) => setForm((f) => ({ ...f, cover_image_url: e.target.value }))} placeholder="https://... or upload a file" />
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Upload
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" disabled={uploading} onChange={(e) => e.target.files?.[0] && uploadCover(e.target.files[0])} />
                </label>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <Label>Body (Markdown)</Label>
                <span className="text-xs text-muted-foreground">{minutes} min read</span>
              </div>
              <Textarea
                rows={22}
                className="font-mono text-sm"
                value={form.body || ""}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                placeholder={"## A great trip starts here\n\nWrite in **Markdown**: headings, *emphasis*, [links](https://example.com), lists, and images."}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <Label className="mb-2 block">Live preview</Label>
              <div className="markdown-body rounded-md border p-4 text-sm" dangerouslySetInnerHTML={{ __html: preview || "<p class='text-muted-foreground'>Nothing to preview yet.</p>" }} />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Meta title (SEO, optional)</Label>
              <Input value={form.meta_title || ""} onChange={(e) => setForm((f) => ({ ...f, meta_title: e.target.value }))} placeholder="Defaults to the post title" />
            </div>
            <div className="space-y-1.5">
              <Label>Meta description (SEO, optional)</Label>
              <Input value={form.meta_description || ""} onChange={(e) => setForm((f) => ({ ...f, meta_description: e.target.value }))} placeholder="Defaults to the first line of the post" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
