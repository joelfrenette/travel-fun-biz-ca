"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Save, Upload, ExternalLink, Search, Copy, Check, Share2 } from "lucide-react"
import type { Post, PostInput } from "@/lib/posts"
import { generateSlug } from "@/lib/utils"
import { renderMarkdown, readingTimeMinutes } from "@/lib/markdown"
import { buildSyndicationKit } from "@/lib/syndication"

function authHeaders(json = true): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

const emptyForm: PostInput = { title: "", slug: "", body: "", cover_image_url: "", alt_text: "", tags: [], status: "draft", publish_date: null, meta_title: "", meta_description: "" }

// Syndication kit (roadmap 93f89574): a copy-paste-ready version of the already-published post
// for LinkedIn, Substack and Medium. Nothing here calls an API or posts anything - it's the same
// real published text, repackaged, so there's no fabrication risk to review beyond the post
// itself already being correct.
function CopyBlock({ label, text, hint }: { label: string; text: string; hint?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can fail (permissions, non-secure context) - the textarea below is
      // still selectable/copyable by hand either way.
    }
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Textarea readOnly value={text} rows={label === "LinkedIn post" ? 6 : 10} className="font-mono text-xs" />
    </div>
  )
}

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
  const [pexelsQuery, setPexelsQuery] = useState("")
  const [searchingPexels, setSearchingPexels] = useState(false)

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

  async function searchPexels() {
    const query = pexelsQuery.trim() || form.title || ""
    if (!query.trim()) { setError("Type a search term (or a title) first."); return }
    setSearchingPexels(true); setError("")
    try {
      const res = await fetch("/api/admin/blog/pexels-photo", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ query, slug: form.slug || "post" }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setForm((f) => ({ ...f, cover_image_url: data.cover_image_url, alt_text: data.alt_text }))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pexels search failed")
    } finally {
      setSearchingPexels(false)
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
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="max-w-sm"
                  value={pexelsQuery}
                  onChange={(e) => setPexelsQuery(e.target.value)}
                  placeholder="Search a free Pexels photo (e.g. a destination) - blank uses the title"
                />
                <Button type="button" size="sm" variant="outline" onClick={searchPexels} disabled={searchingPexels}>
                  {searchingPexels ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}
                  {searchingPexels ? "Searching..." : "Search Pexels"}
                </Button>
              </div>
              <Input
                className="max-w-sm"
                value={form.alt_text || ""}
                onChange={(e) => setForm((f) => ({ ...f, alt_text: e.target.value }))}
                placeholder="Alt text (describe the photo, not the post) - blank falls back to the title"
              />
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

        {!isNew && form.status === "published" && form.slug && form.title && form.body && (
          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex items-center gap-2">
                <Share2 className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-medium">Syndicate this post</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Ready-to-paste text for platforms that need a manual post. Nothing here posts automatically - copy, paste, and publish on each
                platform yourself. It's the same text already live on the blog, just formatted for where it's going.
              </p>
              {(() => {
                const kit = buildSyndicationKit({
                  title: form.title!,
                  slug: form.slug!,
                  body: form.body!,
                  tags: form.tags || [],
                  meta_description: form.meta_description,
                })
                return (
                  <div className="grid gap-4 lg:grid-cols-3">
                    <CopyBlock label="LinkedIn post" text={kit.linkedin} hint="Paste directly into a LinkedIn post." />
                    <CopyBlock label="Substack" text={kit.substack} hint="Paste into a new Substack post (its editor reads Markdown)." />
                    <CopyBlock label="Medium" text={kit.medium} hint={`Use Medium's "Import a story" and set the canonical URL to ${kit.postUrl} to avoid a duplicate-content SEO hit.`} />
                  </div>
                )
              })()}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
