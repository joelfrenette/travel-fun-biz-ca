"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Newspaper } from "lucide-react"

// The "Travel news" section on the Content Autopilot page (growth loop WP20): the two switches, how each feed is doing, and
// the last 10 news items with their status and why. No runtime import of the server code (types are copied here).

interface Item {
  id: string
  title: string
  source: string
  tier: number
  status: "new" | "queued" | "published" | "rejected" | "expired"
  reason: string | null
  postSlug: string | null
  url: string
  at: string
}
interface Source {
  key: string
  name: string
  tier: number
  enabled: boolean
  confidence: string
  fails: number
  lastError: string | null
  lastOkAt: string | null
}
interface NewsCard {
  mode: "off" | "draft" | "publish"
  perDay: number | null
  perDayDefault: number
  perDayMax: number
  needsMigration: boolean
  items: Item[]
  sources: Source[]
}

const STATUS_LABEL: Record<Item["status"], string> = {
  new: "read, not written yet",
  queued: "brief saved as a draft",
  published: "live",
  rejected: "not used",
  expired: "expired (older than 7 days)",
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export function TravelNewsCard() {
  const { toast } = useToast()
  const [card, setCard] = useState<NewsCard | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetch("/api/admin/news", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load")
        setCard(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])
  useEffect(() => { load() }, [load])

  async function save(patch: { mode?: string; per_day?: number }, saved: string) {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/news", { method: "POST", headers: authHeaders(), body: JSON.stringify(patch) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setCard(body)
      toast({ title: "Saved", description: saved })
    } catch (e) {
      toast({ title: "Could not save", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Travel news: {error}</div>
  if (!card) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold"><Newspaper className="h-4 w-4" />Travel news</h2>
          <p className="max-w-2xl text-xs text-muted-foreground">
            The site reads a short list of official and trade news feeds (RSS and Atom only, never the article pages) and keeps only items that change a traveller&apos;s plans: storms, advisories, entry rules, strikes and closures, health notices, new laws, unrest. For a few of them a day it writes its own short brief using only what the feed item says, checks it with the site&apos;s rules and a second, independent AI, and saves it as a normal blog post tagged travel-news with a link to the original and the name of the source. Briefs that fail the checks are not used. One social post goes out per published brief. Posts older than 30 days stay up and are marked as archived news.
          </p>
        </div>

        {card.needsMigration && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
            Travel news needs one database update before it can store anything: run <code>supabase/migrations/0047_news_items.sql</code> in the Supabase SQL editor.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Mode
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm"
              value={card.mode}
              disabled={busy}
              onChange={(e) => void save({ mode: e.target.value }, e.target.value === "publish" ? "Travel news briefs that pass the checks now go live." : e.target.value === "draft" ? "Travel news briefs are written and saved as drafts. Nothing goes live." : "Travel news is off.")}
            >
              <option value="off">Off: nothing is read or written</option>
              <option value="draft">Draft: write and check, nothing goes live</option>
              <option value="publish">Publish: briefs that pass go live and are posted</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            Briefs a day (0 to {card.perDayMax}, {card.perDayDefault} is the default)
            <input
              type="number"
              min={0}
              max={card.perDayMax}
              defaultValue={card.perDay ?? card.perDayDefault}
              key={card.perDay ?? "x"}
              disabled={busy}
              className="h-9 w-20 rounded-md border bg-background px-2 text-sm"
              onBlur={(e) => {
                // An empty box is "no change", never 0 (0 stops the writing).
                if (e.target.value.trim() === "") return
                const n = Number(e.target.value)
                if (Number.isInteger(n) && n >= 0 && n <= card.perDayMax && n !== card.perDay) void save({ per_day: n }, `Up to ${n} travel news brief${n === 1 ? "" : "s"} a day.`)
              }}
            />
          </label>
        </div>
        {card.perDay === null && <p className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-xs">The daily number could not be read, so nothing is written until it can be. This is safe.</p>}

        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Feeds</h3>
          <ul className="space-y-1 text-xs">
            {card.sources.map((s) => (
              <li key={s.key} className="rounded-md border px-2 py-1">
                <span className="font-medium">{s.name}</span>{" "}
                <span className="text-muted-foreground">
                  {s.tier === 1 ? "official" : "trade outlet"}, {s.enabled ? "on" : `off until its address is checked (${s.confidence})`}
                  {s.enabled && s.lastOkAt ? `, last read ${new Date(s.lastOkAt).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })}` : ""}
                </span>
                {s.fails > 0 && <p className={s.fails >= 3 ? "text-destructive" : "text-muted-foreground"}>Failed {s.fails} time{s.fails === 1 ? "" : "s"} in a row{s.lastError ? `: ${s.lastError}` : ""}</p>}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last 10 news items</h3>
          {card.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing read yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {card.items.map((i) => (
                <li key={i.id} className="rounded-md border px-3 py-1.5">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className={i.status === "rejected" ? "text-destructive" : i.status === "published" ? "text-green-700 dark:text-green-400" : ""}>{STATUS_LABEL[i.status]}</span>
                    <a className="hover:underline" href={i.url} target="_blank" rel="noopener noreferrer">{i.title}</a>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {i.source}, {i.tier === 1 ? "official" : "trade outlet"}, {new Date(i.at).toLocaleDateString("en-CA", { timeZone: "America/Toronto" })}
                    {i.postSlug ? <> , <a className="hover:underline" href={`/blog/${i.postSlug}`} target="_blank" rel="noopener noreferrer">{i.status === "published" ? "open the post" : "draft post"}</a></> : null}
                  </p>
                  {i.reason && <p className="text-xs text-muted-foreground">Why: {i.reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
