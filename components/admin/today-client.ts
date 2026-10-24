"use client"

// Browser-side helpers shared by the Today page and the sidebar: one fetch of the queue (so the page and the menu badges
// never ask twice at once), and the three menu badges that come out of it: the Today card count, the open follow-ups, and the
// system check light. The follow-ups page and the system check page add their own fresher numbers with announceBadges.

import type { TodayCard } from "@/lib/today-cards"
import type { SystemCheck, TodayWins, LastAction } from "@/lib/today-queue"
import type { CheckSummary, Light } from "@/lib/system-check"
import type { FixSummary } from "@/lib/system-check-fixes"

export interface TodayData {
  cards: TodayCard[]
  count: number
  total: number
  snoozedCount: number
  lastAction: LastAction | null
  system: SystemCheck
  /** The full system check, summed up. Null when it could not be read at all. */
  check: CheckSummary | null
  /** The top fixes still open from the system check, and the counts. Null when the check could not be read. */
  fixes: FixSummary | null
  /** Open follow-ups from the list built today. Null when no list has been built yet today. */
  followups: { open: number; total: number } | null
  wins: TodayWins
  problems: string[]
  generatedAt: string
}

export interface NavBadges {
  today: number | null
  followups: number | null
  check: Light | null
}

export const BADGES_EVENT = "admin:badges"
/** Kept for older listeners: the Today card count alone. */
export const COUNT_EVENT = "today:count"
const BADGES_KEY = "adminBadges"
const FRESH_MS = 8_000

export function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}`, "Content-Type": "application/json" }
}

let inflight: Promise<TodayData> | null = null
let last: { at: number; data: TodayData } | null = null

export function readCachedBadges(): NavBadges {
  const empty: NavBadges = { today: null, followups: null, check: null }
  try {
    const v = JSON.parse(localStorage.getItem(BADGES_KEY) || "null") as Partial<NavBadges> | null
    if (!v || typeof v !== "object") return empty
    return {
      today: typeof v.today === "number" ? v.today : null,
      followups: typeof v.followups === "number" ? v.followups : null,
      check: v.check === "green" || v.check === "amber" || v.check === "red" ? v.check : null,
    }
  } catch {
    return empty
  }
}

/** Updates one or more menu badges and tells every listener. A badge left out keeps its last value. */
export function announceBadges(patch: Partial<NavBadges>): void {
  const next = { ...readCachedBadges(), ...patch }
  try {
    localStorage.setItem(BADGES_KEY, JSON.stringify(next))
  } catch {
    // storage can be blocked; the badges then just start empty
  }
  window.dispatchEvent(new CustomEvent(BADGES_EVENT, { detail: next }))
  if (typeof patch.today === "number") window.dispatchEvent(new CustomEvent(COUNT_EVENT, { detail: patch.today }))
}

/** Loads the queue. A call made while another is running, or right after one finished, shares that answer. */
export function fetchToday(force = false): Promise<TodayData> {
  if (!force && last && Date.now() - last.at < FRESH_MS) return Promise.resolve(last.data)
  if (inflight) return inflight
  inflight = fetch("/api/admin/today", { headers: authHeaders(), cache: "no-store" })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`)
      const data = body as TodayData
      last = { at: Date.now(), data }
      announceBadges({
        today: data.count,
        ...(data.followups ? { followups: data.followups.open } : {}),
        ...(data.check ? { check: data.check.overall } : {}),
      })
      return data
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
