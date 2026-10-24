"use client"

// Browser-side helpers shared by the Today page and the sidebar: one fetch of the queue (so the page and the menu badge
// never ask twice at once), and the card count that the menu badge shows.

import type { TodayCard } from "@/lib/today-cards"
import type { SystemCheck, TodayWins, LastAction } from "@/lib/today-queue"

export interface TodayData {
  cards: TodayCard[]
  count: number
  total: number
  snoozedCount: number
  lastAction: LastAction | null
  system: SystemCheck
  wins: TodayWins
  problems: string[]
  generatedAt: string
}

export const COUNT_EVENT = "today:count"
const COUNT_KEY = "todayCount"
const FRESH_MS = 8_000

export function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}`, "Content-Type": "application/json" }
}

let inflight: Promise<TodayData> | null = null
let last: { at: number; data: TodayData } | null = null

export function announceCount(count: number): void {
  try {
    localStorage.setItem(COUNT_KEY, String(count))
  } catch {
    // storage can be blocked; the badge then just starts empty
  }
  window.dispatchEvent(new CustomEvent(COUNT_EVENT, { detail: count }))
}

export function readCachedCount(): number | null {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY))
    return Number.isFinite(n) && localStorage.getItem(COUNT_KEY) !== null ? n : null
  } catch {
    return null
  }
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
      announceCount(data.count)
      return data
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
