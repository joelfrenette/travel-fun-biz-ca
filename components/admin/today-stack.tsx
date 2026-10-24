"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, ExternalLink, Clock, Undo2, X, ArrowRight } from "lucide-react"
import { GROUP_LABEL, TODAY_KINDS, actionFor, needsConfirm } from "@/lib/today-cards"
import { SystemCheckStrip } from "@/components/admin/system-check-strip"
import { authHeaders, fetchToday, type TodayData } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// Today: the system check, then the swipe cards. One card at a time. Swipe right (or the right arrow, or the right
// button) is the yes; swipe left (or the left arrow, or the left button) is the no; Later hides the card for a few
// days; Undo takes back the last step where that is possible. A button that cannot be undone asks for a second tap.

const SWIPE_PX = 100
type Op = "approve" | "reject" | "snooze"

export function TodayStack() {
  const router = useRouter()
  const [data, setData] = useState<TodayData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const [noteBad, setNoteBad] = useState(false)
  const [confirming, setConfirming] = useState<{ id: string; op: Op } | null>(null)
  const [dx, setDx] = useState(0)
  const startX = useRef<number | null>(null)
  const startY = useRef<number | null>(null)
  const dragging = useRef(false)

  const load = useCallback(async (force = false) => {
    try {
      setData(await fetchToday(force))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load Today.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const card = data?.cards[0] ?? null
  const def = card ? TODAY_KINDS[card.kind] : null

  // A pending "tap again to confirm" never outlives the card it was for, or a few seconds.
  useEffect(() => {
    if (!confirming) return
    if (confirming.id !== card?.id) {
      setConfirming(null)
      return
    }
    const t = setTimeout(() => setConfirming(null), 6000)
    return () => clearTimeout(t)
  }, [confirming, card?.id])

  const say = (text: string, bad = false) => {
    setNote(text)
    setNoteBad(bad)
  }

  const decide = useCallback(
    async (op: Op) => {
      if (busy || !card || !def) return
      // The left side of a card with one real answer means Later.
      const effective: Op = op === "reject" && !def.secondary ? "snooze" : op
      if (effective !== "snooze") {
        const need = needsConfirm(card.kind, effective)
        if (need && !(confirming && confirming.id === card.id && confirming.op === effective)) {
          setConfirming({ id: card.id, op: effective })
          say(`"${actionFor(card.kind, effective)?.label}" cannot be undone. Tap it again to confirm.`, true)
          setDx(0)
          return
        }
      }
      setBusy(true)
      say("")
      try {
        const res = await fetch("/api/admin/today", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ id: card.id, kind: card.kind, op: effective, title: card.title, ...(confirming?.id === card.id && confirming.op === effective ? { confirm: true } : {}) }),
        })
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string; warning?: string }
        if (!res.ok) {
          say(body.error ?? "That did not work. Please try again.", true)
        } else {
          say([body.message ?? "Done.", body.warning].filter(Boolean).join(" "))
          const action = effective === "snooze" ? null : actionFor(card.kind, effective)
          if (action?.mode === "open" && card.link?.href) {
            setConfirming(null)
            router.push(card.link.href)
            return
          }
        }
        setConfirming(null)
        await load(true)
      } catch {
        say("Could not reach the server. Please try again.", true)
      } finally {
        setBusy(false)
        setDx(0)
      }
    },
    [busy, card, def, confirming, load, router],
  )

  const undo = useCallback(async () => {
    if (busy) return
    setBusy(true)
    say("")
    try {
      const res = await fetch("/api/admin/today", { method: "POST", headers: authHeaders(), body: JSON.stringify({ op: "undo" }) })
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
      say(res.ok ? body.message ?? "Undone." : body.error ?? "Could not undo.", !res.ok)
      await load(true)
    } catch {
      say("Could not reach the server. Please try again.", true)
    } finally {
      setBusy(false)
    }
  }, [busy, load])

  // Keyboard: left and right arrows decide, down is Later, U undoes. Not while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "ArrowRight") void decide("approve")
      else if (e.key === "ArrowLeft") void decide("reject")
      else if (e.key === "ArrowDown") {
        e.preventDefault()
        void decide("snooze")
      } else if (e.key === "u" || e.key === "U") void undo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [decide, undo])

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("a,button")) return
    startX.current = e.clientX
    startY.current = e.clientY
    dragging.current = false
  }
  const onMove = (e: React.PointerEvent) => {
    if (startX.current === null || startY.current === null) return
    const mx = e.clientX - startX.current
    const my = e.clientY - startY.current
    if (!dragging.current) {
      if (Math.abs(mx) < 8 || Math.abs(mx) < Math.abs(my)) return
      dragging.current = true
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    }
    setDx(mx)
  }
  const onUp = () => {
    const moved = dx
    const was = dragging.current
    startX.current = null
    startY.current = null
    dragging.current = false
    if (!was) return
    if (moved > SWIPE_PX) void decide("approve")
    else if (moved < -SWIPE_PX) void decide("reject")
    else setDx(0)
  }

  const last = data?.lastAction ?? null
  const left = data ? data.count : null
  const confirmingOp = confirming && card && confirming.id === card.id ? confirming.op : null

  const label = (op: "approve" | "reject") => {
    if (!card || !def) return ""
    if (op === "reject" && !def.secondary) return "Later"
    const a = actionFor(card.kind, op)
    if (!a) return ""
    return confirmingOp === op ? "Tap again to confirm" : a.label
  }
  const hint = (op: "approve" | "reject") => {
    if (!card || !def) return ""
    if (op === "reject" && !def.secondary) return `Hides this card for ${def.snoozeDays} day${def.snoozeDays === 1 ? "" : "s"}.`
    const a = actionFor(card.kind, op)
    if (!a) return ""
    const cannot = a.mode === "run" && needsConfirm(card.kind, op) ? " It cannot be undone." : ""
    return `${a.hint}${cannot}`
  }

  return (
    <section aria-label="Today" className="mx-auto w-full max-w-xl">
      <SystemCheckStrip system={data?.system ?? null} />

      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-2xl font-bold">Today</h2>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {left === null ? "Loading..." : left === 0 ? "Nothing left" : `${left} left today`}
        </p>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Swipe right for yes, left for no. Or use the arrow keys or the two big buttons. Later hides a card for a few days.
      </p>

      {loadError && <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{loadError}</p>}
      <p role="status" aria-live="polite" className={cn("mb-3 min-h-0 rounded-lg border p-3 text-sm", note ? "block" : "hidden", noteBad ? "border-destructive/40 bg-destructive/10 text-destructive" : "bg-muted text-foreground")}>
        {note}
      </p>

      {!data && !loadError && <div className="h-64 animate-pulse rounded-xl border bg-muted/40" aria-hidden="true" />}

      {data && !card && (
        <div className="rounded-xl border bg-card p-6 text-center">
          <h3 className="text-xl font-semibold">All clear. The machine has it.</h3>
          <p className="mt-1 text-sm text-muted-foreground">Nothing needs your yes or no right now.</p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-left sm:grid-cols-4">
            {[
              ["Posts published", data.wins.postsPublished],
              ["Social posts sent", data.wins.socialSent],
              ["Guides written", data.wins.guidesWritten],
              ["New leads", data.wins.leads],
            ].map(([name, value]) => (
              <div key={name as string} className="rounded-lg bg-muted/50 p-3">
                <dd className="text-2xl font-bold leading-none">{value === null ? "n/a" : (value as number)}</dd>
                <dt className="mt-1 text-xs text-muted-foreground">{name as string} today</dt>
              </div>
            ))}
          </dl>
          {data.snoozedCount > 0 && <p className="mt-3 text-xs text-muted-foreground">{data.snoozedCount} card{data.snoozedCount === 1 ? " is" : "s are"} hidden until later.</p>}
        </div>
      )}

      {card && def && (
        <div className="relative">
          <div
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => {
              startX.current = null
              startY.current = null
              dragging.current = false
              setDx(0)
            }}
            style={{ transform: `translateX(${dx}px) rotate(${dx / 50}deg)`, touchAction: "pan-y", transition: dragging.current ? "none" : "transform 0.2s" }}
            className={cn(
              "select-none rounded-xl border-2 bg-card p-4 shadow-sm motion-reduce:transition-none sm:p-5",
              dx > SWIPE_PX ? "border-emerald-500" : dx < -SWIPE_PX ? "border-red-500" : "border-border",
            )}
            data-testid="today-card"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">{def.badge}</span>
              <span className="text-xs text-muted-foreground">{GROUP_LABEL[def.group]}</span>
            </div>
            <h3 className="break-words text-xl font-bold leading-snug">{card.title}</h3>
            <p className="mt-2 text-sm">{card.why}</p>
            {card.facts.length > 0 && (
              <dl className="mt-3 space-y-1.5 text-sm">
                {card.facts.map((f) => (
                  <div key={f.label} className="grid grid-cols-[6.5rem_1fr] gap-2">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className="min-w-0 break-words">{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {card.link && (
              <a
                href={card.link.href}
                {...(/^https?:/.test(card.link.href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="mt-3 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-2"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" /> {card.link.label}
              </a>
            )}
          </div>
        </div>
      )}

      {card && def && (
        <>
          <div className="sticky bottom-[3.75rem] z-30 mt-4 grid grid-cols-2 gap-3 bg-background/95 py-2 md:static md:bg-transparent md:py-0">
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("reject")}
              aria-describedby="today-hint-no"
              className={cn(
                "inline-flex min-h-16 items-center justify-center gap-2 rounded-xl border-2 px-2 py-3 text-base font-semibold disabled:opacity-40 sm:text-lg",
                def.secondary?.mode === "run" ? "border-red-600 text-red-700 hover:bg-red-600/10 dark:text-red-400" : "border-border text-foreground hover:bg-muted",
                confirmingOp === "reject" && "bg-red-600 text-white hover:bg-red-700 dark:text-white",
              )}
            >
              {def.secondary ? <X className="h-5 w-5 shrink-0" aria-hidden="true" /> : <Clock className="h-5 w-5 shrink-0" aria-hidden="true" />}
              <span>{label("reject")}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("approve")}
              aria-describedby="today-hint-yes"
              className={cn(
                "inline-flex min-h-16 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-2 py-3 text-base font-semibold text-white hover:bg-emerald-700 disabled:opacity-40 sm:text-lg",
                confirmingOp === "approve" && "ring-4 ring-emerald-300",
              )}
            >
              {def.primary.mode === "open" ? <ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" /> : <Check className="h-5 w-5 shrink-0" aria-hidden="true" />}
              <span>{label("approve")}</span>
            </button>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <p id="today-hint-no">{hint("reject")}</p>
            <p id="today-hint-yes">{hint("approve")}</p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {def.secondary && (
              <button type="button" disabled={busy} onClick={() => void decide("snooze")} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-muted disabled:opacity-40">
                <Clock className="h-4 w-4" aria-hidden="true" /> Later ({def.snoozeDays} day{def.snoozeDays === 1 ? "" : "s"})
              </button>
            )}
          </div>
        </>
      )}

      {data && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <button type="button" disabled={busy || !last || !last.undoable} onClick={() => void undo()} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 hover:bg-muted disabled:opacity-40">
            <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo last
          </button>
          {last && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Last: {last.op === "approve" ? "yes" : last.op === "reject" ? "no" : "later"} on {last.title}
              {!last.undoable && " (cannot be undone)"}
            </span>
          )}
          {data.snoozedCount > 0 && card && <span className="text-xs text-muted-foreground">{data.snoozedCount} hidden until later</span>}
        </div>
      )}

      {data && data.problems.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-xs">
          {data.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

