"use client"

import { useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import type { LeadRow } from "@/lib/leads"
import { STATUS_LABEL, isLeadStatus, needsAgent, waitLight, waitMinutes, waitText } from "@/lib/lead-desk"
import { authHeaders } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// The lead desk part of a row on the Leads page: hot flag, status, who has it, how long it waited, and the three
// buttons (contacted, booked, lost). Choosing an agent happens on the Today card, where the whole desk looks.

const LIGHT = { green: "text-emerald-700 dark:text-emerald-400", amber: "text-amber-700 dark:text-amber-400", red: "text-red-700 dark:text-red-400" } as const

export function LeadDeskRow({ lead, onChanged }: { lead: LeadRow; onChanged: (patch: Partial<LeadRow>) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const status = isLeadStatus(lead.status) ? lead.status : "new"
  const waiting = needsAgent(lead)
  const minutes = waitMinutes(lead.created_at)

  if (!lead.hot && status === "new" && !lead.assigned_agent_id) return null

  const mark = async (next: "contacted" | "booked" | "lost") => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      const res = await fetch("/api/admin/leads", { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ id: lead.id, status: next }) })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      onChanged({ status: next, first_contact_at: lead.first_contact_at ?? (next === "lost" ? null : new Date().toISOString()) })
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-1.5 border-t pt-2 text-xs" data-testid="lead-desk-row">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {lead.hot && <Badge className="text-[10px]">Hot lead</Badge>}
        <Badge variant="outline" className="text-[10px]">{STATUS_LABEL[status]}</Badge>
        {lead.assigned_agent_name ? (
          <span>Agent: <span className="font-semibold">{lead.assigned_agent_name}</span>{lead.assigned_by ? ` (chosen by ${lead.assigned_by})` : ""}</span>
        ) : waiting ? (
          <span className={cn("font-semibold", LIGHT[waitLight(minutes)])}>Needs an agent, waiting {waitText(minutes)}</span>
        ) : null}
      </p>
      {waiting && (
        <p>
          <Link href="/admin" className="font-medium text-primary underline underline-offset-2">Choose the agent on the Today card</Link>
        </p>
      )}
      {lead.hot && !lead.is_test && status !== "booked" && status !== "lost" && (
        <div className="flex flex-wrap gap-2">
          {status !== "contacted" && <button type="button" disabled={busy} onClick={() => void mark("contacted")} className="min-h-9 rounded-md border px-3 hover:bg-muted disabled:opacity-40">Mark contacted</button>}
          <button type="button" disabled={busy} onClick={() => void mark("booked")} className="min-h-9 rounded-md border px-3 hover:bg-muted disabled:opacity-40">Mark booked</button>
          <button type="button" disabled={busy} onClick={() => void mark("lost")} className="min-h-9 rounded-md border px-3 hover:bg-muted disabled:opacity-40">Mark lost</button>
        </div>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  )
}
