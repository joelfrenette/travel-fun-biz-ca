"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

type Policy = "retry_failed_posts" | "approve_safe_topics" | "publish_passing_news" | "release_held_posts" | "funnel_watchdog"

interface Decision {
  at: string
  policy: Policy
  subject: string
  action: string
  reason: string
  undo: { kind: string; ref: string } | null
  undone_at?: string
}
interface Switch {
  policy: Policy
  label: string
  on: boolean
  readable: boolean
}
interface Check {
  stage: string
  status: "ok" | "warn" | "bad"
  summary: string
  evidence: Record<string, number | string | null>
  action: string
  unreadable?: boolean
}
interface Exception {
  id: string
  severity: "bad" | "warn" | "info"
  title: string
  why: string
  nextStep: string
  href: string | null
}
interface Payload {
  decisions: Decision[]
  switches: Switch[]
  watchdog: { at: string; checks: Check[] } | null
  exceptions: Exception[]
  exceptionsUnreadable: string[]
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const STAGE_LABELS: Record<string, string> = {
  production: "Production (writing)",
  quality: "Quality",
  distribution: "Distribution (social)",
  discovery: "Indexing and discovery",
  clicks: "Clicks",
  conversion: "Conversion",
  measurement: "Measurement",
}
const DOT: Record<Check["status"], string> = { ok: "bg-green-500", warn: "bg-amber-500", bad: "bg-red-500" }
const WORD: Record<Check["status"], string> = { ok: "Green", warn: "Amber", bad: "Red" }

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

/** Read-only view of what the automatic decisions did (newest first) with an Undo for the reversible ones, a switch for each decision,
 * and the funnel watchdog's result per stage. The only writes are Undo and the switches. */
export function AutoDecisionsCard() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")

  const load = useCallback(() => {
    fetch("/api/admin/auto-decisions", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "could not be read")
        setData(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "could not be read"))
  }, [])

  useEffect(load, [load])

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key)
    setNote("")
    try {
      const r = await fetch("/api/admin/auto-decisions", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      setNote(j.message || j.error || (r.ok ? "Done." : "That did not work."))
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That did not work.")
    } finally {
      setBusy("")
      load()
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <h2 className="font-semibold">Autopilot decisions</h2>
          <p className="text-xs text-muted-foreground">
            Things the system does by itself, each with a reason. Pause all automation stops every one of them. Press Undo to take one back; an undone item is never touched again.
          </p>
        </div>

        {error ? (
          <p className="text-sm text-muted-foreground">Could not load this yet: {error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {note ? <p className="text-sm">{note}</p> : null}

            <div className="space-y-1">
              <p className="text-sm font-medium">Switches</p>
              <ul className="space-y-1">
                {data.switches.map((s) => (
                  <li key={s.policy} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      {s.label}
                      {s.readable ? "" : " (could not read, shown as on)"}
                    </span>
                    <Button size="sm" variant={s.on ? "default" : "outline"} disabled={busy === `sw-${s.policy}`} onClick={() => post({ action: "switch", policy: s.policy, on: !s.on }, `sw-${s.policy}`)} aria-pressed={s.on}>
                      {s.on ? "ON" : "OFF"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">Funnel health{data.watchdog ? ` (checked ${when(data.watchdog.at)})` : ""}</p>
              {!data.watchdog ? (
                <p className="text-sm text-muted-foreground">No check has run yet. It runs once a day.</p>
              ) : (
                <ul className="space-y-2">
                  {data.watchdog.checks.map((c) => (
                    <li key={c.stage} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[c.status]}`} aria-hidden="true" />
                        <span className="font-medium">{STAGE_LABELS[c.stage] ?? c.stage}</span>
                        <span className="text-xs text-muted-foreground">{WORD[c.status]}</span>
                      </div>
                      <p className="pl-4 text-xs">{c.summary}</p>
                      <p className="pl-4 text-xs text-muted-foreground">
                        {Object.entries(c.evidence)
                          .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v === null ? "could not be read" : v}`)
                          .join(" | ")}
                      </p>
                      <p className="pl-4 text-xs text-muted-foreground">{c.action}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">Left for you ({data.exceptions.length})</p>
              {data.exceptionsUnreadable.length ? <p className="text-xs text-muted-foreground">Could not read: {data.exceptionsUnreadable.join(", ")}.</p> : null}
              {data.exceptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing needs you right now.</p>
              ) : (
                <ul className="space-y-1">
                  {data.exceptions.slice(0, 8).map((x) => (
                    <li key={x.id} className="text-sm">
                      {x.title}
                      <span className="block text-xs text-muted-foreground">{x.why}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">Last 20 decisions</p>
              {data.decisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing has been decided automatically yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data.decisions.map((d) => {
                    const key = `${d.at}|${d.policy}|${d.subject}`
                    return (
                      <li key={key} className="flex items-start justify-between gap-3 text-sm">
                        <div>
                          <p>{d.action}</p>
                          <p className="text-xs text-muted-foreground">
                            {when(d.at)} - {d.reason}
                            {d.undone_at ? ` (undone ${when(d.undone_at)})` : ""}
                          </p>
                        </div>
                        {d.undo && !d.undone_at ? (
                          <Button size="sm" variant="outline" disabled={busy === key} onClick={() => post({ action: "undo", at: d.at, policy: d.policy, subject: d.subject }, key)}>
                            Undo
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
