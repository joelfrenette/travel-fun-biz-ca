"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { RefreshCw } from "lucide-react"
import type { CheckResult, CheckSummary } from "@/lib/system-check"
import type { FixSummary, FixView } from "@/lib/system-check-fixes"
import { announceBadges, authHeaders } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// The automated system check: one list in funnel order. Each line is green, amber or red, with one plain sentence, the real
// number, what the site fixed by itself, and what needs you (with a link). The answer is read again at most every 5 minutes.

type Loaded = CheckResult & { summary: CheckSummary; cached: boolean; warning?: string; fixes: FixView[]; fixSummary: FixSummary }

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

  const [tickBusy, setTickBusy] = useState<string | null>(null)

  async function tick(stage: string, op: "done" | "later" | "reopen") {
    setTickBusy(stage)
    try {
      const res = await fetch("/api/admin/system-check", { method: "POST", headers: authHeaders(), body: JSON.stringify({ op, stage }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`)
      setData((d) => (d ? { ...d, fixes: body.fixes as FixView[], fixSummary: body.fixSummary as FixSummary } : d))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that tick.")
    } finally {
      setTickBusy(null)
    }
  }

  // "Run check now" is a POST: it reads everything again and saves the answer. The first load is a plain GET (a saved answer under 5 minutes old is reused).
  const load = useCallback(async (force = false) => {
    setBusy(true)
    try {
      const res = force
        ? await fetch("/api/admin/system-check", { method: "POST", headers: authHeaders(), body: JSON.stringify({ op: "run" }), cache: "no-store" })
        : await fetch("/api/admin/system-check", { headers: authHeaders(), cache: "no-store" })
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
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" /> Run check now
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

          <section aria-labelledby="fix-heading" data-testid="fix-list" className="mt-6 rounded-xl border bg-card p-3 sm:p-4">
            <h2 id="fix-heading" className="text-lg font-bold">Fix these today</h2>
            {data.fixes.length === 0 ? (
              <p className="mt-2 flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                <span className="h-3 w-3 rounded-full bg-emerald-500" aria-hidden="true" />
                All clear. Nothing needs fixing today.
              </p>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  {data.fixSummary.open > 0 ? `${data.fixSummary.open} of ${data.fixSummary.total} still to do, biggest first.` : "Every fix is ticked for today. They come back tomorrow if the stage is still not green."} Tap the button to go to the page that fixes it.
                </p>
                <ol className="mt-3 space-y-2">
                  {data.fixes.map((f, i) => (
                    <li key={f.id} className={cn("rounded-lg border p-3", f.mark !== "open" && "bg-muted/40", f.light === "red" ? "border-red-500/40" : "border-amber-500/40")}>
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold" aria-hidden="true">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className={cn("flex flex-wrap items-center gap-x-2 text-sm font-semibold", f.mark === "done" && "line-through opacity-70")}>
                            <span className={cn("h-2.5 w-2.5 rounded-full", DOT[f.light])} aria-hidden="true" />
                            {f.label}
                            <span className="text-xs font-normal text-muted-foreground">{WORD[f.light]}{f.mark === "done" ? ", done for today" : f.mark === "later" ? ", pushed to Later" : ""}</span>
                          </p>
                          <p className={cn("mt-1 text-sm", f.mark === "done" && "opacity-70")}>{f.sentence}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Link href={f.to.href} className="inline-flex min-h-11 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">
                              {f.to.text}
                            </Link>
                            {f.mark === "open" ? (
                              <>
                                <button type="button" disabled={tickBusy === f.stage} onClick={() => void tick(f.stage, "done")} className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
                                  Done
                                </button>
                                <button type="button" disabled={tickBusy === f.stage} onClick={() => void tick(f.stage, "later")} className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
                                  Later
                                </button>
                              </>
                            ) : (
                              <button type="button" disabled={tickBusy === f.stage} onClick={() => void tick(f.stage, "reopen")} className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
                                Undo
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-muted-foreground">A tick counts for today only. After you fix something, press Run check now to see it turn green.</p>
              </>
            )}
          </section>

          <p className="mt-4 text-xs text-muted-foreground">
            Cards that need a yes or no are on <Link href="/admin" className="underline">Today</Link>. The list of daily tasks is on <Link href="/admin/follow-ups" className="underline">Daily follow-ups</Link>.
          </p>
        </>
      )}
    </div>
  )
}
