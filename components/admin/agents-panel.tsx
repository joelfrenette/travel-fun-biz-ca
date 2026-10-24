"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Loader2 } from "lucide-react"
import { agentsCall, agentsHeaders, arr, s, type AgentsData, type Row } from "@/components/admin/agents-api"
import { AgentsEditor } from "@/components/admin/agents-editor"
import { AgentsImport } from "@/components/admin/agents-import"
import { AgentsReview, AgentsMonth, AgentsLeaderboard } from "@/components/admin/agents-extras"
import { OFFICE_ROLES, OFFICE_ROLE_LABEL, officeHolders, parseOfficeRole, publishBlockers } from "@/lib/agents"
type Tab = "roster" | "import" | "review" | "month" | "leaderboard"

const STATUS_LABEL: Record<string, string> = { draft: "Draft", ready: "Ready", published: "Published" }

export function AgentsPanel() {
  const [data, setData] = useState<AgentsData | null>(null)
  const [error, setError] = useState("")
  const [tab, setTab] = useState<Tab>("roster")
  const [editing, setEditing] = useState<Row | "new" | null>(null)
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("")
  const [specialty, setSpecialty] = useState("")
  const [office, setOffice] = useState("")
  const [alertBusy, setAlertBusy] = useState(false)
  const [alertErr, setAlertErr] = useState("")

  const load = useCallback(() => {
    fetch("/api/admin/agents", { headers: agentsHeaders() })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        setData(d as AgentsData)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])
  useEffect(load, [load])

  const specialties = useMemo(() => Array.from(new Set((data?.agents ?? []).flatMap((a) => arr(a.specialties)))).sort(), [data])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data?.agents ?? []).filter((a) => {
      if (status && a.status !== status) return false
      if (specialty && !arr(a.specialties).includes(specialty)) return false
      if (office) {
        const role = parseOfficeRole(a.office_role)
        const has = role !== null && role !== "invalid"
        if (office === "team" ? !has : role !== office) return false
      }
      if (needle && !`${s(a.display_name)} ${s(a.headline)} ${s(a.home_city)} ${s(a.email)}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [data, q, status, specialty, office])
  const holders = useMemo(() => officeHolders(data?.agents ?? []), [data])

  async function toggleOfficeAlert(on: boolean) {
    setAlertBusy(true); setAlertErr("")
    try { await agentsCall({ action: "office-alert", on }); load() } catch (e) { setAlertErr(e instanceof Error ? e.message : "Could not save") } finally { setAlertBusy(false) }
  }

  if (error) return <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
  if (!data) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading...</p>
  if (!data.migrated) {
    return (
      <p className="rounded-md border p-4 text-sm">
        The agent tables are not in the database yet. Apply migration 0054_agents.sql (Supabase SQL editor), then reload this page.
      </p>
    )
  }

  const tabs: [Tab, string][] = [
    ["roster", `Roster (${data.agents.length})`],
    ["import", "Import from spreadsheet"],
    ["review", `Review (${data.submissions.length + data.drafts.length})`],
    ["month", "Agent of the month"],
    ["leaderboard", "Internal leaderboard"],
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b pb-2" role="tablist">
        {tabs.map(([k, label]) => (
          <Button key={k} role="tab" aria-selected={tab === k} size="sm" variant={tab === k ? "default" : "outline"} onClick={() => { setTab(k); setEditing(null) }}>{label}</Button>
        ))}
      </div>

      {tab === "roster" && !editing && (
        <div className="space-y-3">
          <section className="space-y-2 rounded-md border bg-muted/30 p-3" aria-label="Office team" data-testid="office-team">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="font-medium">Office team</span>
              {OFFICE_ROLES.map((r) => (
                <span key={r}><span className="text-muted-foreground">{OFFICE_ROLE_LABEL[r]}:</span> {holders[r] ? s(holders[r]?.display_name) : <span className="text-muted-foreground">not set</span>}</span>
              ))}
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={data.officeAlert === true} disabled={alertBusy} onChange={(e) => void toggleOfficeAlert(e.target.checked)} />
              <span>Also email the office team when a hot lead arrives. <span className="text-muted-foreground">Uses the private roster emails of the CEO, CTO and Manager. Leave off until your sending domain is verified, because the email service only delivers to the account owner before that.</span></span>
            </label>
            {alertErr && <p role="alert" className="text-sm text-destructive">{alertErr}</p>}
          </section>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="max-w-xs" placeholder="Search name, city, email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search agents" />
            <select className="h-10 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="published">Published</option>
            </select>
            <select className="h-10 rounded-md border bg-background px-2 text-sm" value={specialty} onChange={(e) => setSpecialty(e.target.value)} aria-label="Filter by specialty">
              <option value="">All specialties</option>
              {specialties.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select className="h-10 rounded-md border bg-background px-2 text-sm" value={office} onChange={(e) => setOffice(e.target.value)} aria-label="Filter by office team">
              <option value="">Everyone</option>
              <option value="team">Office team</option>
              {OFFICE_ROLES.map((r) => <option key={r} value={r}>{OFFICE_ROLE_LABEL[r]}</option>)}
            </select>
            <Button size="sm" onClick={() => setEditing("new")}>Add an agent</Button>
          </div>
          {rows.length === 0 && <p className="text-sm text-muted-foreground">{data.agents.length === 0 ? "No agents yet. Add one, or import your spreadsheet." : "No agent matches that filter."}</p>}
          <div className="grid gap-2">
            {rows.map((a) => {
              const blockers = publishBlockers(a as never)
              const role = parseOfficeRole(a.office_role)
              return (
                <Card key={s(a.id)}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="font-medium">{s(a.display_name)} <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs">{STATUS_LABEL[s(a.status)] ?? s(a.status)}</span>{a.featured === true && <span className="ml-1 rounded bg-primary/10 px-2 py-0.5 text-xs">Featured</span>}{role && role !== "invalid" && <span className="ml-1 rounded bg-emerald-600/15 px-2 py-0.5 text-xs font-semibold" data-testid="office-badge">{OFFICE_ROLE_LABEL[role]}</span>}</p>
                      <p className="truncate text-sm text-muted-foreground">{s(a.headline) || "No headline"} {arr(a.specialties).length ? `| ${arr(a.specialties).join(", ")}` : "| no specialties yet"}</p>
                      {s(a.status) !== "published" && blockers.length > 0 && <p className="text-xs text-muted-foreground">Before publishing: {blockers.join(" ")}</p>}
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setEditing(a)}>Edit</Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      )}

      {tab === "roster" && editing && <AgentsEditor agent={editing === "new" ? null : editing} roster={data.agents} onClose={() => setEditing(null)} onChanged={load} achievements={data.achievements.filter((x) => editing !== "new" && x.agent_id === editing.id)} />}
      {tab === "import" && <AgentsImport onDone={() => { load(); setTab("roster") }} />}
      {tab === "review" && <AgentsReview data={data} onChanged={load} />}
      {tab === "month" && <AgentsMonth data={data} onChanged={load} />}
      {tab === "leaderboard" && <AgentsLeaderboard data={data} />}
    </div>
  )
}
