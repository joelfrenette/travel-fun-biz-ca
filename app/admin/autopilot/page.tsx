"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { PostingCard } from "@/components/admin/posting-card"
import { Loader2, Rocket, AlertTriangle, CheckCircle2 } from "lucide-react"

interface Row {
  slug: string
  title: string
  carousel_stage: string
  video_stage: string
  video_url: string | null
  last_error: string | null
  created_at: string
}

interface State {
  on: boolean
  readiness: { blockers: string[]; warnings: string[] }
  videosPerWeek: number
  shotstackEnv: "stage" | "v1"
  distributionMode: "off" | "prepare" | "auto"
  cron: { light: "green" | "amber" | "gray"; label: string }
  lastRun: { at: string; trigger: "schedule" | "button"; steps: { step: "keywords" | "write" | "post" | "repurpose"; ok: boolean; note: string }[] } | null
  keyword: { budget: number; configured: boolean; lastRunAt: string | null; log: { at: string; spentUsd: number; added: number; seeds: string[] }[] }
  rows: Row[]
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const STAGE_VARIANT = (s: string): "default" | "secondary" | "destructive" | "outline" =>
  s === "posted" ? "default" : s === "failed" ? "destructive" : s === "pending" ? "outline" : "secondary"

export default function AutopilotPage() {
  const { toast } = useToast()
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  function load() {
    fetch("/api/admin/autopilot", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setState(data)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }
  useEffect(() => { load() }, [])

  async function post(body: Record<string, unknown>, okTitle: string) {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/autopilot", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      toast({ title: okTitle, description: data.note })
      load()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="p-6 text-destructive">{error}</div>
  if (!state) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const blocked = state.readiness.blockers.length > 0

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Content Autopilot</h1>
          <p className="text-sm text-muted-foreground">One switch. On: blog posts, cover images, captions, carousels and short videos are written and posted to your social accounts on their own.</p>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        <Card className={state.on ? "border-emerald-600/50" : undefined}>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex items-center gap-3">
              <Rocket className={state.on ? "h-8 w-8 text-emerald-600" : "h-8 w-8 text-muted-foreground"} />
              <div>
                <p className="text-lg font-semibold">{state.on ? "Autopilot is ON" : "Autopilot is OFF"}</p>
                <p className="text-sm text-muted-foreground">
                  {state.on ? `Scheduler: ${state.cron.label}` : "Nothing is being written or posted automatically."}
                </p>
              </div>
            </div>
            <Button size="lg" variant={state.on ? "outline" : "default"} disabled={busy || (!state.on && blocked)} onClick={() => post({ on: !state.on }, state.on ? "Autopilot off" : "Autopilot on")}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {state.on ? "Turn off" : "Turn on"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">The pipeline</h2>
                <p className="text-xs text-muted-foreground">Every 15 minutes it does whatever is due, in order: write and publish the post, post it with a caption per network, make the carousel and the video, post those. Posts are written once a day from 9 am Eastern.</p>
              </div>
              <Button size="sm" disabled={busy || !state.on} onClick={() => post({ action: "run" }, "Pipeline ran")} title="Writes and publishes a new post right now, then runs every following step">
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Write and publish a post now
              </Button>
            </div>
            {state.lastRun ? (
              <ol className="space-y-1.5 text-sm">
                <li className="text-xs text-muted-foreground">Last pass: {new Date(state.lastRun.at).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })} ({state.lastRun.trigger === "button" ? "button" : "scheduled"})</li>
                {state.lastRun.steps.map((st) => (
                  <li key={st.step} className="flex items-start gap-2">
                    {st.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                    <span><span className="font-medium capitalize">{st.step === "repurpose" ? "carousel and video" : st.step === "post" ? "post to social" : st.step === "keywords" ? "keyword research" : "write and publish"}</span><span className="text-muted-foreground"> - {st.note}</span></span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">It has not run yet. It starts within 15 minutes of turning Autopilot on.</p>
            )}
          </CardContent>
        </Card>

        {state.distributionMode === "prepare" && (
          <Card className="border-amber-500/50">
            <CardContent className="p-4 text-sm">
              <p className="font-semibold">Review mode</p>
              <p className="text-muted-foreground">Posts wait for your OK on the Distribution page, and carousels and videos are made but not posted. When you trust it, set Distribution to Auto and everything posts on its own.</p>
            </CardContent>
          </Card>
        )}

        {(state.readiness.blockers.length > 0 || state.readiness.warnings.length > 0) && (
          <Card>
            <CardContent className="space-y-2 p-4">
              <h2 className="font-semibold">Setup check</h2>
              {state.readiness.blockers.map((b) => (
                <p key={b} className="flex gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{b}</p>
              ))}
              {state.readiness.warnings.map((w) => (
                <p key={w} className="flex gap-2 text-sm text-muted-foreground"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />{w}</p>
              ))}
            </CardContent>
          </Card>
        )}
        {state.readiness.blockers.length === 0 && state.readiness.warnings.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Everything needed is set up.</p>
        )}

        <PostingCard onChanged={load} />

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <h2 className="font-semibold">Videos per week</h2>
              <p className="text-xs text-muted-foreground">Each video render spends Shotstack credits, so this caps it. Shotstack mode: {state.shotstackEnv === "v1" ? "production" : "sandbox (watermarked, never posted)"}.</p>
            </div>
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm"
              value={state.videosPerWeek}
              disabled={busy}
              onChange={(e) => post({ videosPerWeek: Number(e.target.value) }, "Saved")}
              aria-label="Videos per week"
            >
              {[0, 1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n === 0 ? "No videos" : `${n} per week`}</option>)}
            </select>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <h2 className="font-semibold">Keyword research per week</h2>
              <p className="text-xs text-muted-foreground">
                {state.keyword.configured
                  ? `Once a week it researches new keywords for your trips and feeds them into topic picking. This is the most it will spend. ${state.keyword.log[0] ? `Last run: ${new Date(state.keyword.log[0].at).toLocaleDateString("en-CA")}, spent about $${state.keyword.log[0].spentUsd.toFixed(2)}, added ${state.keyword.log[0].added}.` : "Has not run yet."}`
                  : "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set, so there is no keyword research."}
              </p>
            </div>
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm"
              value={String(state.keyword.budget)}
              disabled={busy || !state.keyword.configured}
              onChange={(e) => post({ keywordBudget: Number(e.target.value) }, "Saved")}
              aria-label="Keyword research budget per week"
            >
              {[0, 0.5, 1, 2, 5].map((n) => <option key={n} value={String(n)}>{n === 0 ? "Off" : `Up to $${n} a week`}</option>)}
            </select>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between p-4">
              <h2 className="font-semibold">Recent posts</h2>
            </div>
            {state.rows.length === 0 ? (
              <p className="border-t p-4 text-sm text-muted-foreground">Nothing yet. Posts show up here after they are published.</p>
            ) : (
              state.rows.map((r) => (
                <div key={r.slug} className="flex flex-wrap items-center justify-between gap-3 border-t p-4">
                  <div className="min-w-[220px] flex-1">
                    <p className="font-medium">{r.title}</p>
                    {r.last_error && <p className="text-xs text-destructive">{r.last_error}</p>}
                    {r.video_stage === "sandbox" && r.video_url && (
                      <a className="text-xs text-primary hover:underline" href={r.video_url} target="_blank" rel="noopener noreferrer">Preview sandbox video</a>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Carousel</span><Badge variant={STAGE_VARIANT(r.carousel_stage)}>{r.carousel_stage}</Badge>
                    {r.carousel_stage === "failed" && <Button size="sm" variant="outline" disabled={busy} onClick={() => post({ action: "retry", slug: r.slug, part: "carousel" }, "Will retry on the next pass")}>Retry</Button>}
                    <span className="text-muted-foreground">Video</span><Badge variant={STAGE_VARIANT(r.video_stage)}>{r.video_stage}</Badge>
                    {r.video_stage === "failed" && <Button size="sm" variant="outline" disabled={busy} onClick={() => post({ action: "retry", slug: r.slug, part: "video" }, "Will retry on the next pass")}>Retry</Button>}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
