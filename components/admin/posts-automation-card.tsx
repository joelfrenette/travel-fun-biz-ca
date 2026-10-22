"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2 } from "lucide-react"
import { DISTRIBUTION_MODE_TEXT } from "@/lib/posts-page-summary"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

interface Automation {
  type: "blog" | "news"
  distributionMode: "off" | "prepare" | "auto"
  tailoredCaptions: boolean
  paused: boolean
  cover: { composedAvailable: boolean; sampleUrl: string | null; sampleSlug: string | null }
  mode: "off" | "draft" | "publish"
  // blog
  postsPerWeek?: number
  maxPerDay?: number
  approvedTopics?: number
  plan?: string
  lastRun?: { at: string; ok: boolean; note?: string } | null
  // news
  perDay?: number | null
}

interface Props {
  type: "blog" | "news"
  /** Bump this to re-read after the page changed a setting (for example the news mode). */
  refreshKey?: number
}

/** The "Automation" card at the top of a Posts page: what runs on its own for this kind of post, read only.
 * The switches themselves stay where they were (Topics & Autoblog tab, the News mode selector, Post Distribution). */
export default function PostsAutomationCard({ type, refreshKey = 0 }: Props) {
  const [data, setData] = useState<Automation | null>(null)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)

  async function changeMaxPerDay(next: number) {
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/admin/blog/autoblog-cadence", { method: "POST", headers: authHeaders(), body: JSON.stringify({ maxPerDay: next }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setData((d) => (d ? { ...d, maxPerDay: next } : d))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    let live = true
    setError("")
    fetch(`/api/admin/posts/automation?type=${type}`, { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!live) return
        if (!ok) throw new Error(body.error || "Could not load")
        setData(body as Automation)
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load"))
    return () => { live = false }
  }, [type, refreshKey])

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">Automation</p>
          {data && <Badge variant={data.mode === "off" ? "secondary" : "default"}>{type === "blog" ? "Autoblog" : "News"}: {data.mode}</Badge>}
          {data && type === "blog" && typeof data.postsPerWeek === "number" && <Badge variant="outline">{data.postsPerWeek} post{data.postsPerWeek === 1 ? "" : "s"} a week</Badge>}
          {data && type === "news" && <Badge variant="outline">{data.perDay === null || data.perDay === undefined ? "briefs per day unknown" : `${data.perDay} brief${data.perDay === 1 ? "" : "s"} a day`}</Badge>}
          {data?.paused && <Badge variant="destructive">Paused by kill switch</Badge>}
        </div>
        {!data && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && (
          <>
            {type === "blog" && data.plan && <p className="text-sm">{data.plan}</p>}
            {type === "blog" && typeof data.maxPerDay === "number" && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <label htmlFor="autoblog-max-per-day" className="font-medium text-foreground">Posts on a writing day</label>
                <select
                  id="autoblog-max-per-day"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={data.maxPerDay}
                  disabled={saving}
                  onChange={(e) => changeMaxPerDay(Number(e.target.value))}
                >
                  <option value={1}>1 (default)</option>
                  <option value={2}>Up to 2</option>
                  <option value={3}>Up to 3</option>
                </select>
                <span>
                  More than 1 only when approved topics are waiting; the extra posts come from your approved topics, at least 90 minutes apart.
                  {typeof data.approvedTopics === "number" ? ` ${data.approvedTopics} approved topic${data.approvedTopics === 1 ? "" : "s"} waiting now.` : ""}
                </span>
              </div>
            )}
            {type === "news" && (
              <p className="text-sm">
                {data.mode === "off" && "News is off: nothing is read or written."}
                {data.mode === "draft" && "News writes short briefs and saves them as drafts. Nothing goes live until you approve it below."}
                {data.mode === "publish" && "News briefs that pass the quality gate and the judge go live on their own."}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Social posting: {DISTRIBUTION_MODE_TEXT[data.distributionMode]}
              {data.tailoredCaptions ? " · tailored captions on" : " · one shared caption"}
              {" · "}
              <Link href="/admin/distribution" className="underline">Post Distribution</Link>
            </p>
            <p className="text-xs text-muted-foreground">
              Instagram cover:{" "}
              {data.cover.composedAvailable && data.cover.sampleUrl
                ? <>a titled cover is composed for each post (<a href={data.cover.sampleUrl} target="_blank" rel="noopener noreferrer" className="underline">preview the latest</a>)</>
                : "no published post to compose a cover for yet"}
            </p>
            {type === "blog" && data.lastRun && (
              <p className="text-xs text-muted-foreground">
                Last scheduled run: {new Date(data.lastRun.at).toLocaleString("en-CA")} ({data.lastRun.ok ? "ok" : "reported a problem"}{data.lastRun.note ? `: ${data.lastRun.note}` : ""})
                {typeof data.approvedTopics === "number" ? ` · ${data.approvedTopics} approved topic${data.approvedTopics === 1 ? "" : "s"} waiting` : ""}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
