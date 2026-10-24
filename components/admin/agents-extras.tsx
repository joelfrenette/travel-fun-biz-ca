"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { agentsCall, arr, s, type AgentsData, type Row } from "@/components/admin/agents-api"
import { monthKey, monthLabel } from "@/lib/agents"

function useRun() {
  const [err, setErr] = useState("")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  async function run<T>(fn: () => Promise<T>, ok?: (r: T) => string): Promise<T | undefined> {
    setBusy(true); setErr(""); setMsg("")
    try { const r = await fn(); if (ok) setMsg(ok(r)); return r } catch (e) { setErr(e instanceof Error ? e.message : "Failed") } finally { setBusy(false) }
  }
  const notes = (<>{err && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{err}</p>}{msg && <p role="status" className="rounded-md border bg-muted/40 p-2 text-sm">{msg}</p>}</>)
  return { run, busy, notes }
}

const nameOf = (data: AgentsData, id: unknown) => s(data.agents.find((a) => a.id === id)?.display_name) || "(unknown)"

/** Agent profile sections waiting for approval, and content drafts waiting for approval. Nothing here auto-publishes. */
export function AgentsReview({ data, onChanged }: { data: AgentsData; onChanged: () => void }) {
  const { run, busy, notes } = useRun()
  return (
    <div className="space-y-6">
      {notes}
      <section className="space-y-2">
        <h2 className="font-semibold">Profiles sent by agents ({data.submissions.length})</h2>
        <p className="text-xs text-muted-foreground">Approving copies their words onto the DRAFT profile. It never publishes, and a certification is never marked verified for you.</p>
        {data.submissions.length === 0 && <p className="text-sm text-muted-foreground">Nothing waiting.</p>}
        {data.submissions.map((sub) => {
          const p = (sub.payload ?? {}) as Row
          return (
            <Card key={s(sub.id)}><CardContent className="space-y-2 p-3 text-sm">
              <p className="font-medium">{nameOf(data, sub.agent_id)} <span className="font-normal text-muted-foreground">{new Date(s(sub.created_at)).toLocaleString()}</span></p>
              {s(p.headline) && <p>Headline: {s(p.headline)}</p>}
              <p className="whitespace-pre-wrap">{s(p.bio)}</p>
              <p>Specialties: {arr(p.specialties).join(", ") || "none"} | Languages: {arr(p.languages).join(", ") || "none"} | Years: {s(p.years_experience) || "not given"}</p>
              {Array.isArray(p.certifications) && (p.certifications as Row[]).length > 0 && <p>Certifications (unverified): {(p.certifications as Row[]).map((c) => s(c.name)).join(", ")}</p>}
              {arr(p.video_urls).length > 0 && <p>Videos: {arr(p.video_urls).join(", ")}</p>}
              {s(p.photo_url) && /* eslint-disable-next-line @next/next/no-img-element */ <img src={s(p.photo_url)} alt="Photo sent by the agent, awaiting approval" className="h-24 w-24 rounded-md object-cover" />}
              <p>Agent ticked: photo consent {p.consent_photo === true ? "yes" : "no"}, bio consent {p.consent_bio === true ? "yes" : "no"}</p>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={async () => { if (await run(() => agentsCall({ action: "submission", id: sub.id, decision: "approve" }), () => "Copied onto the draft profile.")) onChanged() }}>Approve to draft profile</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={async () => { if (await run(() => agentsCall({ action: "submission", id: sub.id, decision: "reject" }))) onChanged() }}>Reject</Button>
              </div>
            </CardContent></Card>
          )
        })}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Content drafts ({data.drafts.length})</h2>
        <p className="text-xs text-muted-foreground">Written only from the agent&apos;s own profile. Approving a post hands it to the Blog topic queue as a suggested topic (the usual approval decides when it is written). A caption is marked approved for you to copy.</p>
        {data.drafts.length === 0 && <p className="text-sm text-muted-foreground">Nothing waiting.</p>}
        {data.drafts.map((d) => (
          <Card key={s(d.id)}><CardContent className="space-y-2 p-3 text-sm">
            <p className="font-medium">{s(d.title)} <span className="font-normal text-muted-foreground">({s(d.kind).replace("_", " ")})</span></p>
            <p className="whitespace-pre-wrap">{s(d.body)}</p>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={async () => { if (await run(() => agentsCall({ action: "draft", id: d.id, decision: "approve" }), () => "Approved.")) onChanged() }}>Approve</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={async () => { if (await run(() => agentsCall({ action: "draft", id: d.id, decision: "reject" }))) onChanged() }}>Reject</Button>
            </div>
          </CardContent></Card>
        ))}
      </section>
    </div>
  )
}

export function AgentsMonth({ data, onChanged }: { data: AgentsData; onChanged: () => void }) {
  const { run, busy, notes } = useRun()
  const [month, setMonth] = useState(monthKey(new Date()))
  const [agentId, setAgentId] = useState("")
  const [blurb, setBlurb] = useState("")
  const [published, setPublished] = useState(true)
  const published_agents = data.agents.filter((a) => a.status === "published")
  return (
    <div className="space-y-4">
      {notes}
      <section className="space-y-2">
        <h2 className="font-semibold">Suggestions</h2>
        <p className="text-xs text-muted-foreground">Ranked from profile quality only (photo, video, verified certifications, public milestones, not featured recently). Sales and commission are never used. You decide.</p>
        {data.suggestions.length === 0 && <p className="text-sm text-muted-foreground">No published agent to suggest yet.</p>}
        {data.suggestions.slice(0, 5).map((x) => (
          <div key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
            <span><span className="font-medium">{x.display_name}</span> ({x.score}/100): {x.reasons.join("; ")}</span>
            <Button size="sm" variant="outline" onClick={() => setAgentId(x.id)}>Pick</Button>
          </div>
        ))}
      </section>
      <section className="space-y-2 rounded-md border p-3">
        <h2 className="font-semibold">Set the agent of the month</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-36" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} placeholder="2026-11" />
          <select className="h-10 rounded-md border bg-background px-2 text-sm" aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Choose an agent</option>
            {published_agents.map((a) => <option key={s(a.id)} value={s(a.id)}>{s(a.display_name)}</option>)}
          </select>
        </div>
        <Textarea rows={3} aria-label="Why this agent (shown publicly, keep it free of amounts)" placeholder="Why this agent (shown on the site). No sales figures." value={blurb} onChange={(e) => setBlurb(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Show on the site now</label>
        <Button disabled={busy || !agentId} onClick={async () => { if (await run(() => agentsCall<{ queued: string[] }>({ action: "aotm", aotm: { month, agent_id: agentId, blurb, published } }), (r) => `Saved.${r.queued.length ? " An announcement draft is waiting in Review." : ""}`)) onChanged() }}>Save</Button>
      </section>
      <section className="space-y-1">
        <h2 className="font-semibold">History</h2>
        {data.aotm.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
        {data.aotm.map((r) => <p key={s(r.id)} className="text-sm">{monthLabel(s(r.month))}: {nameOf(data, r.agent_id)} {r.published === true ? "(shown)" : "(hidden)"}</p>)}
      </section>
    </div>
  )
}

/** Admin only. This is the only place sales / commission figures are summed or shown. */
export function AgentsLeaderboard({ data }: { data: AgentsData }) {
  return (
    <div className="space-y-3">
      <p className="rounded-md border bg-muted/40 p-3 text-sm">Internal only. These private values never appear on the website, in a badge, in a post or in the agent of the month.</p>
      {data.leaderboard.length === 0 && <p className="text-sm text-muted-foreground">No private values recorded yet. Add one on an agent&apos;s milestone.</p>}
      <ol className="space-y-1">
        {data.leaderboard.map((r, i) => (
          <li key={r.agent_id} className="flex justify-between rounded-md border p-2 text-sm"><span>{i + 1}. {r.display_name}</span><span>{r.total.toLocaleString("en-CA")} across {r.count} entr{r.count === 1 ? "y" : "ies"}</span></li>
        ))}
      </ol>
    </div>
  )
}
