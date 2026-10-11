"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Plus, ChevronRight } from "lucide-react"
import { PackageWizard } from "@/components/package-wizard"
import { agentApi } from "@/components/package-wizard-api"

// The public page behind an agent link (WP13): /submit-trip/<token>. No login, no site header, no admin shell. The agent
// sees only their own name and their own drafts. Starting or opening a draft runs the same add-a-trip wizard the admin
// uses; "Send to Joel for review" locks it until Joel approves or sends it back with a note.

interface DraftRow { id: string; tripName: string; state: string; stateLabel: string; reviewNote: string | null; updatedAt: string }
interface Overview { agentName: string; expiresAt: string; drafts: DraftRow[]; canStart: boolean; startNote: string | null }

export default function SubmitTripPage({ params }: { params: { token: string } }) {
  const api = useMemo(() => agentApi(params.token), [params.token])
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  // null = the list; "new" = a new trip; an id = that draft.
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/submit-trip/${params.token}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "This link could not be opened.")
      setOverview(data as Overview)
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "This link could not be opened.")
    } finally {
      setLoading(false)
    }
  }, [params.token])

  useEffect(() => {
    load()
  }, [load])

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">TravelFunBiz.ca</p>
        <h1 className="text-2xl font-bold">Send a trip to Joel</h1>
        {overview && <p className="mt-1 text-muted-foreground">Hello {overview.agentName}. Drop what you have about a trip and the page is built for you. Joel reviews it before anything goes live.</p>}
      </header>

      {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Opening your link...</p>}
      {error && !loading && <p role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">{error}</p>}

      {overview && open === null && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Your trips</CardTitle>
              <CardDescription>Open one to keep working on it. A trip you have sent is read only until Joel answers.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {overview.drafts.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet. Start your first trip below.</p>}
              {overview.drafts.map((d) => (
                <button key={d.id} type="button" onClick={() => setOpen(d.id)} className="flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-muted">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{d.tripName}</span>
                    {d.state === "rejected" && d.reviewNote && <span className="block truncate text-xs text-amber-700 dark:text-amber-300">Joel: {d.reviewNote}</span>}
                  </span>
                  <Badge variant={d.state === "rejected" ? "destructive" : "secondary"}>{d.stateLabel}</Badge>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              ))}
              <div className="pt-2">
                <Button type="button" onClick={() => setOpen("new")} disabled={!overview.canStart}><Plus className="mr-1 h-4 w-4" />Start a new trip</Button>
                {overview.startNote && <p className="mt-2 text-sm text-muted-foreground">{overview.startNote}</p>}
              </div>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">This link works until {new Date(overview.expiresAt).toLocaleDateString("en-CA", { dateStyle: "long" })}. Keep it private: anyone who has it can add trips as you.</p>
        </div>
      )}

      {overview && open !== null && (
        <div className="space-y-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(null); load() }}>Back to my trips</Button>
          <PackageWizard
            key={open}
            api={api}
            initialDraftId={open === "new" ? undefined : open}
            onDone={() => { setOpen(null); load() }}
          />
        </div>
      )}
    </main>
  )
}
