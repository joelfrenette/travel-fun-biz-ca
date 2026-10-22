"use client"

import { Suspense, useEffect, useMemo, useState } from "react"
import PostsPageHeader from "@/components/admin/posts-page-header"
import PostsAutomationCard from "@/components/admin/posts-automation-card"
import { countPostStatuses, countPostsWithoutGoodCover, statusCountCells } from "@/lib/posts-page-summary"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Plus, AlertTriangle, RefreshCw } from "lucide-react"
import type { Post } from "@/lib/posts"
import type { AdminPostMeta } from "@/lib/blog-admin-filters"
import BlogPostsList from "@/components/admin/blog-posts-list"
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
  // The URL is the single source of truth: the active tab is derived from it on every render, so a sidebar
  // click on /admin/blog?tab=autoblog while already on this page switches the tab (the old copy-into-state
  // version only read ?tab= on first paint, so the address changed and the Posts tab stayed up).
  const tab = searchParams.get("tab") === "autoblog" ? "autoblog" : "posts"

  function changeTab(value: string) {
    router.replace(value === "autoblog" ? "/admin/blog?tab=autoblog" : "/admin/blog", { scroll: false })
  }

  const [posts, setPosts] = useState<Post[]>([])
  const [meta, setMeta] = useState<Record<string, AdminPostMeta>>({})
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
        setMeta(data.meta || {})
        if (Array.isArray(data.metaProblems) && data.metaProblems.length > 0) setError(`Some post details could not be loaded (${data.metaProblems.join("; ")}). The list still works; those columns may be blank.`)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const counts = useMemo(() => countPostStatuses(posts, new Date().toISOString().slice(0, 10)), [posts])
  // The four status counts plus one image-quality counter: published posts whose cover is missing, a default thumbnail, an SVG,
  // tiny, a wrong subject or a repeat. scripts/backfill-covers.ts fixes them.
  const cells = useMemo(
    () => [...statusCountCells(counts), { label: "Posts without a good cover", value: countPostsWithoutGoodCover(posts, new Date().toISOString().slice(0, 10)) }],
    [counts, posts],
  )

  return (
    <div>
      <PostsPageHeader
        title="Posts: Blog"
        purpose="Articles and recaps. Draft posts never show on the public site."
        cells={cells}
        loading={loading}
        actions={
          <Button asChild>
            <Link href="/admin/blog/new"><Plus className="mr-1.5 h-4 w-4" />New Post</Link>
          </Button>
        }
      />

      <div className="container mx-auto space-y-3 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <PostsAutomationCard type="blog" />

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
            <BlogPostsList posts={posts} meta={meta} loading={loading} onPostsChange={setPosts} onError={setError} />
          </TabsContent>
          <TabsContent value="autoblog" className="pt-3">
            <BlogTopicQueue />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
