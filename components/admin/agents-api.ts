// Tiny client helper for the Agents back office. Every call carries the admin token.
export function agentsHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export async function agentsCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/admin/agents", { method: "POST", headers: agentsHeaders(), body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

export type Row = Record<string, unknown>

export interface AgentsData {
  migrated: boolean
  agents: Row[]
  achievements: Row[]
  aotm: Row[]
  submissions: Row[]
  drafts: Row[]
  suggestions: { id: string; display_name: string; score: number; reasons: string[] }[]
  leaderboard: { agent_id: string; display_name: string; total: number; count: number }[]
  /** The lead desk switch: also alert the office team (CEO, CTO, Manager). Default off. */
  officeAlert?: boolean
}

export const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v))
export const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
