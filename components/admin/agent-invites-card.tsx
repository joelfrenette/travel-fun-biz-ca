"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Loader2, Copy, Ban, Link as LinkIcon, Check } from "lucide-react"

// "Agent links" (WP13): Joel creates a link for an outside agent, copies it, and sees what each agent sent. Revoking a
// link stops it at once. The agent works on drafts through the same wizard; nothing they send goes live until Joel
// approves it in the trip's editor.

interface SubmissionItem { id: string; package_id: string | null; trip_name: string | null; state: string; created_at: string; submitted_at: string | null }
interface InviteItem {
  id: string; agent_name: string; agent_email: string | null; note: string | null; created_at: string; expires_at: string; revoked_at: string | null
  uses: number; max_uses: number; link: string; active: boolean; blocked: string | null; draftsToday: number; submissions: SubmissionItem[]
}

const STATE_TEXT: Record<string, string> = { in_progress: "Agent is working on it", submitted: "Waiting for you", rejected: "Sent back to the agent", approved: "Published" }

function authHeaders(json = true): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

export function AgentInvitesCard({ onOpenPackage }: { onOpenPackage?: (packageId: string) => void }) {
  const [invites, setInvites] = useState<InviteItem[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [copied, setCopied] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [note, setNote] = useState("")
  const [days, setDays] = useState("30")
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([])
  const [agentId, setAgentId] = useState("")

  // The roster, for the "put approved trips on this agent's page" pick. A failure just leaves the list empty.
  useEffect(() => {
    fetch("/api/admin/agents", { headers: authHeaders(false) })
      .then((r) => r.json())
      .then((d) => setRoster(((d.agents ?? []) as { id?: unknown; display_name?: unknown }[]).filter((a) => typeof a.id === "string" && typeof a.display_name === "string").map((a) => ({ id: a.id as string, name: a.display_name as string }))))
      .catch(() => setRoster([]))
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/agent-invites", { headers: authHeaders(false) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not load the links (HTTP ${res.status})`)
      setInvites(data.invites ?? [])
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the links")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create() {
    setBusy("create")
    setError("")
    try {
      const res = await fetch("/api/admin/agent-invites", { method: "POST", headers: authHeaders(), body: JSON.stringify({ agent_id: agentId || undefined, agent_name: name, agent_email: email, note, expires_days: Number(days) || 30 }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not create the link (HTTP ${res.status})`)
      setName(""); setEmail(""); setNote(""); setAgentId("")
      await load()
      await copy(data.invite.link, data.invite.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the link")
    } finally {
      setBusy("")
    }
  }

  async function copy(link: string, id: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? "" : c)), 2500)
    } catch {
      window.prompt("Copy this link:", link)
    }
  }

  async function revoke(i: InviteItem) {
    if (!confirm(`Stop ${i.agent_name}'s link from working? Their drafts stay, but they cannot open the link any more.`)) return
    setBusy(`revoke:${i.id}`)
    try {
      const res = await fetch(`/api/admin/agent-invites/${i.id}`, { method: "DELETE", headers: authHeaders(false) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not revoke (HTTP ${res.status})`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke")
    } finally {
      setBusy("")
    }
  }

  return (
    <Card className="mx-auto max-w-4xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><LinkIcon className="h-5 w-5" />Agent links</CardTitle>
        <CardDescription>
          Send an agent a private link. They drop screenshots, PDFs, links or text, the site builds a draft trip page, and they send it to you. Nothing goes live until you approve it in the trip's editor. Each link takes 5 new trips and 10 things a day, and 20 trips in all, and works for 30 days unless you choose less.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

        <div className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
          {roster.length > 0 && (
            <div className="md:col-span-2">
              <label htmlFor="invite-agent" className="text-sm">Put approved trips on this roster agent's page (optional)</label>
              <select id="invite-agent" value={agentId} onChange={(e) => { setAgentId(e.target.value); const r = roster.find((x) => x.id === e.target.value); if (r && !name.trim()) setName(r.name) }} className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm">
                <option value="">Not tied to a roster agent</option>
                {roster.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent's name" maxLength={80} aria-label="Agent's name" />
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Agent's email (optional)" type="email" aria-label="Agent's email" />
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for yourself (optional)" maxLength={300} aria-label="Note" />
          <div className="flex items-center gap-2">
            <label htmlFor="invite-days" className="whitespace-nowrap text-sm">Works for</label>
            <Input id="invite-days" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 2))} className="w-20" inputMode="numeric" />
            <span className="text-sm">days</span>
            <Button type="button" className="ml-auto" onClick={create} disabled={busy !== "" || name.trim().length < 2}>{busy === "create" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Create and copy link</Button>
          </div>
        </div>

        {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading...</p>}
        {!loading && invites.length === 0 && !error && <p className="text-sm text-muted-foreground">No links yet.</p>}

        {invites.map((i) => (
          <div key={i.id} className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-[160px] flex-1 font-medium">{i.agent_name}{i.agent_email ? <span className="font-normal text-muted-foreground"> ({i.agent_email})</span> : null}</p>
              <Badge variant={i.active ? "default" : "secondary"}>{i.active ? "Active" : i.blocked === "revoked" ? "Revoked" : i.blocked === "expired" ? "Expired" : "Full"}</Badge>
              <span className="text-xs text-muted-foreground">{i.uses} of {i.max_uses} trips started, {i.draftsToday} today. Ends {new Date(i.expires_at).toLocaleDateString("en-CA", { dateStyle: "medium" })}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => copy(i.link, i.id)}>{copied === i.id ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}{copied === i.id ? "Copied" : "Copy link"}</Button>
              {!i.revoked_at && <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={busy !== ""} onClick={() => revoke(i)}><Ban className="mr-1 h-3.5 w-3.5" />Revoke</Button>}
            </div>
            {i.note && <p className="text-xs text-muted-foreground">{i.note}</p>}
            {i.submissions.length > 0 && (
              <ul className="space-y-1">
                {i.submissions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-[140px] flex-1 truncate">{s.trip_name ?? "Untitled trip"}</span>
                    <Badge variant={s.state === "submitted" ? "default" : "secondary"}>{STATE_TEXT[s.state] ?? s.state}</Badge>
                    {s.package_id && onOpenPackage && <Button type="button" size="sm" variant="outline" onClick={() => onOpenPackage(s.package_id as string)}>Open in the editor</Button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
