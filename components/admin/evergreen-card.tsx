"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Repeat2 } from "lucide-react"

// The small "Evergreen re-share" card on the Content Autopilot page: the on/off switch (default OFF), a read-only "Preview next pick" and the
// last re-shares. Server code is not imported at runtime (types are copied here).

interface Item {
  title: string
  path: string
  kind: "post" | "guide"
  why: string
  publishedAt: string | null
  lastSharedAt: string | null
}
interface Preview {
  switchOn: boolean
  pick: Item | null
  next: Item[]
  excluded: { reason: string; count: number }[]
  today: { allowed: boolean; reason: string }
  note: string
}
interface Card {
  switchOn: boolean
  readable: boolean
  state: { shared: { slug: string; at: string }[]; lastCheckAt: string | null; lastCheckNote: string | null }
  recent: { at: string; subject: string; action: string; reason: string; undone_at?: string }[]
  rules: { minAgeDays: number; cooldownDays: number }
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) : "never")

export function EvergreenCard() {
  const { toast } = useToast()
  const [card, setCard] = useState<Card | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")

  const load = useCallback(() => {
    fetch("/api/admin/evergreen", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load")
        setCard(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }, [])
  useEffect(() => { load() }, [load])

  async function call(body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey)
    try {
      const res = await fetch("/api/admin/evergreen", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" })
      return null
    } finally {
      setBusy("")
    }
  }

  async function toggle() {
    if (!card) return
    const data = await call({ action: "switch", on: !card.switchOn }, "switch")
    if (data) {
      toast({ title: !card.switchOn ? "Evergreen re-share on" : "Evergreen re-share off", description: !card.switchOn ? "It runs inside the Autopilot pass, one page a day at most." : "Nothing will be picked or posted." })
      load()
    }
  }

  async function runPreview() {
    const data = await call({ action: "preview" }, "preview")
    if (data?.preview) setPreview(data.preview)
  }

  if (error) return <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">Evergreen re-share: {error}</div>
  if (!card) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  return (
    <Card className={card.switchOn ? "border-emerald-600/50" : undefined}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[240px] flex-1">
            <h2 className="flex items-center gap-2 font-semibold"><Repeat2 className="h-4 w-4" />Evergreen re-share: {card.switchOn ? "ON" : "OFF"}</h2>
            <p className="max-w-2xl text-xs text-muted-foreground">
              When on, at most one older blog post or guide a day goes back out on social with a new hook. It must be live {card.rules.minAgeDays}+ days, not shared for {card.rules.cooldownDays} days, pass the quality bar, and not be news, a dated trip promo or a thin page. The one with the most Search Console impressions and the weakest click rate goes first. It uses the normal posting list: the same image check, caption checks, pauses and Pause all automation switch as a new post, and links are tagged <code>-evergreen</code> so the Optimizer and Top posts can tell it apart. It never takes the last daily slot from a new post. Runs inside the Autopilot pass, so Autopilot must be on.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => void runPreview()}>
              {busy === "preview" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Preview next pick
            </Button>
            <Button size="sm" variant={card.switchOn ? "outline" : "default"} disabled={busy !== "" || !card.readable} onClick={() => void toggle()} aria-pressed={card.switchOn}>
              {busy === "switch" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{card.switchOn ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </div>
        {!card.readable && <p className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-xs">The switch could not be read, so it is treated as off. This is safe.</p>}

        {preview && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p className="text-xs text-muted-foreground">Read only: nothing was posted or saved. {preview.note}</p>
            {preview.pick ? (
              <div>
                <p className="font-medium">Next pick: <a className="hover:underline" href={preview.pick.path} target="_blank" rel="noopener noreferrer">{preview.pick.title}</a> <span className="text-xs text-muted-foreground">({preview.pick.kind}, live since {day(preview.pick.publishedAt)}, last shared {day(preview.pick.lastSharedAt)})</span></p>
                <p className="text-xs text-muted-foreground">Why: {preview.pick.why}</p>
              </div>
            ) : (
              <p className="font-medium">Nothing would be picked right now.</p>
            )}
            {preview.next.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Then</p>
                <ul className="text-xs">
                  {preview.next.map((n) => <li key={n.path}>{n.title} <span className="text-muted-foreground">- {n.why}</span></li>)}
                </ul>
              </div>
            )}
            <p className="text-xs">{preview.today.allowed ? "Today: a slot is free." : `Today: not now (${preview.today.reason}).`} {preview.switchOn ? "" : "The switch is off, so nothing would go out."}</p>
            {preview.excluded.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Left out ({preview.excluded.reduce((a, b) => a + b.count, 0)})</summary>
                <ul className="mt-1">{preview.excluded.map((e) => <li key={e.reason}>{e.count} x {e.reason}</li>)}</ul>
              </details>
            )}
          </div>
        )}

        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last re-shares</h3>
          {card.recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">None yet. Each one is also a line in Autopilot decisions, with Undo while it has not gone out.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {card.recent.map((d) => (
                <li key={`${d.at}|${d.subject}`} className="rounded-md border px-2 py-1">
                  <span className="font-medium">{d.action}</span> <span className="text-muted-foreground">{day(d.at)}{d.undone_at ? ", undone" : ""}</span>
                </li>
              ))}
            </ul>
          )}
          {card.state.lastCheckAt && <p className="mt-1 text-xs text-muted-foreground">Last look: {new Date(card.state.lastCheckAt).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })}{card.state.lastCheckNote ? `, ${card.state.lastCheckNote}` : ""}.</p>}
        </div>
      </CardContent>
    </Card>
  )
}
