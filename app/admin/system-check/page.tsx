"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { RefreshCw } from "lucide-react"
import type { CheckResult, CheckSummary } from "@/lib/system-check"
import { announceBadges, authHeaders } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// The automated system check: one list in funnel order. Each line is green, amber or red, with one plain sentence, the real
// number, what the site fixed by itself, and what needs you (with a link). The answer is read again at most every 5 minutes.

type Loaded = CheckResult & { summary: CheckSummary; cached: boolean; warning?: string }

const DOT: Record<string, string> = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500" }
const WORD: Record<string, string> = { green: "OK", amber: "Check", red: "Problem" }
const HEAD: Record<string, string> = { green: "All good", amber: "Worth a look", red: "Needs you" }
const FRAME: Record<string, string> = {
  green: "border-emerald-500/40 bg-emerald-500/5",
  amber: "border-amber-500/50 bg-amber-500/5",
  red: "border-red-500/50 bg-red-500/5",
}

export default function SystemCheckPage() {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (force = false) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/system-check${force ? "?force=1" : ""}`, { headers: authHeaders(), cache: "no-store" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`)
      setData(body as Loaded)
      announceBadges({ check: (body as Loaded).overall })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the system check.")
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">System check</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every part of the machine, in the order a visitor moves through it. Green is fine. Amber is worth a look. Red needs you.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void load(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" /> Check again
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {!data && !error && <div className="h-64 animate-pulse rounded-xl border bg-muted/40" aria-hidden="true" />}

      {data && (
        <>
          <section aria-label="Overall" className={cn("mb-4 rounded-lg border px-4 py-3", FRAME[data.overall])}>
            <p className="flex items-center gap-2 text-base font-semibold">
              <span className={cn("h-3 w-3 rounded-full", DOT[data.overall])} aria-hidden="true" />
              {HEAD[data.overall]}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {data.summary.counts.green} green, {data.summary.counts.amber} amber, {data.summary.counts.red} red. Checked {new Date(data.at).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })}
              {data.cached ? " (a saved answer under 5 minutes old)" : ""}.
            </p>
            {data.warning && <p className="mt-1 text-xs text-muted-foreground">{data.warning}</p>}
          </section>

          <ol className="space-y-3">
            {data.stages.map((s, i) => (
              <li key={s.id} className={cn("rounded-xl border bg-card p-3 sm:p-4", s.light === "red" && "border-red-500/50", s.light === "amber" && "border-amber-500/50")}>
                <div className="flex items-start gap-3">
                  <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h2 className="text-base font-semibold">
                        {s.label}
                        <span className="sr-only"> ({WORD[s.light]})</span>
                      </h2>
                      <span className={cn("h-2.5 w-2.5 rounded-full", DOT[s.light])} aria-hidden="true" />
                      <span className="text-xs text-muted-foreground">{s.light === "green" ? "OK" : s.light === "amber" ? "Check" : "Problem"}</span>
                      {s.number && <span className="ml-auto text-xs font-medium text-muted-foreground">{s.number}</span>}
                    </div>
                    <p className="mt-1 text-sm">{s.sentence}</p>
                    {s.fixed.length > 0 && (
                      <div className="mt-2 rounded-lg bg-emerald-500/5 p-2 text-sm">
                        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">What I fixed myself</p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5">
                          {s.fixed.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {s.needs && (
                      <p className="mt-2 text-sm">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs you: </span>
                        <Link href={s.needs.href} className="font-medium text-primary underline underline-offset-2">
                          {s.needs.text}
                        </Link>
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            Cards that need a yes or no are on <Link href="/admin" className="underline">Today</Link>. The list of daily tasks is on <Link href="/admin/follow-ups" className="underline">Daily follow-ups</Link>.
          </p>
        </>
      )}
    </div>
  )
}
