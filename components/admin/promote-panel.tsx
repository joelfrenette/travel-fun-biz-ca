"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Megaphone } from "lucide-react"

// "Promote this package" (growth loop WP15). One click builds a plan of marketing actions around a live trip and queues
// each into the machinery that already exists: tracked search phrases, blog ideas, guide pages and ONE social post. Nothing
// posts or renders from this card. The card then shows the plan and how far each part has got.

interface PlanIdea { id: string; keyword: string; title: string }
interface PlanGuide { kind: string; slug: string; name: string }
interface Plan {
  keywords: string[]
  ideas: PlanIdea[]
  guides: PlanGuide[]
  social: { slug: string; path: string; state: string; note: string } | null
  notes: string[]
  priority_until: string
}
interface Progress {
  keywords: { keyword: string; opportunity: string | null }[]
  ideas: { id: string; keyword: string; title: string; status: string; postSlug: string | null }[]
  guides: { kind: string; slug: string; name: string; state: "written" | "draft" | "waiting"; href: string | null }[]
  social: { state: string; networks: string[]; note: string } | null
  performance: { clicks: number | null; visits: number | null; leads: number | null; day: string } | null
}
interface State {
  migrated: boolean
  slug: string
  name: string
  gate: { ok: true } | { ok: false; code: string; reason: string }
  promotion: { id: string; started_at: string; status: "active" | "paused" | "done"; plan: Plan } | null
  progress: Progress | null
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}`, "Content-Type": "application/json" }
}

const IDEA_STATUS: Record<string, string> = { approved: "Waiting to be written", used: "Written", suggested: "On hold", rejected: "Rejected", removed: "Removed from the queue" }
const GUIDE_STATE: Record<string, string> = { written: "Live", draft: "Written, waiting for your review", waiting: "Waiting its turn" }
const SOCIAL_STATE: Record<string, string> = {
  queued: "Will go out on the next posting pass",
  held: "Waiting for you on the Distribution screen",
  done: "Posted",
  failed: "Did not post (see Needs attention)",
  waiting: "Waiting for a free day",
  skipped: "Not queued",
}
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium" })

export function PromotePanel({ packageId }: { packageId: string }) {
  const { toast } = useToast()
  const [s, setS] = useState<State | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/packages/${packageId}/promote`, { headers: authHeaders() })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Could not load (HTTP ${res.status})`)
      setS(body)
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load")
    }
  }, [packageId])

  useEffect(() => {
    load()
  }, [load])

  async function act(action: string, label: string) {
    setBusy(action)
    try {
      const res = await fetch(`/api/admin/packages/${packageId}/promote`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ action }) })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `${label} failed (HTTP ${res.status})`)
      if (action === "start") {
        const failures = (out.failures ?? []) as string[]
        toast({ title: "Promotion started", description: failures.length ? `Some parts did not work: ${failures.join(" | ")}. See Needs attention on the Autopilot page.` : "Ideas, guides and the social post are queued. They run on the normal schedule." })
      } else {
        toast({ title: label, description: out.note })
      }
    } catch (e) {
      toast({ title: `${label} did not work`, description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
    } finally {
      setBusy("")
      await load()
    }
  }

  if (error) return <Card className="mx-auto mb-4 max-w-4xl"><CardContent className="p-4 text-sm text-red-700">{error}</CardContent></Card>
  if (!s) return <Card className="mx-auto mb-4 max-w-4xl"><CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading the promote card</CardContent></Card>

  const promo = s.promotion
  const plan = promo?.plan
  const progress = s.progress
  const statusText = promo ? (promo.status === "active" ? "Being promoted" : promo.status === "paused" ? "Paused" : "Finished") : null

  return (
    <Card className="mx-auto mb-4 max-w-4xl" id="promote-panel">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Megaphone className="h-5 w-5" />
          Promote this package
          {statusText && <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${promo?.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{statusText}</span>}
        </CardTitle>
        <CardDescription>
          One click turns this trip into marketing: search phrases to track, blog ideas, guide pages for the place and any named hotel or ship, and one social post. Everything is added to what already runs, on its normal schedule and limits. Nothing is posted from this card.
          {!s.migrated && <span className="mt-1 block font-medium text-red-700">One database update is missing: run migration 0039 (supabase/migrations/0039_promotions.sql) in the Supabase SQL editor first.</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={!s.migrated || !s.gate.ok || busy === "start"} onClick={() => act("start", "Promote this package")}>
              {busy === "start" ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />Building the plan</> : "Promote this package"}
            </Button>
            {promo && promo.status === "active" && <Button type="button" variant="outline" disabled={!!busy} onClick={() => act("pause", "Pause")}>Pause</Button>}
            {promo && promo.status === "paused" && <Button type="button" variant="outline" disabled={!!busy} onClick={() => act("resume", "Resume")}>Resume</Button>}
            {promo && promo.status !== "done" && <Button type="button" variant="ghost" disabled={!!busy} onClick={() => act("done", "Mark as finished")}>Mark as finished</Button>}
            {promo && promo.status === "active" && plan && plan.ideas.length === 0 && (
              <Button type="button" variant="outline" disabled={!!busy} onClick={() => act("retry-ideas", "Retry the blog ideas")}>{busy === "retry-ideas" ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />Writing ideas</> : "Retry the blog ideas"}</Button>
            )}
            {promo && promo.status === "active" && plan?.social && (plan.social.state === "waiting" || plan.social.state === "skipped") && (
              <Button type="button" variant="outline" disabled={!!busy} onClick={() => act("retry-social", "Queue the social post")}>Queue the social post</Button>
            )}
          </div>
          {!s.gate.ok && <p className="text-sm text-amber-700">{s.gate.reason}</p>}
          {s.gate.ok && promo && <p className="text-xs text-muted-foreground">Last promoted {dateLabel(promo.started_at)}.</p>}
        </div>

        {promo && plan && (
          <div className="space-y-5">
            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold">1. Search phrases being tracked ({plan.keywords.length})</h3>
              <p className="text-xs text-muted-foreground">Free. The weekly keyword engine groups them and says which are worth shooting for.</p>
              <ul className="space-y-0.5 text-sm">
                {(progress?.keywords.length ? progress.keywords : plan.keywords.map((keyword) => ({ keyword, opportunity: null }))).map((k) => (
                  <li key={k.keyword} className="flex flex-wrap gap-2"><span>{k.keyword}</span><span className="text-xs text-muted-foreground">{k.opportunity ?? "not looked at yet"}</span></li>
                ))}
              </ul>
            </section>

            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold">2. Blog ideas ({plan.ideas.length})</h3>
              <p className="text-xs text-muted-foreground">Approved already. The Monday, Wednesday and Friday posts use approved ideas oldest first, together with any other approved ideas. A trip gets at most one post a week; an idea that has to wait is moved a week on, not thrown away.</p>
              {plan.ideas.length === 0 && <p className="text-sm text-amber-700">No ideas were saved. The reason is in Needs attention on the Autopilot page.</p>}
              <ul className="space-y-1 text-sm">
                {(progress?.ideas.length ? progress.ideas : plan.ideas.map((i) => ({ ...i, status: "approved", postSlug: null }))).map((i) => (
                  <li key={i.id}>
                    <span className="font-medium">{i.title}</span> <span className="text-xs text-muted-foreground">({i.keyword})</span>
                    <span className="ml-2 text-xs">{i.status === "used" && !i.postSlug ? "Skipped, not written" : (IDEA_STATUS[i.status] ?? i.status)}</span>
                    {i.postSlug && <> <a className="text-xs underline" href={`/blog/${i.postSlug}`} target="_blank" rel="noreferrer">Open the post</a></>}
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold">3. Guide pages ({plan.guides.length})</h3>
              <p className="text-xs text-muted-foreground">First in line for the daily guide step until {plan.priority_until ? dateLabel(plan.priority_until) : "30 days from the click"}. They still go through the same safety checks.</p>
              <ul className="space-y-0.5 text-sm">
                {(progress?.guides.length ? progress.guides : plan.guides.map((g) => ({ ...g, state: "waiting" as const, href: null }))).map((g) => (
                  <li key={`${g.kind}:${g.slug}`}>
                    {g.name} <span className="text-xs text-muted-foreground">({g.kind})</span> <span className="ml-1 text-xs">{GUIDE_STATE[g.state]}</span>
                    {g.href && <> <a className="text-xs underline" href={g.href} target="_blank" rel="noreferrer">Open</a></>}
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold">4. Social post</h3>
              {plan.social ? (
                <p className="text-sm">
                  {SOCIAL_STATE[progress?.social?.state ?? plan.social.state] ?? progress?.social?.state ?? plan.social.state}
                  {progress?.social?.networks.length ? <span className="text-xs text-muted-foreground"> on {progress.social.networks.join(", ")}</span> : null}
                  <span className="block text-xs text-muted-foreground">{plan.social.note}</span>
                </p>
              ) : <p className="text-sm text-muted-foreground">No social post was queued.</p>}
            </section>

            <section className="space-y-1.5">
              <h3 className="text-sm font-semibold">5. Results so far</h3>
              {progress?.performance ? (
                <p className="text-sm">Trip page, last 28 days to {progress.performance.day}: {progress.performance.clicks ?? "?"} Google clicks, {progress.performance.visits ?? "?"} visits, {progress.performance.leads ?? "?"} leads (leads count the last 90 days).</p>
              ) : <p className="text-sm text-muted-foreground">No numbers for the trip page yet. They appear after the next daily snapshot.</p>}
              {plan.notes.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-muted-foreground">{plan.notes.map((n, idx) => <li key={`${idx}:${n.slice(0, 40)}`}>{n}</li>)}</ul>
              )}
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
