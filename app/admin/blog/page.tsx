"use client"

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Plus, Trash2, FileText, AlertTriangle, RefreshCw } from "lucide-react"
import type { Post } from "@/lib/posts"
import type { DriftFinding } from "@/lib/content-drift"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import BlogTopicQueue from "@/components/admin/blog-topic-queue"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

// useSearchParams() opts the page into client-side rendering and needs a Suspense boundary around
// it, or `next build` fails with "useSearchParams() should be wrapped in a suspense boundary" -
// same reason app/page.tsx wraps ContactForm. The default export below is just that boundary.
export default function BlogAdminPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>}>
      <BlogAdminPageContent />
    </Suspense>
  )
}

function BlogAdminPageContent() {
  // Lets the admin-nav sidebar link straight to the autoblog tab (/admin/blog?tab=autoblog)
  // instead of landing on Posts and leaving the visitor to find the tab themselves. Controlled
  // (not just read on mount) so the URL stays in sync after switching tabs by hand - an uncontrolled
  // Tabs only honored ?tab= on first paint, so the address bar could say autoblog while Posts was
  // showing, breaking the back button / a bookmarked or shared link.
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = searchParams.get("tab") === "autoblog" ? "autoblog" : "posts"
  const [tab, setTab] = useState(initialTab)

  function changeTab(value: string) {
    setTab(value)
    router.replace(value === "autoblog" ? "/admin/blog?tab=autoblog" : "/admin/blog")
  }

  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  // Post-publish drift check (factory spec item: re-read published posts, flag facts that no
  // longer match the current travel_packages data) - see lib/content-drift.ts.
  const [driftChecking, setDriftChecking] = useState(false)
  const [driftFindings, setDriftFindings] = useState<DriftFinding[] | null>(null)
  const [driftError, setDriftError] = useState("")

  async function checkDrift() {
    setDriftChecking(true); setDriftError("")
    try {
      const res = await fetch("/api/admin/blog/drift", { headers: authHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setDriftFindings(data.findings || [])
    } catch (e) {
      setDriftError(e instanceof Error ? e.message : "Drift check failed")
    } finally {
      setDriftChecking(false)
    }
  }

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

        <Tabs value={tab} onValueChange={changeTab}>
          <TabsList>
            <TabsTrigger value="posts">Posts</TabsTrigger>
            <TabsTrigger value="autoblog">Topics &amp; Autoblog</TabsTrigger>
          </TabsList>
          <TabsContent value="posts" className="space-y-3 pt-3">
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">Content drift check</p>
                  <p className="text-xs text-muted-foreground">
                    Re-checks every published post against the current trip data - flags a post whose linked trip is no longer published or whose dates have already passed.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={checkDrift} disabled={driftChecking}>
                  {driftChecking ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}Check for drift
                </Button>
              </CardContent>
              {driftError && <CardContent className="px-4 pb-4 pt-0 text-sm text-destructive">{driftError}</CardContent>}
              {driftFindings && (
                <CardContent className="space-y-2 px-4 pb-4 pt-0">
                  {driftFindings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No drift found - every published post's linked trip is still published with current dates.</p>
                  ) : (
                    driftFindings.map((f, i) => (
                      <div key={`${f.postId}-${i}`} className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm">
                        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                        <div>
                          <Link href={`/admin/blog/${f.postId}`} className="font-medium hover:underline">{f.postTitle}</Link>
                          <p className="text-xs text-muted-foreground">{f.detail}</p>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              )}
            </Card>
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
                      {post.status === "published" && post.publish_date && post.publish_date > new Date().toISOString().slice(0, 10) ? (
                        <Badge variant="outline">scheduled {new Date(post.publish_date).toLocaleDateString("en-CA")}</Badge>
                      ) : (
                        <Badge variant={post.status === "published" ? "default" : "secondary"}>{post.status}</Badge>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(post)} title="Delete"><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>
          <TabsContent value="autoblog" className="pt-3">
            <BlogTopicQueue />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
