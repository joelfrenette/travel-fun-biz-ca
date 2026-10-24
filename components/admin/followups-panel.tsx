"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Check, ChevronDown, ChevronRight, Clock, ExternalLink, RefreshCw, Undo2 } from "lucide-react"
import type { Selection } from "@/lib/followups"
import { announceBadges, authHeaders } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// The Daily follow-ups list, used on its own page and (collapsible) under the swipe cards on Today. Each task has the reason it
// matters, a time guess, a link to open, and Done / Later. Done on a setup step or on a lead's step is kept for good; any other
// Done is for today. Later pushes the task to tomorrow. The list is built fresh each day and holds at most eight tasks.

type Loaded = Selection & { generatedAt: string; problems: string[]; ticksReadable: boolean }

const GROUP_LABEL: Record<string, string> = {
  lead: "Lead",
  digest: "Growth tip",
  seo: "SEO fix",
  social: "Social",
  weekly: "This week",
  links: "Link building",
  recap: "Trip recap",
  setup: "Setup",
}

const OPEN_KEY = "followupsOpen"

export function FollowupsPanel({ collapsible = false }: { collapsible?: boolean }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (!collapsible) return
    try {
      const v = localStorage.getItem(OPEN_KEY)
      if (v !== null) setOpen(v === "1")
    } catch {
      // storage can be blocked; the section just starts open
    }
  }, [collapsible])

  const apply = useCallback((next: Loaded) => {
    setData(next)
    announceBadges({ followups: next.openCount })
  }, [])

  const load = useCallback(
    async (force = false) => {
      try {
        const res = await fetch(`/api/admin/follow-ups${force ? "?force=1" : ""}`, { headers: authHeaders(), cache: "no-store" })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`)
        apply(body as Loaded)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the follow-ups.")
      }
    },
    [apply],
  )

  useEffect(() => {
    void load()
  }, [load])

  async function tick(id: string, op: "done" | "later" | "reopen") {
    if (busy) return
    setBusy(id)
    try {
      const res = await fetch("/api/admin/follow-ups", { method: "POST", headers: authHeaders(), body: JSON.stringify({ id, op }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) setError(typeof body.error === "string" ? body.error : "That did not work. Please try again.")
      else {
        setError(null)
        apply(body as Loaded)
      }
    } catch {
      setError("Could not reach the server. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0")
    } catch {
      // ignore
    }
  }

  const headline = !data ? "Daily follow-ups" : `Daily follow-ups (${data.openCount} open)`
  const body = (
    <div id="followups-body">
      {error && (
        <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {!data && !error && <div className="h-40 animate-pulse rounded-xl border bg-muted/40" aria-hidden="true" />}
      {data && data.allDone && (
        <div className="mb-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4 text-center" role="status">
          <p className="text-lg font-semibold">All done for today</p>
          <p className="text-sm text-muted-foreground">New tasks come tomorrow, or sooner if a new lead arrives.</p>
        </div>
      )}
      {data && (
        <ul className="space-y-3">
          {data.items.map((item) => (
            <li key={item.id} className={cn("rounded-xl border bg-card p-3 sm:p-4", item.mark !== "open" && "opacity-60")}>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">{GROUP_LABEL[item.group] ?? "Task"}</span>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" aria-hidden="true" /> about {item.minutes} min
                </span>
                {item.note && <span className="text-xs text-muted-foreground">{item.note}</span>}
                {item.mark === "done" && <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Done</span>}
                {item.mark === "later" && <span className="text-xs font-medium text-muted-foreground">Pushed to tomorrow</span>}
              </div>
              <h3 className={cn("break-words text-base font-semibold leading-snug", item.mark === "done" && "line-through")}>{item.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{item.why}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/^https?:/.test(item.href) ? (
                  <a href={item.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium text-primary hover:bg-muted">
                    <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open
                  </a>
                ) : (
                  <Link href={item.href} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium text-primary hover:bg-muted">
                    <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open
                  </Link>
                )}
                {item.mark === "open" ? (
                  <>
                    <button type="button" disabled={busy !== null} onClick={() => void tick(item.id, "done")} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">
                      <Check className="h-4 w-4" aria-hidden="true" /> Done
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => void tick(item.id, "later")} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
                      <Clock className="h-4 w-4" aria-hidden="true" /> Later
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy !== null} onClick={() => void tick(item.id, "reopen")} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
                    <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && data.problems.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-xs">
          {data.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {data && !data.ticksReadable && <p className="mt-2 text-xs text-muted-foreground">The saved ticks could not be read, so every task shows as open for now.</p>}
      <div className="mt-3">
        <button type="button" onClick={() => void load(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted">
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Build the list again
        </button>
      </div>
    </div>
  )

  if (!collapsible) return <section aria-label="Daily follow-ups">{body}</section>
  return (
    <section aria-label="Daily follow-ups" className="mt-8 border-t pt-4">
      <button type="button" onClick={toggle} aria-expanded={open} aria-controls="followups-body" className="flex min-h-11 w-full items-center gap-2 text-left">
        {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
        <h2 className="text-xl font-bold">{headline}</h2>
      </button>
      {open ? <div className="mt-2">{body}</div> : null}
    </section>
  )
}
