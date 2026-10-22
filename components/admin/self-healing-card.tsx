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
  lowest: { type: "post" | "guide" | "page_copy" | "package"; path: string; score: number; reasons: string[] }[]
  healedPages: number
  edits: number
  hardWaiting: number
  calls: number
  /** How many of the scored pages are trip pages (absent in a summary saved before trips were scored). */
  trips?: number
  /** Trip pages fixed by the last run. */
  tripsFixed?: number
  note: string
}

interface LoopEntry {
  at: string
  type: "post" | "guide" | "page_copy" | "package"
  path: string
  status: "healed" | "rejected_by_heal" | "deferred" | "already_clean"
  rounds: number
  calls: number
  reason: string
}

interface Loop {
  cap: number
  used: number
  readable: boolean
  waiting: string
  healedToday: number
  rejectedToday: number | null
  roundsToday: number
  recent: LoopEntry[]
}

interface Card {
  summary: Summary | null
  editsToday: number | null
  slotsUsed: number | null
  slotCap: number
  spend: { calls: number; usd: number }
  needsMigration: boolean
  loop?: Loop
}

const LOOP_STATUS = { healed: "healed and published", rejected_by_heal: "rejected by the heal", deferred: "waiting for tomorrow", already_clean: "already clean" } as const

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const TYPE_LABEL = { post: "Post", guide: "Guide", page_copy: "Page copy", package: "Trip" } as const

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

  async function saveCap(value: number) {
    try {
      const res = await fetch("/api/admin/content-edits", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "set-heal-cap", value }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: "Saved", description: `The heal may make up to ${value} AI calls a day.` })
      load()
    } catch (e) {
      toast({ title: "Could not save", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
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
              Once a day every live post, guide, trip page and compare or best-time page gets an SEO checklist score (our own estimate of how well the page is set up, not a Google ranking). For pages under 70 the site fixes the cheap things by itself: long dashes, over-long meta text, broken links, a link to a real page about the same place, and a missing FAQ or meta text written from the page&apos;s own words. On a trip page it only fills fields that are empty (meta text, keywords, FAQ) and adds one &quot;Related&quot; line of links to the end of the description when it has none (a trip that already happened only gets a FAQ); 2 of the 6 daily slots are kept for trips; it never changes a trip&apos;s name, price, dates, what is included, itinerary or links. When a draft is held back for a banned phrase, a claim, a price, a date or a link, the heal loop below rewords or removes just that part and publishes if the result passes every rule and an independent AI review. It never adds a fact. Every change is listed with an Undo button.
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
          <Stat label="Pages scored" value={s ? String(s.scored) : "-"} hint={s ? `${s.trips != null ? `${s.trips} trip pages included, ` : ""}last run ${new Date(s.at).toLocaleDateString("en-CA", { timeZone: "America/Toronto" })}` : "has not run yet"} />
          <Stat label="Average checklist score" value={s?.avg != null ? `${s.avg} / 100` : "-"} hint={s ? `${s.below} under 70. A checklist score, not a Google ranking` : "A checklist score, not a Google ranking"} />
          <Stat label="Fixed by itself today" value={card.editsToday === null ? "?" : String(card.editsToday)} hint={`${card.slotsUsed ?? "?"} of ${card.slotCap} pages used today`} />
          <Stat label="Held pages healed today" value={card.loop ? String(card.loop.healedToday) : "-"} hint="rewritten and published by the heal loop" />
        </div>

        {card.loop && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Heal loop: nothing is held for you</h3>
            <p className="text-xs text-muted-foreground">
              A held draft is rewritten by one AI and checked by a second, independent AI plus the site&apos;s own rules, up to 5 rounds, with plainer wording asked for in the later rounds. If that is not enough it removes the offending sentences, rewrites that section from the facts, and for blog posts writes the whole post again once. For guides the last step is a short safe page built only from stored facts (published, with a safe-page note so it can be improved later). It only ever publishes text that passes the rules. Otherwise the draft is marked rejected, its slot is freed and the next topic or guide is picked by itself. It never adds a fact.
            </p>
            <div className="grid gap-2 text-sm sm:grid-cols-4">
              <Stat label="AI calls used today" value={`${card.loop.used} / ${card.loop.cap}`} hint="the daily limit for the heal loop" />
              <Stat label="Healed today" value={String(card.loop.healedToday)} />
              <Stat label="Rejected today" value={card.loop.rejectedToday === null ? "?" : String(card.loop.rejectedToday)} hint="no action needed; the slot is free" />
              <Stat label="Rounds today" value={String(card.loop.roundsToday)} />
            </div>
            {card.loop.waiting && <p className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-xs">{card.loop.waiting}</p>}
            <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Daily limit (0 to 60 AI calls, 40 is the default):
              <input
                type="number"
                min={0}
                max={60}
                defaultValue={card.loop.cap}
                key={card.loop.cap}
                className="h-8 w-20 rounded-md border bg-background px-2 text-sm text-foreground"
                onBlur={(e) => {
                  // An empty box is "no change", never 0 (0 switches the heal off).
                  if (e.target.value.trim() === "") return
                  const n = Number(e.target.value)
                  if (Number.isInteger(n) && n >= 0 && n <= 60 && n !== card.loop?.cap) void saveCap(n)
                }}
              />
            </label>
            {card.loop.recent.length > 0 && (
              <ul className="space-y-1 text-xs">
                {card.loop.recent.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="rounded-md border px-2 py-1">
                    <span className="font-medium">{LOOP_STATUS[e.status]}</span> <span className="text-muted-foreground">{TYPE_LABEL[e.type]} {e.path}, {e.rounds} round{e.rounds === 1 ? "" : "s"}, {e.calls} AI call{e.calls === 1 ? "" : "s"}</span>
                    {e.reason && <p className="text-muted-foreground">{e.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Daily limit: 6 pages and 2 AI calls a page (about ${(card.spend.usd).toFixed(2)} estimated so far today across {card.spend.calls} call{card.spend.calls === 1 ? "" : "s"}; the most it can spend is about $0.60 a day).
        </p>

        {s && s.lowest.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lowest checklist scores (an SEO to-do estimate, not a Google ranking)</h3>
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
