"use client"

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, ExternalLink, Clock, Undo2, X, ArrowRight, ChevronLeft, SkipForward, Wrench, ClipboardCopy } from "lucide-react"
import { GROUP_LABEL, TODAY_KINDS, actionFor, needsConfirm } from "@/lib/today-cards"
import { DEFAULT_SNOOZE_DAYS, SNOOZE_CHOICES, applySession, canGoBack, emptySession, openTargetFor, parseSkipped, rowTwoFor, sessionReducer, undoOffered, type CardHealResult } from "@/lib/today-card-actions"
import { buildCardPrompt } from "@/lib/today-card-prompt"
import { authHeaders, copyText, fetchToday, type TodayData } from "@/components/admin/today-client"
import { cn } from "@/lib/utils"

// Today: the system check, then the swipe cards. One card at a time. Row 1 is the two big buttons: swipe right (or the right
// arrow, or the right button) is the yes; swipe left (or the left arrow, or the left button) is the no. Row 2 is smaller and
// conditional: Previous, Later, Skip, Auto-heal, Copy for Claude and Undo last. A button that cannot be undone asks for a second tap.

const SWIPE_PX = 100
const SKIPPED_KEY = "todaySkipped"
type Op = "approve" | "reject" | "snooze"

const ROW2_BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-transparent px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"

export function TodayStack() {
  const router = useRouter()
  const [data, setData] = useState<TodayData | null>(null)
  const [session, dispatch] = useReducer(sessionReducer, undefined, emptySession)
  const [heals, setHeals] = useState<Record<string, CardHealResult>>({})
  const [healing, setHealing] = useState<string | null>(null)
  const [rowNote, setRowNote] = useState("")
  const [copied, setCopied] = useState(false)
  const [laterOpen, setLaterOpen] = useState(false)
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

  // Skipped cards live in this browser session only (sessionStorage): no snooze, no log entry, nothing sent to the server.
  useEffect(() => {
    try {
      for (const id of parseSkipped(sessionStorage.getItem(SKIPPED_KEY))) dispatch({ type: "skip", id })
    } catch {
      // blocked storage: skips just last until the page is reloaded
    }
  }, [])
  const skippedKey = session.skipped.join("|")
  useEffect(() => {
    try {
      sessionStorage.setItem(SKIPPED_KEY, JSON.stringify(session.skipped))
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skippedKey])

  const ordered = useMemo(() => (data ? applySession(data.cards, session) : []), [data, session])
  const liveCard = ordered[0] ?? null
  const readOnly = !!session.viewing
  const card = session.viewing ? session.viewing.card : liveCard
  const def = card ? TODAY_KINDS[card.kind] : null

  // Remember each card the moment it is on screen, so Previous can come back to it.
  const liveCardRef = liveCard
  useEffect(() => {
    if (liveCardRef && !session.viewing) dispatch({ type: "shown", card: liveCardRef })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCardRef?.id, session.viewing])

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
    async (op: Op, days?: number) => {
      if (busy || !card || !def || readOnly) return
      setLaterOpen(false)
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
          body: JSON.stringify({ id: card.id, kind: card.kind, op: effective, title: card.title, ...(effective === "snooze" && days ? { days } : {}), ...(confirming?.id === card.id && confirming.op === effective ? { confirm: true } : {}) }),
        })
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string; warning?: string }
        if (!res.ok) {
          say(body.error ?? "That did not work. Please try again.", true)
        } else {
          say([body.message ?? "Done.", body.warning].filter(Boolean).join(" "))
          const action = effective === "snooze" ? null : actionFor(card.kind, effective)
          dispatch({ type: "answered", id: card.id, op: effective, label: action?.label ?? `Later (${SNOOZE_CHOICES.find((c) => c.days === days)?.label ?? `${def.snoozeDays} day${def.snoozeDays === 1 ? "" : "s"}`})` })
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
    [busy, card, def, readOnly, confirming, load, router, setLaterOpen],
  )

  const undo = useCallback(async () => {
    if (busy) return
    setBusy(true)
    say("")
    try {
      const undoneId = data?.lastAction && data.lastAction.undoable ? data.lastAction.id : null
      const res = await fetch("/api/admin/today", { method: "POST", headers: authHeaders(), body: JSON.stringify({ op: "undo" }) })
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
      say(res.ok ? body.message ?? "Undone." : body.error ?? "Could not undo.", !res.ok)
      await load(true)
      // The card is back in the queue on the server; show it again first.
      if (res.ok && undoneId) dispatch({ type: "unanswered", id: undoneId })
    } catch {
      say("Could not reach the server. Please try again.", true)
    } finally {
      setBusy(false)
    }
  }, [busy, data, load])

  // Previous: go back one card in this session. A card already answered is shown read-only (never silently re-answered).
  const canPrev = canGoBack(session, card?.id ?? null)
  const previous = useCallback(() => {
    if (!card || !canGoBack(session, card.id)) return
    setRowNote("")
    dispatch({ type: "previous", currentId: card.id, liveIds: (data?.cards ?? []).map((c) => c.id) })
  }, [card, session, data])

  // Skip: send this card to the end of today's stack for this browser session. No server call, no snooze, no log entry.
  const skip = useCallback(() => {
    if (readOnly || !liveCard || ordered.length < 2) return
    dispatch({ type: "skip", id: liveCard.id })
    setRowNote("Skipped for now. It moved to the end of today's stack. Nothing was saved.")
  }, [readOnly, liveCard, ordered.length])

  // Auto-heal: one call per card per click; an answer already on screen is reused, and the server keeps it for the day.
  const autoHeal = useCallback(async () => {
    if (!card || readOnly || healing) return
    const known = heals[card.id]
    if (known && known.state !== "skipped") return
    setHealing(card.id)
    try {
      const res = await fetch("/api/admin/today/heal", { method: "POST", headers: authHeaders(), body: JSON.stringify({ id: card.id }) })
      const body = (await res.json().catch(() => ({}))) as { result?: CardHealResult; error?: string }
      const result: CardHealResult = res.ok && body.result ? body.result : { state: "failed", message: body.error ?? "Auto-heal did not work. Please try again.", at: "" }
      setHeals((h) => ({ ...h, [card.id]: result }))
    } catch {
      setHeals((h) => ({ ...h, [card.id]: { state: "failed", message: "Could not reach the server. Please try again.", at: "" } }))
    } finally {
      setHealing(null)
    }
  }, [card, readOnly, healing, heals])

  const copyForClaude = useCallback(async () => {
    if (!card) return
    const h = heals[card.id]
    const ok = await copyText(buildCardPrompt({ now: new Date(), card, heal: h ? { state: h.state, message: h.message } : null, siteUrl: typeof window !== "undefined" ? window.location.origin : undefined }))
    setCopied(ok)
    setRowNote(ok ? "Copied. Paste it into Claude Code." : "Could not copy. Your browser blocked the clipboard.")
    if (ok) setTimeout(() => setCopied(false), 2500)
  }, [card, heals])

  // Keyboard: left and right arrows decide, down or L is Later, P previous, S skip, U undoes. Not while typing in a field.
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
      } else if (e.key === "l" || e.key === "L") void decide("snooze", DEFAULT_SNOOZE_DAYS)
      else if (e.key === "Escape") setLaterOpen(false)
      else if (e.key === "p" || e.key === "P") previous()
      else if (e.key === "s" || e.key === "S") skip()
      else if (e.key === "u" || e.key === "U") void undo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [decide, undo, previous, skip])

  const onDown = (e: React.PointerEvent) => {
    if (readOnly || (e.target as HTMLElement).closest("a,button")) return
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
  const heal = card ? heals[card.id] ?? null : null
  const target = card ? openTargetFor(card) : null
  const row2 = card ? rowTwoFor(card.kind, { canGoBack: canPrev, readOnly, hasTarget: !!target }) : null

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
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-2xl font-bold">Today</h2>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {left === null ? "Loading..." : left === 0 ? "Nothing left" : `${left} left today`}
        </p>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Swipe right for yes, left for no. Or use the arrow keys or the two big buttons. The smaller buttons below are extra options for this card.
      </p>

      {loadError && <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{loadError}</p>}
      <p role="status" aria-live="polite" className={cn("mb-3 min-h-0 rounded-lg border p-3 text-sm", note ? "block" : "hidden", noteBad ? "border-destructive/40 bg-destructive/10 text-destructive" : "bg-muted text-foreground")}>
        {note}
      </p>

      {!data && !loadError && <div className="h-64 animate-pulse rounded-xl border bg-muted/40" aria-hidden="true" />}

      {data && !card && (
        <div className="rounded-xl border bg-card p-6 text-center" data-testid="today-empty">
          <h3 className="text-xl font-semibold">All done for today</h3>
          <p className="mt-1 text-sm text-muted-foreground">Nothing needs your yes or no right now.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Link href="/admin/follow-ups" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90">
              Daily follow-ups <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <Link href="/admin/dashboard" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
              Dashboard <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          {data.snoozedCount > 0 && <p className="mt-3 text-xs text-muted-foreground">{data.snoozedCount} card{data.snoozedCount === 1 ? " is" : "s are"} hidden until later.</p>}
        </div>
      )}

      {card && def && session.viewing && (
        <div role="status" className="mb-3 rounded-lg border bg-muted/60 p-3 text-sm" data-testid="today-readonly">
          <p>
            Earlier card, shown read-only. You answered it: <strong>{session.viewing.outcome?.label ?? "no answer yet"}</strong>.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {undoOffered(session.viewing, last) ? (
              <button type="button" disabled={busy} onClick={() => void undo()} className={ROW2_BTN}>
                <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo this answer
              </button>
            ) : (
              <span className="text-muted-foreground">It cannot be undone from here. Only the very last step can be undone.</span>
            )}
            <button type="button" onClick={() => dispatch({ type: "closeView" })} className={ROW2_BTN}>
              <ArrowRight className="h-4 w-4" aria-hidden="true" /> Back to today&apos;s card
            </button>
          </div>
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

      {card && def && row2 && (
        <>
          <div className="sticky bottom-[3.75rem] z-30 mt-4 grid grid-cols-2 gap-3 bg-background/95 py-2 md:static md:bg-transparent md:py-0">
            <button
              type="button"
              disabled={busy || readOnly}
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
              disabled={busy || readOnly}
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
          <div role="group" aria-label="More options for this card" className="mt-3 flex flex-wrap items-center gap-2" data-testid="today-row2">
            {row2.previous && (
              <button type="button" disabled={busy} onClick={previous} className={ROW2_BTN} aria-keyshortcuts="P">
                <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
              </button>
            )}
            {row2.later && (
              <span className="relative inline-flex" data-testid="today-later">
                <button type="button" disabled={busy} onClick={() => void decide("snooze", DEFAULT_SNOOZE_DAYS)} className={cn(ROW2_BTN, "rounded-r-none border-r-0")} aria-keyshortcuts="L">
                  <Clock className="h-4 w-4" aria-hidden="true" /> Later (1 day)
                </button>
                <button type="button" disabled={busy} onClick={() => setLaterOpen((o) => !o)} aria-haspopup="menu" aria-expanded={laterOpen} aria-label="Choose how long to hide this card" className={cn(ROW2_BTN, "min-w-11 justify-center rounded-l-none px-2")}>
                  <span aria-hidden="true">&#9662;</span>
                </button>
                {laterOpen && (
                  <div role="menu" aria-label="Hide this card for" className="absolute bottom-full left-0 z-40 mb-1 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                    {SNOOZE_CHOICES.map((c) => (
                      <button key={c.days} type="button" role="menuitem" onClick={() => void decide("snooze", c.days)} className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm hover:bg-muted">
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            )}
            {row2.open && target && (
              target.external ? (
                <a href={target.href} target="_blank" rel="noopener noreferrer" className={ROW2_BTN}>
                  <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open
                </a>
              ) : (
                <Link href={target.href} className={ROW2_BTN}>
                  <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open
                </Link>
              )
            )}
            {row2.skip && ordered.length > 1 && (
              <button type="button" disabled={busy} onClick={skip} className={ROW2_BTN} aria-keyshortcuts="S" aria-describedby="today-hint-skip">
                <SkipForward className="h-4 w-4" aria-hidden="true" /> Skip
              </button>
            )}
            {row2.autoHeal && (
              <button type="button" disabled={busy || healing === card.id || (!!heal && heal.state !== "skipped")} onClick={() => void autoHeal()} className={ROW2_BTN} aria-describedby="today-heal-result">
                <Wrench className="h-4 w-4" aria-hidden="true" /> {healing === card.id ? "Healing..." : "Auto-heal"}
              </button>
            )}
            {row2.copy && (
              <button type="button" onClick={() => void copyForClaude()} className={ROW2_BTN}>
                <ClipboardCopy className="h-4 w-4" aria-hidden="true" /> {copied ? "Copied" : "Copy for Claude"}
              </button>
            )}
            <button type="button" disabled={busy || !last || !last.undoable} onClick={() => void undo()} className={ROW2_BTN} aria-keyshortcuts="U">
              <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo last
            </button>
          </div>
          {/* Reserved height, so a result appearing never pushes the page. */}
          <div className="mt-2 min-h-[2.75rem] text-sm" aria-live="polite">
            <p id="today-hint-skip" className="sr-only">Moves this card to the end of today&apos;s stack for this visit only. Nothing is saved.</p>
            {heal ? (
              <p id="today-heal-result" className={cn("rounded-lg border p-2", heal.state === "fixed" ? "border-emerald-500/40 bg-emerald-500/10" : heal.state === "failed" ? "border-destructive/40 bg-destructive/10 text-destructive" : "bg-muted")} data-testid="today-heal-result">
                <strong>Auto-heal:</strong> {heal.state === "fixed" ? "fixed. " : heal.state === "unchanged" ? "tried, changed nothing. " : heal.state === "skipped" ? "skipped. " : "failed. "}
                {heal.message}
                {heal.cached ? " (Already ran today.)" : ""}
                {heal.state === "fixed" && !readOnly && (
                  <button type="button" onClick={() => void load(true)} className="ml-2 underline underline-offset-2">Refresh the list</button>
                )}
              </p>
            ) : (
              <p className="text-muted-foreground">{rowNote}</p>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Keys: left and right arrows answer. P previous, L later, S skip, U undo.</p>
        </>
      )}

      {data && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          {!card && (
            <button type="button" disabled={busy || !last || !last.undoable} onClick={() => void undo()} className={ROW2_BTN}>
              <Undo2 className="h-4 w-4" aria-hidden="true" /> Undo last
            </button>
          )}
          {last && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Last: {last.op === "approve" ? "yes" : last.op === "reject" ? "no" : "later"} on {last.title}
              {!last.undoable && " (cannot be undone)"}
            </span>
          )}
          {data.snoozedCount > 0 && card && <span className="text-xs text-muted-foreground">{data.snoozedCount} hidden until later</span>}
        </div>
      )}

    </section>
  )
}

