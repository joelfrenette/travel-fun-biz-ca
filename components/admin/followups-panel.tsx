"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Check, ClipboardCopy, Clock, ExternalLink, RefreshCw, Sparkles, Undo2 } from "lucide-react"
import type { Selection } from "@/lib/followups"
import { ASSIST_REGISTRY, assistKindFor, buildTaskPrompt, type AssistResult } from "@/lib/followups-actions"
import { announceBadges, authHeaders, copyText } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// The Daily follow-ups list, and nothing else (its own page). Each task has the reason it matters, a time guess, a link to open, and
// Done / Later. Where the machine can safely help there is a "Do this for me" button that drafts the words into a box on the task
// (nothing is ever sent or posted); every other task has "Copy for Claude", which copies a ready prompt for that one task.
// Done on a setup step or on a lead's step is kept for good; any other Done is for today. Later pushes the task to tomorrow.

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

const BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40"

export function FollowupsPanel() {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [assistBusy, setAssistBusy] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, AssistResult>>({})
  const [assistError, setAssistError] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string>("")

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

  async function assist(id: string, force = false) {
    if (assistBusy) return
    setAssistBusy(id)
    setAssistError((m) => ({ ...m, [id]: "" }))
    try {
      const res = await fetch("/api/admin/follow-ups/assist", { method: "POST", headers: authHeaders(), body: JSON.stringify({ id, force }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`)
      setResults((m) => ({ ...m, [id]: body.result as AssistResult }))
    } catch (e) {
      setAssistError((m) => ({ ...m, [id]: e instanceof Error ? e.message : "That did not work. Please try again." }))
    } finally {
      setAssistBusy(null)
    }
  }

  async function copy(key: string, text: string) {
    setCopied((await copyText(text)) ? key : `fail:${key}`)
  }

  return (
    <section aria-label="Daily follow-ups">
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
          {data.items.map((item) => {
            const kind = assistKindFor(item)
            const result = results[item.id]
            const failed = assistError[item.id]
            const promptKey = `prompt:${item.id}`
            return (
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
                  {kind ? (
                    <button type="button" data-testid="do-for-me" disabled={assistBusy !== null || item.mark !== "open"} onClick={() => void assist(item.id)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40" title={ASSIST_REGISTRY[kind].promise}>
                      <Sparkles className={cn("h-4 w-4", assistBusy === item.id && "animate-pulse")} aria-hidden="true" /> {assistBusy === item.id ? "Working..." : ASSIST_REGISTRY[kind].button}
                    </button>
                  ) : (
                    <button type="button" data-testid="copy-for-claude" onClick={() => void copy(promptKey, buildTaskPrompt(item, new Date(), window.location.origin))} className={BTN}>
                      <ClipboardCopy className="h-4 w-4" aria-hidden="true" /> {copied === promptKey ? "Copied" : "Copy for Claude"}
                    </button>
                  )}
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
                      <button type="button" disabled={busy !== null} onClick={() => void tick(item.id, "later")} className={BTN}>
                        <Clock className="h-4 w-4" aria-hidden="true" /> Later
                      </button>
                    </>
                  ) : (
                    <button type="button" disabled={busy !== null} onClick={() => void tick(item.id, "reopen")} className={BTN}>
                      <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo
                    </button>
                  )}
                </div>

                {failed && (
                  <div role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <p>{failed}</p>
                    <button type="button" onClick={() => void copy(promptKey, buildTaskPrompt(item, new Date(), window.location.origin))} className={cn(BTN, "mt-2 text-foreground")}>
                      <ClipboardCopy className="h-4 w-4" aria-hidden="true" /> {copied === promptKey ? "Copied" : "Copy for Claude instead"}
                    </button>
                  </div>
                )}

                {result && (
                  <div data-testid="assist-result" className="mt-3 rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{result.title}</p>
                    {result.note && <p className="mt-1 text-xs text-muted-foreground">{result.note}</p>}
                    {result.blocks.map((b, i) => {
                      const key = `${item.id}:${i}`
                      return (
                        <div key={key} className="mt-2">
                          <p className="text-xs font-medium">{b.label}</p>
                          <textarea readOnly rows={Math.min(12, Math.max(3, b.text.split("\n").length + 1))} value={b.text} onFocus={(e) => e.currentTarget.select()} className="mt-1 w-full rounded-md border bg-background p-2 text-sm" />
                          <button type="button" onClick={() => void copy(key, b.text)} className={cn(BTN, "mt-1")}>
                            <ClipboardCopy className="h-4 w-4" aria-hidden="true" /> {copied === key ? "Copied" : copied === `fail:${key}` ? "Select the text and copy it" : "Copy"}
                          </button>
                        </div>
                      )
                    })}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.mark === "open" && (
                        <button type="button" disabled={busy !== null} onClick={() => void tick(item.id, "done")} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">
                          <Check className="h-4 w-4" aria-hidden="true" /> Done
                        </button>
                      )}
                      <button type="button" disabled={assistBusy !== null} onClick={() => void assist(item.id, true)} className={BTN}>
                        <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {data && !data.ticksReadable && <p className="mt-2 text-xs text-muted-foreground">The saved ticks could not be read, so every task shows as open for now.</p>}
      <div className="mt-3">
        <button type="button" onClick={() => void load(true)} className={BTN}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Build the list again
        </button>
      </div>
    </section>
  )
}
