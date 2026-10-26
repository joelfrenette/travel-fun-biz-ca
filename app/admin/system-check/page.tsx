"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { ArrowRight, ClipboardCopy, RefreshCw, Wand2 } from "lucide-react"
import type { CheckResult, CheckSummary } from "@/lib/system-check"
import type { FixSummary, FixView } from "@/lib/system-check-fixes"
import { buildClaudePrompt, type CheckDiff, type HealReport } from "@/lib/system-check-prompt"
import { announceBadges, authHeaders, checkAlreadyRanToday, copyText, markCheckRan } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// The automated system check: one list in funnel order. Each line is green, amber or red, with one plain sentence, the real
// number, what the site fixed by itself, and what needs you (with a link). The answer is read again at most every 5 minutes.

type HealAnswer = { report: HealReport; cooledDown: boolean; cooldownSeconds: number; diff: CheckDiff }
type Loaded = CheckResult & { summary: CheckSummary; cached: boolean; warning?: string; fixes: FixView[]; fixSummary: FixSummary; heal?: HealAnswer }

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
  const [phase, setPhase] = useState<"idle" | "check" | "heal">("idle")
  const [heal, setHeal] = useState<HealAnswer | null>(null)
  const [copied, setCopied] = useState<"" | "ok" | "fail">("")
  const [promptText, setPromptText] = useState("")

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
  const load = useCallback(async (force = false, op: "run" | "heal" = "run") => {
    setBusy(true)
    setPhase(op === "heal" ? "heal" : "check")
    try {
      const res = force
        ? await fetch("/api/admin/system-check", { method: "POST", headers: authHeaders(), body: JSON.stringify({ op }), cache: "no-store" })
        : await fetch("/api/admin/system-check", { headers: authHeaders(), cache: "no-store" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`)
      const next = body as Loaded
      setData(next)
      if (next.heal) setHeal(next.heal)
      setCopied("")
      announceBadges({ check: next.overall })
      setError(null)
      if (force) markCheckRan()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the system check.")
    } finally {
      setBusy(false)
      setPhase("idle")
    }
  }, [])

  // On a new login (or a new tab, or a new day) the check runs fresh by itself, once. After that, moving around the admin only
  // reads the saved answer.
  useEffect(() => {
    void load(!checkAlreadyRanToday())
  }, [load])

  // Always built from the check on screen right now, so a plain "Run check now" after an Auto-heal never copies a stale list.
  function currentPrompt(d: Loaded): string {
    return buildClaudePrompt({ now: new Date(), check: d, heal: heal?.report ?? null, diff: heal?.diff ?? null, siteUrl: window.location.origin })
  }

  async function copyForClaude() {
    if (!data) return
    const text = currentPrompt(data)
    setPromptText(text)
    setCopied((await copyText(text)) ? "ok" : "fail")
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            {data && <span className={cn("h-3.5 w-3.5 shrink-0 rounded-full", DOT[data.overall])} aria-hidden="true" />}
            System check
            {data && <span className="sr-only"> ({HEAD[data.overall]})</span>}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Every part of the machine, in the order a visitor moves through it. Green is fine. Amber is worth a look. Red needs you.</p>
        </div>
      </div>

      {/* One row for every button; it wraps on a narrow screen. Copy all to Claude is always here once the check has loaded, with or without an Auto-heal run. */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="check-actions">
        <button
          type="button"
          disabled={busy || !data}
          onClick={() => void load(true, "heal")}
          data-testid="auto-heal"
          title="Runs the safe repairs the site already makes by itself, once, then checks again"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          <Wand2 className={cn("h-4 w-4", phase === "heal" && "animate-pulse")} aria-hidden="true" /> {phase === "heal" ? "Healing..." : "Auto-heal"}
        </button>
        <button type="button" disabled={busy} onClick={() => void load(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
          <RefreshCw className={cn("h-4 w-4", phase === "check" && "animate-spin")} aria-hidden="true" /> Run check now
        </button>
        <button
          type="button"
          disabled={!data}
          onClick={() => void copyForClaude()}
          data-testid="copy-for-claude"
          title="Copies one prompt that tells Claude Code to fix every issue below, with the full identify, fix, test, monitor and rule loop"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary/50 px-3 text-sm font-medium text-primary hover:bg-muted disabled:opacity-40"
        >
          <ClipboardCopy className="h-4 w-4" aria-hidden="true" /> {copied === "ok" ? "Copied. Paste it into Claude Code" : "Copy all to Claude"}
        </button>
        <Link href="/admin" data-testid="skip" className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm hover:bg-muted">
          Skip
        </Link>
        {data && !busy && (
          <Link href="/admin" data-testid="continue" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white hover:bg-emerald-700">
            Continue to admin <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}
      </div>

      {busy && (
        <p role="status" aria-live="polite" data-testid="check-progress" className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          {phase === "heal" ? "Auto-heal is making the safe repairs, then may use a little AI on up to 3 pages, then checks again. This can take a few minutes." : "Running a fresh check of every stage..."}
        </p>
      )}
      {copied === "fail" && data && (
        <div className="mb-4">
          <p role="alert" className="mb-1 text-sm text-destructive">Your browser blocked copying. Select this text and copy it yourself.</p>
          <textarea readOnly rows={8} value={promptText} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-lg border bg-muted/40 p-2 font-mono text-xs" />
        </div>
      )}
      {heal && !busy && (
        <section aria-label="Auto-heal result" data-testid="heal-result" className="mb-4 rounded-lg border bg-card p-3 text-sm">
          <p className="font-semibold">
            Auto-heal finished: {heal.diff.fixed.length} fixed, {heal.diff.stillOpen.length} still open{heal.diff.newlyWorse.length ? `, ${heal.diff.newlyWorse.length} newly worse` : ""}.
          </p>
          {heal.cooledDown && <p className="mt-1 text-xs text-muted-foreground">It ran a moment ago, so this is that answer ({heal.cooldownSeconds}s before it can run again).</p>}
          {heal.report.paused && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Automation is paused, so nothing was repaired.</p>}
          {heal.diff.fixed.length > 0 && <p className="mt-1">Fixed: {heal.diff.fixed.map((f) => f.label).join(", ")}.</p>}
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {heal.report.steps.map((st) => (
              <li key={st.id}>
                {st.label}: {st.ran ? (st.acted ? `changed ${st.acted}` : "nothing to change") : "skipped"}
                {st.note ? `. ${st.note}` : ""}
              </li>
            ))}
          </ul>
          {heal.report.ai && (
            <div data-testid="heal-ai" className="mt-2 rounded-md border bg-muted/30 p-2 text-xs">
              <p className="font-semibold">AI fix step: about {heal.report.ai.calls} AI call{heal.report.ai.calls === 1 ? "" : "s"} used (at most 3 pages per click)</p>
              {heal.report.ai.skipped && <p className="mt-1 text-muted-foreground">Did not run: {heal.report.ai.skipped}</p>}
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {heal.report.ai.items.map((it) => (
                  <li key={it.kind}>
                    {it.label}: {it.status === "fixed" ? `AI fixed ${it.changed} (about ${it.calls} calls, with Undo)` : it.status === "tried" ? `AI tried, changed nothing (about ${it.calls} calls)` : "skipped"}
                    {it.note ? `. ${it.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Every repair is in the Autopilot decisions log with an Undo. Press Copy for Claude to hand what is left to Claude Code.</p>
        </section>
      )}

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
