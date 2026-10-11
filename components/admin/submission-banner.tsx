"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, UserCheck } from "lucide-react"

// "Submitted by <agent>" with Approve (publish) and Reject (back to the agent with a note) on a trip an agent sent (WP13).
// Renders nothing for a trip that no agent sent. Approve publishes, so it is refused while a required field (name,
// destination, how long, price) is still empty: fill those in the form below first.

interface Sub { id: string; agent_name: string; agent_email: string | null; message: string | null; dates_note: string | null; state: string; review_note: string | null; created_at: string; submitted_at: string | null }

const STATE_TEXT: Record<string, string> = { in_progress: "The agent is still working on it", submitted: "Waiting for your review", rejected: "Sent back to the agent", approved: "Published" }

export function SubmissionBanner({ packageId, onChanged }: { packageId: string; onChanged?: () => void }) {
  const [sub, setSub] = useState<Sub | null>(null)
  const [note, setNote] = useState("")
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/packages/${packageId}/submission`, { headers: { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` } })
      const data = await res.json().catch(() => ({}))
      setSub(res.ok ? (data.submission ?? null) : null)
    } catch {
      setSub(null)
    }
  }, [packageId])

  useEffect(() => {
    load()
  }, [load])

  async function decide(action: "approve" | "reject") {
    setBusy(action)
    setError("")
    try {
      const res = await fetch(`/api/admin/packages/${packageId}/submission`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }, body: JSON.stringify({ action, note }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed (HTTP ${res.status})`)
      setAsking(false)
      setNote("")
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong")
    } finally {
      setBusy("")
    }
  }

  if (!sub) return null
  const open = sub.state === "submitted" || sub.state === "in_progress"
  return (
    <Card className="mx-auto mb-4 max-w-4xl border-amber-300">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <UserCheck className="h-5 w-5 text-amber-600" />
          <p className="flex-1 font-medium">Submitted by {sub.agent_name}{sub.agent_email ? ` (${sub.agent_email})` : ""}</p>
          <span className="text-sm text-muted-foreground">{STATE_TEXT[sub.state] ?? sub.state}</span>
        </div>
        {sub.message && <p className="whitespace-pre-wrap text-sm">{sub.message}</p>}
        {sub.dates_note && <p className="text-sm text-muted-foreground">Dates the agent gave: {sub.dates_note}</p>}
        {sub.review_note && sub.state === "rejected" && <p className="text-sm text-muted-foreground">Your note to the agent: {sub.review_note}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {open && (
          <div className="space-y-2">
            {asking && <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Tell the agent what to change. They can read this on their page." maxLength={1000} />}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy !== ""} onClick={() => { if (confirm("Publish this trip page now? It goes live on the site.")) decide("approve") }}>{busy === "approve" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Approve and publish</Button>
              {!asking ? (
                <Button type="button" variant="outline" disabled={busy !== ""} onClick={() => setAsking(true)}>Send back to the agent</Button>
              ) : (
                <Button type="button" variant="outline" disabled={busy !== "" || note.trim().length < 3} onClick={() => decide("reject")}>{busy === "reject" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Send back with this note</Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">It stays a draft either way until you approve. Approve is refused while the name, destination, length or price is empty: fill those in below first.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
