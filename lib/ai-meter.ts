import { getSupabaseAdmin } from '@/lib/supabase-admin'

// AI usage meter. lib/ai-verify.ts (callAnthropic) is the single chokepoint for Anthropic calls, so
// it records every call here into the api_calls table (migration 0044). Rules:
//   - Logging NEVER throws and never delays the call: it runs after the response is already on
//     its way back, and every failure is swallowed.
//   - Tokens come from the API's own `usage` field. Cost is an ESTIMATE from the rate table below.
//   - No prompt or reply text is stored, only counts.

export interface ApiCallRow {
  ts: string
  feature: string
  model: string
  input_tokens: number
  output_tokens: number
  est_cost_usd: number
  ok: boolean
}

// ESTIMATED list prices in US dollars per million tokens (input, output). These are rough
// placeholders for planning, not an invoice: check the Anthropic console for the real bill, and
// edit this table when prices change. A model that matches no row falls back to the dearest row,
// so an unknown model is over-counted rather than hidden.
const RATES_PER_MILLION: { match: RegExp; input: number; output: number }[] = [
  { match: /haiku/i, input: 1, output: 5 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /opus/i, input: 15, output: 75 },
]
const FALLBACK_RATE = { input: 15, output: 75 }

/** Estimated cost in US dollars for one call. Pure. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES_PER_MILLION.find((r) => r.match.test(model)) ?? FALLBACK_RATE
  const usd = (Math.max(0, inputTokens) * rate.input + Math.max(0, outputTokens) * rate.output) / 1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}

/** Pull token counts from a Messages API response body. Missing or odd values count as 0. Pure. */
export function usageFrom(data: unknown): { input: number; output: number } {
  const u = (data as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  return { input: n(u?.input_tokens), output: n(u?.output_tokens) }
}

/**
 * Name the feature from the caller's file, read off a stack trace: the first frame that is not
 * this meter or ai-verify. "lib/blog-composer.ts" becomes "blog-composer". Falls back to "other".
 * Pure, so the check can prove it.
 */
export function featureFromStack(stack: string | undefined): string {
  if (!stack) return 'other'
  for (const line of stack.split('\n').slice(1)) {
    const m = line.replace(/\\/g, '/').match(/\/(?:lib|app|components)\/([^():]+?)\.(?:ts|tsx|js|mjs)\b/)
    if (!m) continue
    const parts = m[1].split('/')
    const name = parts[parts.length - 1] === 'route' ? parts.slice(-3, -1).join('-') : parts[parts.length - 1]
    if (name === 'ai-verify' || name === 'ai-meter') continue
    return name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'other'
  }
  return 'other'
}

export interface MeterWriter {
  from: (table: string) => { insert: (row: unknown) => PromiseLike<{ error: { message: string } | null }> }
}

/** Record one call. Never throws, whatever the database does. `writer` is for tests. */
export async function recordApiCall(row: Omit<ApiCallRow, 'ts' | 'est_cost_usd'> & { ts?: string }, writer?: MeterWriter): Promise<void> {
  try {
    const full: ApiCallRow = {
      ts: row.ts ?? new Date().toISOString(),
      feature: row.feature || 'other',
      model: row.model,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      est_cost_usd: estimateCostUsd(row.model, row.input_tokens, row.output_tokens),
      ok: row.ok,
    }
    const db = writer ?? (getSupabaseAdmin() as unknown as MeterWriter)
    await db.from('api_calls').insert(full)
  } catch {
    // The meter is a side note: a failed write must never become a failed AI call.
  }
}

/**
 * Meter one finished response. Reads a CLONE of the body in the background so the caller's own
 * read of the response is untouched. Returns immediately.
 */
export function meterResponse(res: Response, model: string, feature: string): void {
  try {
    if (!res.ok) {
      void recordApiCall({ feature, model, input_tokens: 0, output_tokens: 0, ok: false })
      return
    }
    const copy = res.clone()
    void copy
      .json()
      .then((data) => {
        const u = usageFrom(data)
        return recordApiCall({ feature, model, input_tokens: u.input, output_tokens: u.output, ok: true })
      })
      .catch(() => recordApiCall({ feature, model, input_tokens: 0, output_tokens: 0, ok: true }))
  } catch {
    // never let metering touch the call
  }
}
