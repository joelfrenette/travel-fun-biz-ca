"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Wrench } from "lucide-react"

// The "Self-healing" card on the Autopilot page: how the published pages score for SEO, what the site fixed by itself
// today, and how many drafts are waiting on a person. No runtime import of the server code (types are copied here).

interface Summary {
  at: string
  scored: number
  avg: number | null
  below: number
  lowest: { type: "post" | "guide" | "page_copy"; path: string; score: number; reasons: string[] }[]
  healedPages: number
  edits: number
  hardWaiting: number
  calls: number
  note: string
}

interface Card {
  summary: Summary | null
  editsToday: number | null
  slotsUsed: number | null
  slotCap: number
  spend: { calls: number; usd: number }
  needsMigration: boolean
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const TYPE_LABEL = { post: "Post", guide: "Guide", page_copy: "Page copy" } as const

export function SelfHealingCard() {
  const { toast } = useToast()
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetch("/api/admin/content-edits?card=1", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load")
        setCard(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])
  useEffect(() => { load() }, [load])

  async function healNow() {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/content-edits", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "heal-now" }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: "Heal finished", description: body.note })
      load()
    } catch (e) {
      toast({ title: "Heal problem", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Self-healing: {error}</div>
  if (!card) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  const s = card.summary
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-semibold"><Wrench className="h-4 w-4" />Self-healing</h2>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Once a day every live post, guide and compare or best-time page gets an SEO score. For pages under 70 the site fixes the cheap things by itself: long dashes, over-long meta text, broken links, a link to a real page about the same place, and a missing FAQ or meta text written from the page&apos;s own words. When a draft is held back for a banned phrase, the site rewords or removes just that sentence and publishes if it then passes. It never adds a fact, and never touches a price, a date, a claim that &quot;we went there&quot;, or a link to another website. Every change is listed with an Undo button.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || card.needsMigration} onClick={healNow} title="Scores everything and fixes what it can right now. Skips the once-a-day wait; the 6-pages-a-day limit still applies.">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Heal now
            </Button>
            <Button size="sm" variant="outline" asChild><Link href="/admin/content-edits">See every change</Link></Button>
          </div>
        </div>

        {card.needsMigration && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
            Self-healing needs one database update before it can change anything: run <code>supabase/migrations/0033_content_edits.sql</code> in the Supabase SQL editor. Until then it only reports.
          </div>
        )}

        <div className="grid gap-2 text-sm sm:grid-cols-4">
          <Stat label="Pages scored" value={s ? String(s.scored) : "-"} hint={s ? `last run ${new Date(s.at).toLocaleDateString("en-CA", { timeZone: "America/Toronto" })}` : "has not run yet"} />
          <Stat label="Average score" value={s?.avg != null ? `${s.avg} / 100` : "-"} hint={s ? `${s.below} under 70` : ""} />
          <Stat label="Fixed by itself today" value={card.editsToday === null ? "?" : String(card.editsToday)} hint={`${card.slotsUsed ?? "?"} of ${card.slotCap} pages used today`} />
          <Stat label="Waiting on a person" value={s ? String(s.hardWaiting) : "-"} hint="drafts held back for a price, date, claim or link" warn={!!s && s.hardWaiting > 0} />
        </div>
        <p className="text-xs text-muted-foreground">
          Daily limit: 6 pages and 2 AI calls a page (about ${(card.spend.usd).toFixed(2)} estimated so far today across {card.spend.calls} call{card.spend.calls === 1 ? "" : "s"}; the most it can spend is about $0.60 a day).
        </p>

        {s && s.lowest.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lowest scores</h3>
            <ul className="space-y-1.5 text-sm">
              {s.lowest.map((l) => (
                <li key={l.path} className="rounded-md border px-3 py-1.5">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className={l.score < 70 ? "text-destructive" : ""}>{l.score}</span>
                    <a className="hover:underline" href={l.path} target="_blank" rel="noopener noreferrer">{l.path}</a>
                    <span className="text-xs font-normal text-muted-foreground">{TYPE_LABEL[l.type]}</span>
                  </p>
                  {l.reasons.length > 0 && <p className="text-xs text-muted-foreground">{l.reasons.join(" ")}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {s && <p className="text-xs text-muted-foreground">{s.note}</p>}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={warn ? "text-xl font-semibold text-destructive" : "text-xl font-semibold"}>{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
