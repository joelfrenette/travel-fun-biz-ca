"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Plus, Trash2, FileText } from "lucide-react"
import type { Post } from "@/lib/posts"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export default function BlogAdminPage() {
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  function load() {
    setLoading(true)
    fetch("/api/admin/blog", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setPosts(data.posts || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function remove(post: Post) {
    if (!confirm(`Delete "${post.title}"? This cannot be undone.`)) return
    const res = await fetch(`/api/admin/blog/${post.id}`, { method: "DELETE", headers: authHeaders() })
    if (res.ok) setPosts((p) => p.filter((x) => x.id !== post.id))
    else setError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">Blog</h1>
            <p className="text-sm text-muted-foreground">Articles and recaps. Draft posts never show on the public site.</p>
          </div>
          <Button asChild>
            <Link href="/admin/blog/new"><Plus className="mr-1.5 h-4 w-4" />New Post</Link>
          </Button>
        </div>
      </div>

      <div className="container mx-auto space-y-3 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <FileText className="h-8 w-8" />
            <p>No posts yet. Write your first one.</p>
          </div>
        ) : (
          posts.map((post) => (
            <Card key={post.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-[220px] flex-1">
                  <Link href={`/admin/blog/${post.id}`} className="font-medium hover:underline">{post.title}</Link>
                  <p className="text-xs text-muted-foreground">
                    /blog/{post.slug}{post.publish_date ? ` · ${new Date(post.publish_date).toLocaleDateString("en-CA")}` : ""}
                    {post.tags.length > 0 ? ` · ${post.tags.join(", ")}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={post.status === "published" ? "default" : "secondary"}>{post.status}</Badge>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(post)} title="Delete"><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
